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

const DEFAULT_LLM_PROMPT_TEMPLATES = [
    {
        id: 'import',
        label: '历史导入关键词生成指令',
        validator: 'keywords',
        maxTokens: 200,
        systemPrompt: [
            '你是 nocturne_memory 的关键词提取助手。',
            '你的职责是从聊天楼层中提取最有检索价值的专有名词和关键短语。',
            '只输出关键词，不改写正文，不编造，不解释。',
        ].join('\n'),
        userPromptTemplate: [
            '请从以下聊天楼层中提取 3-8 个最有检索价值的关键词。',
            '优先选取：人名、别名、地名、物品名、组织名、关系词、事件关键短语。',
            '输出格式：只输出一行，用空格分隔各关键词，不要标题，不要解释，不要标点。',
            '',
            '楼层内容：',
            '{{input}}',
        ].join('\n'),
    },
    {
        id: 'recall',
        label: '召回查询处理指令',
        validator: 'recall',
        maxTokens: 300,
        systemPrompt: [
            '你是 nocturne_memory 的召回查询整理助手。',
            '你的职责是把用户输入压缩为适合全文检索的检索查询。',
            '输出必须服务于关键词命中、人物地点事件关系检索，不要解释。',
        ].join('\n'),
        userPromptTemplate: [
            '请将以下用户输入整理为适合全文检索的召回查询。',
            '提炼核心人物、地点、事件、关系与关键短语。',
            '输出单段纯文本查询，不要解释。',
            '',
            '用户输入：',
            '{{input}}',
        ].join('\n'),
    },
    {
        id: 'disclosure',
        label: '导入 disclosure 生成指令',
        validator: 'disclosure',
        maxTokens: 200,
        systemPrompt: [
            '你是 nocturne_memory 的 disclosure 生成助手。',
            '你的职责是为一条记忆生成稳定、简洁、可检索的召回条件。',
            '输出必须是一句中文条件描述，服务于 trigger/disclosure 召回网络。',
        ].join('\n'),
        userPromptTemplate: [
            '你要为一条即将写入 nocturne_memory 的记忆生成 disclosure。',
            'disclosure 的作用，是描述“在什么情况下应该召回这条记忆”。',
            '要求：',
            '1. 只输出一句话，不要解释。',
            '2. 聚焦人物、地点、事件、关系、状态变化、世界线条件。',
            '3. 不要出现“这条记忆”或“应该召回”这类元话语。',
            '4. 长度尽量控制在 18 到 48 个字。',
            '',
            '聊天绑定：{{chatBinding}}',
            '角色信息：{{characterInfo}}',
            '最近上下文：',
            '{{recentContext}}',
            '',
            '世界书摘要：',
            '{{worldbookSummary}}',
            '',
            '当前导入楼层：',
            '{{input}}',
        ].join('\n'),
    },
];

const DEFAULT_LLM_PROMPTS = [
    {
        id: 'mainPrompt',
        name: '主系统提示词',
        role: 'system',
        content: [
            '你是 nocturne_memory 的记忆整理助手。',
            '你的职责是将聊天内容整理为适合长期记忆写入与检索的文本。',
            '保持事实、关系、状态变化与关键表达，不编造，不扩写，不改变原意。',
            '输出应稳定、简洁、可复用，优先服务 nocturne_memory 的 MCP 记忆写入、召回查询改写与结果整理。',
        ].join('\n'),
    },
    ...DEFAULT_LLM_PROMPT_TEMPLATES.map((template) => ({
        id: `${template.id}Prompt`,
        name: template.label,
        role: 'user',
        content: template.userPromptTemplate,
        systemPrompt: template.systemPrompt,
        validator: template.validator,
        maxTokens: template.maxTokens,
    })),
];

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
        prompts: JSON.parse(JSON.stringify(DEFAULT_LLM_PROMPTS)),
    };
}

const DEFAULT_SETTINGS = {
    workMode: 'bridge',
    ui: {
        activeTab: 'overview',
        fabPosition: {
            x: 0.92,
            y: 0.88,
        },
    },
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
        disclosure: '',
        filterMode: 'selected',
        limit: 20,
        rangeStart: '',
        rangeEnd: '',
        roleFilter: 'all',
        keyword: '',
        nonEmptyOnly: true,
        batchSize: 1,
        stripTagPatterns: [
            'thinking',
            'UpdateVariable',
            'StatusPlaceHolderImpl',
            'Analysis',
            'JSONPatch',
            'content',
            'time',
            'recap',
        ],
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
                prompts: JSON.parse(JSON.stringify(DEFAULT_LLM_PROMPTS)),
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
let importLastClickedVisibleIndex = null;
let panelRoot = null;
let panelFab = null;
let panelContainer = null;
let panelNavButton = null;
let currentPanelTab = 'overview';
let currentChatBindingState = createEmptyChatBindingState();
let lastGeneratedDisclosurePreview = '';
let fabDragState = null;

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
    if (!settings.ui || typeof settings.ui !== 'object') {
        settings.ui = {};
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

    if (!Object.hasOwn(settings.ui, 'activeTab')) {
        settings.ui.activeTab = DEFAULT_SETTINGS.ui.activeTab;
    }
    if (!settings.ui.fabPosition || typeof settings.ui.fabPosition !== 'object') {
        settings.ui.fabPosition = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.ui.fabPosition));
    }
    if (!Object.hasOwn(settings.ui.fabPosition, 'x')) {
        settings.ui.fabPosition.x = DEFAULT_SETTINGS.ui.fabPosition.x;
    }
    if (!Object.hasOwn(settings.ui.fabPosition, 'y')) {
        settings.ui.fabPosition.y = DEFAULT_SETTINGS.ui.fabPosition.y;
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
    if (!Object.hasOwn(settings.import, 'filterMode')) {
        settings.import.filterMode = DEFAULT_SETTINGS.import.filterMode;
    }
    if (!Object.hasOwn(settings.import, 'limit')) {
        settings.import.limit = DEFAULT_SETTINGS.import.limit;
    }
    if (!Object.hasOwn(settings.import, 'rangeStart')) {
        settings.import.rangeStart = DEFAULT_SETTINGS.import.rangeStart;
    }
    if (!Object.hasOwn(settings.import, 'rangeEnd')) {
        settings.import.rangeEnd = DEFAULT_SETTINGS.import.rangeEnd;
    }
    if (!Object.hasOwn(settings.import, 'roleFilter')) {
        settings.import.roleFilter = DEFAULT_SETTINGS.import.roleFilter;
    }
    if (!Object.hasOwn(settings.import, 'keyword')) {
        settings.import.keyword = DEFAULT_SETTINGS.import.keyword;
    }
    if (!Object.hasOwn(settings.import, 'nonEmptyOnly')) {
        settings.import.nonEmptyOnly = DEFAULT_SETTINGS.import.nonEmptyOnly;
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
        prompts: (() => {
            const existingPrompts = Array.isArray(preset?.prompts) ? preset.prompts : [];
            const existingMap = new Map(existingPrompts.filter(prompt => prompt?.id).map(prompt => [prompt.id, prompt]));
            return DEFAULT_LLM_PROMPTS.map(prompt => ({ ...prompt, ...(existingMap.get(prompt.id) || {}) }));
        })(),
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

function createEmptyChatBindingState() {
    return {
        rawChatId: '',
        bindingSlug: 'default',
        parentUri: 'core://rp/default',
        label: '未识别聊天',
        source: 'fallback',
        characterInfo: '未知角色',
    };
}

function slugifyChatBinding(value) {
    const normalized = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[\\/]+/g, '-')
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[-._]+|[-._]+$/g, '');
    return normalized || 'default';
}

function resolveCharacterInfo(context = SillyTavern.getContext()) {
    const parts = [
        context?.name2,
        context?.characterName,
        context?.groupId ? `group:${context.groupId}` : '',
        context?.characterId != null ? `char:${context.characterId}` : '',
    ].map(value => String(value || '').trim()).filter(Boolean);
    return parts.join(' / ') || '未知角色';
}

function resolveCurrentChatBinding(context = SillyTavern.getContext(), explicitChatId = '') {
    const chatIdCandidates = [
        explicitChatId,
        context?.chatId,
        context?.chat?.chat_id,
        context?.chatMetadata?.chat_id,
        context?.chatMetadata?.chatId,
        context?.chatMetadata?.file_name,
        context?.chatMetadata?.name,
    ];
    const rawChatId = chatIdCandidates
        .map(value => String(value || '').trim())
        .find(value => value && value !== 'null');
    const bindingSlug = slugifyChatBinding(rawChatId || 'default');
    const label = rawChatId || '未识别聊天';
    return {
        rawChatId: rawChatId || '',
        bindingSlug,
        parentUri: `core://rp/${bindingSlug}`,
        label,
        source: rawChatId ? 'chat' : 'fallback',
        characterInfo: resolveCharacterInfo(context),
    };
}

function buildChatBoundParentUri(settings = getSettings()) {
    const overrideUri = getImportSettings(settings).parentUri?.trim();
    if (overrideUri) return overrideUri;
    return currentChatBindingState.parentUri || 'core://rp/default';
}

function getEffectiveImportTargetLabel(settings = getSettings()) {
    const overrideUri = getImportSettings(settings).parentUri?.trim();
    return overrideUri ? `${overrideUri}（高级覆盖）` : (currentChatBindingState.parentUri || 'core://rp/default');
}

function refreshCurrentChatBinding(explicitChatId = '') {
    currentChatBindingState = resolveCurrentChatBinding(SillyTavern.getContext(), explicitChatId);
    return currentChatBindingState;
}

function buildImportContent(message) {
    const roleLabel = message.isUser ? '用户' : '助手';
    return [
        `楼层：#${message.floor}`,
        `角色：${roleLabel}`,
        `名称：${String(message.name || '').trim() || roleLabel}`,
        '正文：',
        String(message.text || '').trim(),
    ].join('\n');
}

function normalizeImportSourceText(text, settings) {
    const imp = getImportSettings(settings || getSettings());
    const tagList = (imp.stripTagPatterns || []).filter(Boolean);
    const tagPattern = tagList.length
        ? new RegExp('<(?:' + tagList.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b[^>]*>[\\s\\S]*?<\/(?:' + tagList.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')>', 'gi')
        : null;
    return String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/\[Start a new chat\]/gi, ' ')
        .replace(tagPattern || /(?:)/g, tagPattern ? ' ' : '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/^\s*\[metacognition\]\s*$/gim, ' ')
        .replace(/^\s*<details><summary>.*?<\/summary>\s*$/gim, ' ')
        .replace(/^\s*<\/details>\s*$/gim, ' ')
        .replace(/^\s*[-*]\s*(确认输出语言|必须使用|只写|不写|之前发生了什么|剧情进展到哪里|当前时间|地点|人物关系|角色状态|深度分析|世界如何运转|角色台词与旁白叙事|角色知道什么|当前使用什么文风|上一条内容最后停在哪里|如何自然过渡|是否重复|检查Mingyue输入|当前是否适合推进剧情|结尾是否升华|检查<echo>|角色运行引擎|角色理解|性格融合|场景压力识别|情绪阈值管理|防劣化自检|检查其他细节|小总结准备).*$/gim, ' ')
        .replace(/^\s*楼层：#\d+\s*$/gim, ' ')
        .replace(/^\s*角色：.*$/gim, ' ')
        .replace(/^\s*名称：.*$/gim, ' ')
        .replace(/^\s*正文：\s*$/gim, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function isImportContentMeaningful(text) {
    const normalized = normalizeImportSourceText(text);
    if (!normalized) return false;
    if (normalized.length < 8) return false;
    if (/^(收到|你好|您好|我是\s*Memory\s*Bridge)/i.test(normalized)) return false;
    return /[\u4e00-\u9fa5A-Za-z0-9]/.test(normalized);
}

function buildImportFallbackContent(message) {
    return normalizeImportSourceText(message?.text || '');
}

function buildRecentChatContext(limit = 6) {
    const messages = getChatMessagesForImport()
        .filter(message => message.text.trim())
        .slice(-Math.max(1, limit));
    if (!messages.length) return '（无最近上下文）';
    return messages.map((message) => {
        const role = message.isUser ? '用户' : '助手';
        const preview = message.text.replace(/\s+/g, ' ').trim().slice(0, 120);
        return `#${message.floor} ${role}/${message.name || role}: ${preview}`;
    }).join('\n');
}

function extractWorldbookSummary(context = SillyTavern.getContext()) {
    const candidates = [
        context?.chatMetadata?.worldbook,
        context?.chatMetadata?.worldbook_name,
        context?.chatMetadata?.lorebook,
        Array.isArray(context?.chatMetadata?.worldbookNames) ? context.chatMetadata.worldbookNames.join(', ') : '',
    ].map(value => String(value || '').trim()).filter(Boolean);
    return candidates.join(' / ') || '（当前未检测到世界书信息）';
}

function buildDisclosureInputContext(message, settings = getSettings()) {
    const chatBinding = refreshCurrentChatBinding();
    return {
        input: buildImportContent(message),
        chatBinding: `${chatBinding.label} -> ${chatBinding.parentUri}`,
        characterInfo: chatBinding.characterInfo,
        recentContext: buildRecentChatContext(),
        worldbookSummary: extractWorldbookSummary(),
    };
}

function buildDisclosureFallback(message) {
    const roleText = message.isUser ? '用户' : '角色回复';
    const name = String(message.name || '').trim();
    const namedRole = name ? `${roleText}“${name}”` : roleText;
    const bindingLabel = currentChatBindingState.label || '当前聊天';
    return `当${bindingLabel}中再次涉及${namedRole}相关人物、场景、关系变化或关键事件时`;
}

async function generateDisclosure(message, settings = getSettings()) {
    const contextVars = buildDisclosureInputContext(message, settings);
    const execution = await executeLlmTask('disclosure', contextVars, {
        settings,
        fallback: () => buildDisclosureFallback(message),
    }, settings);
    return execution.ok ? execution.content : buildDisclosureFallback(message);
}

function setDisclosurePreview(value) {
    lastGeneratedDisclosurePreview = String(value || '').trim();
    const textarea = document.getElementById('mb-import-disclosure');
    if (textarea) textarea.value = lastGeneratedDisclosurePreview;
    const panelPreview = document.getElementById('mb-panel-disclosure-preview');
    if (panelPreview) panelPreview.textContent = lastGeneratedDisclosurePreview || '（尚未生成）';
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

function getUiSettings(settings = getSettings()) {
    return settings.ui ?? DEFAULT_SETTINGS.ui;
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
              <span><b>${escapeHtml(toolName)}</b><br><small>${description || '无描述'}</small></span>
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

async function rewriteRecallQuery(input, settings = getSettings()) {
    const normalizedInput = String(input || '').trim();
    if (!normalizedInput) return '';
    const execution = await executeLlmTask('recall', { input: normalizedInput }, {
        settings,
        fallback: () => buildFallbackRecallQuery(normalizedInput),
    }, settings);
    return execution.ok ? execution.content : buildFallbackRecallQuery(normalizedInput);
}

async function recallMemory(query) {
    const settings = getSettings();
    const bridge = getBridgeSettings(settings);
    try {
        if (!await ensureConnected()) {
            logError('无法连接到 MCP 服务，跳过记忆召回');
            return '';
        }
        const rewrittenQuery = await rewriteRecallQuery(query, settings);
        const effectiveQuery = String(rewrittenQuery || query || '').slice(0, 500).trim();
        if (!effectiveQuery) return '';
        const args = { query: effectiveQuery, limit: bridge.recallLimit };
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
    return chat.map((message, index) => ({
        index,
        visibleOrder: index,
        floor: index + 1,
        isUser: !!message?.is_user,
        role: message?.is_user ? 'user' : 'assistant',
        name: String(message?.name || (message?.is_user ? 'User' : 'Assistant') || ''),
        text: String(message?.mes || ''),
    }));
}


function getImportTitle(index, settings = getSettings()) {
    const prefix = getImportSettings(settings).titlePrefix?.trim() || 'chat';
    return `${prefix}-${String(index + 1).padStart(3, '0')}`;
}

function extractImportKeywords(content) {
    const text = String(content || '').trim();
    if (!text) return [];
    return Array.from(new Set(
        text
            .split(/[\s,，、;；|/]+/)
            .map(keyword => keyword.trim())
            .filter(keyword => keyword.length >= 2)
            .slice(0, 8),
    ));
}

async function manageMemoryTriggers(uri, add = [], remove = []) {
    const payload = { uri };
    if (Array.isArray(add) && add.length) payload.add = add;
    if (Array.isArray(remove) && remove.length) payload.remove = remove;
    return await mcpCallTool('manage_triggers', payload);
}


function escapeHtml(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function normalizeImportRangeValue(value) {
    const normalized = parseInt(String(value ?? '').trim(), 10);
    return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}

function getImportFilterState(settings = getSettings()) {
    const importSettings = getImportSettings(settings);
    return {
        filterMode: ['selected', 'recent', 'range', 'all'].includes(importSettings.filterMode) ? importSettings.filterMode : 'recent',
        limit: Math.max(1, parseInt(importSettings.limit, 10) || 20),
        rangeStart: normalizeImportRangeValue(importSettings.rangeStart),
        rangeEnd: normalizeImportRangeValue(importSettings.rangeEnd),
        roleFilter: ['all', 'user', 'assistant'].includes(importSettings.roleFilter) ? importSettings.roleFilter : 'all',
        keyword: String(importSettings.keyword || '').trim().toLowerCase(),
        nonEmptyOnly: importSettings.nonEmptyOnly !== false,
    };
}

function filterImportMessages(messages, settings = getSettings()) {
    const filters = getImportFilterState(settings);
    let visibleMessages = Array.isArray(messages) ? [...messages] : [];

    if (filters.filterMode === 'selected') {
        const selectedIndexes = new Set(importSelection);
        visibleMessages = visibleMessages.filter(message => selectedIndexes.has(message.index));
    }

    if (filters.nonEmptyOnly) {
        visibleMessages = visibleMessages.filter(message => message.text.trim());
    }

    if (filters.filterMode === 'range') {
        let start = filters.rangeStart;
        let end = filters.rangeEnd;
        if (start != null && end != null && start > end) {
            [start, end] = [end, start];
        }
        visibleMessages = visibleMessages.filter((message) => {
            if (start != null && message.floor < start) return false;
            if (end != null && message.floor > end) return false;
            return true;
        });
    } else if (filters.filterMode === 'recent') {
        visibleMessages = visibleMessages.slice(Math.max(0, visibleMessages.length - filters.limit));
    }

    if (filters.roleFilter !== 'all') {
        visibleMessages = visibleMessages.filter(message => message.role === filters.roleFilter);
    }

    if (filters.keyword) {
        visibleMessages = visibleMessages.filter((message) => {
            const haystack = `${message.name}\n${message.text}`.toLowerCase();
            return haystack.includes(filters.keyword);
        });
    }

    return visibleMessages.map((message, visibleOrder) => ({ ...message, visibleOrder }));
}

function getVisibleImportMessages(settings = getSettings()) {
    return filterImportMessages(getChatMessagesForImport(), settings);
}

function applySelectionToVisibleMessages(visibleMessages, shouldSelect) {
    visibleMessages.forEach((message) => {
        if (shouldSelect(message)) {
            importSelection.add(message.index);
        } else {
            importSelection.delete(message.index);
        }
    });
}

function updateImportFilterModeUI() {
    const mode = document.getElementById('mb-import-filter-mode')?.value ?? 'recent';
    document.querySelectorAll('[data-mb-import-filter-mode="recent"]').forEach(section => {
        section.classList.toggle('mb-hidden', mode !== 'recent');
    });
    document.querySelectorAll('[data-mb-import-filter-mode="range"]').forEach(section => {
        section.classList.toggle('mb-hidden', mode !== 'range');
    });
    const bulkRangeRow = document.getElementById('mb-import-bulk-range')?.closest('.mb-row');
    bulkRangeRow?.classList.toggle('mb-hidden', mode === 'range');
}

function updateImportSummaryCards({ visibleMessages = [], selectedMessages = [], settings = getSettings() } = {}) {
    const importSettings = getImportSettings(settings);
    const filters = getImportFilterState(settings);
    const targetUri = document.getElementById('mb-import-target-uri');
    const titlePreview = document.getElementById('mb-import-title-preview');
    const effectiveTargetLabel = getEffectiveImportTargetLabel(settings);
    if (targetUri) {
        if (filters.filterMode === 'selected') {
            targetUri.textContent = '当前选区';
        } else {
            targetUri.textContent = effectiveTargetLabel;
        }
    }
    if (titlePreview) titlePreview.textContent = importSettings.titlePrefix?.trim() || 'chat';

    const panelUri = document.getElementById('mb-panel-import-target-uri');
    if (panelUri) panelUri.textContent = effectiveTargetLabel;
    const panelCounts = document.getElementById('mb-panel-import-counts');
    if (panelCounts) panelCounts.textContent = `可见 ${visibleMessages.length} / 已选 ${selectedMessages.length}`;
}

function setImportSelectionByRange(range, options = {}) {
    const { keepView = true } = options;
    const allMessages = getChatMessagesForImport().filter(message => message.text.trim());
    importSelection = new Set(
        allMessages
            .filter(message => message.floor >= range.start && message.floor <= range.end)
            .map(message => message.index),
    );
    importLastClickedVisibleIndex = null;
    if (keepView) {
        const filterModeSelect = document.getElementById('mb-import-filter-mode');
        if (filterModeSelect) {
            filterModeSelect.value = 'selected';
        }
        saveSettingsFromUI();
    }
}

function parseImportBulkRange(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const match = text.match(/^(\d+)\s*(?:[-~～—]{1}|\.\.)\s*(\d+)$/);
    if (!match) return null;
    const start = parseInt(match[1], 10);
    const end = parseInt(match[2], 10);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= 0) return null;
    return start <= end ? { start, end } : { start: end, end: start };
}

function fillPromptTemplate(template, variables = {}) {
    let output = String(template || '');
    for (const [key, value] of Object.entries(variables)) {
        const pattern = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
        output = output.replace(pattern, String(value ?? ''));
    }
    return output;
}

function getPromptTemplateDefinition(taskId) {
    return DEFAULT_LLM_PROMPT_TEMPLATES.find(template => template.id === taskId) || null;
}

function getTaskPrompt(taskId, settings = getSettings()) {
    return getPromptById(`${taskId}Prompt`, settings);
}

function buildPromptMessages(promptId, variables = {}, settings = getSettings()) {
    const mainPrompt = getPromptById('mainPrompt', settings);
    const taskPrompt = getPromptById(promptId, settings);
    const messages = [];
    const taskSystemPrompt = taskPrompt?.systemPrompt || '';
    if (mainPrompt?.content?.trim()) {
        messages.push({ role: String(mainPrompt.role || 'system').toLowerCase(), content: mainPrompt.content });
    }
    if (taskSystemPrompt.trim()) {
        messages.push({ role: 'system', content: fillPromptTemplate(taskSystemPrompt, variables) });
    }
    if (taskPrompt?.content?.trim()) {
        messages.push({ role: String(taskPrompt.role || 'user').toLowerCase(), content: fillPromptTemplate(taskPrompt.content, variables) });
    }
    return messages.filter(message => message.content?.trim());
}

function normalizeLlmText(value) {
    return String(value || '').replace(/\r\n/g, '\n').trim();
}

function isGreetingLikeText(text) {
    const normalized = normalizeLlmText(text);
    if (!normalized) return false;
    return /^(收到|你好|您好|嗨|hello|hi|我是\s*(?:memory\s*bridge|nocturne_memory))/i.test(normalized);
}

function classifyLlmError(error) {
    const message = getErrorMessage(error).toLowerCase();
    if (!message) return 'unknown';
    if (/http\s+40[134]/.test(message) || message.includes('unauthorized') || message.includes('forbidden') || message.includes('unprocessable')) return 'client_error';
    if (message.includes('429') || message.includes('rate limit') || message.includes('resource_exhausted') || message.includes('quota')) return 'rate_limit';
    if (message.includes('timeout')) return 'timeout';
    if (message.includes('network') || message.includes('failed to fetch')) return 'network';
    if (/http\s+5\d\d/.test(message)) return 'http_retryable';
    return 'unknown';
}

function shouldRetryLlmFailure(failureType) {
    return ['rate_limit', 'timeout', 'network', 'http_retryable'].includes(failureType);
}

function getTaskMaxTokens(taskId, options = {}, settings = getSettings()) {
    if (Number.isFinite(Number(options.maxTokens)) && Number(options.maxTokens) > 0) {
        return Number(options.maxTokens);
    }
    const taskPrompt = getTaskPrompt(taskId, settings);
    if (Number.isFinite(Number(taskPrompt?.maxTokens)) && Number(taskPrompt.maxTokens) > 0) {
        return Number(taskPrompt.maxTokens);
    }
    const definition = getPromptTemplateDefinition(taskId);
    if (Number.isFinite(Number(definition?.maxTokens)) && Number(definition.maxTokens) > 0) {
        return Number(definition.maxTokens);
    }
    return Number(getCurrentLlmPreset(settings)?.maxTokens) || 2000;
}

function validateImportCandidate(text) {
    const normalized = normalizeImportSourceText(text);
    if (!normalized) return { ok: false, failureType: 'empty', reason: '空输出' };
    if (normalized.length < 20) return { ok: false, failureType: 'validation_failed', reason: '内容过短' };
    if (isGreetingLikeText(normalized)) return { ok: false, failureType: 'junk', reason: '寒暄输出' };
    if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(normalized)) {
        return { ok: false, failureType: 'validation_failed', reason: '缺少有效字符' };
    }
    if (/(?:\[Start a new chat\]|<StatusPlaceHolderImpl|<UpdateVariable|<JSONPatch|<time>|<content>|<recap>)/i.test(normalized)) {
        return { ok: false, failureType: 'validation_failed', reason: '仍含控制块残留' };
    }
    return { ok: true, content: normalized };
}

function validateDisclosureCandidate(text) {
    const normalized = normalizeLlmText(text).replace(/\n+/g, ' ');
    if (!normalized) return { ok: false, failureType: 'empty', reason: '空输出' };
    if (isGreetingLikeText(normalized)) return { ok: false, failureType: 'junk', reason: '寒暄输出' };
    if (normalized.length < 8 || normalized.length > 80) {
        return { ok: false, failureType: 'validation_failed', reason: '长度不符合 disclosure 要求' };
    }
    if (/这条记忆|应该召回|以下是|disclosure/i.test(normalized)) {
        return { ok: false, failureType: 'validation_failed', reason: '含元话语' };
    }
    return { ok: true, content: normalized };
}

function validateRecallCandidate(text) {
    const normalized = normalizeLlmText(text).replace(/\n+/g, ' ');
    if (!normalized) return { ok: false, failureType: 'empty', reason: '空输出' };
    if (isGreetingLikeText(normalized)) return { ok: false, failureType: 'junk', reason: '寒暄输出' };
    if (normalized.length < 4) return { ok: false, failureType: 'validation_failed', reason: '查询过短' };
    if (/以下是|查询如下|解释|步骤|结果[:：]/i.test(normalized)) {
        return { ok: false, failureType: 'validation_failed', reason: '含解释性话术' };
    }
    return { ok: true, content: normalized };
}

function validateKeywordsCandidate(text) {
    const normalized = normalizeLlmText(text).replace(/\n+/g, ' ');
    if (!normalized) return { ok: false, failureType: 'empty', reason: '空输出' };
    if (isGreetingLikeText(normalized)) return { ok: false, failureType: 'junk', reason: '寒暄输出' };
    if (normalized.length < 2) return { ok: false, failureType: 'validation_failed', reason: '关键词过短' };
    if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(normalized)) return { ok: false, failureType: 'validation_failed', reason: '缺少有效字符' };
    return { ok: true, content: normalized };
}

function validateTaskLlmOutput(taskId, text) {
    if (taskId === 'import') return validateImportCandidate(text);
    if (taskId === 'keywords') return validateKeywordsCandidate(text);
    if (taskId === 'disclosure') return validateDisclosureCandidate(text);
    if (taskId === 'recall') return validateRecallCandidate(text);
    const normalized = normalizeLlmText(text);
    if (!normalized) return { ok: false, failureType: 'empty', reason: '空输出' };
    return { ok: true, content: normalized };
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

async function executeLlmTask(taskId, variables = {}, options = {}, settings = getSettings()) {
    const llm = getCurrentLlmPreset(settings);
    const fallback = typeof options.fallback === 'function' ? options.fallback : () => '';
    const rawFallback = normalizeLlmText(fallback());
    const maxAttempts = llm.enabled ? 3 : 0;
    let lastFailureType = '';
    let lastError = null;

    if (!llm.enabled) {
        const fallbackValidation = validateTaskLlmOutput(taskId, rawFallback);
        return {
            ok: fallbackValidation.ok,
            content: fallbackValidation.ok ? fallbackValidation.content : '',
            source: 'fallback',
            attempts: 0,
            failureType: fallbackValidation.ok ? '' : fallbackValidation.failureType,
            fallbackContent: rawFallback,
        };
    }

    const messages = buildPromptMessages(`${taskId}Prompt`, variables, settings);
    const maxTokens = getTaskMaxTokens(taskId, options, settings);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const result = await callLlm(messages, { maxTokens });
            const validation = validateTaskLlmOutput(taskId, result);
            if (validation.ok) {
                return {
                    ok: true,
                    content: validation.content,
                    source: 'llm',
                    attempts: attempt,
                    failureType: '',
                    fallbackContent: rawFallback,
                };
            }
            lastFailureType = validation.failureType || 'validation_failed';
            lastError = new Error(validation.reason || 'LLM 输出未通过校验');
            if (!shouldRetryLlmFailure(lastFailureType) || attempt >= maxAttempts) {
                break;
            }
        } catch (error) {
            lastFailureType = classifyLlmError(error);
            lastError = error;
            if (!shouldRetryLlmFailure(lastFailureType) || attempt >= maxAttempts) {
                break;
            }
        }
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    const fallbackValidation = validateTaskLlmOutput(taskId, rawFallback);
    if (fallbackValidation.ok) {
        return {
            ok: true,
            content: fallbackValidation.content,
            source: 'fallback',
            attempts: maxAttempts,
            failureType: lastFailureType,
            error: lastError,
            fallbackContent: rawFallback,
        };
    }

    return {
        ok: false,
        content: '',
        source: 'failed',
        attempts: maxAttempts,
        failureType: fallbackValidation.failureType || lastFailureType || 'validation_failed',
        error: lastError,
        fallbackContent: rawFallback,
    };
}

function buildFallbackRecallQuery(input) {
    const normalized = normalizeImportSourceText(input).replace(/\n+/g, ' ').trim();
    if (!normalized) return '';
    const keywords = Array.from(new Set(normalized.match(/[\u4e00-\u9fa5A-Za-z0-9_]{2,20}/g) || [])).slice(0, 12);
    return keywords.join(' ');
}

async function generateImportKeywords(message, settings = getSettings()) {
    const rawContent = buildImportContent(message);
    const execution = await executeLlmTask('keywords', { input: rawContent }, {
        settings,
        fallback: () => {
            const cleaned = normalizeImportSourceText(message?.text || '');
            return Array.from(new Set((cleaned.match(/[\u4e00-\u9fa5A-Za-z0-9_]{2,20}/g) || []))).slice(0, 8).join(' ');
        },
    }, settings);
    if (!execution.ok || !execution.content.trim()) return [];
    return Array.from(new Set(
        execution.content.trim().split(/[\s,，、;；|/]+/).map(k => k.trim()).filter(k => k.length >= 2)
    )).slice(0, 10);
}

function renderImportList() {
    const container = document.getElementById('mb-import-list');
    const summary = document.getElementById('mb-import-summary');
    if (!container || !summary) return;

    const settings = getSettings();
    const visibleMessages = getVisibleImportMessages(settings);
    const selectedMessages = collectSelectedImportMessages();
    updateImportSummaryCards({ visibleMessages, selectedMessages, settings });

    if (!visibleMessages.length) {
        importLastClickedVisibleIndex = null;
        container.innerHTML = '<div class="mb-hint">当前筛选条件下没有可导入楼层。</div>';
        summary.textContent = '0 条可导入';
        const panelSummary = document.getElementById('mb-panel-import-summary-copy');
        if (panelSummary) panelSummary.textContent = '当前无可导入楼层';
        return;
    }

    const filters = getImportFilterState(settings);
    const firstVisibleFloor = visibleMessages[0]?.floor;
    const lastVisibleFloor = visibleMessages[visibleMessages.length - 1]?.floor;
    const rangeText = firstVisibleFloor && lastVisibleFloor
        ? `#${firstVisibleFloor}-${lastVisibleFloor}`
        : '无';
    const modeTextMap = {
        selected: '当前选区',
        recent: '最近楼层',
        range: '楼层区间',
        all: '全部楼层',
    };
    summary.textContent = `${modeTextMap[filters.filterMode] || '当前视图'}：可见 ${visibleMessages.length} 条，已选 ${selectedMessages.length} 条，范围 ${rangeText}`;
    const panelSummary = document.getElementById('mb-panel-import-summary-copy');
    if (panelSummary) panelSummary.textContent = summary.textContent;
    container.innerHTML = visibleMessages.map((message) => {
        const checked = importSelection.has(message.index) ? 'checked' : '';
        const role = message.isUser ? '用户' : '助手';
        const title = getImportTitle(message.index, settings);
        const preview = message.text.replace(/\s+/g, ' ').trim().slice(0, 120);
        return `
            <label class="mb-import-item" data-visible-order="${message.visibleOrder}">
              <input type="checkbox" class="mb-import-checkbox" data-import-index="${message.index}" data-visible-order="${message.visibleOrder}" ${checked} />
              <span class="mb-import-item-body">
                <b>#${message.floor} · ${role} · ${escapeHtml(title)}</b><br>
                <small>${escapeHtml(message.name)}</small><br>
                <small>${escapeHtml(preview || '（空文本）')}</small>
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
        .filter(Boolean)
        .filter(message => message.text.trim());
}

async function runSelectedImport() {
    saveSettingsFromUI();
    const settings = getSettings();
    const selectedMessages = collectSelectedImportMessages();
    if (!selectedMessages.length) {
        return { ok: false, message: '请先勾选要导入的楼层' };
    }

    const parentUri = buildChatBoundParentUri(settings);
    if (!parentUri) {
        return { ok: false, message: '当前无法解析导入目标 URI' };
    }

    const batchSize = Math.max(1, getImportSettings(settings).batchSize || 1);

    // Split into batches
    const batches = [];
    for (let i = 0; i < selectedMessages.length; i += batchSize) {
        batches.push(selectedMessages.slice(i, i + batchSize));
    }

    let successCount = 0;
    const failures = [];

    for (const batch of batches) {
        // Filter out meaningless messages; skip whole batch if all empty
        const meaningful = batch.filter(m => isImportContentMeaningful(normalizeImportSourceText(m.text || '', settings)));
        if (!meaningful.length) {
            batch.forEach(m => failures.push(`#${m.index + 1}: 导入内容无有效信息，已跳过`));
            continue;
        }

        // Merge content for this batch
        const mergedContent = meaningful.map(m => {
            const roleLabel = m.isUser ? '用户' : '助手';
            return `【#${m.floor} ${roleLabel}】\n${normalizeImportSourceText(m.text || '', settings)}`;
        }).join('\n\n---\n\n');

        // Use first meaningful message as representative for title/priority/disclosure
        const rep = meaningful[0];
        const batchLabel = meaningful.length > 1
            ? `#${meaningful[0].floor}-${meaningful[meaningful.length - 1].floor}`
            : `#${rep.floor}`;

        // Build a synthetic message object for LLM tasks
        const syntheticMsg = { ...rep, text: mergedContent };

        const [keywords, disclosure] = await Promise.all([
            generateImportKeywords(syntheticMsg, settings),
            generateDisclosure(syntheticMsg, settings),
        ]);
        setDisclosurePreview(disclosure);

        const args = {
            parent_uri: parentUri,
            title: getImportTitle(rep.index, settings),
            content: mergedContent,
            priority: rep.isUser ? 2 : 3,
            disclosure,
        };
        try {
            const createResult = await createMemory(args);
            const createdUriMatch = String(createResult || '').match(/'([^'\n]+:\/\/[^'\n]+)'/);
            const createdUri = createdUriMatch?.[1] || '';
            if (createdUri && keywords.length) {
                await manageMemoryTriggers(createdUri, keywords);
            }
            successCount += meaningful.length;
        } catch (error) {
            meaningful.forEach(m => failures.push(`${batchLabel}: ${getErrorMessage(error)}`));
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

    const panelState = document.getElementById('mb-panel-connection-state');
    const panelError = document.getElementById('mb-panel-error-text');
    const statusLine = document.getElementById('mb-panel-status-line');
    if (panelState) panelState.textContent = text.textContent;
    if (panelError) panelError.textContent = lastErrorMessage || '暂无错误';
    if (statusLine) statusLine.textContent = `连接：${text.textContent} · 聊天：${currentChatBindingState.label || '未识别'}`;
}

function updateLastInjectPreview(content) {
    const el = document.getElementById('mb-last-inject');
    if (el) {
        if (content) {
            el.textContent = content.slice(0, 300) + (content.length > 300 ? '...' : '');
            el.classList.remove('empty');
        } else {
            el.textContent = '（尚未注入）';
            el.classList.add('empty');
        }
    }

    const panelPreview = document.getElementById('mb-panel-last-inject');
    const panelShort = document.getElementById('mb-panel-last-inject-short');
    if (panelPreview) {
        panelPreview.textContent = content || '（尚未注入）';
        panelPreview.classList.toggle('empty', !content);
    }
    if (panelShort) {
        panelShort.textContent = content ? `${content.slice(0, 60)}${content.length > 60 ? '...' : ''}` : '尚未注入';
        panelShort.classList.toggle('empty', !content);
    }
}

function updateBootStatusUI(content) {
    const el = document.getElementById('mb-boot-status');
    if (el) {
        if (content) {
            el.textContent = content;
            el.classList.remove('empty');
        } else {
            el.textContent = '（尚未加载）';
            el.classList.add('empty');
        }
    }

    const panelBoot = document.getElementById('mb-panel-boot-state');
    if (panelBoot) {
        panelBoot.textContent = content || '尚未加载';
        panelBoot.classList.toggle('empty', !content);
    }
}

// ─── 设置面板 ─────────────────────────────────────────────────────────────────

function updatePanelChatBindingUI(settings = getSettings()) {
    const state = currentChatBindingState;
    const resolvedParentUri = buildChatBoundParentUri(settings);
    const effectiveTargetLabel = getEffectiveImportTargetLabel(settings);
    const chatLabel = document.getElementById('mb-panel-chat-label');
    const parentUri = document.getElementById('mb-panel-parent-uri');
    const parentUriSource = document.getElementById('mb-panel-parent-uri-source');
    const workMode = document.getElementById('mb-panel-work-mode');
    const importTarget = document.getElementById('mb-panel-import-target-uri');
    const settingsUri = document.getElementById('mb-chat-bound-parent-uri');
    if (chatLabel) chatLabel.textContent = `当前聊天：${state.label}`;
    if (parentUri) parentUri.textContent = effectiveTargetLabel;
    if (parentUriSource) parentUriSource.textContent = state.source === 'chat' ? '按当前聊天自动生成' : '未拿到 chatId，使用默认回退';
    if (workMode) workMode.textContent = `当前模式：${getSettings().workMode}`;
    if (importTarget) importTarget.textContent = effectiveTargetLabel;
    if (settingsUri) settingsUri.textContent = resolvedParentUri;
}

function setPanelTab(tabId) {
    const settings = getSettings();
    currentPanelTab = tabId;
    getUiSettings(settings).activeTab = tabId;
    persistSettings(settings);
    document.querySelectorAll('.mb-panel-tab').forEach((button) => {
        button.classList.toggle('is-active', button.dataset.mbTab === tabId);
    });
    document.querySelectorAll('[data-mb-tab-panel]').forEach((panel) => {
        panel.classList.toggle('is-active', panel.dataset.mbTabPanel === tabId);
    });
}

function openPanel(targetTab = currentPanelTab) {
    if (!panelRoot) return;
    if (targetTab) {
        currentPanelTab = targetTab;
    }
    panelRoot.classList.remove('mb-hidden');
    setPanelTab(currentPanelTab);
    refreshPanelState();
}

function closePanel() {
    panelRoot?.classList.add('mb-hidden');
}

function openSettingsDrawer() {
    const drawer = document.querySelector('#memory-bridge-settings')?.closest('.inline-drawer');
    const toggle = drawer?.querySelector('.inline-drawer-toggle');
    const content = drawer?.querySelector('.inline-drawer-content');
    if (content && getComputedStyle(content).display === 'none') {
        toggle?.click();
    }
    drawer?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function refreshPanelState() {
    updatePanelChatBindingUI();
    updateStatusUI(connectionState);
    updateLastInjectPreview(lastInjectedContent);
    updateBootStatusUI(lastBootStatusMessage);
    setDisclosurePreview(lastGeneratedDisclosurePreview);
    renderImportList();
}

function updateFabVisibility(settings = getSettings()) {
    const enabled = !!getBridgeSettings(settings).enabled;
    panelFab?.classList.toggle('mb-hidden', !enabled);
    panelNavButton?.classList.toggle('mb-hidden', !enabled);
}

function clampFabRatio(value, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(0.95, Math.max(0.05, num));
}

function applyFabPosition(settings = getSettings()) {
    if (!panelFab) return;
    const fabPosition = getUiSettings(settings).fabPosition || DEFAULT_SETTINGS.ui.fabPosition;
    const x = clampFabRatio(fabPosition.x, DEFAULT_SETTINGS.ui.fabPosition.x);
    const y = clampFabRatio(fabPosition.y, DEFAULT_SETTINGS.ui.fabPosition.y);
    panelFab.style.left = `${Math.round(window.innerWidth * x)}px`;
    panelFab.style.top = `${Math.round(window.innerHeight * y)}px`;
}

function saveFabPositionFromViewport(left, top) {
    const settings = getSettings();
    const nextX = clampFabRatio(left / Math.max(window.innerWidth, 1), DEFAULT_SETTINGS.ui.fabPosition.x);
    const nextY = clampFabRatio(top / Math.max(window.innerHeight, 1), DEFAULT_SETTINGS.ui.fabPosition.y);
    getUiSettings(settings).fabPosition = { x: nextX, y: nextY };
    persistSettings(settings);
    applyFabPosition(settings);
}

function handleFabPointerMove(event) {
    if (!fabDragState || !panelFab) return;
    const nextLeft = Math.min(
        Math.max(event.clientX - fabDragState.offsetX, 28),
        Math.max(28, window.innerWidth - 28),
    );
    const nextTop = Math.min(
        Math.max(event.clientY - fabDragState.offsetY, 28),
        Math.max(28, window.innerHeight - 28),
    );
    const distance = Math.hypot(event.clientX - fabDragState.startX, event.clientY - fabDragState.startY);
    if (distance > 6) {
        fabDragState.dragged = true;
        panelFab.classList.add('is-dragging');
    }
    panelFab.style.left = `${Math.round(nextLeft)}px`;
    panelFab.style.top = `${Math.round(nextTop)}px`;
}

function handleFabPointerUp() {
    if (!fabDragState || !panelFab) return;
    const dragged = fabDragState.dragged;
    const left = parseFloat(panelFab.style.left || '0');
    const top = parseFloat(panelFab.style.top || '0');
    panelFab.releasePointerCapture?.(fabDragState.pointerId);
    panelFab.removeEventListener('pointermove', handleFabPointerMove);
    panelFab.removeEventListener('pointerup', handleFabPointerUp);
    panelFab.removeEventListener('pointercancel', handleFabPointerUp);
    panelFab.classList.remove('is-dragging');
    fabDragState = null;
    saveFabPositionFromViewport(left, top);
    if (!dragged) {
        openPanel();
    }
}

function bindFloatingButtonDrag() {
    if (!panelFab || panelFab.dataset.mbDragBound === 'true') return;
    panelFab.dataset.mbDragBound = 'true';
    panelFab.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        const rect = panelFab.getBoundingClientRect();
        fabDragState = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
            dragged: false,
        };
        panelFab.setPointerCapture?.(event.pointerId);
        panelFab.addEventListener('pointermove', handleFabPointerMove);
        panelFab.addEventListener('pointerup', handleFabPointerUp);
        panelFab.addEventListener('pointercancel', handleFabPointerUp);
        event.preventDefault();
    });
}

function openMemoryBridgeWorkspace(targetTab = currentPanelTab) {
    openPanel(targetTab);
}

function injectNavButton() {
    if (panelNavButton) return;
    const leftSendForm = document.querySelector('#leftSendForm');
    if (!leftSendForm) return;
    const button = document.createElement('div');
    button.id = 'mb-workspace-trigger';
    button.className = 'fa-solid fa-brain interactable';
    button.tabIndex = 0;
    button.title = 'Memory Bridge 工作台';
    button.style.cssText = `
        order: 11;
        display: flex;
        width: var(--bottomFormBlockSize);
        height: var(--bottomFormBlockSize);
        align-items: center;
        justify-content: center;
    `;
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openMemoryBridgeWorkspace();
    });
    leftSendForm.appendChild(button);
    panelNavButton = button;
    updateFabVisibility();
}

function bindWorkspaceActions() {
    panelFab?.addEventListener('click', (event) => {
        if (fabDragState?.dragged) {
            event.preventDefault();
            event.stopPropagation();
        }
    });

    panelRoot?.querySelectorAll('[data-mb-panel-close]').forEach((element) => {
        element.addEventListener('click', closePanel);
    });

    panelRoot?.querySelectorAll('.mb-panel-tab').forEach((button) => {
        button.addEventListener('click', () => setPanelTab(button.dataset.mbTab || 'overview'));
    });

    document.getElementById('mb-panel-refresh')?.addEventListener('click', refreshPanelState);
    document.getElementById('mb-panel-open-settings')?.addEventListener('click', openSettingsDrawer);
    document.getElementById('mb-panel-go-settings')?.addEventListener('click', openSettingsDrawer);
    document.getElementById('mb-panel-test-recall')?.addEventListener('click', async () => {
        const textarea = (window.parent || window).document.getElementById('send_textarea');
        const query = textarea?.value?.trim() || '测试';
        const { ok, result, message } = await runRecallPreview(query);
        toastr[ok ? (result ? 'success' : 'warning') : 'warning'](message, 'Memory Bridge');
        setPanelTab('recall');
    });
}

function injectOptionsMenuEntry() {
    if (document.getElementById('option_memory_bridge_panel')) return;
    const optionsContent = $('#options .options-content');
    const anchor = $('#option_toggle_logprobs');
    const menuItem = $(`
        <a id="option_memory_bridge_panel">
          <i class="fa-lg fa-solid fa-brain"></i>
          <span>Memory Bridge</span>
        </a>
    `).on('click', () => {
        openPanel();
        $('#options').hide();
    });

    if (anchor.length > 0) {
        anchor.after(menuItem);
    } else if (optionsContent.length > 0) {
        optionsContent.append(menuItem);
    }
}

async function mountStandalonePanel() {
    if (panelRoot && panelFab) return;
    const { renderExtensionTemplateAsync } = SillyTavern.getContext();
    const panelHtml = await renderExtensionTemplateAsync('third-party/memory-bridge', 'panel');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = panelHtml.trim();
    panelRoot = wrapper.querySelector('#memory-bridge-panel-root');
    panelContainer = wrapper.querySelector('.mb-panel-shell');
    panelFab = wrapper.querySelector('#mb-floating-button');
    if (panelRoot) document.body.appendChild(panelRoot);
    if (panelFab) {
        document.body.appendChild(panelFab);
        bindFloatingButtonDrag();
        applyFabPosition();
    }
    bindWorkspaceActions();
    injectNavButton();
    setPanelTab(getUiSettings().activeTab || currentPanelTab);
    updateFabVisibility();
    refreshPanelState();
}

function updateConnectionModeUI() {
    const mode = document.getElementById('mb-connection-mode')?.value ?? 'http';
    const httpSection = document.getElementById('mb-http-config');
    const jsonSection = document.getElementById('mb-json-config');
    httpSection?.classList.toggle('mb-hidden', mode !== 'http');
    jsonSection?.classList.toggle('mb-hidden', mode !== 'json');
}

function renderLlmModelOptions(models = [], selectedModel = '') {
    const select = document.getElementById('mb-llm-model-list');
    if (!select) return;
    if (!Array.isArray(models) || !models.length) {
        select.innerHTML = '<option value="">（先拉取模型列表）</option>';
        return;
    }
    select.innerHTML = [
        '<option value="">（选择模型写入上方输入框）</option>',
        ...models.map((model) => {
            const value = String(model?.id || model?.name || '');
            const safe = value.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const selected = value === selectedModel ? 'selected' : '';
            return `<option value="${safe}" ${selected}>${safe}</option>`;
        }),
    ].join('');
}

async function fetchOpenAiCompatibleModels(apiUrl, apiKey, settings = getSettings()) {
    const preset = getCurrentLlmPreset(settings);
    const source = String(preset?.source || '').trim();
    if (source === 'tavern') {
        throw new Error('当前预设使用 Tavern 主模型，无需填写 API URL');
    }
    const baseUrl = String(apiUrl || '').trim().replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
    if (!baseUrl) {
        throw new Error('请先填写 API URL');
    }
    const response = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            ...(apiKey?.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {}),
        },
    });
    if (!response.ok) {
        throw new Error(`模型列表拉取失败: HTTP ${response.status}`);
    }
    const data = await response.json();
    return (data?.data || data || []).map((item) => ({
        id: item?.id || item?.model || item?.name,
        name: item?.name || item?.id || item?.model,
    })).filter(item => item.id);
}

async function testCurrentLlmPreset(settings = getSettings()) {
    const execution = await executeLlmTask('recall', { input: '测试：阿洲，中村圆，地下停车场。' }, {
        settings,
        maxTokens: 300,
    }, settings);
    if (!execution.ok || execution.source !== 'llm') {
        const reason = !execution.ok ? (execution.failureType || 'unknown') : 'fallback (LLM 未实际响应)';
        throw new Error(`当前 LLM 预设测试失败: ${reason}`);
    }
    return execution.content;
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
    const templateMap = Object.fromEntries(DEFAULT_LLM_PROMPT_TEMPLATES.map(template => [template.id, template]));
    const existingPromptMap = new Map(Array.isArray(preset.prompts) ? preset.prompts.map(prompt => [prompt?.id, prompt]) : []);
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
            ...(existingPromptMap.get('mainPrompt') || {}),
            id: 'mainPrompt',
            name: '主系统提示词',
            role: 'system',
            content: get('mb-llm-main-prompt')?.value ?? '',
        },
        {
            ...(existingPromptMap.get('importPrompt') || {}),
            id: 'importPrompt',
            name: '历史导入处理指令',
            role: 'user',
            content: get('mb-llm-import-prompt')?.value ?? '',
            systemPrompt: existingPromptMap.get('importPrompt')?.systemPrompt ?? templateMap.import?.systemPrompt ?? '',
            validator: existingPromptMap.get('importPrompt')?.validator ?? templateMap.import?.validator ?? 'keywords',
            maxTokens: existingPromptMap.get('importPrompt')?.maxTokens ?? templateMap.import?.maxTokens ?? 200,
        },
        {
            ...(existingPromptMap.get('disclosurePrompt') || {}),
            id: 'disclosurePrompt',
            name: '导入 disclosure 生成指令',
            role: 'user',
            content: get('mb-llm-disclosure-prompt')?.value ?? '',
            systemPrompt: existingPromptMap.get('disclosurePrompt')?.systemPrompt ?? templateMap.disclosure?.systemPrompt ?? '',
            validator: existingPromptMap.get('disclosurePrompt')?.validator ?? templateMap.disclosure?.validator ?? 'disclosure',
            maxTokens: existingPromptMap.get('disclosurePrompt')?.maxTokens ?? templateMap.disclosure?.maxTokens ?? 200,
        },
        {
            ...(existingPromptMap.get('recallPrompt') || {}),
            id: 'recallPrompt',
            name: '召回查询处理指令',
            role: 'user',
            content: get('mb-llm-recall-prompt')?.value ?? '',
            systemPrompt: existingPromptMap.get('recallPrompt')?.systemPrompt ?? templateMap.recall?.systemPrompt ?? '',
            validator: existingPromptMap.get('recallPrompt')?.validator ?? templateMap.recall?.validator ?? 'recall',
            maxTokens: existingPromptMap.get('recallPrompt')?.maxTokens ?? templateMap.recall?.maxTokens ?? 300,
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
    const bridge = getBridgeSettings(s);
    const connection = getConnectionSettings(s);
    const toolExposure = getToolExposureSettings(s);
    const llm = getCurrentLlmPreset(s);
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.type === 'checkbox' ? (el.checked = !!val) : (el.value = val ?? '');
    };
    set('mb-enabled', bridge.enabled);
    const imp = getImportSettings(s);
    set('mb-import-filter-mode', imp.filterMode);
    set('mb-import-limit', imp.limit);
    set('mb-import-range-start', imp.rangeStart);
    set('mb-import-range-end', imp.rangeEnd);
    set('mb-import-keyword', imp.keyword);
    set('mb-import-role-filter', imp.roleFilter);
    set('mb-import-nonempty', imp.nonEmptyOnly);
    set('mb-import-batch-size', imp.batchSize ?? 1);
    set('mb-import-strip-tags', (imp.stripTagPatterns || []).join('\n'));
    set('mb-work-mode', s.workMode);
    set('mb-connection-mode', connection.mode);
    set('mb-server-url', connection.serverUrl);
    set('mb-token', connection.token);
    set('mb-selected-server-name', connection.selectedServerName);
    set('mb-mcp-config-json', connection.mcpConfigJson);
    set('mb-tool-exposure-enabled', toolExposure.enabled);
    set('mb-tool-stealth', toolExposure.stealth);
    renderLlmPresetOptions();
    set('mb-llm-enabled', llm.enabled);
    set('mb-llm-source', llm.source);
    set('mb-llm-tavern-profile', llm.tavernProfile);
    set('mb-llm-api-url', llm.apiUrl);
    set('mb-llm-api-key', llm.apiKey);
    set('mb-llm-model', llm.model);
    set('mb-llm-temperature', llm.temperature);
    set('mb-llm-max-tokens', llm.maxTokens);
    set('mb-llm-use-main-api', llm.useMainApi);
    set('mb-llm-main-prompt', getPromptById('mainPrompt', s)?.content ?? '');
    set('mb-llm-import-prompt', getPromptById('importPrompt', s)?.content ?? '');
    set('mb-llm-disclosure-prompt', getPromptById('disclosurePrompt', s)?.content ?? '');
    set('mb-llm-recall-prompt', getPromptById('recallPrompt', s)?.content ?? '');
    updateImportFilterModeUI();
    updateWorkModeUI();
    updateConnectionModeUI();
    updateLlmSourceUI();
    updateFabVisibility(s);
    applyFabPosition(s);
    refreshCurrentChatBinding();
    updatePanelChatBindingUI(s);
    updateStatusUI(connectionState);
    updateLastInjectPreview(lastInjectedContent);
    updateBootStatusUI(lastBootStatusMessage);
    setDisclosurePreview(lastGeneratedDisclosurePreview);
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
    s.bridge.enabled = get('mb-enabled')?.checked ?? false;
    s.workMode = get('mb-work-mode')?.value ?? s.workMode;

    const connection = getConnectionSettings(s);
    connection.mode = get('mb-connection-mode')?.value ?? connection.mode;
    connection.serverUrl = get('mb-server-url')?.value?.trim() ?? connection.serverUrl;
    connection.token = get('mb-token')?.value ?? connection.token;
    connection.selectedServerName = get('mb-selected-server-name')?.value?.trim() ?? connection.selectedServerName;
    connection.mcpConfigJson = get('mb-mcp-config-json')?.value ?? connection.mcpConfigJson;

    const toolExposure = getToolExposureSettings(s);
    toolExposure.enabled = get('mb-tool-exposure-enabled')?.checked ?? toolExposure.enabled;
    toolExposure.stealth = get('mb-tool-stealth')?.checked ?? toolExposure.stealth;

    const selectedTools = {};
    document.querySelectorAll('.mb-tool-checkbox').forEach((cb) => {
        const name = cb.dataset.toolName;
        if (name) selectedTools[name] = !!cb.checked;
    });
    toolExposure.selectedTools = selectedTools;

    const imp = getImportSettings(s);
    if (get('mb-import-filter-mode')) imp.filterMode = get('mb-import-filter-mode').value;
    if (get('mb-import-limit')) imp.limit = Math.max(1, parseInt(get('mb-import-limit').value, 10) || 20);
    if (get('mb-import-range-start')) imp.rangeStart = get('mb-import-range-start').value;
    if (get('mb-import-range-end')) imp.rangeEnd = get('mb-import-range-end').value;
    if (get('mb-import-keyword')) imp.keyword = get('mb-import-keyword').value;
    if (get('mb-import-role-filter')) imp.roleFilter = get('mb-import-role-filter').value;
    if (get('mb-import-nonempty')) imp.nonEmptyOnly = get('mb-import-nonempty').checked;
    const batchSizeEl = get('mb-import-batch-size');
    if (batchSizeEl) imp.batchSize = Math.max(1, parseInt(batchSizeEl.value, 10) || 1);
    const stripTagsEl = get('mb-import-strip-tags');
    if (stripTagsEl) {
        imp.stripTagPatterns = stripTagsEl.value.split(/[\n,]+/).map(t => t.trim()).filter(t => t.length > 0);
    }

    syncCurrentLlmPresetFromUI(s);
    persistSettings(s);
    updateImportFilterModeUI();
    updateWorkModeUI();
    updateConnectionModeUI();
    updateLlmSourceUI();
    updateFabVisibility(s);
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
    document.querySelectorAll('#memory-bridge-settings input')
        .forEach(el => el.addEventListener('change', saveSettingsFromUI));

    const configIds = [
        'mb-work-mode',
        'mb-connection-mode',
        'mb-server-url',
        'mb-token',
        'mb-selected-server-name',
        'mb-mcp-config-json',
        'mb-tool-exposure-enabled',
        'mb-tool-stealth',
        'mb-llm-preset',
        'mb-llm-enabled',
        'mb-llm-source',
        'mb-llm-tavern-profile',
        'mb-llm-api-url',
        'mb-llm-api-key',
        'mb-llm-model',
        'mb-llm-temperature',
        'mb-llm-max-tokens',
        'mb-llm-use-main-api',
        'mb-llm-main-prompt',
        'mb-llm-import-prompt',
        'mb-llm-disclosure-prompt',
        'mb-llm-recall-prompt',
        'mb-import-filter-mode',
        'mb-import-limit',
        'mb-import-range-start',
        'mb-import-range-end',
        'mb-import-keyword',
        'mb-import-role-filter',
        'mb-import-nonempty',
        'mb-import-batch-size',
        'mb-import-strip-tags',
    ];
    configIds.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        const eventName = el.tagName === 'TEXTAREA' || el.type === 'text' || el.type === 'password' || el.type === 'number' ? 'input' : 'change';
        el.addEventListener(eventName, saveSettingsFromUI);
        if (eventName !== 'change') el.addEventListener('change', saveSettingsFromUI);
    });

    document.getElementById('mb-llm-preset')?.addEventListener('change', () => {
        const s = getSettings();
        const nextId = document.getElementById('mb-llm-preset')?.value;
        if (nextId) getLlmState(s).selectedPresetId = nextId;
        persistSettings(s);
        loadSettingsToUI();
    });

    document.getElementById('mb-llm-model-list')?.addEventListener('change', () => {
        const selected = document.getElementById('mb-llm-model-list')?.value;
        const input = document.getElementById('mb-llm-model');
        if (selected && input) {
            input.value = selected;
            saveSettingsFromUI();
        }
    });

    document.getElementById('mb-btn-fetch-llm-models')?.addEventListener('click', async () => {
        saveSettingsFromUI();
        const settings = getSettings();
        const preset = getCurrentLlmPreset(settings);
        toastr.info('正在拉取模型列表...', 'Memory Bridge');
        try {
            const models = await fetchOpenAiCompatibleModels(preset.apiUrl, preset.apiKey, settings);
            renderLlmModelOptions(models, preset.model);
            toastr.success(`已拉取 ${models.length} 个模型`, 'Memory Bridge');
        } catch (error) {
            toastr.error(`拉取失败: ${getErrorMessage(error)}`, 'Memory Bridge');
        }
    });

    document.getElementById('mb-btn-test-llm')?.addEventListener('click', async () => {
        saveSettingsFromUI();
        const settings = getSettings();
        toastr.info('正在测试当前 LLM 预设...', 'Memory Bridge');
        try {
            const result = await testCurrentLlmPreset(settings);
            const preview = String(result || '').trim().slice(0, 200) || '（模型已响应，但返回空内容）';
            toastr.success(`连通性测试成功：${preview}`, 'Memory Bridge');
        } catch (error) {
            toastr.error(`测试失败: ${getErrorMessage(error)}`, 'Memory Bridge');
        }
    });

    document.getElementById('mb-btn-apply-import-range')?.addEventListener('click', () => {
        const rangeInput = document.getElementById('mb-import-bulk-range');
        const parsed = parseImportBulkRange(rangeInput?.value);
        if (!parsed) {
            toastr.warning('请输入有效区间，例如 20-40', 'Memory Bridge');
            return;
        }
        setImportSelectionByRange(parsed);
        renderImportList();
    });

    document.getElementById('mb-btn-select-visible-user')?.addEventListener('click', () => {
        const visibleMessages = getVisibleImportMessages();
        applySelectionToVisibleMessages(visibleMessages, (message) => message.isUser);
        renderImportList();
    });

    document.getElementById('mb-btn-select-visible-assistant')?.addEventListener('click', () => {
        const visibleMessages = getVisibleImportMessages();
        applySelectionToVisibleMessages(visibleMessages, (message) => !message.isUser);
        renderImportList();
    });

    document.getElementById('mb-import-list')?.addEventListener('click', (event) => {
        const target = event.target;
        if (!target?.classList?.contains('mb-import-checkbox')) return;
        const index = Number(target.dataset.importIndex);
        const visibleOrder = Number(target.dataset.visibleOrder);
        if (!Number.isFinite(index) || !Number.isFinite(visibleOrder)) return;

        const visibleMessages = getVisibleImportMessages();
        const shouldCheck = !!target.checked;
        if (event.shiftKey && importLastClickedVisibleIndex != null) {
            const start = Math.min(importLastClickedVisibleIndex, visibleOrder);
            const end = Math.max(importLastClickedVisibleIndex, visibleOrder);
            visibleMessages
                .filter(message => message.visibleOrder >= start && message.visibleOrder <= end)
                .forEach((message) => {
                    if (shouldCheck) {
                        importSelection.add(message.index);
                    } else {
                        importSelection.delete(message.index);
                    }
                });
        } else if (shouldCheck) {
            importSelection.add(index);
        } else {
            importSelection.delete(index);
        }

        importLastClickedVisibleIndex = visibleOrder;
        renderImportList();
    });

    document.getElementById('mb-btn-import-selected')?.addEventListener('click', async () => {
        toastr.info('正在导入选中楼层...', 'Memory Bridge');
        const { ok, message } = await runSelectedImport();
        toastr[ok ? 'success' : 'warning'](message, 'Memory Bridge');
    });

    document.getElementById('mb-tool-list')?.addEventListener('change', (event) => {
        if (event.target?.classList?.contains('mb-tool-checkbox')) {
            saveSettingsFromUI();
        }
    });

    document.getElementById('mb-btn-refresh-tools')?.addEventListener('click', async () => {
        toastr.info('正在刷新 MCP 工具列表...', 'Memory Bridge');
        try {
            await registerMcpToolsToSillyTavern();
            toastr.success('工具列表刷新成功', 'Memory Bridge');
        } catch (error) {
            toastr.error(`刷新失败: ${getErrorMessage(error)}`, 'Memory Bridge');
        }
    });
}

// ─── 初始化 ───────────────────────────────────────────────────────────────────

jQuery(async () => {
    getSettings();
    refreshCurrentChatBinding();

    const { renderExtensionTemplateAsync, eventSource, event_types } = SillyTavern.getContext();
    const settingsHtml = await renderExtensionTemplateAsync('third-party/memory-bridge', 'settings');
    $('#extensions_settings2').append(settingsHtml);

    try {
        await mountStandalonePanel();
    } catch (error) {
        logError('独立面板挂载失败，已降级为仅保留设置抽屉:', error);
    }

    loadSettingsToUI();
    bindSettingsEvents();

    try {
        await registerMcpToolsToSillyTavern();
    } catch (error) {
        logError('初始化注册函数工具失败:', error);
    }

    installSendIntentHooks();
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);

    window.addEventListener('resize', () => {
        applyFabPosition();
    });

    eventSource.on(event_types.CHAT_CHANGED, async (chatId) => {
        refreshCurrentChatBinding(chatId);
        resetBridgeRuntimeState();
        importSelection.clear();
        renderImportList();
        updatePanelChatBindingUI();
        setDisclosurePreview('');
        setLastBootStatus('正在加载 Boot Memory...');
        await loadBootMemory();
        refreshPanelState();
    });

    if (SillyTavern.getContext()?.chatId) {
        refreshCurrentChatBinding(SillyTavern.getContext().chatId);
        updatePanelChatBindingUI();
    }

    log('Memory Bridge 已加载');
});
