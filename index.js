/**
 * Memory Bridge — SillyTavern Extension
 * 独立记忆召回层：通过 MCP Streamable HTTP 协议连接外置记忆库，
 * 在用户发送前自动召回相关记忆并注入上下文，不占用 RPAI token。
 *
 * 架构：
 *   用户发送 → GENERATION_AFTER_COMMANDS 拦截
 *     → MCP search_memory(用户输入) → 召回记忆文本
 *     → 拼接注入用户输入 → 正常发给 RPAI
 */

import {
  getContext,
  extension_settings,
  renderExtensionTemplateAsync,
  saveSettingsDebounced,
} from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';

// ─── 常量 ────────────────────────────────────────────────────────────────────

const EXT_NAME = 'memory-bridge';
const LOG_PREFIX = '[MemBridge]';

// GENERATION_AFTER_COMMANDS 是 ACU 剧情推进使用的同一个拦截点
// 在提示词构建完成、发送给 API 之前触发，可以修改 params.prompt
const INTERCEPT_EVENT = event_types.GENERATION_AFTER_COMMANDS;

// 用户发送意图 TTL（毫秒），与 ACU 保持一致
const SEND_INTENT_TTL_MS = 5000;

// ─── 默认设置 ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  enabled: false,
  serverUrl: 'http://localhost:8000/mcp',
  token: '',
  recallLimit: 5,
  domain: '',
  injectMode: 'suffix',   // 'suffix' | 'system'
  injectTag: '[记忆参考]',
  bootEnabled: false,
  bootUri: 'system://boot',
  debug: false,
};

// ─── 运行时状态 ───────────────────────────────────────────────────────────────

/** MCP 会话 ID（Streamable HTTP 需要） */
let mcpSessionId = null;
/** 当前连接状态 */
let connectionState = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'
/** 发送意图时间戳（用于过滤非用户触发的生成） */
let lastSendIntentAt = 0;
/** 是否正在处理（防重入） */
let isProcessing = false;
/** 上次注入的内容（调试用） */
let lastInjectedContent = '';

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function log(...args) {
  if (extension_settings[EXT_NAME]?.debug) {
    console.log(LOG_PREFIX, ...args);
  }
}

function logError(...args) {
  console.error(LOG_PREFIX, ...args);
}

function getSettings() {
  return extension_settings[EXT_NAME] ?? DEFAULT_SETTINGS;
}

// ─── MCP Streamable HTTP 客户端 ───────────────────────────────────────────────

/**
 * 向 MCP 服务发送 JSON-RPC 请求
 * 支持 application/json 和 text/event-stream 两种响应格式
 */
async function mcpRpc(method, params) {
  const settings = getSettings();
  const url = settings.serverUrl;

  const headers = {
    'accept': 'application/json, text/event-stream',
    'content-type': 'application/json',
  };

  if (mcpSessionId) {
    headers['mcp-session-id'] = mcpSessionId;
  }

  if (settings.token) {
    headers['Authorization'] = `Bearer ${settings.token}`;
  }

  const isNotification = method.startsWith('notifications/');
  const body = {
    jsonrpc: '2.0',
    method,
    params,
  };
  if (!isNotification) {
    body.id = crypto.randomUUID();
  }

  log(`RPC → ${method}`, params);

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`MCP HTTP ${response.status}: ${response.statusText}`);
  }

  return response;
}

/**
 * 解析 MCP 响应（支持 JSON 和 SSE 流）
 */
async function parseMcpResponse(response) {
  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    const data = await response.json();
    log('RPC ← JSON', data);
    return data;
  }

  if (contentType.includes('text/event-stream')) {
    // 读取 SSE 流，取第一条有效数据
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
          // 继续读取
        }
      }
    }
    throw new Error('SSE 流结束但未收到有效数据');
  }

  throw new Error(`未知响应类型: ${contentType}`);
}

/**
 * 初始化 MCP 会话（握手）
 * 成功后保存 sessionId，后续请求复用
 */
async function mcpInitialize() {
  const initResponse = await mcpRpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'memory-bridge', version: '0.1.0' },
  });

  // 从响应头获取 session ID
  const newSessionId = initResponse.headers.get('mcp-session-id');
  if (newSessionId) {
    mcpSessionId = newSessionId;
    log('会话已建立, sessionId:', mcpSessionId);
  }

  // 解析响应体（验证服务端能力）
  await parseMcpResponse(initResponse);

  // 发送 initialized 通知（不需要响应）
  await mcpRpc('notifications/initialized', {});

  return true;
}

/**
 * 调用 MCP 工具
 * @param {string} toolName - 工具名称
 * @param {object} args - 工具参数
 * @returns {Promise<string>} 工具返回的文本内容
 */
async function mcpCallTool(toolName, args) {
  const response = await mcpRpc('tools/call', { name: toolName, arguments: args });
  const data = await parseMcpResponse(response);

  if (data?.error) {
    throw new Error(`MCP 工具错误: ${data.error.message}`);
  }

  // 提取文本内容
  const content = data?.result?.content ?? [];
  return content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');
}

// ─── 连接管理 ─────────────────────────────────────────────────────────────────

/**
 * 建立/重建 MCP 连接
 */
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

/**
 * 确保连接可用，断开时自动重连
 */
async function ensureConnected() {
  if (connectionState === 'connected' && mcpSessionId) return true;
  return await connect();
}

function setConnectionState(state) {
  connectionState = state;
  updateStatusUI(state);
}

// ─── 记忆召回 ─────────────────────────────────────────────────────────────────

/**
 * 搜索记忆
 * @param {string} query - 搜索关键词（通常是用户输入）
 * @returns {Promise<string>} 格式化后的记忆文本，失败返回空字符串
 */
async function recallMemory(query) {
  const settings = getSettings();

  try {
    const connected = await ensureConnected();
    if (!connected) {
      logError('无法连接到 MCP 服务，跳过记忆召回');
      return '';
    }

    const args = {
      query: query.slice(0, 500), // 限制查询长度
      limit: settings.recallLimit,
    };
    if (settings.domain) {
      args.domain = settings.domain;
    }

    log('召回记忆, query:', args.query);
    const result = await mcpCallTool('search_memory', args);
    log('召回结果长度:', result.length);
    return result;

  } catch (err) {
    logError('记忆召回失败:', err);
    // 连接可能已失效，重置会话
    mcpSessionId = null;
    setConnectionState('disconnected');
    return '';
  }
}

/**
 * 读取指定 URI 的记忆（用于 boot memory）
 * @param {string} uri
 * @returns {Promise<string>}
 */
async function readMemory(uri) {
  try {
    const connected = await ensureConnected();
    if (!connected) return '';

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

/**
 * 将召回的记忆内容注入到用户输入中
 * @param {string} userInput - 原始用户输入
 * @param {string} memoryContent - 召回的记忆内容
 * @returns {string} 注入后的完整文本
 */
function buildInjectedMessage(userInput, memoryContent) {
  if (!memoryContent || !memoryContent.trim()) return userInput;

  const settings = getSettings();
  const tag = settings.injectTag?.trim();

  let memoryBlock;
  if (tag) {
    memoryBlock = `\n\n${tag}\n${memoryContent.trim()}\n${tag}`;
  } else {
    memoryBlock = `\n\n${memoryContent.trim()}`;
  }

  return userInput + memoryBlock;
}

// ─── 发送意图检测（复用 ACU 策略）────────────────────────────────────────────

function markSendIntent() {
  lastSendIntentAt = Date.now();
}

function isRecentSendIntent() {
  return (Date.now() - lastSendIntentAt) <= SEND_INTENT_TTL_MS;
}

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
        if ((e.key === 'Enter' || e.key === 'NumpadEnter') && !e.shiftKey) {
          markSendIntent();
        }
      }, true);
      textarea.__mb_hooked = true;
    }

    // 元素可能尚未渲染，延迟重试
    if ((!sendBtn || !textarea) && !window.__mb_hookRetryScheduled) {
      window.__mb_hookRetryScheduled = true;
      setTimeout(() => {
        window.__mb_hookRetryScheduled = false;
        installSendIntentHooks();
      }, 1500);
    }
  } catch (e) {
    // ignore
  }
}

// ─── 核心拦截逻辑 ─────────────────────────────────────────────────────────────

/**
 * GENERATION_AFTER_COMMANDS 事件处理器
 * 复用 ACU 的双策略拦截：
 *   策略1：用户楼层已写入 chat（/send 命令等）
 *   策略2：输入框中有文本 + 近期发送意图
 */
async function onGenerationAfterCommands(type, params, dryRun) {
  const settings = getSettings();

  // 前置检查
  if (!settings.enabled) return;
  if (dryRun) return;
  if (isProcessing) return;

  // 过滤 quiet/后台生成
  if (type === 'quiet') return;
  if (params?.quiet_prompt) return;
  if (params?.automatic_trigger) return;

  const context = getContext();
  const chat = context.chat;
  if (!chat || chat.length === 0) return;

  // ── 策略1：最新楼层是用户消息且未处理 ──
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

  // ── 策略2：输入框有文本 + 近期发送意图 ──
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
      try { params.prompt = injected; } catch (_) {}
      lastInjectedContent = memory;
      updateLastInjectPreview(memory);
      log('策略2注入成功, 记忆长度:', memory.length);
    }
  } catch (err) {
    logError('策略2处理失败:', err);
  } finally {
    isProcessing = false;
    lastSendIntentAt = 0; // 消费意图，防止重复触发
  }
}

// ─── Boot Memory ──────────────────────────────────────────────────────────────

/**
 * 切换聊天时加载核心记忆，注入世界书（通过 ST 的 setExtensionPrompt）
 */
async function loadBootMemory() {
  const settings = getSettings();
  if (!settings.bootEnabled || !settings.bootUri) return;

  log('加载 Boot Memory:', settings.bootUri);
  const content = await readMemory(settings.bootUri);
  if (!content) return;

  // 使用 ST 的 setExtensionPrompt 注入为系统提示词
  // 这是 ST 扩展注入上下文的标准方式，不修改聊天记录
  try {
    const { setExtensionPrompt, extension_prompt_types } = await import('../../../extensions.js');
    setExtensionPrompt(
      EXT_NAME + '_boot',
      content,
      extension_prompt_types.IN_PROMPT,
      0,  // 插入位置（0 = 最前）
    );
    log('Boot Memory 已注入系统提示词, 长度:', content.length);
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
  const labels = {
    connected: '已连接',
    connecting: '连接中...',
    disconnected: '未连接',
  };
  text.textContent = labels[state] ?? state;
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
    if (el.type === 'checkbox') el.checked = !!val;
    else el.value = val ?? '';
  };

  set('mb-enabled', s.enabled);
  set('mb-server-url', s.serverUrl);
  set('mb-token', s.token);
  set('mb-recall-limit', s.recallLimit);
  set('mb-domain', s.domain);
  set('mb-inject-mode', s.injectMode);
  set('mb-inject-tag', s.injectTag);
  set('mb-boot-enabled', s.bootEnabled);
  set('mb-boot-uri', s.bootUri);
  set('mb-debug', s.debug);

  updateStatusUI(connectionState);
  updateLastInjectPreview(lastInjectedContent);
}

function saveSettingsFromUI() {
  const s = extension_settings[EXT_NAME];
  const get = (id) => document.getElementById(id);

  s.enabled      = get('mb-enabled')?.checked ?? false;
  s.serverUrl    = get('mb-server-url')?.value?.trim() ?? '';
  s.token        = get('mb-token')?.value ?? '';
  s.recallLimit  = parseInt(get('mb-recall-limit')?.value) || 5;
  s.domain       = get('mb-domain')?.value?.trim() ?? '';
  s.injectMode   = get('mb-inject-mode')?.value ?? 'suffix';
  s.injectTag    = get('mb-inject-tag')?.value ?? '[记忆参考]';
  s.bootEnabled  = get('mb-boot-enabled')?.checked ?? false;
  s.bootUri      = get('mb-boot-uri')?.value?.trim() ?? 'system://boot';
  s.debug        = get('mb-debug')?.checked ?? false;

  saveSettingsDebounced();
}

function bindSettingsEvents() {
  // 所有输入变化自动保存
  document.querySelectorAll('#memory-bridge-settings input, #memory-bridge-settings select')
    .forEach(el => el.addEventListener('change', saveSettingsFromUI));

  // 连接测试
  document.getElementById('mb-btn-connect')?.addEventListener('click', async () => {
    saveSettingsFromUI();
    mcpSessionId = null;
    const ok = await connect();
    toastr[ok ? 'success' : 'error'](
      ok ? 'MCP 服务连接成功' : '连接失败，请检查地址和 Token',
      'Memory Bridge',
    );
  });

  // 测试召回
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

  // 清除会话
  document.getElementById('mb-btn-clear-session')?.addEventListener('click', () => {
    mcpSessionId = null;
    setConnectionState('disconnected');
    toastr.info('会话已清除', 'Memory Bridge');
  });
}

// ─── 初始化 ───────────────────────────────────────────────────────────────────

jQuery(async () => {
  // 初始化设置
  extension_settings[EXT_NAME] = Object.assign(
    {},
    DEFAULT_SETTINGS,
    extension_settings[EXT_NAME] ?? {},
  );

  // 渲染设置面板
  const settingsHtml = await renderExtensionTemplateAsync(EXT_NAME, 'settings');
  $('#extensions_settings').append(settingsHtml);

  // 加载设置到 UI
  loadSettingsToUI();

  // 绑定 UI 事件
  bindSettingsEvents();

  // 安装发送意图捕获钩子
  installSendIntentHooks();

  // 注册生成拦截事件
  eventSource.on(INTERCEPT_EVENT, onGenerationAfterCommands);

  // 切换聊天时加载 Boot Memory
  eventSource.on(event_types.CHAT_CHANGED, async () => {
    // 重置发送意图，防止跨聊天误触发
    lastSendIntentAt = 0;
    isProcessing = false;
    await loadBootMemory();
  });

  log('Memory Bridge 已加载');
});
