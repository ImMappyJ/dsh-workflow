/**
 * Core Domain —— 与详细技术设计 §2 一一对应。
 * 仅纯类型与默认值工厂，无任何宿主/UI 依赖。
 */
/**
 * 校验提交字段是否符合 inputSchema（任务 5）：
 * 返回错误列表，空 = 通过。缺失 schema / 无 fields 时宽松处理（兼容旧工作流）。
 */
export function validateInputFields(schema, fields) {
    const errs = [];
    const defs = schema?.fields ?? [];
    const values = fields ?? {};
    for (const f of defs) {
        const v = values[f.name];
        const missing = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
        if (f.required && missing) {
            errs.push(`缺少必填字段 ${f.label ?? f.name}（${f.type}）`);
            continue;
        }
        if (missing)
            continue;
        switch (f.type) {
            case 'number':
                if (typeof v !== 'number' && Number.isNaN(Number(v)))
                    errs.push(`字段 ${f.name} 需要数字`);
                break;
            case 'boolean':
                if (typeof v !== 'boolean' && v !== 'true' && v !== 'false')
                    errs.push(`字段 ${f.name} 需要布尔值`);
                break;
            case 'select':
                if (f.options?.length && !f.options.includes(String(v)))
                    errs.push(`字段 ${f.name} 不在选项范围内`);
                break;
            case 'json':
                if (typeof v === 'string') {
                    try {
                        JSON.parse(v);
                    }
                    catch {
                        errs.push(`字段 ${f.name} 不是合法 JSON`);
                    }
                }
                break;
            case 'file':
            case 'directory':
                if (typeof v !== 'string')
                    errs.push(`字段 ${f.name} 需要路径（字符串）`);
                break;
            case 'files':
                if (!Array.isArray(v))
                    errs.push(`字段 ${f.name} 需要路径数组`);
                break;
            default:
                break; // text / artifact：字符串即可，不硬校验
        }
    }
    return errs;
}
/** 第一阶段遗留 type 与 kind 的双向映射 */
export function kindFromLegacyType(t) {
    return t === 'markdown' ? 'markdown' : t === 'json' ? 'json' : 'text';
}
export function legacyTypeFromKind(k) {
    return k === 'markdown' ? 'markdown' : k === 'json' ? 'json' : 'plaintext';
}
/** outputContract.format → kind（引擎登记 Artifact 用） */
export function kindFromFormat(format) {
    if (format === 'markdown')
        return 'markdown';
    if (format === 'json')
        return 'json';
    return 'text';
}
// ---------------------------------------------------------------- defaults
export const DEFAULTS = {
    maxExecutionSteps: 100,
    MAX_EXECUTION_STEPS_HARD_LIMIT: 1000,
    defaultNodeMaxRuns: 5,
    maxIterations: 3,
    timeoutMs: 120_000,
    maxInputCharsPerSource: 8000,
    maxTotalInputChars: 24_000,
    defaultPort: 3090,
};
export function defaultRuntimeConfig(partial) {
    return {
        maxRuns: DEFAULTS.defaultNodeMaxRuns,
        timeoutMs: DEFAULTS.timeoutMs,
        onFailure: 'fail_workflow',
        ...partial,
        retry: { enabled: true, maxRetries: 2, backoffMs: 1000, ...partial?.retry },
    };
}
export function defaultSettings(partial) {
    return {
        maxExecutionSteps: DEFAULTS.maxExecutionSteps,
        defaultNodeMaxRuns: DEFAULTS.defaultNodeMaxRuns,
        ...partial,
    };
}
// ---------------------------------------------------------------- 第三阶段辅助
/** §4：旧 Definition 无 revision 时按 1 处理（向后兼容） */
export function effectiveRevision(def) {
    return typeof def.revision === 'number' && def.revision >= 1 ? Math.floor(def.revision) : 1;
}
/** §20：边路由缺省值——auto/bezier/无控制点 */
export function effectiveRouting(edge) {
    return {
        mode: edge.routing?.mode === 'manual' ? 'manual' : 'auto',
        type: edge.routing?.type ?? 'bezier',
        points: Array.isArray(edge.routing?.points) ? edge.routing.points : [],
    };
}
