const fs = require('fs');
let t = fs.readFileSync('e:/MyP/Sillytavern-Memory/memory-bridge/index.js', 'utf8');
let changed = 0;

function replaceOnce(label, oldStr, newStr) {
    const idx = t.indexOf(oldStr);
    if (idx === -1) { console.error('MISS: ' + label + ' [' + JSON.stringify(oldStr.slice(0,80)) + ']'); process.exit(1); }
    t = t.slice(0, idx) + newStr + t.slice(idx + oldStr.length);
    changed++;
    console.log('OK: ' + label);
}

// ─── 1. validateImportCandidate: remove old structural-format check ───
const OLD_VALIDATE = `    if (normalized.length < 20) return { ok: false, failureType: 'validation_failed', reason: '内容过短' };
    if (isGreetingLikeText(normalized)) return { ok: false, failureType: 'junk', reason: '寒暄输出' };
    if (/^(角色\/说话方|核心内容)\s*[：:]/m.test(normalized) && !/^检索关键词\s*[：:]/m.test(normalized)) {
        return { ok: false, failureType: 'validation_failed', reason: '缺少检索关键词' };
    }
    if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(normalized)) {`;
const NEW_VALIDATE = `    if (normalized.length < 20) return { ok: false, failureType: 'validation_failed', reason: '内容过短' };
    if (isGreetingLikeText(normalized)) return { ok: false, failureType: 'junk', reason: '寒暄输出' };
    if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(normalized)) {`;
replaceOnce('validateImportCandidate remove structural check', OLD_VALIDATE, NEW_VALIDATE);

// ─── 2. insert validateKeywordsCandidate before validateTaskLlmOutput ───
const VALIDATE_TASK = `function validateTaskLlmOutput(taskId, text) {
    if (taskId === 'import') return validateImportCandidate(text);`;
const NEW_VALIDATE_TASK = `function validateKeywordsCandidate(text) {
    const normalized = normalizeLlmText(text).replace(/\r?\n/g, ' ').trim();
    if (!normalized) return { ok: false, failureType: 'empty', reason: '空输出' };
    if (isGreetingLikeText(normalized)) return { ok: false, failureType: 'junk', reason: '寒暄输出' };
    if (normalized.length < 2) return { ok: false, failureType: 'validation_failed', reason: '关键词过短' };
    return { ok: true, content: normalized };
}

function validateTaskLlmOutput(taskId, text) {
    if (taskId === 'keywords') return validateKeywordsCandidate(text);
    if (taskId === 'import') return validateImportCandidate(text);`;
replaceOnce('insert validateKeywordsCandidate', VALIDATE_TASK, NEW_VALIDATE_TASK);

// ─── 3. Replace maybeProcessImportContent + add helpers before it ───
const OLD_MAYBE = `async function maybeProcessImportContent(message, settings = getSettings()) {
    const rawContent = buildImportContent(message);
    const localFallback = buildImportFallbackContent(message);
    const execution = await executeLlmTask('import', { input: rawContent }, {
        settings,
        fallback: () => localFallback || rawContent,
    }, settings);
    return execution.ok ? execution.content : '';
}`;
const NEW_MAYBE = `function buildFallbackKeywords(text) {
    const normalized = normalizeImportSourceText(text).replace(/\n+/g, ' ').trim();
    if (!normalized) return '';
    return Array.from(new Set(normalized.match(/[\u4e00-\u9fa5A-Za-z0-9_]{2,20}/g) || [])).slice(0, 8).join(' ');
}

async function generateImportKeywords(message, settings = getSettings()) {
    const rawText = normalizeImportSourceText(message?.text || '');
    const fallbackStr = buildFallbackKeywords(rawText);
    const execution = await executeLlmTask('import', { input: rawText }, {
        settings,
        fallback: () => fallbackStr,
    }, settings);
    const raw = execution.ok ? execution.content : fallbackStr;
    return raw.split(/[\s,，、;；|/]+/).map(k => k.trim()).filter(k => k.length >= 2).slice(0, 8);
}

async function maybeProcessImportContent(message, settings = getSettings()) {
    const rawContent = buildImportContent(message);
    const localFallback = buildImportFallbackContent(message);
    const execution = await executeLlmTask('import', { input: rawContent }, {
        settings,
        fallback: () => localFallback || rawContent,
    }, settings);
    return execution.ok ? execution.content : '';
}`;
replaceOnce('add generateImportKeywords + buildFallbackKeywords', OLD_MAYBE, NEW_MAYBE);

// ─── 4. runSelectedImport: use local-cleaned body, generateImportKeywords for triggers ───
const OLD_LOOP = `    for (const message of selectedMessages) {
        const processedContent = await maybeProcessImportContent(message, settings);
        if (!isImportContentMeaningful(processedContent)) {
            failures.push(\`#\${message.index + 1}: 导入内容无有效信息，已跳过\`);
            continue;
        }
        const disclosure = await generateDisclosure(message, settings);
        setDisclosurePreview(disclosure);
        const args = {
            parent_uri: parentUri,
            title: getImportTitle(message.index, settings),
            content: processedContent,
            priority: message.isUser ? 2 : 3,
            disclosure,
        };
        try {
            const createResult = await createMemory(args);
            const createdUriMatch = String(createResult || '').match(/'([^'\n]+:\/\/[^'\n]+)'/);
            const createdUri = createdUriMatch?.[1] || '';
            const keywords = extractImportKeywords(processedContent);
            if (createdUri && keywords.length) {
                await manageMemoryTriggers(createdUri, keywords);
            }
            successCount += 1;
        } catch (error) {
            failures.push(\`#\${message.index + 1}: \${getErrorMessage(error)}\`);
        }
    }`;
const NEW_LOOP = `    for (const message of selectedMessages) {
        const importBody = normalizeImportSourceText(message?.text || '');
        if (!isImportContentMeaningful(importBody)) {
            failures.push(\`#\${message.index + 1}: 导入内容无有效信息，已跳过\`);
            continue;
        }
        const keywords = await generateImportKeywords(message, settings);
        const disclosure = await generateDisclosure(message, settings);
        setDisclosurePreview(disclosure);
        const args = {
            parent_uri: parentUri,
            title: getImportTitle(message.index, settings),
            content: importBody,
            priority: message.isUser ? 2 : 3,
            disclosure,
        };
        try {
            const createResult = await createMemory(args);
            const createdUriMatch = String(createResult || '').match(/'([^'\n]+:\/\/[^'\n]+)'/);
            const createdUri = createdUriMatch?.[1] || '';
            if (createdUri && keywords.length) {
                await manageMemoryTriggers(createdUri, keywords);
            }
            successCount += 1;
        } catch (error) {
            failures.push(\`#\${message.index + 1}: \${getErrorMessage(error)}\`);
        }
    }`;
replaceOnce('runSelectedImport use importBody + generateImportKeywords', OLD_LOOP, NEW_LOOP);

// ─── 5. testCurrentLlmPreset: reject fallback source ───
const OLD_TEST = `    if (!execution.ok) {
        throw new Error(\`当前 LLM 预设测试失败: \${execution.failureType || 'unknown'}\`);
    }
    return execution.content;`;
const NEW_TEST = `    if (!execution.ok || execution.source !== 'llm') {
        const reason = !execution.ok ? (execution.failureType || 'unknown') : 'fallback (LLM 未实际响应)';
        throw new Error(\`当前 LLM 预设测试失败: \${reason}\`);
    }
    return execution.content;`;
replaceOnce('testCurrentLlmPreset reject fallback', OLD_TEST, NEW_TEST);

// ─── 6. shouldRetryLlmFailure: drop generic http ───
const OLD_RETRY = `    return ['rate_limit', 'timeout', 'network', 'http', 'empty'].includes(failureType);`;
const NEW_RETRY = `    return ['rate_limit', 'timeout', 'network'].includes(failureType);`;
replaceOnce('shouldRetryLlmFailure drop http+empty', OLD_RETRY, NEW_RETRY);

// ─── 7. preset migration: merge prompts by id ───
const OLD_PROMPTS_MERGE = `        prompts: Array.isArray(preset?.prompts) ? preset.prompts : JSON.parse(JSON.stringify(DEFAULT_LLM_PROMPTS)),`;
const NEW_PROMPTS_MERGE = `        prompts: (() => {
            const existingPrompts = Array.isArray(preset?.prompts) ? preset.prompts : [];
            const existingMap = new Map(existingPrompts.filter(p => p?.id).map(p => [p.id, p]));
            return DEFAULT_LLM_PROMPTS.map(def => ({ ...def, ...(existingMap.get(def.id) || {}) }));
        })(),`;
replaceOnce('preset migration prompts merge-by-id', OLD_PROMPTS_MERGE, NEW_PROMPTS_MERGE);

// ─── 8. syncCurrentLlmPresetFromUI: preserve custom meta ───
const OLD_IMPORT_META = `            systemPrompt: templateMap.import?.systemPrompt || '',
            validator: templateMap.import?.validator || 'import',
            maxTokens: templateMap.import?.maxTokens || 2000,`;
const NEW_IMPORT_META = `            systemPrompt: existingPromptMap.get('importPrompt')?.systemPrompt ?? templateMap.import?.systemPrompt ?? '',
            validator: existingPromptMap.get('importPrompt')?.validator ?? templateMap.import?.validator ?? 'keywords',
            maxTokens: existingPromptMap.get('importPrompt')?.maxTokens ?? templateMap.import?.maxTokens ?? 200,`;
replaceOnce('syncCurrentLlmPresetFromUI importPrompt meta', OLD_IMPORT_META, NEW_IMPORT_META);

const OLD_DISC_META = `            systemPrompt: templateMap.disclosure?.systemPrompt || '',
            validator: templateMap.disclosure?.validator || 'disclosure',
            maxTokens: templateMap.disclosure?.maxTokens || 200,`;
const NEW_DISC_META = `            systemPrompt: existingPromptMap.get('disclosurePrompt')?.systemPrompt ?? templateMap.disclosure?.systemPrompt ?? '',
            validator: existingPromptMap.get('disclosurePrompt')?.validator ?? templateMap.disclosure?.validator ?? 'disclosure',
            maxTokens: existingPromptMap.get('disclosurePrompt')?.maxTokens ?? templateMap.disclosure?.maxTokens ?? 200,`;
replaceOnce('syncCurrentLlmPresetFromUI disclosurePrompt meta', OLD_DISC_META, NEW_DISC_META);

const OLD_RECALL_META = `            systemPrompt: templateMap.recall?.systemPrompt || '',
            validator: templateMap.recall?.validator || 'recall',
            maxTokens: templateMap.recall?.maxTokens || 300,`;
const NEW_RECALL_META = `            systemPrompt: existingPromptMap.get('recallPrompt')?.systemPrompt ?? templateMap.recall?.systemPrompt ?? '',
            validator: existingPromptMap.get('recallPrompt')?.validator ?? templateMap.recall?.validator ?? 'recall',
            maxTokens: existingPromptMap.get('recallPrompt')?.maxTokens ?? templateMap.recall?.maxTokens ?? 300,`;
replaceOnce('syncCurrentLlmPresetFromUI recallPrompt meta', OLD_RECALL_META, NEW_RECALL_META);

fs.writeFileSync('e:/MyP/Sillytavern-Memory/memory-bridge/index.js', t);
console.log('\nAll', changed, 'patches applied.');
