# memory-bridge 落地计划

> 基于 refs/Engram 调研 + 现有代码分析，制定三项新功能 + 一项 bug 修复的落地方案。
> 更新：2026-04

---

## Bug Fix P0：拉取模型按钮不可用

### 现象
`mb-btn-fetch-llm-models` 按钮点击后报错或无响应。

### 根因
`fetchOpenAiCompatibleModels()` (index.js:2415) 直接用浏览器 `fetch()` 访问外部 API URL。ST 前端受 CORS 限制，跨域请求被拦截。`source === 'tavern'` 时逻辑正确报错；`custom` 模式下 CORS 导致 network error。

### 修复方案
通过 ST 后端代理转发，而非直接浏览器 fetch：
- 方案 A：调用 ST 已有的 `/api/openai/models` 代理路由（需确认 ST 版本是否支持）
- 方案 B：复用 `pluginFetch` 包装，经 MCP plugin 后端中转
- 最小路径：在请求前判断是否为 `useMainApi` 模式，是则跳过拉取改为提示「使用主模型无需拉取」

### 验收
custom 模式下填写有效 API URL + Key 后点击拉取，下拉框能展示模型列表。

---

## 功能一 P1：正则清洗配置 Tab

### 目标
独立可视化的正则规则管理界面，与 SillyTavern 原生正则不冲突。

### 借鉴来源
`refs/Engram/src/config/types/data_processing.ts` — `RegexRule` 结构

### 数据结构
`DEFAULT_SETTINGS.import.regexRules: RegexRule[]`

```js
// 每条规则：
{
    id: string,          // 唯一 ID（nanoid 或时间戳）
    name: string,        // 显示名
    pattern: string,     // 正则字符串
    replacement: string, // 替换内容（空串=删除）
    enabled: boolean,
    flags: string,       // 'gi' 等
    scope: 'import' | 'recall-inject' | 'both'
}
```

默认规则：将现有 `stripTagPatterns` 迁移为等价规则对象。

### 新增函数
- `applyRegexRules(text, scope, settings)` — 纯函数，按 scope 过滤后依次 replace
- `renderRegexRuleList()` — 渲染规则列表
- `bindRegexRuleEvents()` — 增删改事件

### 改动点
1. `DEFAULT_SETTINGS.import` 新增 `regexRules: []`
2. `migrateLegacySettings()` 把旧 `stripTagPatterns` 转为规则对象
3. `normalizeImportSourceText()` 末尾调用 `applyRegexRules(text, 'import', settings)`
4. recall 注入路径调用 `applyRegexRules(content, 'recall-inject', settings)`
5. `panel.html` 新增 `regex` tab + section
6. 规则行模板：`[开关] 名称 | pattern | replacement | flags | scope | [删除]`

### 验收
- 添加规则后导入消息，正文按规则清洗
- 禁用规则后正文保留原内容
- 旧 `stripTagPatterns` 迁移后行为不变

---

## 功能二 P1：半自动导入（每 N 楼触发）

### 目标
配置「每 N 楼最新 AI 回复后自动入库」，无需手动点导入。

### 借鉴来源
Engram `GENERATION_AFTER_COMMANDS` 事件 + `EventTrimmer` 触发节奏设计

### 数据结构
`DEFAULT_SETTINGS` 新增 `autoImport` 节：

```js
autoImport: {
    enabled: false,
    everyNFloors: 5,
    role: 'assistant',   // 'assistant' | 'user' | 'both'
    onlyMeaningful: true,
}
```

运行时：模块级 `let autoImportLastFloor = 0;`，`CHAT_CHANGED` 时重置。

### 触发位置
`onGenerationAfterCommands` 回调末尾追加 `checkAutoImport()`。

### 核心逻辑
1. 未启用则返回
2. 取最后一条 AI 消息的 `floor`
3. `currentFloor - autoImportLastFloor < everyNFloors` 则跳过
4. 更新 `autoImportLastFloor = currentFloor`
5. 取最近 `everyNFloors` 条符合 `role` 的消息
6. 复用现有导入管道静默执行（失败仅 debug log，不弹 toastr）

### UI 位置
panel `config` tab 新增「半自动导入」卡片：
```
[开关] 启用半自动导入
每 [5] 楼触发一次
角色筛选: [AI回复 ▼]
[✓] 跳过无意义内容
状态: 上次自动导入于 #42 楼
```

### 验收
- 对话满 N 楼后自动触发，状态行更新楼层号
- 切换聊天后计数器归零
- 手动导入不受影响

---

## 功能三 P2：易用性交互优化

### 3.1 导入列表快捷操作
在 import tab 选择区新增按钮行：「全选」「清空」「仅选AI」「仅选用户」

### 3.2 导入进度指示
批量导入时在 panel 内显示进度条 + 计数（非仅 toastr）。

```html
<div id="mb-import-progress" class="mb-hidden">
  <div class="mb-progress-bar"><div id="mb-import-progress-fill"></div></div>
  <div id="mb-import-progress-text">0 / 0</div>
</div>
```

### 3.3 召回结果预览
recall 注入后，overview tab 显示本次注入的记忆片段列表（标题 + 短摘要），而非仅「已注入 N 条」。

### 3.4 FAB 连接状态徽标
FAB 按钮根据 `connectionState` 显示颜色徽标（绿/黄/红）。

```js
function updateFabStatus() {
    const fab = document.getElementById('mb-floating-button');
    if (!fab) return;
    fab.dataset.mbStatus = connectionState; // CSS [data-mb-status] 着色
}
```

---

## 实施优先级

| 优先级 | 项目 | 估计改动量 |
|--------|------|------------|
| P0 | Bug: 拉取模型按钮 | 10-20 行 |
| P1 | 功能一：正则清洗 Tab | ~150 行 |
| P1 | 功能二：半自动导入 | ~80 行 |
| P2 | 3.1 快捷选择按钮 | ~30 行 |
| P2 | 3.4 FAB 状态徽标 | ~15 行 |
| P3 | 3.2 导入进度指示 | ~40 行 |
| P3 | 3.3 召回结果预览 | ~50 行 |

---

## 约束

- 所有改动在 `src/memory-bridge/index.js` 单文件内完成，无构建流程
- 正则规则存入 `extensionSettings`，不引入独立存储
- 自动导入失败静默，不弹 toastr 错误
- ST 原生正则与 memory-bridge 正则作用域不重叠，不修改 ST 全局正则配置

## 历史错误记录

| Error | Attempt | Resolution |
|---|---:|---|
