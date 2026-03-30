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

function createDefaultLlmPreset(name = '默认预设') {
    return {
        id: `llm-preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        enabled: false,
        source: 'tavern',
        tavernProfile: '',
        apiUrl: '',
        apiKey: '',
        model: '',
        temperature: 0.7,
        maxTokens: 2000,
        useMainApi: true,
        prompts: JSON.parse(JSON.stringify(DEFAULT_SETTINGS.llm.prompts)),
    };
}

const DEFAULT_SETTINGS = {
    workMode: 'bridge',
    connection: {
        mode: 'http',
        serverUrl: 'http://localhost:8000/mcp',
        token: '',
        mcpConfigJson: DEFAULT_MCP_CONFIG_JSON,
        selectedServerName: '',
    },
    bridge: {
        enabled: false,
        recallLimit: 5,
        domain: '',
        injectTag: '[记忆参考]',
        bootEnabled: false,
        bootUri: 'system://boot',
        testSnippet: '',
    },
    import: {
        parentUri: 'core://',
        titlePrefix: 'chat',
        disclosure: '当需要回想这段聊天内容时',
        limit: 20,
    },
    llm: {
        selectedPresetId: 'default',
        presets: [
            {
                id: 'default',
                name: '默认预设',
                enabled: false,
                source: 'tavern',
                tavernProfile: '',
                apiUrl: '',
                apiKey: '',
                model: '',
                temperature: 0.7,
                maxTokens: 2000,
                useMainApi: true,
                prompts: [
                    {
                        id: 'mainPrompt',
                        name: '主系统提示词',
                        role: 'system',
                        content: [
                            '你是 Memory Bridge 的记忆整理助手。',
                            '你的职责是将聊天内容整理为适合长期记忆写入与检索的文本。',
                            '保持事实、关系、状态变化与关键表达，不编造，不扩写，不改变原意。',
                            '输出应稳定、简洁、可复用，优先服务 MCP 记忆写入、召回查询改写与结果整理。',
                        ].join('\n'),
                    },
                    {
                        id: 'importPrompt',
                        name: '历史导入处理指令',
                        role: 'user',
                        content: [
                            '请将以下聊天楼层整理为适合写入长期记忆的内容。',
                            '保留：角色、事实、关系、状态变化、设定、事件结论。',
                            '删除：明显噪音、重复表述、无意义口头禅。',
                            '输出纯文本，不要使用 Markdown 标题，不要解释你的步骤。',
                            '',
                            '原始楼层：',
                            '{{input}}',
                        ].join('\n'),
                    },
                    {
                        id: 'recallPrompt',
                        name: '召回查询处理指令',
                        role: 'user',
                        content: [
                            '请将以下用户输入整理为适合全文检索的召回查询。',
                            '提炼核心人物、地点、事件、关系与关键短语。',
                            '输出单段纯文本查询，不要解释。',
                            '',
                            '用户输入：',
                            '{{input}}',
                        ].join('\n'),
                    },
                ],
            },
        ],
    },
    toolExposure: {
        enabled: true,
        selectedTools: {},
        stealth: true,
    },
    debug: false,
};

// ─── 运行时状态 ───────────────────────────────────────────────────────────────

let mcpClient = null;
let connectionState = 'disconnected';
let lastSendIntentAt = 0;
let isProcessing = false;
let lastInjectedContent = '';
let lastErrorMessage = '';
let lastBootStatusMessage = '';
let registeredFunctionTools = [];
let importSelection = new Set();

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function log(...args) {
    if (getSettings().debug) console.log(LOG_PREFIX, ...args);
}

function logError(...args) {
    console.error(LOG_PREFIX, ...args);
}

function getDefaultSettings() {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function migrateLegacySettings(settings) {
    if (!settings || typeof settings !== 'object') {
        return getDefaultSettings();
    }

    if (!settings.connection || typeof settings.connection !== 'object') {
        settings.connection = {};
    }
    if (!settings.bridge || typeof settings.bridge !== 'object') {
        settings.bridge = {};
    }
    if (!settings.import || typeof settings.import !== 'object') {
        settings.import = {};
    }
    if (!settings.llm || typeof settings.llm !== 'object') {
        settings.llm = {};
    }
    if (!settings.toolExposure || typeof settings.toolExposure !== 'object') {
        settings.toolExposure = {};
    }

    if (!settings.workMode) {
        settings.workMode = 'bridge';
    }

    if (!Object.hasOwn(settings.connection, 'mode')) {
        settings.connection.mode = settings.connectionMode ?? DEFAULT_SETTINGS.connection.mode;
    }
    if (!Object.hasOwn(settings.connection, 'serverUrl')) {
        settings.connection.serverUrl = settings.serverUrl ?? DEFAULT_SETTINGS.connection.serverUrl;
    }
    if (!Object.hasOwn(settings.connection, 'token')) {
        settings.connection.token = settings.token ?? DEFAULT_SETTINGS.connection.token;
    }
    if (!Object.hasOwn(settings.connection, 'mcpConfigJson')) {
        settings.connection.mcpConfigJson = settings.mcpConfigJson ?? DEFAULT_SETTINGS.connection.mcpConfigJson;
    }
    if (!Object.hasOwn(settings.connection, 'selectedServerName')) {
        settings.connection.selectedServerName = settings.selectedServerName ?? DEFAULT_SETTINGS.connection.selectedServerName;
    }

    if (!Object.hasOwn(settings.bridge, 'enabled')) {
        settings.bridge.enabled = settings.enabled ?? DEFAULT_SETTINGS.bridge.enabled;
    }
    if (!Object.hasOwn(settings.bridge, 'recallLimit')) {
        settings.bridge.recallLimit = settings.recallLimit ?? DEFAULT_SETTINGS.bridge.recallLimit;
    }
    if (!Object.hasOwn(settings.bridge, 'domain')) {
        settings.bridge.domain = settings.domain ?? DEFAULT_SETTINGS.bridge.domain;
    }
    if (!Object.hasOwn(settings.bridge, 'injectTag')) {
        settings.bridge.injectTag = settings.injectTag ?? DEFAULT_SETTINGS.bridge.injectTag;
    }
    if (!Object.hasOwn(settings.bridge, 'bootEnabled')) {
        settings.bridge.bootEnabled = settings.bootEnabled ?? DEFAULT_SETTINGS.bridge.bootEnabled;
    }
    if (!Object.hasOwn(settings.bridge, 'bootUri')) {
        settings.bridge.bootUri = settings.bootUri ?? DEFAULT_SETTINGS.bridge.bootUri;
    }
    if (!Object.hasOwn(settings.bridge, 'testSnippet')) {
        settings.bridge.testSnippet = DEFAULT_SETTINGS.bridge.testSnippet;
    }

    if (!Object.hasOwn(settings.import, 'parentUri')) {
        settings.import.parentUri = DEFAULT_SETTINGS.import.parentUri;
    }
    if (!Object.hasOwn(settings.import, 'titlePrefix')) {
        settings.import.titlePrefix = DEFAULT_SETTINGS.import.titlePrefix;
    }
    if (!Object.hasOwn(settings.import, 'disclosure')) {
        settings.import.disclosure = DEFAULT_SETTINGS.import.disclosure;
    }
    if (!Object.hasOwn(settings.import, 'limit')) {
        settings.import.limit = DEFAULT_SETTINGS.import.limit;
    }

    if (!Object.hasOwn(settings.llm, 'selectedPresetId')) {
        settings.llm.selectedPresetId = 'default';
    }
    if (!Array.isArray(settings.llm.presets) || !settings.llm.presets.length) {
        settings.llm.presets = [createDefaultLlmPreset('默认预设')];
        settings.llm.presets[0].id = 'default';
    }
    settings.llm.presets = settings.llm.presets.map((preset, index) => ({
        ...createDefaultLlmPreset(preset?.name || `预设 ${index + 1}`),
        ...preset,
        id: preset?.id || `llm-preset-${index + 1}`,
        prompts: Array.isArray(preset?.prompts) ? preset.prompts : JSON.parse(JSON.stringify(DEFAULT_SETTINGS.llm.presets[0].prompts)),
    }));
    if (!settings.llm.presets.some(preset => preset.id === settings.llm.selectedPresetId)) {
        settings.llm.selectedPresetId = settings.llm.presets[0].id;
    }

    if (!Object.hasOwn(settings.toolExposure, 'enabled')) {
        settings.toolExposure.enabled = settings.workMode === 'tool-exposed';
    }
    if (!Object.hasOwn(settings.toolExposure, 'selectedTools') || typeof settings.toolExposure.selectedTools !== 'object') {
        settings.toolExposure.selectedTools = {};
    }
    if (!Object.hasOwn(settings.toolExposure, 'stealth')) {
        settings.toolExposure.stealth = true;
    }

    if (!Object.hasOwn(settings, 'debug')) {
        settings.debug = false;
    }

    delete settings.connectionMode;
    delete settings.serverUrl;
    delete settings.token;
    delete settings.mcpConfigJson;
    delete settings.selectedServerName;
    delete settings.enabled;
    delete settings.recallLimit;
    delete settings.domain;
    delete settings.injectTag;
    delete settings.bootEnabled;
    delete settings.bootUri;

    return settings;
}

function applyDefaultSettings(target, defaults) {
    for (const [key, value] of Object.entries(defaults)) {
        if (!Object.hasOwn(target, key) || target[key] == null) {
            target[key] = Array.isArray(value)
                ? [...value]
                : (value && typeof value === 'object')
                    ? JSON.parse(JSON.stringify(value))
                    : value;
            continue;
        }

        if (value && typeof value === 'object' && !Array.isArray(value)) {
            applyDefaultSettings(target[key], value);
        }
    }
}

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[EXT_NAME]) {
        extensionSettings[EXT_NAME] = getDefaultSettings();
    }
    extensionSettings[EXT_NAME] = migrateLegacySettings(extensionSettings[EXT_NAME]);
    applyDefaultSettings(extensionSettings[EXT_NAME], DEFAULT_SETTINGS);
    return extensionSettings[EXT_NAME];
}

function resetMcpClient() {
    mcpClient = null;
}

function resetBridgeRuntimeState() {
    lastSendIntentAt = 0;
    isProcessing = false;
    lastInjectedContent = '';
    updateLastInjectPreview('');
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

function setLastBootStatus(message) {
    lastBootStatusMessage = message || '';
    updateBootStatusUI(lastBootStatusMessage);
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

function isBridgeMode(settings = getSettings()) {
    return settings.workMode !== 'tool-exposed';
}

function isToolExposureEnabled(settings = getSettings()) {
    return settings.workMode === 'tool-exposed' && settings.toolExposure?.enabled !== false;
}

function getConnectionSettings(settings = getSettings()) {
    return settings.connection ?? DEFAULT_SETTINGS.connection;
}

function getBridgeSettings(settings = getSettings()) {
    return settings.bridge ?? DEFAULT_SETTINGS.bridge;
}

function getToolExposureSettings(settings = getSettings()) {
    return settings.toolExposure ?? DEFAULT_SETTINGS.toolExposure;
}

function getImportSettings(settings = getSettings()) {
    return settings.import ?? DEFAULT_SETTINGS.import;
}

function getLlmState(settings = getSettings()) {
    return settings.llm ?? DEFAULT_SETTINGS.llm;
}

function getLlmPresets(settings = getSettings()) {
    return getLlmState(settings).presets || [];
}

function getCurrentLlmPreset(settings = getSettings()) {
    const llm = getLlmState(settings);
    const presets = getLlmPresets(settings);
    return presets.find(preset => preset.id === llm.selectedPresetId) || presets[0] || DEFAULT_SETTINGS.llm.presets[0];
}

function getPromptById(promptId, settings = getSettings()) {
    return (getCurrentLlmPreset(settings).prompts || []).find(prompt => prompt?.id === promptId) || null;
}

function isToolSelected(toolName, settings = getSettings()) {
    const selected = getToolExposureSettings(settings).selectedTools;
    if (!selected || typeof selected !== 'object') return true;
    return selected[toolName] === true;
}

function setAvailableToolsToUI(tools) {
    const container = document.getElementById('mb-tool-list');
    if (!container) return;

    if (!Array.isArray(tools) || !tools.length) {
        container.innerHTML = '<div class="mb-hint">暂无工具。先连接 MCP 后点击刷新工具列表。</div>';
        return;
    }

    const settings = getSettings();
    const selected = getToolExposureSettings(settings).selectedTools || {};
    container.innerHTML = tools.map((tool) => {
        const toolName = String(tool.name || '');
        const checked = selected[toolName] === true ? 'checked' : '';
        const escapedName = toolName.replace(/"/g, '&quot;');
        const description = String(tool.description || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `
            <label class="mb-tool-item">
              <input type="checkbox" class="mb-tool-checkbox" data-tool-name="${escapedName}" ${checked} />
              <span><b>${toolName}</b><br><small>${description || '无描述'}</small></span>
            </label>
        `;
    }).join('');
}

function getSelectedServerName(config, settings = getSettings()) {
    const connection = getConnectionSettings(settings);
    const explicitName = connection.selectedServerName?.trim();
    if (explicitName) return explicitName;
    if (config.serverName) return config.serverName;
    if (config.source === 'json') return config.label.replace(/\s+\(via mcp-router\)$/, '');
    return 'memory-bridge-default';
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
    const connection = getConnectionSettings(settings);
    const url = connection.serverUrl?.trim();
    if (!url) throw new Error('请填写 MCP 服务地址');
    const headers = {};
    if (connection.token) headers.Authorization = `Bearer ${connection.token}`;
    return {
        source: 'http',
        transport: 'streamable-http',
        url,
        headers,
        label: url,
        serverName: 'memory-bridge-default',
        usePluginRegistry: true,
    };
}

function normalizeJsonHttpServer(serverName, serverConfig) {
    const url = serverConfig.url?.trim();
    if (!url) throw new Error(`MCP server ${serverName} 缺少 url`);
    const headers = serverConfig.headers && typeof serverConfig.headers === 'object'
        ? Object.fromEntries(Object.entries(serverConfig.headers).filter(([, value]) => value != null))
        : {};
    // 插件后端注册名加 -http 后缀，避免与同名 stdio server 冲突
    const pluginServerName = `${serverName}-http`;
    return {
        source: 'json',
        transport: 'streamable-http',
        url,
        headers,
        label: serverName,
        serverName: pluginServerName,
        usePluginRegistry: true,
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
    const connection = getConnectionSettings(settings);
    const raw = connection.mcpConfigJson?.trim();
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

    const selectedServerName = connection.selectedServerName?.trim();
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
    return getConnectionSettings(settings).mode === 'json'
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

function shouldExposeTools(settings = getSettings()) {
    return isToolExposureEnabled(settings);
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
                const exposeTools = shouldExposeTools();
                return {
                    ok: true,
                    headers: new Headers({ 'content-type': 'application/json' }),
                    json: async () => ({
                        jsonrpc: '2.0',
                        result: {
                            protocolVersion: '2025-03-26',
                            capabilities: exposeTools ? { tools: {} } : {},
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
                if (!shouldExposeTools()) {
                    throw new Error('当前模式未启用工具暴露');
                }
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
                if (!shouldExposeTools()) {
                    throw new Error('当前模式未启用工具暴露');
                }
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
    if (config.transport === 'streamable-http') {
        if (config.usePluginRegistry === false) {
            return createStreamableHttpClient(config);
        }
        return createPluginBackedClient(config);
    }
    if (config.transport === 'command') {
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

function unregisterAllFunctionTools() {
    const context = SillyTavern.getContext();
    if (typeof context.unregisterFunctionTool !== 'function') return;
    for (const toolName of registeredFunctionTools) {
        try {
            context.unregisterFunctionTool(toolName);
        } catch (error) {
            logError('注销函数工具失败:', toolName, error);
        }
    }
    registeredFunctionTools = [];
}

function toFunctionToolName(serverName, toolName) {
    return `mb__${serverName}__${toolName}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

function getOriginalToolName(functionToolName) {
    const parts = String(functionToolName).split('__');
    return parts.slice(2).join('__') || functionToolName;
}

async function registerMcpToolsToSillyTavern() {
    const context = SillyTavern.getContext();
    unregisterAllFunctionTools();

    if (typeof context.registerFunctionTool !== 'function') {
        log('当前 ST 环境不支持 registerFunctionTool');
        return;
    }

    if (typeof context.isToolCallingSupported === 'function' && !context.isToolCallingSupported()) {
        log('当前预设或模型未启用工具调用');
        return;
    }

    if (!shouldExposeTools()) {
        log('当前模式未启用工具暴露');
        return;
    }

    if (!await ensureConnected()) {
        throw new Error(lastErrorMessage || '无法连接到 MCP 服务');
    }

    const config = resolveConnectionConfig();
    const serverName = getSelectedServerName(config);
    const response = await mcpRpc('tools/list', {});
    const data = await parseMcpResponse(response);
    if (data?.error) {
        throw new Error(`MCP 列工具失败: ${data.error.message}`);
    }

    const allTools = Array.isArray(data?.result?.tools) ? data.result.tools : [];
    setAvailableToolsToUI(allTools);

    const settings = getSettings();
    const tools = allTools.filter((tool) => tool?.name && isToolSelected(tool.name, settings));
    for (const tool of tools) {
        if (!tool?.name || !tool?.description) continue;
        const functionToolName = toFunctionToolName(serverName, tool.name);
        context.registerFunctionTool({
            name: functionToolName,
            displayName: tool.title || tool.name,
            description: tool.description,
            parameters: tool.inputSchema || { type: 'object', properties: {} },
            action: async (args) => {
                const originalToolName = getOriginalToolName(functionToolName);
                return await mcpCallTool(originalToolName, args ?? {});
            },
            formatMessage: () => '',
            shouldRegister: () => shouldExposeTools() && isToolSelected(tool.name),
            stealth: getToolExposureSettings(settings).stealth !== false,
        });
        registeredFunctionTools.push(functionToolName);
    }

    log('已注册函数工具数量:', registeredFunctionTools.length);
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
    const bridge = getBridgeSettings(settings);
    try {
        if (!await ensureConnected()) {
            logError('无法连接到 MCP 服务，跳过记忆召回');
            return '';
        }
        const args = { query: query.slice(0, 500), limit: bridge.recallLimit };
        if (bridge.domain) args.domain = bridge.domain;
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

async function createMemory(args) {
    try {
        if (!await ensureConnected()) {
            throw new Error(lastErrorMessage || '无法连接到 MCP 服务');
        }
        log('创建记忆:', args?.title || '(untitled)');
        return await mcpCallTool('create_memory', args);
    } catch (err) {
        logError('创建记忆失败:', err);
        resetMcpClient();
        setConnectionState('disconnected');
        throw err;
    }
}

function getChatMessagesForImport() {
    const context = SillyTavern.getContext();
    const chat = Array.isArray(context.chat) ? context.chat : [];
    return chat
        .map((message, index) => ({
            index,
            isUser: !!message?.is_user,
            name: String(message?.name || (message?.is_user ? 'User' : 'Assistant') || ''),
            text: String(message?.mes || ''),
        }))
        .filter(message => message.text.trim());
}

function getImportTitle(index, settings = getSettings()) {
    const prefix = getImportSettings(settings).titlePrefix?.trim() || 'chat';
    return `${prefix}-${String(index + 1).padStart(3, '0')}`;
}

function buildImportContent(message) {
    const role = message.isUser ? 'user' : 'assistant';
    return `[${role}] ${message.name}\n${message.text.trim()}`;
}

function fillPromptTemplate(template, variables = {}) {
    let output = String(template || '');
    for (const [key, value] of Object.entries(variables)) {
        const pattern = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
        output = output.replace(pattern, String(value ?? ''));
    }
    return output;
}

function buildPromptMessages(promptId, variables = {}, settings = getSettings()) {
    const mainPrompt = getPromptById('mainPrompt', settings);
    const taskPrompt = getPromptById(promptId, settings);
    const messages = [];
    if (mainPrompt?.content?.trim()) {
        messages.push({ role: String(mainPrompt.role || 'system').toLowerCase(), content: mainPrompt.content });
    }
    if (taskPrompt?.content?.trim()) {
        messages.push({ role: String(taskPrompt.role || 'user').toLowerCase(), content: fillPromptTemplate(taskPrompt.content, variables) });
    }
    return messages.filter(message => message.content?.trim());
}

async function callLlm(messages, options = {}) {
    if (!Array.isArray(messages) || !messages.length) {
        throw new Error('LLM messages 不能为空');
    }

    const settings = getSettings();
    const llm = getCurrentLlmPreset(settings);
    const context = SillyTavern.getContext();
    const maxTokens = options.maxTokens || llm.maxTokens || 2000;

    if (llm.source === 'tavern') {
        if (typeof context.generateRaw === 'function') {
            return await context.generateRaw({
                ordered_prompts: messages,
                max_chat_history: 0,
                should_stream: false,
                should_silence: true,
            });
        }
        throw new Error('当前 ST 环境不支持 generateRaw');
    }

    if (!llm.apiUrl?.trim() || !llm.model?.trim()) {
        throw new Error('自定义 LLM API 未配置完整');
    }

    const body = {
        messages,
        model: llm.model.trim(),
        temperature: Number(llm.temperature) || 0.7,
        max_tokens: maxTokens,
        stream: false,
        chat_completion_source: 'custom',
        group_names: [],
        include_reasoning: false,
        reasoning_effort: 'medium',
        enable_web_search: false,
        request_images: false,
        custom_prompt_post_processing: 'strict',
        reverse_proxy: llm.apiUrl.trim(),
        proxy_password: '',
        custom_url: llm.apiUrl.trim(),
        custom_include_headers: llm.apiKey?.trim() ? `Authorization: Bearer ${llm.apiKey.trim()}` : '',
    };

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: {
            ...getRequestHeaders(),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        throw new Error(`LLM 请求失败: HTTP ${response.status}`);
    }

    const data = await response.json();
    return data?.choices?.[0]?.message?.content || data?.content || '';
}

async function maybeProcessImportContent(message, settings = getSettings()) {
    const llm = getCurrentLlmPreset(settings);
    const rawContent = buildImportContent(message);
    if (!llm.enabled) return rawContent;

    const messages = buildPromptMessages('importPrompt', { input: rawContent }, settings);
    const result = await callLlm(messages, { maxTokens: llm.maxTokens });
    return String(result || '').trim() || rawContent;
}

function renderImportList() {
    const container = document.getElementById('mb-import-list');
    const summary = document.getElementById('mb-import-summary');
    if (!container || !summary) return;

    const settings = getSettings();
    const limit = Math.max(1, parseInt(getImportSettings(settings).limit, 10) || 20);
    const messages = getChatMessagesForImport();
    const visibleMessages = messages.slice(Math.max(0, messages.length - limit));
    const visibleIndexes = new Set(visibleMessages.map(message => message.index));

    importSelection = new Set(Array.from(importSelection).filter(index => visibleIndexes.has(index)));

    if (!visibleMessages.length) {
        container.innerHTML = '<div class="mb-hint">当前聊天没有可导入的正文楼层。</div>';
        summary.textContent = '0 条可导入';
        return;
    }

    summary.textContent = `显示最近 ${visibleMessages.length} 条可导入楼层，已选 ${importSelection.size} 条`;
    container.innerHTML = visibleMessages.map((message) => {
        const checked = importSelection.has(message.index) ? 'checked' : '';
        const role = message.isUser ? '用户' : '助手';
        const title = getImportTitle(message.index, settings);
        const preview = message.text.replace(/\s+/g, ' ').slice(0, 120);
        const escapedName = message.name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const escapedPreview = preview.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `
            <label class="mb-import-item">
              <input type="checkbox" class="mb-import-checkbox" data-import-index="${message.index}" ${checked} />
              <span>
                <b>#${message.index + 1} · ${role} · ${title}</b><br>
                <small>${escapedName}</small><br>
                <small>${escapedPreview || '（空文本）'}</small>
              </span>
            </label>
        `;
    }).join('');
}

function collectSelectedImportMessages() {
    const messages = getChatMessagesForImport();
    const messageMap = new Map(messages.map(message => [message.index, message]));
    return Array.from(importSelection)
        .sort((left, right) => left - right)
        .map(index => messageMap.get(index))
        .filter(Boolean);
}

async function runSelectedImport() {
    saveSettingsFromUI();
    const settings = getSettings();
    const importSettings = getImportSettings(settings);
    const selectedMessages = collectSelectedImportMessages();
    if (!selectedMessages.length) {
        return { ok: false, message: '请先勾选要导入的楼层' };
    }

    const parentUri = importSettings.parentUri?.trim();
    if (!parentUri) {
        return { ok: false, message: '请先填写父 URI' };
    }

    let successCount = 0;
    const failures = [];
    for (const message of selectedMessages) {
        const processedContent = await maybeProcessImportContent(message, settings);
        const args = {
            parent_uri: parentUri,
            title: getImportTitle(message.index, settings),
            content: processedContent,
            priority: message.isUser ? 2 : 3,
            disclosure: importSettings.disclosure?.trim() || '当需要回想这段聊天内容时',
        };
        try {
            await createMemory(args);
            successCount += 1;
        } catch (error) {
            failures.push(`#${message.index + 1}: ${getErrorMessage(error)}`);
        }
    }

    if (!failures.length) {
        return { ok: true, message: `成功导入 ${successCount} 条楼层` };
    }

    return {
        ok: successCount > 0,
        message: `成功 ${successCount} 条，失败 ${failures.length} 条\n${failures.join('\n')}`,
    };
}

// ─── 内容注入 ─────────────────────────────────────────────────────────────────
function buildInjectedMessage(userInput, memoryContent) {
    if (!memoryContent?.trim()) return userInput;
    const tag = getBridgeSettings().injectTag?.trim();
    const block = tag
        ? `\n\n${tag}\n${memoryContent.trim()}\n${tag}`
        : `\n\n${memoryContent.trim()}`;
    return userInput + block;
}

function hasInjectedMemoryBlock(text, settings = getSettings()) {
    const content = String(text || '');
    if (!content.trim()) return false;
    const tag = getBridgeSettings(settings).injectTag?.trim();
    if (tag) {
        return content.includes(`\n\n${tag}\n`) && content.includes(`\n${tag}`);
    }
    const memory = lastInjectedContent?.trim();
    return !!memory && content.includes(memory);
}

function shouldRunBridgeRecall(type, params, dryRun, settings = getSettings()) {
    const bridge = getBridgeSettings(settings);
    if (!isBridgeMode(settings)) return false;
    if (!bridge.enabled) return false;
    if (dryRun) return false;
    if (isProcessing) return false;
    if (type === 'quiet') return false;
    if (params?.quiet_prompt) return false;
    if (params?.automatic_trigger) return false;
    return true;
}

function applyInjectedPreview(memory) {
    lastInjectedContent = memory || '';
    updateLastInjectPreview(lastInjectedContent);
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
    const settings = getSettings();
    if (!shouldRunBridgeRecall(type, params, dryRun, settings)) return;

    const { chat } = SillyTavern.getContext();
    if (!chat?.length) return;

    const lastMsg = chat[chat.length - 1];
    if (lastMsg?.is_user && !lastMsg.__mb_processed) {
        const userText = String(lastMsg.mes || '');
        if (!userText.trim()) return;
        if (hasInjectedMemoryBlock(userText, settings)) {
            lastMsg.__mb_processed = true;
            return;
        }
        lastMsg.__mb_processed = true;
        isProcessing = true;
        try {
            const memory = await recallMemory(userText);
            if (!memory) return;
            const injected = buildInjectedMessage(userText, memory);
            lastMsg.mes = injected;
            params.prompt = injected;
            applyInjectedPreview(memory);
            log('策略1注入成功, 记忆长度:', memory.length);
        } catch (err) {
            logError('策略1处理失败:', err);
        } finally {
            isProcessing = false;
        }
        return;
    }

    if (!isRecentSendIntent()) return;
    const textarea = (window.parent || window).document.getElementById('send_textarea');
    const textInBox = String(textarea?.value || '');
    if (!textInBox.trim()) return;
    if (hasInjectedMemoryBlock(textInBox, settings)) {
        lastSendIntentAt = 0;
        return;
    }

    isProcessing = true;
    try {
        const memory = await recallMemory(textInBox);
        if (!memory) return;
        const injected = buildInjectedMessage(textInBox, memory);
        textarea.value = injected;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        try { params.prompt = injected; } catch (_) { /* ignore */ }
        applyInjectedPreview(memory);
        log('策略2注入成功, 记忆长度:', memory.length);
    } catch (err) {
        logError('策略2处理失败:', err);
    } finally {
        isProcessing = false;
        lastSendIntentAt = 0;
    }
}

// ─── Boot Memory ──────────────────────────────────────────────────────────────

async function loadBootMemory() {
    const bridge = getBridgeSettings();
    if (!isBridgeMode() || !bridge.bootEnabled || !bridge.bootUri) {
        setLastBootStatus('（当前未启用 Boot Memory）');
        return;
    }
    log('加载 Boot Memory:', bridge.bootUri);
    const content = await readMemory(bridge.bootUri);
    if (!content) {
        setLastBootStatus(`Boot 读取失败或无内容：${bridge.bootUri}`);
        return;
    }
    try {
        const { setExtensionPrompt, extension_prompt_types } = SillyTavern.getContext();
        setExtensionPrompt(EXT_NAME + '_boot', content, extension_prompt_types.IN_PROMPT, 0);
        setLastBootStatus(`Boot 已加载：${bridge.bootUri}（${content.length} 字符）`);
        log('Boot Memory 已注入, 长度:', content.length);
    } catch (err) {
        const message = `Boot 注入失败：${getErrorMessage(err)}`;
        setLastBootStatus(message);
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

function updateBootStatusUI(content) {
    const el = document.getElementById('mb-boot-status');
    if (!el) return;
    if (content) {
        el.textContent = content;
        el.classList.remove('empty');
    } else {
        el.textContent = '（尚未加载）';
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

function renderLlmPresetOptions() {
    const select = document.getElementById('mb-llm-preset');
    if (!select) return;
    const settings = getSettings();
    const llm = getLlmState(settings);
    const presets = getLlmPresets(settings);
    select.innerHTML = presets.map((preset) => {
        const selected = preset.id === llm.selectedPresetId ? 'selected' : '';
        return `<option value="${preset.id}" ${selected}>${String(preset.name || preset.id).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</option>`;
    }).join('');
}

function syncCurrentLlmPresetFromUI(settings = getSettings()) {
    const preset = getCurrentLlmPreset(settings);
    if (!preset) return;
    const get = (id) => document.getElementById(id);
    preset.enabled = get('mb-llm-enabled')?.checked ?? false;
    preset.source = get('mb-llm-source')?.value ?? 'tavern';
    preset.tavernProfile = get('mb-llm-tavern-profile')?.value?.trim() ?? '';
    preset.apiUrl = get('mb-llm-api-url')?.value?.trim() ?? '';
    preset.apiKey = get('mb-llm-api-key')?.value ?? '';
    preset.model = get('mb-llm-model')?.value?.trim() ?? '';
    preset.temperature = parseFloat(get('mb-llm-temperature')?.value) || 0.7;
    preset.maxTokens = parseInt(get('mb-llm-max-tokens')?.value) || 2000;
    preset.useMainApi = get('mb-llm-use-main-api')?.checked ?? true;
    preset.prompts = [
        {
            id: 'mainPrompt',
            name: '主系统提示词',
            role: 'system',
            content: get('mb-llm-main-prompt')?.value ?? '',
        },
        {
            id: 'importPrompt',
            name: '历史导入处理指令',
            role: 'user',
            content: get('mb-llm-import-prompt')?.value ?? '',
        },
        {
            id: 'recallPrompt',
            name: '召回查询处理指令',
            role: 'user',
            content: get('mb-llm-recall-prompt')?.value ?? '',
        },
    ];
}

function updateWorkModeUI() {
    const workMode = document.getElementById('mb-work-mode')?.value ?? 'bridge';
    const bridgeSections = document.querySelectorAll('[data-mb-mode="bridge"]');
    const toolSections = document.querySelectorAll('[data-mb-mode="tool-exposed"]');
    bridgeSections.forEach(section => section.classList.toggle('mb-hidden', workMode !== 'bridge'));
    toolSections.forEach(section => section.classList.toggle('mb-hidden', workMode !== 'tool-exposed'));
}

function updateLlmSourceUI() {
    const source = document.getElementById('mb-llm-source')?.value ?? 'tavern';
    document.querySelectorAll('[data-mb-llm-source="tavern"]').forEach(section => {
        section.classList.toggle('mb-hidden', source !== 'tavern');
    });
    document.querySelectorAll('[data-mb-llm-source="custom"]').forEach(section => {
        section.classList.toggle('mb-hidden', source !== 'custom');
    });
}

function loadSettingsToUI() {
    const s = getSettings();
    const connection = getConnectionSettings(s);
    const bridge = getBridgeSettings(s);
    const toolExposure = getToolExposureSettings(s);
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.type === 'checkbox' ? (el.checked = !!val) : (el.value = val ?? '');
    };
    set('mb-work-mode', s.workMode);
    set('mb-enabled', bridge.enabled);
    set('mb-tool-exposure-enabled', toolExposure.enabled);
    set('mb-tool-stealth', toolExposure.stealth !== false);
    set('mb-connection-mode', connection.mode);
    set('mb-server-url', connection.serverUrl);
    set('mb-token', connection.token);
    set('mb-mcp-config-json', connection.mcpConfigJson);
    set('mb-selected-server-name', connection.selectedServerName);
    set('mb-recall-limit', bridge.recallLimit);
    set('mb-domain', bridge.domain);
    set('mb-inject-tag', bridge.injectTag);
    set('mb-boot-enabled', bridge.bootEnabled);
    set('mb-boot-uri', bridge.bootUri);
    set('mb-test-snippet', bridge.testSnippet);
    const importSettings = getImportSettings(s);
    set('mb-import-parent-uri', importSettings.parentUri);
    set('mb-import-title-prefix', importSettings.titlePrefix);
    set('mb-import-disclosure', importSettings.disclosure);
    set('mb-import-limit', importSettings.limit);
    renderLlmPresetOptions();
    const llm = getCurrentLlmPreset(s);
    set('mb-llm-enabled', llm.enabled);
    set('mb-llm-source', llm.source);
    set('mb-llm-tavern-profile', llm.tavernProfile);
    set('mb-llm-api-url', llm.apiUrl);
    set('mb-llm-api-key', llm.apiKey);
    set('mb-llm-model', llm.model);
    set('mb-llm-temperature', llm.temperature);
    set('mb-llm-max-tokens', llm.maxTokens);
    set('mb-llm-use-main-api', llm.useMainApi);
    set('mb-llm-main-prompt', getPromptById('mainPrompt', s)?.content || '');
    set('mb-llm-import-prompt', getPromptById('importPrompt', s)?.content || '');
    set('mb-llm-recall-prompt', getPromptById('recallPrompt', s)?.content || '');
    set('mb-debug', s.debug);
    updateConnectionModeUI();
    updateWorkModeUI();
    updateLlmSourceUI();
    updateStatusUI(connectionState);
    updateLastInjectPreview(lastInjectedContent);
    updateBootStatusUI(lastBootStatusMessage);
    renderImportList();
}

function persistSettings(settings) {
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
    extensionSettings[EXT_NAME] = settings;
    saveSettingsDebounced();
}

function saveSettingsFromUI() {
    const s = getSettings();
    const get = (id) => document.getElementById(id);
    s.workMode = get('mb-work-mode')?.value ?? 'bridge';
    s.connection.mode = get('mb-connection-mode')?.value ?? 'http';
    s.connection.serverUrl = get('mb-server-url')?.value?.trim() ?? '';
    s.connection.token = get('mb-token')?.value ?? '';
    s.connection.mcpConfigJson = get('mb-mcp-config-json')?.value ?? DEFAULT_MCP_CONFIG_JSON;
    s.connection.selectedServerName = get('mb-selected-server-name')?.value?.trim() ?? '';
    s.bridge.enabled = get('mb-enabled')?.checked ?? false;
    s.bridge.recallLimit = parseInt(get('mb-recall-limit')?.value) || 5;
    s.bridge.domain = get('mb-domain')?.value?.trim() ?? '';
    s.bridge.injectTag = get('mb-inject-tag')?.value ?? '[记忆参考]';
    s.bridge.bootEnabled = get('mb-boot-enabled')?.checked ?? false;
    s.bridge.bootUri = get('mb-boot-uri')?.value?.trim() ?? 'system://boot';
    s.bridge.testSnippet = get('mb-test-snippet')?.value ?? '';
    s.import.parentUri = get('mb-import-parent-uri')?.value?.trim() ?? 'core://';
    s.import.titlePrefix = get('mb-import-title-prefix')?.value?.trim() ?? 'chat';
    s.import.disclosure = get('mb-import-disclosure')?.value?.trim() ?? '当需要回想这段聊天内容时';
    s.import.limit = parseInt(get('mb-import-limit')?.value) || 20;
    s.llm.selectedPresetId = get('mb-llm-preset')?.value ?? s.llm.selectedPresetId ?? 'default';
    syncCurrentLlmPresetFromUI(s);
    s.toolExposure.enabled = get('mb-tool-exposure-enabled')?.checked ?? false;
    s.toolExposure.stealth = get('mb-tool-stealth')?.checked ?? true;
    s.toolExposure.selectedTools = Object.fromEntries(
        Array.from(document.querySelectorAll('.mb-tool-checkbox')).map((el) => [el.dataset.toolName, el.checked]),
    );
    s.debug = get('mb-debug')?.checked ?? false;
    persistSettings(s);
}

async function runRecallPreview(query) {
    const text = String(query || '').trim();
    if (!text) {
        updateLastInjectPreview('');
        return { ok: false, result: '', message: '请输入要测试的文本片段' };
    }
    const result = await recallMemory(text);
    updateLastInjectPreview(result || '');
    if (!result) {
        return { ok: true, result: '', message: '未找到相关记忆' };
    }
    return { ok: true, result, message: `召回 ${result.length} 字符` };
}

function previewInjectedSnippet(snippet) {
    const text = String(snippet || '').trim();
    if (!text) {
        updateLastInjectPreview('');
        return { ok: false, message: '请输入要预演的文本片段' };
    }
    if (!lastInjectedContent?.trim()) {
        return { ok: false, message: '请先完成一次召回，再预演注入' };
    }
    const preview = buildInjectedMessage(text, lastInjectedContent);
    updateLastInjectPreview(preview);
    return { ok: true, message: `已生成注入预演（${preview.length} 字符）` };
}

function bindSettingsEvents() {
    document.querySelectorAll('#memory-bridge-settings input, #memory-bridge-settings select, #memory-bridge-settings textarea')
        .forEach(el => el.addEventListener('change', saveSettingsFromUI));

    document.getElementById('mb-work-mode')?.addEventListener('change', () => {
        saveSettingsFromUI();
        updateWorkModeUI();
        unregisterAllFunctionTools();
        resetMcpClient();
        setConnectionState('disconnected');
    });

    document.getElementById('mb-connection-mode')?.addEventListener('change', () => {
        saveSettingsFromUI();
        updateConnectionModeUI();
        unregisterAllFunctionTools();
        resetMcpClient();
        setConnectionState('disconnected');
    });

    document.getElementById('mb-llm-source')?.addEventListener('change', () => {
        saveSettingsFromUI();
        updateLlmSourceUI();
    });

    document.getElementById('mb-llm-preset')?.addEventListener('change', () => {
        saveSettingsFromUI();
        loadSettingsToUI();
    });

    document.getElementById('mb-btn-add-llm-preset')?.addEventListener('click', () => {
        const settings = getSettings();
        syncCurrentLlmPresetFromUI(settings);
        const presets = getLlmPresets(settings);
        const preset = createDefaultLlmPreset(`预设 ${presets.length + 1}`);
        presets.push(preset);
        settings.llm.selectedPresetId = preset.id;
        persistSettings(settings);
        loadSettingsToUI();
        toastr.success('已新建 LLM 预设', 'Memory Bridge');
    });

    document.getElementById('mb-btn-copy-llm-preset')?.addEventListener('click', () => {
        const settings = getSettings();
        syncCurrentLlmPresetFromUI(settings);
        const current = getCurrentLlmPreset(settings);
        const copy = {
            ...JSON.parse(JSON.stringify(current)),
            id: `llm-preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: `${current.name || '预设'} (副本)`,
        };
        settings.llm.presets.push(copy);
        settings.llm.selectedPresetId = copy.id;
        persistSettings(settings);
        loadSettingsToUI();
        toastr.success('已复制 LLM 预设', 'Memory Bridge');
    });

    document.getElementById('mb-btn-delete-llm-preset')?.addEventListener('click', () => {
        const settings = getSettings();
        syncCurrentLlmPresetFromUI(settings);
        const presets = getLlmPresets(settings);
        if (presets.length <= 1) {
            toastr.warning('至少保留一个 LLM 预设', 'Memory Bridge');
            return;
        }
        settings.llm.presets = presets.filter(preset => preset.id !== settings.llm.selectedPresetId);
        settings.llm.selectedPresetId = settings.llm.presets[0]?.id || 'default';
        persistSettings(settings);
        loadSettingsToUI();
        toastr.success('已删除当前 LLM 预设', 'Memory Bridge');
    });

    document.getElementById('mb-btn-connect')?.addEventListener('click', async () => {
        saveSettingsFromUI();
        resetMcpClient();
        const ok = await connect();
        if (ok) {
            try {
                await registerMcpToolsToSillyTavern();
            } catch (error) {
                logError('注册函数工具失败:', error);
            }
        }
        toastr[ok ? 'success' : 'error'](
            ok ? 'MCP 服务连接成功' : (lastErrorMessage || '连接失败，请检查当前连接配置'),
            'Memory Bridge',
        );
    });

    document.getElementById('mb-btn-refresh-tools')?.addEventListener('click', async () => {
        saveSettingsFromUI();
        try {
            await registerMcpToolsToSillyTavern();
            toastr.success(`已刷新工具列表，当前注册 ${registeredFunctionTools.length} 个工具`, 'Memory Bridge');
        } catch (error) {
            logError('刷新工具列表失败:', error);
            toastr.error(getErrorMessage(error), 'Memory Bridge');
        }
    });

    document.getElementById('mb-btn-select-all-tools')?.addEventListener('click', () => {
        document.querySelectorAll('.mb-tool-checkbox').forEach((el) => {
            el.checked = true;
        });
        saveSettingsFromUI();
    });

    document.getElementById('mb-btn-clear-all-tools')?.addEventListener('click', () => {
        document.querySelectorAll('.mb-tool-checkbox').forEach((el) => {
            el.checked = false;
        });
        saveSettingsFromUI();
    });

    document.getElementById('mb-btn-test-recall')?.addEventListener('click', async () => {
        const textarea = (window.parent || window).document.getElementById('send_textarea');
        const query = textarea?.value?.trim() || '测试';
        toastr.info('正在召回...', 'Memory Bridge');
        const { ok, result, message } = await runRecallPreview(query);
        toastr[ok ? (result ? 'success' : 'warning') : 'warning'](message, 'Memory Bridge');
    });

    document.getElementById('mb-btn-test-snippet')?.addEventListener('click', async () => {
        saveSettingsFromUI();
        const query = document.getElementById('mb-test-snippet')?.value ?? '';
        toastr.info('正在测试文本片段召回...', 'Memory Bridge');
        const { ok, result, message } = await runRecallPreview(query);
        toastr[ok ? (result ? 'success' : 'warning') : 'warning'](message, 'Memory Bridge');
    });

    document.getElementById('mb-btn-preview-snippet')?.addEventListener('click', () => {
        saveSettingsFromUI();
        const query = document.getElementById('mb-test-snippet')?.value ?? '';
        const { ok, message } = previewInjectedSnippet(query);
        toastr[ok ? 'success' : 'warning'](message, 'Memory Bridge');
    });

    document.getElementById('mb-btn-clear-session')?.addEventListener('click', () => {
        resetMcpClient();
        resetBridgeRuntimeState();
        setLastBootStatus('（会话已清除，等待重新加载）');
        setConnectionState('disconnected');
        toastr.info('会话已清除', 'Memory Bridge');
    });

    document.getElementById('mb-btn-refresh-import-list')?.addEventListener('click', () => {
        saveSettingsFromUI();
        renderImportList();
        toastr.info('已刷新楼层列表', 'Memory Bridge');
    });

    document.getElementById('mb-btn-select-all-import')?.addEventListener('click', () => {
        document.querySelectorAll('.mb-import-checkbox').forEach((el) => {
            el.checked = true;
            importSelection.add(Number(el.dataset.importIndex));
        });
        renderImportList();
    });

    document.getElementById('mb-btn-clear-import')?.addEventListener('click', () => {
        importSelection.clear();
        renderImportList();
    });

    document.getElementById('mb-import-list')?.addEventListener('change', (event) => {
        const target = event.target;
        if (!target?.classList?.contains('mb-import-checkbox')) return;
        const index = Number(target.dataset.importIndex);
        if (!Number.isFinite(index)) return;
        if (target.checked) {
            importSelection.add(index);
        } else {
            importSelection.delete(index);
        }
        renderImportList();
    });

    document.getElementById('mb-btn-import-selected')?.addEventListener('click', async () => {
        toastr.info('正在导入选中楼层...', 'Memory Bridge');
        const { ok, message } = await runSelectedImport();
        toastr[ok ? 'success' : 'warning'](message, 'Memory Bridge');
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

    try {
        await registerMcpToolsToSillyTavern();
    } catch (error) {
        logError('初始化注册函数工具失败:', error);
    }

    // 安装发送意图捕获钩子
    installSendIntentHooks();

    // 注册生成拦截
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);

    // 切换聊天时加载 Boot Memory
    eventSource.on(event_types.CHAT_CHANGED, async () => {
        resetBridgeRuntimeState();
        importSelection.clear();
        renderImportList();
        setLastBootStatus('正在加载 Boot Memory...');
        await loadBootMemory();
    });

    log('Memory Bridge 已加载');
});
