/**
 * Memory Bridge — SillyTavern Extension
 * 独立记忆召回层：通过 MCP 协议连接外置记忆库，
 * 在用户发送前自动召回相关记忆并注入上下文，不占用 RPAI token。
 */

// ─── 常量 ────────────────────────────────────────────────────────────────────

const EXT_NAME = 'memory-bridge';
const LOG_PREFIX = '[MemBridge]';
const SEND_INTENT_TTL_MS = 5000;
const MCP_PLUGIN_ID = 'mcp';
const MCP_PLUGIN_BASE = `/api/plugins/${MCP_PLUGIN_ID}`;
const DEFAULT_MCP_CONFIG_JSON = JSON.stringify({
    mcpServers: {
        'mcp-router': {
            command: 'npx',
            args: ['-y', '@mcp_router/cli@latest', 'connect'],
            env: { MCPR_TOKEN: '' },
        },
    },
}, null, 2);

// ─── 默认设置 ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
    enabled: false,
    connectionMode: 'http',
    serverUrl: 'http://localhost:8000/mcp',
    token: '',
    mcpConfigJson: DEFAULT_MCP_CONFIG_JSON,
    selectedServerName: '',
    recallLimit: 5,
    domain: '',
    injectTag: '[记忆参考]',
    bootEnabled: false,
    bootUri: 'system://boot',
    debug: false,
};

// ─── 运行时状态 ───────────────────────────────────────────────────────────────

let mcpClient = null;
let connectionState = 'disconnected';
let lastSendIntentAt = 0;
let isProcessing = false;
let lastInjectedContent = '';
let lastErrorMessage = '';

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
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(extensionSettings[EXT_NAME], key)) {
            extensionSettings[EXT_NAME][key] = DEFAULT_SETTINGS[key];
        }
    }
    return extensionSettings[EXT_NAME];
}

function resetMcpClient() {
    mcpClient = null;
}

function getErrorMessage(error) {
    if (!error) return '未知错误';
    if (typeof error === 'string') return error;
    if (error instanceof Error) return error.message;
    return String(error);
}

function setLastErrorMessage(message) {
    lastErrorMessage = message || '';
}

function getRequestHeaders(options = {}) {
    const context = SillyTavern.getContext();
    if (typeof context.getRequestHeaders === 'function') {
        return context.getRequestHeaders(options);
    }
    return {
        'Content-Type': 'application/json',
    };
}

function getSelectedServerName(config, settings = getSettings()) {
    if (config.source === 'json') return config.label.replace(/\s+\(via mcp-router\)$/, '');
    return settings.selectedServerName?.trim() || 'memory-bridge-default';
}

async function pluginFetch(path, body, method = 'POST') {
    const response = await fetch(`${MCP_PLUGIN_BASE}${path}`, {
        method,
        headers: {
            ...getRequestHeaders(),
            'Content-Type': 'application/json',
        },
        body: body == null ? undefined : JSON.stringify(body),
    });

    let data = null;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
        data = await response.json();
    } else {
        const text = await response.text();
        data = text ? { raw: text } : null;
    }

    if (!response.ok) {
        const errorMessage = data?.error || data?.message || `HTTP ${response.status}`;
        throw new Error(errorMessage);
    }
    return data;
}


function createRpcBody(method, params) {
    const isNotification = method.startsWith('notifications/');
    const body = { jsonrpc: '2.0', method, params };
    if (!isNotification) body.id = crypto.randomUUID();
    return body;
}

function resolveHttpConnectionConfig(settings) {
    const url = settings.serverUrl?.trim();
    if (!url) throw new Error('请填写 MCP 服务地址');
    const headers = {};
    if (settings.token) headers.Authorization = `Bearer ${settings.token}`;
    return {
        source: 'http',
        transport: 'streamable-http',
        url,
        headers,
        label: url,
    };
}

function normalizeJsonHttpServer(serverName, serverConfig) {
    const url = serverConfig.url?.trim();
    if (!url) throw new Error(`MCP server ${serverName} 缺少 url`);
    const headers = serverConfig.headers && typeof serverConfig.headers === 'object'
        ? Object.fromEntries(Object.entries(serverConfig.headers).filter(([, value]) => value != null))
        : {};
    return {
        source: 'json',
        transport: 'streamable-http',
        url,
        headers,
        label: serverName,
    };
}

function normalizeJsonCommandServer(serverName, serverConfig) {
    const command = serverConfig.command?.trim();
    if (!command) throw new Error(`MCP server ${serverName} 缺少 command`);
    const args = Array.isArray(serverConfig.args) ? serverConfig.args.map(arg => String(arg)) : [];
    const env = serverConfig.env && typeof serverConfig.env === 'object'
        ? Object.fromEntries(Object.entries(serverConfig.env).filter(([, value]) => value != null).map(([key, value]) => [key, String(value)]))
        : {};

    const isMcpRouterConnect = command === 'npx'
        && args.some(arg => arg.includes('@mcp_router/cli'))
        && args.includes('connect');
    if (isMcpRouterConnect) {
        const token = env.MCPR_TOKEN?.trim();
        if (!token) throw new Error(`MCP server ${serverName} 缺少 MCPR_TOKEN`);
        return {
            source: 'json',
            transport: 'command',
            command,
            args,
            env,
            label: `${serverName} (via mcp-router)`,
        };
    }

    return {
        source: 'json',
        transport: 'command',
        command,
        args,
        env,
        label: serverName,
    };
}

function resolveJsonConnectionConfig(settings) {
    const raw = settings.mcpConfigJson?.trim();
    if (!raw) throw new Error('请填写 MCP JSON 配置');

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`MCP JSON 解析失败: ${error.message}`);
    }

    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== 'object') {
        throw new Error('MCP JSON 必须包含 mcpServers 对象');
    }

    const entries = Object.entries(servers).filter(([, value]) => value && typeof value === 'object');
    if (!entries.length) {
        throw new Error('mcpServers 中没有可用的 server 配置');
    }

    const selectedServerName = settings.selectedServerName?.trim();
    const match = selectedServerName
        ? entries.find(([name]) => name === selectedServerName)
        : entries[0];
    if (!match) {
        throw new Error(`未找到名为 ${selectedServerName} 的 MCP server`);
    }

    const [serverName, serverConfig] = match;
    if (serverConfig.url) return normalizeJsonHttpServer(serverName, serverConfig);
    if (serverConfig.command) return normalizeJsonCommandServer(serverName, serverConfig);
    throw new Error(`MCP server ${serverName} 既没有 url，也没有 command`);
}

function resolveConnectionConfig() {
    const settings = getSettings();
    return settings.connectionMode === 'json'
        ? resolveJsonConnectionConfig(settings)
        : resolveHttpConnectionConfig(settings);
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
                } catch {
                    continue;
                }
            }
        }
        throw new Error('SSE 流结束但未收到有效数据');
    }

    throw new Error(`未知响应类型: ${contentType}`);
}

function createStreamableHttpClient(config) {
    let sessionId = null;

    return {
        config,
        async send(method, params) {
            const headers = {
                accept: 'application/json, text/event-stream',
                'content-type': 'application/json',
                ...config.headers,
            };
            if (sessionId) headers['mcp-session-id'] = sessionId;

            log(`RPC → ${method}`, config.label);
            const response = await fetch(config.url, {
                method: 'POST',
                headers,
                body: JSON.stringify(createRpcBody(method, params)),
            });
            if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${response.statusText}`);
            const nextSessionId = response.headers.get('mcp-session-id');
            if (nextSessionId) sessionId = nextSessionId;
            return response;
        },
        getSessionId() {
            return sessionId;
        },
        reset() {
            sessionId = null;
        },
    };
}

function createPluginBackedClient(config) {
    let started = false;
    let serverName = getSelectedServerName(config);

    async function ensureToolCacheLoaded() {
        await pluginFetch(`/servers/${encodeURIComponent(serverName)}/reload-tools`, {});
    }

    return {
        config,
        async send(method, params) {
            serverName = getSelectedServerName(config);

            if (!started) {
                const pluginConfig = config.transport === 'command'
                    ? {
                        type: 'stdio',
                        command: config.command,
                        args: config.args,
                        env: config.env,
                    }
                    : {
                        type: 'streamableHttp',
                        url: config.url,
                        headers: config.headers,
                        env: {},
                    };

                try {
                    await pluginFetch('/servers', { name: serverName, config: pluginConfig });
                } catch (error) {
                    const message = getErrorMessage(error);
                    if (!message.includes('already exists')) throw error;
                }

                try {
                    await pluginFetch(`/servers/${encodeURIComponent(serverName)}/start`, {});
                } catch (error) {
                    const message = getErrorMessage(error);
                    if (!message.includes('already running')) throw error;
                }

                await ensureToolCacheLoaded();
                started = true;
            }

            if (method === 'initialize') {
                return {
                    ok: true,
                    headers: new Headers({ 'content-type': 'application/json' }),
                    json: async () => ({
                        jsonrpc: '2.0',
                        result: {
                            protocolVersion: '2025-03-26',
                            capabilities: {
                                tools: {},
                            },
                            serverInfo: { name: serverName },
                        },
                    }),
                };
            }

            if (method === 'notifications/initialized') {
                return {
                    ok: true,
                    headers: new Headers({ 'content-type': 'application/json' }),
                    json: async () => ({ jsonrpc: '2.0', result: {} }),
                };
            }

            if (method === 'tools/list') {
                const tools = await pluginFetch(`/servers/${encodeURIComponent(serverName)}/list-tools`, null, 'GET');
                return {
                    ok: true,
                    headers: new Headers({ 'content-type': 'application/json' }),
                    json: async () => ({
                        jsonrpc: '2.0',
                        result: {
                            tools: Array.isArray(tools) ? tools.filter(tool => tool?._enabled !== false) : [],
                        },
                    }),
                };
            }

            if (method === 'tools/call') {
                const result = await pluginFetch(`/servers/${encodeURIComponent(serverName)}/call-tool`, {
                    toolName: params.name,
                    arguments: params.arguments ?? {},
                });
                const text = JSON.stringify(result?.result?.data ?? result?.result ?? result ?? {}, null, 2);
                return {
                    ok: true,
                    headers: new Headers({ 'content-type': 'application/json' }),
                    json: async () => ({
                        jsonrpc: '2.0',
                        result: {
                            content: [{ type: 'text', text }],
                        },
                    }),
                };
            }

            throw new Error(`本地 MCP 插件暂不支持方法: ${method}`);
        },
        getSessionId() {
            return serverName;
        },
        reset() {
            started = false;
        },
    };
}

function createMcpClient(config) {
    if (config.transport === 'streamable-http' || config.transport === 'command') {
        return createPluginBackedClient(config);
    }
    throw new Error(`不支持的 MCP transport: ${config.transport}`);
}

function getMcpClient() {
    if (!mcpClient) {
        const config = resolveConnectionConfig();
        mcpClient = createMcpClient(config);
    }
    return mcpClient;
}

async function mcpRpc(method, params) {
    return await getMcpClient().send(method, params);
}

async function mcpInitialize() {
    const initResponse = await mcpRpc('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'memory-bridge', version: '0.1.0' },
    });
    const data = await parseMcpResponse(initResponse);
    const sessionId = getMcpClient().getSessionId();
    if (sessionId) log('会话已建立, sessionId:', sessionId);
    if (data?.error) throw new Error(`MCP 初始化失败: ${data.error.message}`);
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
    setLastErrorMessage('');
    resetMcpClient();
    try {
        const config = resolveConnectionConfig();
        log('连接配置:', config);
        await mcpInitialize();
        setConnectionState('connected');
        log('连接成功');
        return true;
    } catch (err) {
        const message = getErrorMessage(err);
        setLastErrorMessage(message);
        resetMcpClient();
        setConnectionState('disconnected');
        logError('连接失败:', err);
        return false;
    }
}

async function ensureConnected() {
    if (connectionState === 'connected' && mcpClient) return true;
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
        resetMcpClient();
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
        resetMcpClient();
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
    const errorText = document.getElementById('mb-error-text');
    if (!dot || !text) return;
    dot.className = state;
    text.textContent = { connected: '已连接', connecting: '连接中...', disconnected: '未连接' }[state] ?? state;
    if (errorText) {
        errorText.textContent = lastErrorMessage || '';
        errorText.classList.toggle('mb-hidden', !lastErrorMessage);
    }
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

function updateConnectionModeUI() {
    const mode = document.getElementById('mb-connection-mode')?.value ?? 'http';
    const httpSection = document.getElementById('mb-http-config');
    const jsonSection = document.getElementById('mb-json-config');
    httpSection?.classList.toggle('mb-hidden', mode !== 'http');
    jsonSection?.classList.toggle('mb-hidden', mode !== 'json');
}

function loadSettingsToUI() {
    const s = getSettings();
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.type === 'checkbox' ? (el.checked = !!val) : (el.value = val ?? '');
    };
    set('mb-enabled', s.enabled);
    set('mb-connection-mode', s.connectionMode);
    set('mb-server-url', s.serverUrl);
    set('mb-token', s.token);
    set('mb-mcp-config-json', s.mcpConfigJson);
    set('mb-selected-server-name', s.selectedServerName);
    set('mb-recall-limit', s.recallLimit);
    set('mb-domain', s.domain);
    set('mb-inject-tag', s.injectTag);
    set('mb-boot-enabled', s.bootEnabled);
    set('mb-boot-uri', s.bootUri);
    set('mb-debug', s.debug);
    updateConnectionModeUI();
    updateStatusUI(connectionState);
    updateLastInjectPreview(lastInjectedContent);
}

function saveSettingsFromUI() {
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
    const s = extensionSettings[EXT_NAME];
    const get = (id) => document.getElementById(id);
    s.enabled            = get('mb-enabled')?.checked ?? false;
    s.connectionMode     = get('mb-connection-mode')?.value ?? 'http';
    s.serverUrl          = get('mb-server-url')?.value?.trim() ?? '';
    s.token              = get('mb-token')?.value ?? '';
    s.mcpConfigJson      = get('mb-mcp-config-json')?.value ?? DEFAULT_MCP_CONFIG_JSON;
    s.selectedServerName = get('mb-selected-server-name')?.value?.trim() ?? '';
    s.recallLimit        = parseInt(get('mb-recall-limit')?.value) || 5;
    s.domain             = get('mb-domain')?.value?.trim() ?? '';
    s.injectTag          = get('mb-inject-tag')?.value ?? '[记忆参考]';
    s.bootEnabled        = get('mb-boot-enabled')?.checked ?? false;
    s.bootUri            = get('mb-boot-uri')?.value?.trim() ?? 'system://boot';
    s.debug              = get('mb-debug')?.checked ?? false;
    saveSettingsDebounced();
}

function bindSettingsEvents() {
    document.querySelectorAll('#memory-bridge-settings input, #memory-bridge-settings select, #memory-bridge-settings textarea')
        .forEach(el => el.addEventListener('change', saveSettingsFromUI));

    document.getElementById('mb-connection-mode')?.addEventListener('change', () => {
        updateConnectionModeUI();
        resetMcpClient();
        setConnectionState('disconnected');
    });

    document.getElementById('mb-btn-connect')?.addEventListener('click', async () => {
        saveSettingsFromUI();
        resetMcpClient();
        const ok = await connect();
        toastr[ok ? 'success' : 'error'](
            ok ? 'MCP 服务连接成功' : (lastErrorMessage || '连接失败，请检查当前连接配置'),
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
        resetMcpClient();
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
