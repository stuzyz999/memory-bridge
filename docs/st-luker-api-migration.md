# Luker Plugin Context Migration Guide

This guide is primarily for extension authors building against Luker’s exposed context surface (`Luker.getContext()`).

It is not intended to be a full standalone backend API reference. The low-level HTTP routes documented later are an advanced appendix for debugging, migration audits, or integrations that cannot use the context helpers directly.

If you are starting a plugin from scratch and need folder structure, `manifest.json`, entry-module, and UI scaffolding guidance, read `docs/luker-plugin-authoring-guide.md` first.

## 1) Use Context Helpers First

In Luker, `getContext()` is the primary plugin surface. Prefer these helpers over direct endpoint calls.

Global object recommendation:

- Prefer `Luker.getContext()` in new plugins.
- `st.getContext()` / `SillyTavern.getContext()` are compatibility aliases and should be considered legacy naming.

### Chat/message persistence

- `appendChatMessages(messages)`
- `patchChatMessages(operations)`
- `saveChatMetadata(withMetadata?)`

### Chat-bound plugin state

- `getChatStateBatch(namespaces, options?)`
- `getChatState(namespace, options?)`
- `patchChatState(namespace, operations, options?)`
- `updateChatState(namespace, updater, options?)`
- `deleteChatState(namespace, options?)`

### Preset helpers

- `presets.list(collection?)`
- `presets.resolve(target?, options?)`
- `presets.getSelected(collection?)`
- `presets.getLive(collection?)`
- `presets.getStored(target?)`
- `presets.save(target, body, options?)`
- `presets.readExtensions(target?, path?)`
- `presets.writeExtensions(target?, path, value)`
- `presets.state.get(namespace, options?)`
- `presets.state.getBatch(namespaces, options?)`
- `presets.state.patch(namespace, operations, options?)`
- `presets.state.update(namespace, updater, options?)`
- `presets.state.delete(namespace, options?)`
- `presets.state.deleteAll(target?)`

### Prompt/world-info assembly

- `getActivePromptPresetEnvelope(options?)`
- `getActivePromptLayout(options?)`
- `formatPromptPresetEnvelope(envelope, options?)`
- `buildPresetAwarePromptMessages(options)`
- `simulateWorldInfoActivation(options?)`
- `buildWorldInfoChatInput(messages, includeNames?)`
- `buildWorldInfoGlobalScanData(type, overrides?)`

#### Detailed parameter reference

##### Chat/message persistence

```ts
appendChatMessages(messages: ChatMessage[]): Promise<boolean>
```

- Appends one or more chat-format messages to the active chat/group chat.
- Writes are serialized internally so plugin writes do not race each other.
- Returns `true` when the incremental write succeeded.
- Returns `false` when no active target is available or the incremental write could not be reconciled.

```ts
patchChatMessages(operations: JsonPatchOperation[] | JsonPatchOperation): Promise<boolean>
```

- Applies RFC6902 operations against the chat message array root (`/0`, `/1`, ...).
- Luker auto-attaches lightweight `test` guards from the latest known message snapshot before sending the request.
- Returns `false` when the patch could not be reconciled and the caller should fall back, retry with a fresh snapshot, or stop.

```ts
saveChatMetadata(withMetadata?: object): Promise<boolean>
```

- Merges `withMetadata` into the current in-memory `chat_metadata` object and sends only the metadata diff.
- On success, Luker updates local integrity state used by subsequent chat writes.
- Prefer this over direct metadata endpoint calls from plugins.

##### Chat-bound plugin state

```ts
type ChatStateTarget =
  | { is_group: true, id: string }
  | { is_group: false, avatar_url: string, file_name: string }
```

- When `options.target` is omitted, Luker targets the currently open chat/group chat.
- Use explicit `target` values when working with branch creation flows, sidecar popups, or background processing on a different chat.

```ts
getChatStateBatch(
  namespaces: string[],
  options?: { target?: ChatStateTarget | null }
): Promise<Map<string, object | null>>
```

- Fetches multiple namespaces in one batched request.
- Namespace keys are normalized to lowercase.
- Missing or unreadable sidecars resolve to `null`.

```ts
getChatState(
  namespace: string,
  options?: { target?: ChatStateTarget | null }
): Promise<object | null>
```

- Convenience wrapper over `getChatStateBatch(...)`.
- Returns `null` when the namespace has no stored payload or no valid target is available.

```ts
patchChatState(
  namespace: string,
  operations: object[],
  options?: { target?: ChatStateTarget | null }
): Promise<boolean>
```

- Applies RFC6902 object patch operations to the namespace payload.
- Luker rebuilds optimistic `test` guards from the freshest server state and retries once on `409`.
- Returns `false` when no valid target/namespace exists or the patch still fails after recovery.

```ts
updateChatState(
  namespace: string,
  updater: (
    currentState: object,
    meta?: {
      attempt: number,
      target: ChatStateTarget,
      namespace: string,
    }
  ) => object | null | undefined | Promise<object | null | undefined>,
  options?: {
    target?: ChatStateTarget | null,
    maxOperations?: number,
    maxRetries?: number,
    asyncDiff?: boolean,
  }
): Promise<{ ok: boolean, state: object | null, updated: boolean }>
```

- Recommended helper when next state depends on the latest server value.
- `updater` receives a cloned plain-object snapshot of current state.
- Return `null` / `undefined` to skip writing.
- `updated=false` means no write was needed; `ok=false` means the state could not be persisted.

```ts
deleteChatState(
  namespace: string,
  options?: { target?: ChatStateTarget | null }
): Promise<boolean>
```

- Deletes the namespace sidecar file for the target chat.
- Useful for teardown or explicit reset flows.

Practical rules:

- Use `updateChatState(...)` for read-modify-write logic instead of manually chaining `getChatState(...)` + `patchChatState(...)`.
- Keep namespace payloads JSON-serializable plain objects.
- Prefer chat state sidecars over stuffing large plugin objects into `chat_metadata`.
- Treat `false` / `ok=false` as “state not persisted” and keep your plugin UI resilient.

##### Preset helpers

```ts
type PresetRef = {
  collection: string,
  name: string,
}

type PresetSnapshot = {
  ref: PresetRef,
  body: object,
  source: 'live' | 'stored',
  selected: boolean,
  stored: boolean,
}
```

Important scope rules:

- `collection` here means preset collection (`openai`, `context`, `instruct`, `sysprompt`, `reasoning`, `kobold`, `novel`, `textgenerationwebui`), not API endpoint/proxy presets.
- `presets.list(...)` and `presets.getSelected(...)` only work with stored presets.
- OpenAI character-bound runtime presets are intentionally excluded from stored refs. When such a runtime preset is active, `presets.getSelected('openai')` returns `null`, while `presets.getLive('openai')` still returns the current live body with `stored: false`.

```ts
presets.list(collection?: string): Array<PresetRef>
```

- Lists stored preset refs for the collection.
- Preserves the collection’s UI ordering.
- Safe for building pickers or cross-preset copy flows.

```ts
presets.resolve(
  target?: PresetRef | { collection?: string, name?: string } | string | null,
  options?: { collection?: string, defaultCollection?: string }
): PresetRef | null
```

- Resolves a preset target to the canonical stored preset ref currently known to the UI.
- If `target` omits `name`, Luker resolves the currently selected stored preset for that collection.
- Returns `null` when no stored preset target is available.
- `save(...)` is the only helper that accepts a new preset name not already in the stored list.

```ts
presets.getSelected(collection?: string): PresetRef | null
```

- Returns the currently selected stored preset ref for the collection.
- Returns `null` when the active selection is runtime-only or invalid.

```ts
presets.getLive(collection?: string): PresetSnapshot | null
```

- Returns the current live preset body from the UI/settings layer.
- Use this when your plugin edits the preset currently loaded in the editor, even if the user has unsaved changes.
- `stored: false` means the live preset is not currently backed by a stored preset ref.

```ts
presets.getStored(target?: PresetRef | object | string | null): PresetSnapshot | null
```

- Returns a cloned stored preset snapshot.
- Returns `null` when the target does not resolve to an existing stored preset.
- Use this for diffing against another saved preset without pulling editor-only live state.

```ts
presets.save(
  target: PresetRef | { collection?: string, name?: string },
  body: object,
  options?: {
    collection?: string,
    select?: boolean,
    maxOperations?: number,
  }
): Promise<{
  ok: boolean,
  ref: PresetRef | null,
  mode: 'patch' | 'full' | 'noop',
  operations: object[],
  response?: Response | null,
  body?: object | null,
  snapshot?: PresetSnapshot | null,
}>
```

- Persists a preset body using the same patch-first strategy as core preset saves.
- `mode='patch'` means Luker stored the change through `/api/presets/patch`; `mode='full'` means it fell back to a full save; `mode='noop'` means no change was needed.
- By default, Luker only re-selects the preset in UI when saving the currently selected stored preset. Pass `select: true` to force selection.
- This is the preferred helper for plugin-authored preset edits; you do not need to build raw preset patches yourself.

```ts
presets.readExtensions(
  target?: PresetRef | object | string | null,
  path?: string
): any

presets.writeExtensions(
  target?: PresetRef | object | string | null,
  path?: string,
  value?: any
): Promise<boolean>
```

- Reads or writes `preset.extensions` payloads through the same preset-manager semantics used by core.
- Use this only for actual preset content. For plugin runtime/session data, prefer `presets.state.*`.

```ts
presets.state.get(
  namespace: string,
  options?: { collection?: string, target?: PresetRef | object | string | null }
): Promise<object | null>

presets.state.getBatch(
  namespaces: string[],
  options?: { collection?: string, target?: PresetRef | object | string | null }
): Promise<Map<string, object | null>>

presets.state.patch(
  namespace: string,
  operations: object[],
  options?: { collection?: string, target?: PresetRef | object | string | null }
): Promise<boolean>

presets.state.update(
  namespace: string,
  updater: (currentState: object, meta?: {
    attempt: number,
    target: PresetRef,
    namespace: string,
  }) => object | null | undefined | Promise<object | null | undefined>,
  options?: {
    collection?: string,
    target?: PresetRef | object | string | null,
    maxOperations?: number,
    maxRetries?: number,
    asyncDiff?: boolean,
  }
): Promise<{ ok: boolean, state: object | null, updated: boolean }>

presets.state.delete(
  namespace: string,
  options?: { collection?: string, target?: PresetRef | object | string | null }
): Promise<boolean>

presets.state.deleteAll(
  target?: PresetRef | object | string | null
): Promise<boolean>
```

- These helpers store plugin state in preset-bound sidecar files instead of polluting preset bodies or global settings.
- When `target` is omitted, Luker uses the currently selected stored preset for that collection.
- If no stored preset target exists, these helpers return `null`, `false`, or an empty result instead of silently binding state to an ephemeral runtime preset name.
- Use `update(...)` for read-modify-write logic and `patch(...)` only when you already have a precise RFC6902 object patch.

##### Prompt/world-info assembly

Function signatures:

```ts
getActivePromptPresetEnvelope({
  includeCharacterCard = true,
  api = context.mainApi,
  promptPresetName = '',          // alias of completionPresetName
  completionPresetName = '',
  contextPresetName = '',
  instructPresetName = '',
  syspromptPresetName = '',
  reasoningPresetName = '',
} = {})
```

- Returns a full envelope object containing:
  - `presetRefs`
  - `promptCore` (`completion/context/instruct/sysprompt/reasoning`)
  - `promptLayout`
  - `promptCatalog`
  - optional `characterCard` (when `includeCharacterCard=true`)

```ts
getActivePromptLayout(options = {})
```

- `options` uses the same fields as `getActivePromptPresetEnvelope`.
- Returns normalized prompt layout only (`envelope.promptLayout` normalized).

```ts
formatPromptPresetEnvelope(envelope?, { label = 'LUKER_PRESET_ENVELOPE' } = {})
```

- If `envelope` is omitted, Luker uses current active envelope.
- Returns:
  - `[[<label>]]`
  - JSON string of the envelope

```ts
buildPresetAwarePromptMessages({
  taskSystem = '',
  taskUser = '',
  messages = [],                  // [{ role, content }] preferred
  envelope = null,                // optional prebuilt envelope
  envelopeOptions = {},           // used when envelope is null
  promptPresetName = '',          // completion preset shortcut
  runtimeWorldInfo = null,        // optional WI override bundle
} = {})
```

- `messages` replaces only chat-history content in preset layout.
- Standard tool-call history is preserved when included in `messages`:
  - assistant messages may carry `tool_calls`
  - tool messages may carry `tool_call_id`
- `taskSystem` / `taskUser` are legacy compatibility fields and are only used when `messages` is empty.
- `runtimeWorldInfo` is entries-first and supports:
  - `worldInfoBeforeEntries: string[]`
  - `worldInfoAfterEntries: string[]`
  - `worldInfoDepth: Array<{ depth: number, role: 'system'|'user'|'assistant'|number, entries: string[] }>`
  - `outletEntries: object`
  - `worldInfoExamples: any[]`
  - `anBefore: string[]`
  - `anAfter: string[]`
- If `runtimeWorldInfo` is omitted or `null`, Luker falls back to the currently active world-info prompt fields when composing preset-aware plugin messages.
- Pass `runtimeWorldInfo: {}` to explicitly suppress that fallback and build a preset-aware request with no world-info content.
- Throws when prompt layout cannot produce a valid plugin message sequence.

```ts
simulateWorldInfoActivation({
  coreChat = [],                  // ChatMessage[] in chronological order
  maxContext = undefined,         // default: current context size
  dryRun = false,
  type = 'normal',                // normal/continue/regenerate/swipe/...
  chatForWI = undefined,          // optional prebuilt string[]
  includeNames = true,
  globalScanData = undefined,     // optional override object
} = {})
```

- Returns WI resolution + normalized request inputs:
  - `worldInfoString`
  - `worldInfoBeforeEntries`
  - `worldInfoAfterEntries`
  - `worldInfoExamples`
  - `worldInfoDepth`
  - `outletEntries`
  - `anBefore`
  - `anAfter`
  - `chatForWI`
  - `maxContext`
  - `globalScanData`

#### World-info runtime contract

- Treat world-info as structured entry arrays, not as pre-flattened text blocks.
- Use `worldInfoBeforeEntries` / `worldInfoAfterEntries` in plugin code, helper payloads, and generation hook payloads.
- If your plugin needs a flat string for display or a custom downstream payload, join the entry arrays explicitly at the edge of your integration.
- `GENERATION_AFTER_WORLD_INFO_SCAN` and `GENERATION_WORLD_INFO_FINALIZED` expose the same entries-first WI fields listed above.

```ts
buildWorldInfoChatInput(messages, includeNames = true)
```

- `messages` should be chronological and use chat shape (`{ name, mes, ... }`).
- Returns reversed `string[]` for WI scanner.

```ts
buildWorldInfoGlobalScanData(type, overrides = {})
```

- `type` is generation trigger type.
- Base payload fields:
  - `personaDescription`
  - `characterDescription`
  - `characterPersonality`
  - `characterDepthPrompt`
  - `scenario`
  - `creatorNotes`
  - `trigger`
- `overrides` is merged last and can replace any of the fields above.

Behavior notes:

- `buildPresetAwarePromptMessages(options)` preserves active preset content outside chat-history and only replaces chat-history with your supplied message list.
- Plugin-only regex rules are applied to the caller-supplied chat messages and `runtimeWorldInfo` passed into `buildPresetAwarePromptMessages(options)`.
- For popup/sidecar generation, run world-info simulation/finalization helpers before composing the final request body if you need the same world-info behavior as main chat generation.
- If your plugin composes request messages after `GENERATION_WORLD_INFO_FINALIZED`, depth-based world-info injections are preserved in the final payload.

#### Best practices

- Prefer `messages` over legacy `taskSystem/taskUser` in new code.
- For popup/sidecar generation, call `simulateWorldInfoActivation(...)` and pass its result into `runtimeWorldInfo` to keep WI behavior consistent with main generation.
- Keep chat inputs chronological before calling `buildWorldInfoChatInput(...)`.
- Use `envelopeOptions` / `promptPresetName` instead of manually reconstructing preset internals.

#### Minimal popup chain example (recommended)

```js
const context = Luker.getContext();

const wi = await context.simulateWorldInfoActivation({
  coreChat: popupMessages, // [{ name, is_user, is_system, mes }]
  type: 'normal',
  includeNames: true,
});

const requestMessages = context.buildPresetAwarePromptMessages({
  messages: popupMessages.map(m => ({
    role: m.is_user ? 'user' : (m.is_system ? 'system' : 'assistant'),
    content: m.mes,
  })),
  runtimeWorldInfo: {
    worldInfoBeforeEntries: wi.worldInfoBeforeEntries,
    worldInfoAfterEntries: wi.worldInfoAfterEntries,
    worldInfoDepth: wi.worldInfoDepth,
    outletEntries: wi.outletEntries,
    worldInfoExamples: wi.worldInfoExamples,
    anBefore: wi.anBefore,
    anAfter: wi.anAfter,
  },
});
```

#### Stateful plugin example (chat-bound sidecar)

```js
const context = Luker.getContext();
const NAMESPACE = 'my-plugin';

async function recordOpen(target = null) {
  return await context.updateChatState(NAMESPACE, (current = {}) => ({
    ...current,
    stats: {
      ...current.stats,
      opens: Number(current.stats?.opens || 0) + 1,
      lastOpenedAt: Date.now(),
    },
  }), { target });
}

context.eventSource.on(context.eventTypes.MESSAGE_EDITED, async (_messageId, meta) => {
  if (!meta) return;

  await context.updateChatState(NAMESPACE, (current = {}) => ({
    ...current,
    lastEditedAt: Date.now(),
    lastEditedPlayableSeq: meta.playableSeq,
    lastEditedAssistantSeq: meta.assistantSeq,
  }));
});

context.eventSource.on(context.eventTypes.CHAT_BRANCH_CREATED, async (payload) => {
  const sourceState = await context.getChatState(NAMESPACE, {
    target: payload.sourceTarget,
  });

  if (!sourceState) return;

  await context.updateChatState(NAMESPACE, () => ({
    ...sourceState,
    branch: {
      sourceMesId: payload.mesId,
      branchName: payload.branchName,
      copiedAt: Date.now(),
    },
  }), {
    target: payload.targetTarget,
  });
});
```

Why this pattern works:

- `updateChatState(...)` keeps the read-modify-write sequence aligned with the latest persisted sidecar state.
- `MESSAGE_EDITED` updates only lightweight invalidation metadata.
- `CHAT_BRANCH_CREATED` copies state to the new chat target explicitly instead of assuming “current chat” has already switched.

### Regex runtime API (plugin-side)

For plugin-owned temporary regex rules, use the regex runtime provider API instead of writing into global/scoped/preset regex storage.

Module path:

```js
import {
  registerRegexProvider,
  registerManagedRegexProvider,
  unregisterRegexProvider,
  notifyRuntimeRegexScriptsChanged,
  regex_placement,
  substitute_find_regex,
} from '../regex/engine.js';
```

Function signatures:

```ts
registerRegexProvider(
  owner: string,
  provider: (options?: { allowedOnly?: boolean }) => RegexScript[] | null | undefined,
  options?: { reloadOnChange?: boolean }   // default: false
): {
  owner: string,
  refresh(options?: { requestReload?: boolean }): void,
  unregister(): void,
} | null
```

- Registers an in-memory provider keyed by `owner`.
- Re-registering with the same `owner` replaces the previous provider.
- Runtime scripts are never persisted to settings/character/preset files.
- `reloadOnChange=true` dispatches a runtime event requesting chat reload.
- The returned handle lets provider owners refresh the regex UI/runtime list without reaching for a separate global notify helper.

```ts
registerManagedRegexProvider(
  owner: string,
  options?: { reloadOnChange?: boolean }   // default: false
): {
  owner: string,
  refresh(options?: { requestReload?: boolean }): void,
  unregister(): void,
  upsertScript(script: RegexScript, options?: { requestReload?: boolean }): boolean,
  removeScript(scriptId: string, options?: { requestReload?: boolean }): boolean,
  setScripts(scripts: RegexScript[] | null | undefined, options?: { requestReload?: boolean }): void,
  clearScripts(options?: { requestReload?: boolean }): void,
  getScripts(): RegexScript[],
} | null
```

- Creates and registers an engine-managed runtime regex collection keyed by `owner`.
- Use this when your plugin wants `upsert/remove/set/clear` semantics instead of a pure callback provider.
- Managed scripts are never persisted to settings/character/preset files.
- Managed scripts require stable `id` values.

```ts
unregisterRegexProvider(owner: string): void
```

- Removes the provider by `owner`.
- If the removed provider was registered with `reloadOnChange=true`, unregister also requests a reload via runtime event.

```ts
notifyRuntimeRegexScriptsChanged({ requestReload?: boolean } = {}): void
```

- Triggers `luker:regex-runtime-scripts-changed`.
- Use this when provider output depends on mutable plugin settings/state and the provider function itself does not change.
- Set `requestReload=true` only when your regex changes require immediate chat re-render.

```ts
getRegexScripts({ allowedOnly = false } = {}): RegexScript[]
getRuntimeRegexScripts({ allowedOnly = false } = {}): RegexScript[]
runRegexScript(script: RegexScript, raw: string, { characterOverride? } = {}): string
```

- `getRegexScripts(...)` returns persisted scripts + runtime provider scripts.
- `getRuntimeRegexScripts(...)` returns runtime provider scripts only (read-only/debug use).
- `runRegexScript(...)` executes one script against a string without mutating storage.

`RegexScript` fields (runtime provider output) follow `RegexScriptData` shape. Required/important fields:

- `scriptName: string` (required, non-empty)
- `findRegex: string` (e.g. `'/[\\s\\S]*/g'`)
- `replaceString: string`
- `placement: number[]` (use `regex_placement` enum)
- `disabled: boolean`
- Optional controls: `promptOnly`, `markdownOnly`, `pluginOnly`, `runOnEdit`, `substituteRegex`, `trimStrings`, `minDepth`, `maxDepth`

Enums:

```ts
regex_placement = {
  MD_DISPLAY: 0,   // deprecated
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  WORLD_INFO: 5,
  REASONING: 6,
}

substitute_find_regex = {
  NONE: 0,
  RAW: 1,
  ESCAPED: 2,
}
```

Provider example:

```js
const OWNER = 'my-plugin:visible-window';
const runtimeRegex = registerRegexProvider(OWNER, () => buildRuntimeRegexScripts(), { reloadOnChange: false });

function buildRuntimeRegexScripts() {
  const n = Number(extension_settings.my_plugin?.visibleAssistantTurns ?? 0);
  if (n <= 0) return [];
  return [{
    id: `${OWNER}:mask`,
    scriptName: `My Plugin Visible Window (${n})`,
    findRegex: '/[\\s\\S]*/g',
    replaceString: '',
    trimStrings: [],
    placement: [regex_placement.USER_INPUT, regex_placement.AI_OUTPUT],
    disabled: false,
    markdownOnly: false,
    promptOnly: true,
    pluginOnly: false,
    runOnEdit: false,
    substituteRegex: substitute_find_regex.NONE,
    minDepth: n,
    maxDepth: 999999,
  }];
}

// Later, when plugin settings changed:
runtimeRegex?.refresh({ requestReload: false });

// On plugin teardown:
runtimeRegex?.unregister();
```

Managed collection example:

```js
const OWNER = 'my-plugin:visible-window';
const runtimeRegex = registerManagedRegexProvider(OWNER, { reloadOnChange: false });

function syncVisibleWindowRegex() {
  const n = Number(extension_settings.my_plugin?.visibleAssistantTurns ?? 0);
  if (!runtimeRegex) return;

  if (n <= 0) {
    runtimeRegex.clearScripts();
    return;
  }

  runtimeRegex.upsertScript({
    id: `${OWNER}:mask`,
    scriptName: `My Plugin Visible Window (${n})`,
    findRegex: '/[\\s\\S]*/g',
    replaceString: '',
    trimStrings: [],
    placement: [regex_placement.USER_INPUT, regex_placement.AI_OUTPUT],
    disabled: false,
    markdownOnly: false,
    promptOnly: true,
    pluginOnly: false,
    runOnEdit: false,
    substituteRegex: substitute_find_regex.NONE,
    minDepth: n,
    maxDepth: 999999,
  });
}

syncVisibleWindowRegex();

// On plugin teardown:
runtimeRegex?.unregister();
```

Best practices:

- Keep provider pure and deterministic from current plugin state.
- Prefer `registerManagedRegexProvider(...)` when plugin state naturally maps to a small mutable set of runtime scripts.
- Use stable `owner` IDs and stable `scriptName` values.
- Use stable runtime script `id` values when using the managed collection API.
- Prefer `reloadOnChange=false` unless UI rendering must update immediately.
- Prefer runtime providers for plugin-temporary behavior; use persisted regex storage only for user-managed rules.

### Search tools runtime API (plugin-side)

When the `search-tools` extension is loaded, it exposes a reusable runtime API on `Luker.searchTools` for popup/sidecar flows that want search + visit tool calls without duplicating schema or dispatch logic.

Global object:

```js
const searchTools = Luker.searchTools;
```

Behavior notes:

- This runtime API is available independently from the `Expose tools to main model` setting.
- The setting only controls whether `luker_web_search` / `luker_web_visit` are registered for the main generation model.
- Plugin-side callers decide whether to include these tools in their own request loop.

Available fields:

```ts
Luker.searchTools = {
  toolNames: {
    SEARCH: 'luker_web_search',
    VISIT: 'luker_web_visit',
  },
  getToolDefs(): Array<{
    type: 'function',
    function: {
      name: string,
      description: string,
      parameters: object,
    },
  }>,
  isToolName(name: string): boolean,
  invoke(
    call: { name?: string, args?: object },
    options?: { abortSignal?: AbortSignal | null }
  ): Promise<any>,
  search(args?: object, options?: { abortSignal?: AbortSignal | null }): Promise<any>,
  visit(args?: object, options?: { abortSignal?: AbortSignal | null }): Promise<any>,
  getSettings(): {
    enabled: boolean,
    preRequestEnabled: boolean,
    provider: string,
    defaultMaxResults: number,
    defaultVisitMaxChars: number,
    safeSearch: string,
    agentApiPresetName: string,
    agentPresetName: string,
    agentMaxRounds: number,
    lorebookDepth: number,
    lorebookRole: number,
    lorebookEntryOrder: number,
  },
}
```

Method notes:

- `toolNames` exposes the canonical tool names to reference in prompts or routing logic.
- `getToolDefs()` returns function-tool definitions suitable for popup/sidecar tool-calling loops.
- `isToolName(name)` is the routing helper for splitting search tool calls from your own plugin tool calls.
- `invoke(call, options)` dispatches one canonical search tool call by `name`.
- `search(...)` and `visit(...)` are the low-level direct methods if you do not need tool-call routing.
- `visit(...)` currently requests `/api/search/visit` with `reader: 'jina'` and falls back server-side to direct page fetch when the public `https://r.jina.ai/` reader cannot provide content.
- `getSettings()` returns normalized runtime settings currently active for the search-tools extension.

Minimal popup loop example:

```js
const searchApi = Luker.searchTools;
const tools = [
  ...myPluginTools,
  ...searchApi.getToolDefs(),
];

const { calls } = await requestToolCalls(tools);
const pluginCalls = [];
const searchCalls = [];

for (const call of calls) {
  if (searchApi.isToolName(call?.name)) {
    searchCalls.push(call);
  } else {
    pluginCalls.push(call);
  }
}

for (const call of searchCalls) {
  const result = await searchApi.invoke(call);
  // Feed result back into your own loop/context.
}
```

### Lorebook/world info persistence

- `loadWorldInfo(name)`
- `saveWorldInfo(name, data, immediately?)` (patch-first RFC6902 persistence path)

## 2) Generation Hooks and Event Ordering (Recommended)

Register generation-time logic with:

- `context.eventSource.on(context.eventTypes.GENERATION_CONTEXT_READY, handler)`
- `context.eventSource.on(context.eventTypes.GENERATION_BEFORE_WORLD_INFO_SCAN, handler)`
- `context.eventSource.on(context.eventTypes.GENERATION_AFTER_WORLD_INFO_SCAN, handler)`
- `context.eventSource.on(context.eventTypes.GENERATION_WORLD_INFO_FINALIZED, handler)`
- `context.eventSource.on(context.eventTypes.GENERATION_BEFORE_API_REQUEST, handler)`

`GENERATION_CONTEXT_READY` is emitted before world-info scanning and lets plugins adjust the core chat slice or effective context limit for the current request.

Payload shape:

```ts
{
  type: string,
  dryRun: boolean,
  isContinue: boolean,
  isImpersonate: boolean,
  coreChat: ChatMessage[],
  maxContext: number,
}
```

### Listener ordering semantics

Luker event listeners are awaited serially. Listener execution order is:

1. Explicit per-event plugin order (`pluginOrder`) when provided by `eventSource.setOrderConfig(...)` or the built-in Hook Order extension.
2. Listener `priority` passed as the third argument to `eventSource.on(...)` (higher number runs earlier).
3. Listener registration order (earlier registration runs earlier).

Useful APIs:

- `context.eventSource.on(eventName, handler, { priority })`
- `context.eventSource.makeFirst(eventName, handler)`
- `context.eventSource.makeLast(eventName, handler)`
- `context.eventSource.getListenersMeta(eventName)`

Practical notes:

- The built-in Hook Order extension writes per-event `pluginOrder` for selected core hooks. If no explicit order is configured, default priority/registration ordering applies.
- Plugin identity for ordering/debugging is inferred from the extension path, including third-party extensions (`third-party/<name>`).
- `APP_READY` is auto-fired: listeners registered after app startup still receive the last emitted `APP_READY` arguments immediately.

### Common hook placement guide

| Hook | Use it for | Avoid |
| --- | --- | --- |
| `GENERATION_CONTEXT_READY` | Trimming/replacing `coreChat`, adjusting per-request context limits | Logic that depends on finalized world-info output |
| `GENERATION_BEFORE_WORLD_INFO_SCAN` | Temporary mutations that should affect lorebook/world-info scanning | Last-mile request-body edits |
| `GENERATION_WORLD_INFO_FINALIZED` | Reading finalized WI resolution, depth injections, or branch-aware sidecar state | Reconstructing assumptions about the pre-scan chat slice |
| `GENERATION_BEFORE_API_REQUEST` | Final request inspection, tool/runtime wiring, provider-specific addenda | Changes that must influence world-info activation |
| `MESSAGE_EDITED` / `MESSAGE_UPDATED` / `MESSAGE_DELETED` | `MESSAGE_EDITED` for mutation-aware invalidation, `MESSAGE_UPDATED` for lightweight per-message refresh work, `MESSAGE_DELETED` for truncation/removal handling | Heavy rescans on every render |
| `CHAT_BRANCH_CREATED` | Copying/truncating chat-bound plugin state to the branch target | Blindly copying “latest” state without considering `mesId` |

Lifecycle hooks:

- `GENERATION_STARTED`
- `GENERATION_STOPPED`
- `GENERATION_ENDED`

Chat lifecycle hooks commonly used by plugins:

- `CHAT_CHANGED`
- `CHAT_CREATED`
- `GROUP_CHAT_CREATED`
- `CHAT_BRANCH_CREATED`
- `USER_MESSAGE_RENDERED`
- `CHARACTER_MESSAGE_RENDERED`
- `MESSAGE_SENT`
- `MESSAGE_RECEIVED`
- `MESSAGE_EDITED`
- `MESSAGE_UPDATED`
- `MESSAGE_DELETED`
- `MESSAGE_SWIPED`
- `MESSAGE_SWIPE_DELETED`

`MESSAGE_RECEIVED` is emitted as:

```ts
(messageId: number, type?: string)
```

Common `type` values include normal generation modes such as `swipe`, `continue`, `append`, `appendfinal`, plus non-standard sources like `first_message`, `command`, or `extension`.

`MESSAGE_EDITED` is emitted as:

```ts
(messageId: number, meta?: {
  messageId: number,
  playableSeq: number | null,
  assistantSeq: number | null,
  isUser: boolean,
  isAssistant: boolean,
  isSystem: boolean,
})
```

The second `meta` argument is backward-compatible and may be absent for older emitters. Use it when your plugin needs immediate invalidation based on the edited message position/type.

`MESSAGE_UPDATED` is emitted as:

```ts
(messageId: number)
```

Use `MESSAGE_UPDATED` for lightweight "message block was refreshed locally" notifications when you do not need the richer edit/delete mutation metadata. Core emitters use it after confirmed edits and after canceling an inline edit that restores the rendered message block. If you need to know that message content definitely mutated, prefer `MESSAGE_EDITED`.

`MESSAGE_DELETED` is emitted as:

```ts
(chatLength: number, meta?: {
  kind: 'delete',
  deletedPlayableSeqFrom: number | null,
  deletedPlayableSeqTo: number | null,
  deletedAssistantSeqFrom: number | null,
  deletedAssistantSeqTo: number | null,
})
```

`MESSAGE_SWIPED` is emitted as:

```ts
(messageId: number, meta?: {
  pendingGeneration: boolean,
  previousSwipeId: number | null,
  nextSwipeId: number | null,
})
```

`MESSAGE_SWIPE_DELETED` is emitted as:

```ts
({
  messageId: number,
  swipeId: number,
  newSwipeId: number | null,
})
```

`CHAT_BRANCH_CREATED` is emitted after the new branch chat file is saved and before the UI switches into that branch. This is intended for chat-bound plugin state that needs to be copied or truncated for the new branch.

Payload shape:

```ts
{
  mesId: number,                  // branch point message index in source chat
  branchName: string,             // new branch chat id / file name
  assistantMessageCount: number,  // assistant turns included in the branch
  sourceTarget: {
    is_group: boolean,
    id?: string,                  // group chat id when is_group=true
    avatar_url?: string,          // character avatar when is_group=false
    file_name?: string,           // source character chat id when is_group=false
  },
  targetTarget: {
    is_group: boolean,
    id?: string,
    avatar_url?: string,
    file_name?: string,
  },
}
```

Practical rule:
- If your plugin stores chat-bound sidecar state and branch semantics depend on the cutoff point, use `CHAT_BRANCH_CREATED` to create the derived branch state instead of blindly copying the latest source state.

Practical rule:
- If you need to read/update lorebook-triggered context for this request, do it at `GENERATION_WORLD_INFO_FINALIZED`.

### Popup generation pattern (Recommended)

- Build popup-local messages first.
- Build preset-aware request messages with `buildPresetAwarePromptMessages(...)`.
- Run world-info simulation/finalization helpers or generation hooks in the same order as main generation.
- Send the final full `messages` array to your generation route.
- Do not manually strip world-info `before/after` sections from the assembled output.

## 3) Migration Rules

- Do not full-save entire chats after every tiny mutation.
- Use message patch ops for edit/delete/insert behavior.
- Use metadata patching for lightweight per-chat state.
- Use chat state sidecar for larger plugin objects.
- For app/global settings, prefer `saveSettings()` / `saveSettingsDebounced()` (Luker now routes these through settings patch internally).
- For lorebook edits, prefer `saveWorldInfo(...)` so built-ins and extensions get patch-first persistence automatically.
- Prefer context helpers to preserve compatibility and future internal changes.

## 4) Generation Resilience

Luker generation routes attach backend generation IDs (`x-luker-generation-id`) and use backend-owned job state, so reply persistence is decoupled from frontend connection stability.

This behavior is not limited to a single model provider route.

## 5) Legacy Compatibility

Legacy full-save routes are still available for compatibility:

- `/api/chats/save`
- `/api/chats/group/save`
- `/api/settings/save`

Luker internals and built-ins are patch-first; full-save is legacy compatibility, not the preferred path.

## 6) Low-level Endpoint Appendix (Advanced / Debug Only)

Most plugins should stop at the context helpers above.

The routes below are included for advanced debugging, migration audits, or integrations that cannot rely on `Luker.getContext()`. They are same-origin web-app routes, not the primary extension contract.

This appendix is intentionally partial and focuses on patch-first flows that plugin authors are most likely to inspect while debugging.

### Character chat

- `POST /api/chats/append`
- `POST /api/chats/patch`
- `POST /api/chats/meta/patch`
- `POST /api/chats/get-delta`

### Group chat

- `POST /api/chats/group/append`
- `POST /api/chats/group/patch`
- `POST /api/chats/group/meta/patch`
- `POST /api/chats/group/get-delta`

### Chat state sidecar

- `POST /api/chats/state/get`
- `POST /api/chats/state/get-batch`
- `POST /api/chats/state/patch`
- `POST /api/chats/state/delete`

### Settings

- `POST /api/settings/patch`

### World info

- `POST /api/worldinfo/patch`

### Search / visit

- `POST /api/search/visit`

Current `/api/search/visit` request-body notes:

- `url: string` is required.
- `html: boolean` defaults to `true`.
- `reader?: 'jina'` enables a Jina Reader-first fetch path (`https://r.jina.ai/<url>`) with automatic fallback to the original direct fetch path.

`html` semantics are intentionally narrow:

- `html=true` means “return HTML text”.
  - In direct-fetch mode, the server requires upstream `content-type` to be HTML and returns the raw HTML body.
  - In `reader: 'jina'` mode, the server wraps the readable text into a minimal HTML document so existing HTML-oriented callers can keep their parsing flow unchanged.
- `html=false` does not mean “extract readable text”.
  - It means “do not enforce HTML; proxy the upstream response bytes as-is”.
  - This is mainly for low-level callers that want passthrough behavior and should not be treated as a reader/text-extraction flag.

### Message patch operation format

Message patch routes now use RFC6902 operations against the message array root:

- `add` (insert message): `{ "op": "add", "path": "/2", "value": { ...message } }`
- `replace` (edit message): `{ "op": "replace", "path": "/5", "value": { ...message } }`
- `remove` (delete message): `{ "op": "remove", "path": "/3" }`
- `test` (recommended guard): `{ "op": "test", "path": "/5", "value": { ...expectedMessage } }`

Legacy custom message ops (`insert/update/delete/insert_many/update_many/delete_range/batch`) are no longer supported.

### Object patch format (`meta/patch`, `state/patch`, `settings/patch`, `worldinfo/patch`)

Object patch routes use RFC6902-style operations:

- `add`
- `remove`
- `replace`
- `test` (recommended guard)

Path uses JSON Pointer string format:

```json
{ "op": "replace", "path": "/extensions/memory/last_capsule", "value": { "ok": true } }
```

Luker context helpers auto-attach lightweight `test` guards on patch-first paths.

### Patch conflict and integrity semantics

- `409 Conflict` means patch preconditions failed (for example: stale state, `test` mismatch, or integrity mismatch).
- Treat `409` as recoverable: refresh latest state/delta, rebuild operations, then retry.
- `500` indicates server-side failure and should not be used as a normal patch-conflict response.
- Prefer context helpers so guard/integrity behavior stays aligned with Luker internals.

#### Low-level retry pattern (if you must call endpoints directly)

```js
async function patchWithRetry(buildRequestBody, fetchPatch, fetchLatest, maxRetries = 1) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const latest = await fetchLatest();
    const body = buildRequestBody(latest);
    const res = await fetchPatch(body);
    if (res.ok) return true;
    if (res.status !== 409) return false;
  }
  return false;
}
```

### Chat-completions request body

For generation requests, send the full `messages` array in the request body.

### Connection profile resolution (recommended for plugins)

If your plugin supports selecting a Connection Manager profile, do not manually map profile fields (`api`, `model`, `api-url`, `proxy`, `secret-id`, `function-calling-plain-text`, `function-calling-plain-text-error-retry`, `function-calling-plain-text-error-retry-max-attempts`) to request payload keys.

Use shared resolver:

- `public/scripts/extensions/connection-manager/profile-resolver.js`
- `resolveChatCompletionRequestProfile({ profileName, defaultApi, defaultSource })`

Return values:

- `requestApi`: normalized API family to use in `buildPresetAwarePromptMessages(...)`
- `apiSettingsOverride`: normalized connection override object for `sendOpenAIRequest(...)`

This keeps plugin behavior aligned with core connection semantics and avoids drift when new connection fields are added.

### Shared function-call runtime for extensions

Luker now exposes a shared helper module for extension-side tool calling:

- `public/scripts/extensions/function-call-runtime.js`

Core request API now also supports mode switching:

- `sendOpenAIRequest(type, messages, signal, options?)`
- New options:
  - `functionCallMode`: `'native' | 'prompt_xml' | 'prompt_json'` (default `'native'`; note: `prompt_json` is a legacy alias of `prompt_xml`, not a JSON-wire/output format)
  - `functionCallOptions` (optional):
    - `requiredFunctionName?: string`
    - `protocolStyle?: TOOL_PROTOCOL_STYLE.TABLE | TOOL_PROTOCOL_STYLE.JSON_SCHEMA`
    - `triggerSignal?: string` (auto-generated when omitted)

Behavior:

- `functionCallMode='native'`:
  - Uses normal `tools/tool_choice` flow.
  - If resolved request settings include `function_calling_plain_text=true`, runtime auto-upgrades to `prompt_xml` mode (applies to both chat and extension-internal requests).
- `functionCallMode='prompt_xml'`:
  - Preferred plain-text function-calling mode.
  - Core injects an early system protocol prompt automatically.
  - Core disables native tool payload for that request (`tools=[]` override) to avoid mixed modes.
  - Core parses model text response as Toolify-style XML tool-calls and normalizes it to `choices[0].message.tool_calls`.
  - Required payload shape is: trigger signal line, then one `<function_calls>` block with one or more `<function_call>` children, each using `<tool>` + `<args_json><![CDATA[{...}]]></args_json>`.
  - Model output may include optional text before the trigger signal / tool-call payload.
  - If a plugin requires a specific preamble format such as `<thought>...</thought>`, that contract should be defined by the plugin's own prompt, not by core protocol settings.
  - If model output has no trigger signal / no tool-call payload, core returns `tool_calls=[]` and leaves policy decisions to the caller/plugin.
  - If trigger signal appears but tool-call XML is invalid/unparseable, core throws request error.
  - Plugins can keep using `extractAllFunctionCalls(...)` as if it were native output.
- `functionCallMode='prompt_json'`:
  - Legacy alias for `prompt_xml`.
  - `prompt_json` does not switch the protocol to a JSON function-call wire format; response parsing remains XML tool-call parsing.
  - Core injects an early system protocol prompt automatically.
  - Core disables native tool payload for that request (`tools=[]` override) to avoid mixed modes.
  - Runtime behavior is identical to `prompt_xml`.
  - Model output may include optional text before the trigger signal / tool-call payload.
  - If a plugin requires a specific preamble format such as `<thought>...</thought>`, that contract should be defined by the plugin's own prompt, not by core protocol settings.
  - If model output has no trigger signal / no tool-call payload, core returns `tool_calls=[]` and leaves policy decisions to the caller/plugin.
  - If trigger signal appears but tool-call XML is invalid/unparseable, core throws request error.
  - Plugins can keep using `extractAllFunctionCalls(...)` as if it were native output.

Retry responsibility:

- `sendOpenAIRequest(...)` does **not** perform implicit retry loops for function-calling.
- Retry policy (if needed) is owned by the caller/plugin, including max attempts and retry conditions.

Recommended runtime exports (for custom parsing/contracts when needed):

- `buildPlainTextToolProtocolMessage(tools, options?)`
- `buildStrictFunctionCallOutputAddendum(options?)`
- `buildStrictThoughtAndFunctionOnlyAddendum(options?)` (legacy alias)
- `mergeSystemAddendumIntoPromptMessages(messages, addendum, tagOptions?)`
- `mergeUserAddendumIntoPromptMessages(messages, addendum, tagOptions?)`
- `extractFunctionCallArguments(responseData, functionName)`
- `extractAllFunctionCalls(responseData, allowedNames?)`
- `extractAllFunctionCallsFromText(responseData, allowedNames?)`
- `extractToolCallsFromResponse(responseData, allowedNames?)` (lenient)
- `extractToolCallsFromTextResponse(responseData, allowedNames?)` (lenient)
- `extractDisplayTextFromPlainTextFunctionResponse(rawText)`
- `getResponseMessageContent(responseData)`

Protocol styles:

- `TOOL_PROTOCOL_STYLE.TABLE` (compact function table)
- `TOOL_PROTOCOL_STYLE.JSON_SCHEMA` (function + JSON schema list)

Practical rules:

- Prefer `sendOpenAIRequest(..., { functionCallMode })` over manually injecting/parsing in each plugin.
- Prefer native tool-calling where available.
- Keep plain-text mode (`prompt_xml`) as fallback and keep the core contract minimal: trigger signal plus one parseable XML tool-call payload.
- If a plugin needs `<thought>` or any other fixed preamble format, require it in that plugin's own prompt.
- Use shared helpers instead of per-plugin parser copies to avoid drift.

### `secret_id` request override (chat-completions)

Luker supports an optional `secret_id` in chat-completions requests:

- `POST /api/backends/chat-completions/generate`
- `POST /api/backends/chat-completions/status`

Behavior:

- If `secret_id` is provided and valid for the selected provider key, backend uses that secret for this request.
- If missing/invalid, backend falls back to the provider's currently active secret.

Notes:

- Plugins should prefer profile resolver output over constructing `secret_id` manually.
- This is request-scoped override behavior; it does not rotate or mutate active secret selection globally.
