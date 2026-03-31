# 星·数据库（AutoCardUpdater）脚本接口文档与外置记忆库可行性分析

> 基于 `参考脚本/index.js` v1.1（`shujuku_v120`）逆向整理

---

## 一、脚本概述

**星·数据库（ACU）** 是一个 SillyTavern Tampermonkey 脚本，核心功能是：

- 在聊天消息中嵌入结构化 JSON 表格数据（附加字段存储于消息对象上）
- 通过 LLM 自动解析对话内容并填写/更新表格
- 将表格数据注入世界书（Lorebook）条目，供 AI 上下文使用
- 对外暴露 `window.AutoCardUpdaterAPI` 供其他脚本/插件调用

---

## 二、数据模型

### 2.1 表格数据结构（Sheet）

```js
{
  name: "表格名称",          // string，如 "主角信息"
  content: [
    ["列名1", "列名2", ...], // 第0行：表头
    ["值1",   "值2",   ...], // 第1行起：数据行
    ...
  ],
  exportConfig: { ... },     // 世界书注入配置
  orderNumber: 1             // 排序序号
}
```

### 2.2 聊天消息附加字段

数据以附加字段形式存储在 SillyTavern 的聊天消息对象上：

| 字段名 | 类型 | 说明 |
|--------|------|------|
| `TavernDB_ACU_Data` | Object | 标准表数据（`sheet_*` 键值对） |
| `TavernDB_ACU_SummaryData` | Object | 总结表/大纲表数据 |
| `TavernDB_ACU_IsolatedData` | Object | 按隔离标签分组的独立数据（新格式） |
| `TavernDB_ACU_IndependentData` | Object | 独立表数据（旧格式兼容） |
| `TavernDB_ACU_ModifiedKeys` | Array | 本次更新的 sheetKey 列表 |
| `TavernDB_ACU_UpdateGroupKeys` | Array | 本次更新组的 sheetKey 列表 |
| `TavernDB_ACU_Identity` | string | 数据隔离标识码 |

### 2.3 全局数据对象（currentJsonTableData_ACU）

```js
{
  mate: { ... },          // 元信息（版本、排序等）
  sheet_0: { Sheet },     // 第一张表
  sheet_1: { Sheet },     // 第二张表
  ...
}
```

---

## 三、公开 API（`window.AutoCardUpdaterAPI`）

挂载于 `topLevelWindow.AutoCardUpdaterAPI`，可跨 iframe 访问。

### 3.1 数据读写

| 方法 | 签名 | 返回 | 说明 |
|------|------|------|------|
| `exportTableAsJson` | `() => Object` | 当前全量表格数据对象 | 同步，返回内存中的合并数据 |
| `importTableAsJson` | `(jsonString: string) => Promise<boolean>` | 成功/失败 | 全量覆盖导入，自动保存并刷新世界书 |
| `updateCell` | `(tableName, rowIndex, colIdentifier, value) => Promise<boolean>` | 成功/失败 | 更新单个单元格 |
| `updateRow` | `(tableName, rowIndex, data: Object) => Promise<boolean>` | 成功/失败 | 按列名-值映射更新整行 |
| `insertRow` | `(tableName, data: Object) => Promise<number>` | 新行索引/-1 | 在表末尾插入新行 |
| `deleteRow` | `(tableName, rowIndex) => Promise<boolean>` | 成功/失败 | 删除指定行（不可删表头） |

### 3.2 更新触发

| 方法 | 签名 | 返回 | 说明 |
|------|------|------|------|
| `triggerUpdate` | `() => Promise<boolean>` | 成功/失败 | 触发一次完整的 LLM 填表流程 |
| `manualUpdate` | `() => Promise<boolean>` | 成功/失败 | 等价于点击"立即手动更新"按钮 |
| `syncWorldbookEntries` | `({ createIfNeeded? }) => Promise<boolean>` | 成功/失败 | 同步世界书注入条目 |
| `refreshDataAndWorldbook` | `() => Promise<boolean>` | 成功/失败 | 强制刷新数据合并并重新注入世界书 |

### 3.3 模板与设置管理

| 方法 | 签名 | 返回 | 说明 |
|------|------|------|------|
| `getTemplatePresetNames` | `() => string[]` | 预设名称列表 | 获取所有模板预设 |
| `switchTemplatePreset` | `(presetName: string) => Promise<{success, message}>` | 结果对象 | 切换模板预设 |
| `importTemplate` | `() => Promise<boolean>` | — | 弹出文件选择框导入模板 |
| `exportTemplate` | `() => Promise<boolean>` | — | 导出当前模板 |
| `resetTemplate` | `() => Promise<boolean>` | — | 重置模板到默认 |
| `exportCombinedSettings` | `() => Promise<boolean>` | — | 导出全部设置 |
| `importCombinedSettings` | `() => Promise<boolean>` | — | 导入全部设置 |
| `resetAllDefaults` | `() => Promise<boolean>` | — | 重置所有设置到默认值 |

### 3.4 世界书条目管理

| 方法 | 签名 | 返回 | 说明 |
|------|------|------|------|
| `deleteInjectedEntries` | `() => Promise<boolean>` | — | 删除本插件生成的所有世界书条目 |
| `setZeroTkOccupyMode` | `(enabled: boolean) => Promise<boolean>` | — | 设置 0TK 占用模式（禁用/启用世界书条目） |
| `setOutlineEntryEnabled` | `(enabled: boolean) => Promise<boolean>` | — | 设置大纲条目启用状态（旧接口） |

### 3.5 表格锁定

| 方法 | 签名 | 返回 | 说明 |
|------|------|------|------|
| `getTableLockState` | `(sheetKey) => Object\|null` | `{rows, cols, cells}` | 获取锁定状态 |
| `setTableLockState` | `(sheetKey, lockState, {merge?}) => boolean` | — | 批量设置锁定 |
| `clearTableLocks` | `(sheetKey) => boolean` | — | 清除所有锁定 |
| `lockTableRow` | `(sheetKey, rowIndex, locked?) => boolean` | — | 锁定/解锁行 |
| `lockTableCol` | `(sheetKey, colIndex, locked?) => boolean` | — | 锁定/解锁列 |
| `lockTableCell` | `(sheetKey, rowIndex, colIndex, locked?) => boolean` | — | 锁定/解锁单元格 |

### 3.6 剧情推进预设

| 方法 | 签名 | 返回 | 说明 |
|------|------|------|------|
| `getPlotPresets` | `() => Array` | 预设数组 | 获取所有剧情预设 |
| `getCurrentPlotPreset` | `() => string` | 当前预设名 | — |
| `switchPlotPreset` | `(presetName: string) => boolean` | 成功/失败 | 切换剧情预设 |

### 3.7 事件回调

| 方法 | 签名 | 说明 |
|------|------|------|
| `registerTableUpdateCallback` | `(callback: (data) => void)` | 注册表格更新后的回调，参数为最新全量数据 |
| `unregisterTableUpdateCallback` | `(callback)` | 注销回调 |
| `registerTableFillStartCallback` | `(callback: () => void)` | 注册填表开始时的回调 |

### 3.8 UI 操作

| 方法 | 签名 | 说明 |
|------|------|------|
| `openSettings` | `() => Promise<boolean>` | 打开设置面板 |
| `openVisualizer` | `() => void` | 打开可视化编辑器 |

---

## 四、SillyTavern 事件钩子

脚本监听以下 SillyTavern 内部事件：

| 事件 | 触发时机 | ACU 响应 |
|------|----------|----------|
| `CHAT_CHANGED` | 切换聊天 | 重置状态、停止循环、加载预设 |
| `CHAT_COMPLETION_SETTINGS_READY` | 提示词构建完成 | 注入提示词模板（makeLast） |
| `MESSAGE_RECEIVED` / `GENERATION_ENDED` | AI 回复完成 | 触发自动填表判断 |

---

## 五、存储架构

```
优先级（高→低）：
  SillyTavern extensionSettings（服务端，跨浏览器同步）
    ↓ 失败时回退
  IndexedDB（本浏览器，持久化）
    ↓ 失败时回退
  内存（仅当前会话）

禁用：localStorage / sessionStorage（默认禁止）
```

---

## 六、MCP + Skills 外置记忆库可行性分析

### 6.1 目标架构

```
SillyTavern（前端）
  └── ACU 脚本（数据库）
        ↕ AutoCardUpdaterAPI
  └── 外置记忆库扩展（新建）
        ↕ MCP 工具调用 / Skills 调用
  外置记忆库后端（Python/Node.js）
        └── 持久化存储（SQLite / 向量库）
```

### 6.2 可行性评估

**结论：可行，推荐分两层实现。**

#### 层一：ACU → 外置记忆库（写入方向）

ACU 已提供 `registerTableUpdateCallback`，每次表格更新后会推送最新数据。外置记忆库扩展可以：

1. 注册回调，监听 ACU 数据变更
2. 将结构化表格数据转换为记忆条目格式
3. 通过 MCP `create_memory` / `update_memory` 写入外置记忆库

```js
// 示例：ACU 数据变更 → 写入 MCP 记忆库
AutoCardUpdaterAPI.registerTableUpdateCallback(async (tableData) => {
  const summary = convertTableToMemoryContent(tableData);
  await mcpClient.call('update_memory', {
    uri: 'core://character_state',
    append: summary
  });
});
```

#### 层二：外置记忆库 → ACU（读取/注入方向）

外置记忆库的内容需要注入 AI 上下文，有两条路径：

**路径 A（推荐）：通过世界书注入**
- 外置记忆库扩展调用 `AutoCardUpdaterAPI.importTableAsJson()` 将记忆内容写回 ACU 表格
- ACU 自动将表格内容注入世界书，AI 可直接读取
- 优点：零侵入，利用 ACU 现有的世界书注入机制

**路径 B：直接注入提示词**
- 监听 `CHAT_COMPLETION_SETTINGS_READY` 事件（与 ACU 同级）
- 将记忆内容作为额外系统提示词注入
- 优点：更灵活；缺点：需要处理与 ACU 的提示词顺序冲突

### 6.3 MCP 规范适配

参考 `nocturne_memory` 的 7 个工具，ACU 数据可以映射为：

| MCP 工具 | ACU 对应操作 |
|----------|-------------|
| `read_memory(uri)` | `exportTableAsJson()` + 按表名过滤 |
| `create_memory(...)` | `insertRow(tableName, data)` |
| `update_memory(uri, ...)` | `updateRow(tableName, rowIndex, data)` |
| `delete_memory(uri)` | `deleteRow(tableName, rowIndex)` |
| `search_memory(query)` | 遍历 `exportTableAsJson()` 全文匹配 |
| `add_alias` | 无直接对应（可通过复制行模拟） |
| `manage_triggers` | 无直接对应（可映射到世界书关键词） |

### 6.4 Skills 规范适配

SillyTavern Skills（斜杠命令扩展）可以封装以下能力：

```
/db-read [tableName]          → exportTableAsJson() + 过滤
/db-update [table] [row] ...  → updateRow()
/db-insert [table] ...        → insertRow()
/db-sync                      → refreshDataAndWorldbook()
/db-search [keyword]          → 全文搜索表格内容
```

### 6.5 主要挑战与解决方案

| 挑战 | 说明 | 解决方案 |
|------|------|----------|
| 数据格式差异 | ACU 是二维表格，MCP 记忆库是树状文本 | 编写双向转换层（表格行 ↔ 结构化文本段落） |
| 实时同步 | ACU 数据存在聊天消息中，外置库在服务端 | 用 `registerTableUpdateCallback` 做增量同步，避免全量轮询 |
| 上下文注入冲突 | ACU 和外置记忆库都会注入世界书 | 分配不同的世界书条目 order 范围，避免覆盖 |
| 跨会话持久化 | ACU 数据绑定聊天文件，外置库独立持久化 | 以 `chatFileName + isolationCode` 为键做关联索引 |
| MCP 连接 | 浏览器脚本无法直接连接 MCP 服务 | 通过 SillyTavern 的 MCP 代理层（或本地 HTTP 桥接）中转 |

### 6.6 推荐实现路径

**最小可行方案（MVP）：**

1. 新建一个 SillyTavern 扩展（`index.js` + `manifest.json`）
2. 注册 `AutoCardUpdaterAPI.registerTableUpdateCallback`，监听数据变更
3. 将表格数据序列化为 Markdown 文本，通过 `fetch` 调用本地 MCP HTTP 端点写入记忆库
4. 在 `CHAT_COMPLETION_SETTINGS_READY` 事件中，从记忆库读取相关记忆并注入提示词

**完整方案：**

在 MVP 基础上增加：
- 双向同步（记忆库 → ACU 表格回写）
- Skills 斜杠命令封装
- 向量搜索支持（替换全文匹配）
- 基于 `disclosure` 的条件触发注入（参考 nocturne_memory 设计）

---

## 七、关键风险

1. **ACU 版本耦合**：`AutoCardUpdaterAPI` 是非官方接口，脚本更新可能破坏兼容性，建议做版本检测
2. **浏览器沙箱限制**：Tampermonkey 脚本无法直接建立 WebSocket/TCP 连接到 MCP 服务，需要通过 SillyTavern 服务端代理
3. **数据一致性**：ACU 数据分散在各楼层消息中，合并逻辑复杂，外置同步时需依赖 `exportTableAsJson()` 的合并结果而非原始消息字段
