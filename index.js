/**
 * Memory Bridge — SillyTavern Extension
 * 独立记忆召回层：通过 MCP Streamable HTTP 协议连接外置记忆库，
 * 在用户发送前自动召回相关记忆并注入上下文，不占用 RPAI token。
 */

// ─── 常量 ────────────────────────────────────────────────────────────────────

const EXT_NAME = 'memory-bridge';
const LOG_PREFIX = '[MemBridge]';
const SEND_INTENT_TTL_MS = 5000;

// ─── 默认设置 ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
    enabled: false,
    serverUrl: 'http://localhost:8000/mcp',
    token: '',
    recallLimit: 5,
    domain: '',
    injectTag: '[记忆参考]',
    bootEnabled: false,
    bootUri: 'system://boot',
    debug: false,
};

// ─── 运行时状态 ───────────────────────────────────────────────────────────────

let mcpSessionId = null;
let connectionState = 'disconnected';
let lastSendIntentAt = 0;
let isProcessing = false;
let lastInjectedContent = '';

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function log(...args) {
    if (getSettings().debug) console.log(LOG_PREFIX, ...args);
}

function logError(...args) {
    console.error(LOG_PREFIX, ...args);
}

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[EXT_NAME]) {
        extensionSettings[EXT_NAME] = Object.assign({}, DEFAULT_SETTINGS);
    }
    // 补全新增字段
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(extensionSettings[EXT_NAME], key)) {
            extensionSettings[EXT_NAME][key] = DEFAULT_SETTINGS[key];
        }
    }
    return extensionSettings[EXT_NAME];
}

// ─── MCP Streamable HTTP 客户端 ───────────────────────────────────────────────

async function mcpRpc(method, params) {
    const settings = getSettings();
    const headers = {
        'accept': 'application/json, text/event-stream',
        'content-type': 'application/json',
    };
    if (mcpSessionId) headers['mcp-session-id'] = mcpSessionId;
    if (settings.token) headers['Authorization'] = `Bearer ${settings.token}`;

    const isNotification = method.startsWith('notifications/');
    const body = { jsonrpc: '2.0', method, params };
    if (!isNotification) body.id = crypto.randomUUID();

    log(`RPC → ${method}`);
    const response = await fetch(settings.serverUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });

    if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${response.statusText}`);
    return response;
}

async function parseMcpResponse(response) {
    const contentType = response.headers.get('content-type') ?? '';

    if (contentType.includes('application/json')) {
        const data = await response.json();
        log('RPC ← JSON', data);
        return data;
    }

    if (contentType.includes('text/event-stream')) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const data = trimmed.slice(5).trim();
                if (!data || data === 'ping') continue;
                try {
                    const parsed = JSON.parse(data);
                    log('RPC ← SSE', parsed);
                    return parsed;
                } catch { /* continue */ }
            }
        }
        throw new Error('SSE 流结束但未收到有效数据');
    }

    throw new Error(`未知响应类型: ${contentType}`);
}

async function mcpInitialize() {
    const initResponse = await mcpRpc('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'memory-bridge', version: '0.1.0' },
    });
    const newSessionId = initResponse.headers.get('mcp-session-id');
    if (newSessionId) {
        mcpSessionId = newSessionId;
        log('会话已建立, sessionId:', mcpSessionId);
    }
    await parseMcpResponse(initResponse);
    await mcpRpc('notifications/initialized', {});
    return true;
}

async function mcpCallTool(toolName, args) {
    const response = await mcpRpc('tools/call', { name: toolName, arguments: args });
    const data = await parseMcpResponse(response);
    if (data?.error) throw new Error(`MCP 工具错误: ${data.error.message}`);
    const content = data?.result?.content ?? [];
    return content.filter(c => c.type === 'text').map(c => c.text).join('\n');
}

// ─── 连接管理 ─────────────────────────────────────────────────────────────────

async function connect() {
    if (connectionState === 'connecting') return false;
    setConnectionState('connecting');
    mcpSessionId = null;
    try {
        await mcpInitialize();
        setConnectionState('connected');
        log('连接成功');
        return true;
    } catch (err) {
        setConnectionState('disconnected');
        logError('连接失败:', err);
        return false;
    }
}

async function ensureConnected() {
    if (connectionState === 'connected' && mcpSessionId) return true;
    return await connect();
}

function setConnectionState(state) {
    connectionState = state;
    updateStatusUI(state);
}

// ─── 记忆召回 ─────────────────────────────────────────────────────────────────

async function recallMemory(query) {
    const settings = getSettings();
    try {
        if (!await ensureConnected()) {
            logError('无法连接到 MCP 服务，跳过记忆召回');
            return '';
        }
        const args = { query: query.slice(0, 500), limit: settings.recallLimit };
        if (settings.domain) args.domain = settings.domain;
        log('召回记忆, query:', args.query);
        const result = await mcpCallTool('search_memory', args);
        log('召回结果长度:', result.length);
        return result;
    } catch (err) {
        logError('记忆召回失败:', err);
        mcpSessionId = null;
        setConnectionState('disconnected');
        return '';
    }
}

async function readMemory(uri) {
    try {
        if (!await ensureConnected()) return '';
        log('读取记忆:', uri);
        return await mcpCallTool('read_memory', { uri });
    } catch (err) {
        logError('读取记忆失败:', err);
        mcpSessionId = null;
        setConnectionState('disconnected');
        return '';
    }
}

// ─── 内容注入 ─────────────────────────────────────────────────────────────────

function buildInjectedMessage(userInput, memoryContent) {
    if (!memoryContent?.trim()) return userInput;
    const tag = getSettings().injectTag?.trim();
    const block = tag
        ? `\n\n${tag}\n${memoryContent.trim()}\n${tag}`
        : `\n\n${memoryContent.trim()}`;
    return userInput + block;
}

// ─── 发送意图检测 ─────────────────────────────────────────────────────────────

function markSendIntent() { lastSendIntentAt = Date.now(); }
function isRecentSendIntent() { return (Date.now() - lastSendIntentAt) <= SEND_INTENT_TTL_MS; }

function installSendIntentHooks() {
    try {
        const doc = (window.parent || window).document;
        const sendBtn = doc.getElementById('send_but');
        if (sendBtn && !sendBtn.__mb_hooked) {
            sendBtn.addEventListener('click', markSendIntent, true);
            sendBtn.addEventListener('pointerup', markSendIntent, true);
            sendBtn.__mb_hooked = true;
        }
        const textarea = doc.getElementById('send_textarea');
        if (textarea && !textarea.__mb_hooked) {
            textarea.addEventListener('keydown', (e) => {
                if ((e.key === 'Enter' || e.key === 'NumpadEnter') && !e.shiftKey) markSendIntent();
            }, true);
            textarea.__mb_hooked = true;
        }
        if ((!sendBtn || !textarea) && !window.__mb_hookRetryScheduled) {
            window.__mb_hookRetryScheduled = true;
            setTimeout(() => { window.__mb_hookRetryScheduled = false; installSendIntentHooks(); }, 1500);
        }
    } catch (e) { /* ignore */ }
}

// ─── 核心拦截逻辑 ─────────────────────────────────────────────────────────────

async function onGenerationAfterCommands(type, params, dryRun) {
    if (!getSettings().enabled) return;
    if (dryRun) return;
    if (isProcessing) return;
    if (type === 'quiet') return;
    if (params?.quiet_prompt) return;
    if (params?.automatic_trigger) return;

    const { chat } = SillyTavern.getContext();
    if (!chat?.length) return;

    // 策略1：最新楼层是用户消息且未处理
    const lastMsg = chat[chat.length - 1];
    if (lastMsg?.is_user && !lastMsg.__mb_processed) {
        const userText = lastMsg.mes;
        if (!userText?.trim()) return;
        lastMsg.__mb_processed = true;
        isProcessing = true;
        try {
            const memory = await recallMemory(userText);
            if (memory) {
                const injected = buildInjectedMessage(userText, memory);
                lastMsg.mes = injected;
                params.prompt = injected;
                lastInjectedContent = memory;
                updateLastInjectPreview(memory);
                log('策略1注入成功, 记忆长度:', memory.length);
            }
        } catch (err) {
            logError('策略1处理失败:', err);
        } finally {
            isProcessing = false;
        }
        return;
    }

    // 策略2：输入框有文本 + 近期发送意图
    if (!isRecentSendIntent()) return;
    const textarea = (window.parent || window).document.getElementById('send_textarea');
    const textInBox = textarea?.value?.trim();
    if (!textInBox) return;

    isProcessing = true;
    try {
        const memory = await recallMemory(textInBox);
        if (memory) {
            const injected = buildInjectedMessage(textInBox, memory);
            textarea.value = injected;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            try { params.prompt = injected; } catch (_) { /* ignore */ }
            lastInjectedContent = memory;
            updateLastInjectPreview(memory);
            log('策略2注入成功, 记忆长度:', memory.length);
        }
    } catch (err) {
        logError('策略2处理失败:', err);
    } finally {
        isProcessing = false;
        lastSendIntentAt = 0;
    }
}

// ─── Boot Memory ──────────────────────────────────────────────────────────────

async function loadBootMemory() {
    const settings = getSettings();
    if (!settings.bootEnabled || !settings.bootUri) return;
    log('加载 Boot Memory:', settings.bootUri);
    const content = await readMemory(settings.bootUri);
    if (!content) return;
    try {
        const { setExtensionPrompt, extension_prompt_types } = SillyTavern.getContext();
        setExtensionPrompt(EXT_NAME + '_boot', content, extension_prompt_types.IN_PROMPT, 0);
        log('Boot Memory 已注入, 长度:', content.length);
    } catch (err) {
        logError('Boot Memory 注入失败:', err);
    }
}

// ─── UI 更新 ──────────────────────────────────────────────────────────────────

function updateStatusUI(state) {
    const dot = document.getElementById('mb-status-dot');
    const text = document.getElementById('mb-status-text');
    if (!dot || !text) return;
    dot.className = state;
    text.textContent = { connected: '已连接', connecting: '连接中...', disconnected: '未连接' }[state] ?? state;
}

function updateLastInjectPreview(content) {
    const el = document.getElementById('mb-last-inject');
    if (!el) return;
    if (content) {
        el.textContent = content.slice(0, 300) + (content.length > 300 ? '...' : '');
        el.classList.remove('empty');
    } else {
        el.textContent = '（尚未注入）';
        el.classList.add('empty');
    }
}

// ─── 设置面板 ─────────────────────────────────────────────────────────────────

function loadSettingsToUI() {
    const s = getSettings();
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.type === 'checkbox' ? (el.checked = !!val) : (el.value = val ?? '');
    };
    set('mb-enabled', s.enabled);
    set('mb-server-url', s.serverUrl);
    set('mb-token', s.token);
    set('mb-recall-limit', s.recallLimit);
    set('mb-domain', s.domain);
    set('mb-inject-tag', s.injectTag);
    set('mb-boot-enabled', s.bootEnabled);
    set('mb-boot-uri', s.bootUri);
    set('mb-debug', s.debug);
    updateStatusUI(connectionState);
    updateLastInjectPreview(lastInjectedContent);
}

function saveSettingsFromUI() {
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
    const s = extensionSettings[EXT_NAME];
    const get = (id) => document.getElementById(id);
    s.enabled      = get('mb-enabled')?.checked ?? false;
    s.serverUrl    = get('mb-server-url')?.value?.trim() ?? '';
    s.token        = get('mb-token')?.value ?? '';
    s.recallLimit  = parseInt(get('mb-recall-limit')?.value) || 5;
    s.domain       = get('mb-domain')?.value?.trim() ?? '';
    s.injectTag    = get('mb-inject-tag')?.value ?? '[记忆参考]';
    s.bootEnabled  = get('mb-boot-enabled')?.checked ?? false;
    s.bootUri      = get('mb-boot-uri')?.value?.trim() ?? 'system://boot';
    s.debug        = get('mb-debug')?.checked ?? false;
    saveSettingsDebounced();
}

function bindSettingsEvents() {
    document.querySelectorAll('#memory-bridge-settings input, #memory-bridge-settings select')
        .forEach(el => el.addEventListener('change', saveSettingsFromUI));

    document.getElementById('mb-btn-connect')?.addEventListener('click', async () => {
        saveSettingsFromUI();
        mcpSessionId = null;
        const ok = await connect();
        toastr[ok ? 'success' : 'error'](
            ok ? 'MCP 服务连接成功' : '连接失败，请检查地址和 Token',
            'Memory Bridge',
        );
    });

    document.getElementById('mb-btn-test-recall')?.addEventListener('click', async () => {
        const textarea = (window.parent || window).document.getElementById('send_textarea');
        const query = textarea?.value?.trim() || '测试';
        toastr.info('正在召回...', 'Memory Bridge');
        const result = await recallMemory(query);
        updateLastInjectPreview(result || '（无结果）');
        toastr[result ? 'success' : 'warning'](
            result ? `召回 ${result.length} 字符` : '未找到相关记忆',
            'Memory Bridge',
        );
    });

    document.getElementById('mb-btn-clear-session')?.addEventListener('click', () => {
        mcpSessionId = null;
        setConnectionState('disconnected');
        toastr.info('会话已清除', 'Memory Bridge');
    });
}

// ─── 初始化 ───────────────────────────────────────────────────────────────────

jQuery(async () => {
    // 初始化设置
    getSettings();

    // 渲染设置面板（路径必须是 third-party/<目录名>）
    const { renderExtensionTemplateAsync, eventSource, event_types } = SillyTavern.getContext();
    const settingsHtml = await renderExtensionTemplateAsync('third-party/memory-bridge', 'settings');
    $('#extensions_settings2').append(settingsHtml);

    // 加载设置到 UI 并绑定事件
    loadSettingsToUI();
    bindSettingsEvents();

    // 安装发送意图捕获钩子
    installSendIntentHooks();

    // 注册生成拦截
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);

    // 切换聊天时加载 Boot Memory
    eventSource.on(event_types.CHAT_CHANGED, async () => {
        lastSendIntentAt = 0;
        isProcessing = false;
        await loadBootMemory();
    });

    log('Memory Bridge 已加载');
});
