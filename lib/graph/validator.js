/**
 * GraphValidator —— 结构校验 + 环检测（详细设计 §3 / §6.1）。
 * 错误（errors）阻止运行；警告（warnings）允许保存/运行但 UI 需提示。
 */
import { DEFAULTS, } from '../domain/types.js';
import { buildAdjacency, detectLoops } from './tarjan.js';
import { validateWorkspaceDir } from '../domain/workspace.js';
export function validateWorkflow(def) {
    const errors = [];
    const warnings = [];
    // Phase 8（§36）：Working Directory 安全边界
    {
        const ws = validateWorkspaceDir(def.settings?.workspaceDir);
        errors.push(...ws.errors);
        warnings.push(...ws.warnings);
    }
    // —— 基本结构 ——
    if (!Array.isArray(def.nodes) || def.nodes.length === 0) {
        errors.push({ code: 'empty_graph', message: 'workflow 不包含任何节点' });
        return { valid: false, errors, warnings, loops: [] };
    }
    const nodeIds = new Set(def.nodes.map(n => n.id));
    if (nodeIds.size !== def.nodes.length) {
        errors.push({ code: 'duplicate_node_id', message: '存在重复的节点 id' });
    }
    // —— start / end 节点 ——
    const starts = def.nodes.filter(n => n.type === 'start');
    const ends = def.nodes.filter(n => n.type === 'end');
    if (starts.length === 0)
        errors.push({ code: 'missing_start', message: '缺少 start 节点' });
    if (starts.length > 1)
        errors.push({ code: 'multiple_start', message: 'start 节点只能有一个' });
    if (ends.length === 0)
        errors.push({ code: 'missing_end', message: '缺少 end 节点' });
    if (ends.length > 1) {
        errors.push({ code: 'multiple_end', message: 'end 节点只能有一个', nodeId: ends[1].id });
    }
    // —— 节点字段 ——
    for (const n of def.nodes) {
        if (n.type === 'agent') {
            if (!n.identity?.name)
                errors.push({ code: 'missing_identity', message: `节点 ${n.id} 缺少 identity.name`, nodeId: n.id });
            if (!n.roleDescription)
                warnings.push({ code: 'missing_role', message: `节点 ${n.id} 未填写角色描述`, nodeId: n.id });
            if (n.runtimeConfig?.maxRuns !== undefined && n.runtimeConfig.maxRuns < 1) {
                errors.push({ code: 'invalid_max_runs', message: `节点 ${n.id} maxRuns 必须 >= 1`, nodeId: n.id });
            }
        }
        if (n.type !== 'start') {
            const badTargets = (n.outputContract?.targets ?? []).filter(t => !nodeIds.has(t));
            for (const t of badTargets) {
                warnings.push({ code: 'unknown_target', message: `节点 ${n.id} 的 output target "${t}" 不存在于图中`, nodeId: n.id });
            }
        }
    }
    // —— 边引用 ——
    for (const e of def.edges ?? []) {
        if (!nodeIds.has(e.source.nodeId)) {
            errors.push({ code: 'dangling_edge_source', message: `边 ${e.id} 的 source 节点不存在`, edgeId: e.id });
        }
        if (!nodeIds.has(e.target.nodeId)) {
            errors.push({ code: 'dangling_edge_target', message: `边 ${e.id} 的 target 节点不存在`, edgeId: e.id });
        }
        if (e.source.nodeId === e.target.nodeId) {
            warnings.push({ code: 'self_loop', message: `边 ${e.id} 是自环`, edgeId: e.id });
        }
    }
    // —— start 出边 / end 入边 ——
    if (starts.length === 1) {
        const startId = starts[0].id;
        const hasOut = (def.edges ?? []).some(e => e.source.nodeId === startId);
        if (!hasOut)
            errors.push({ code: 'start_no_out', message: 'start 节点没有出边' });
    }
    for (const end of ends) {
        const hasIn = (def.edges ?? []).some(e => e.target.nodeId === end.id);
        if (!hasIn)
            warnings.push({ code: 'end_no_in', message: `end 节点 ${end.id} 没有入边`, nodeId: end.id });
    }
    // —— settings 上限 ——
    const maxSteps = def.settings?.maxExecutionSteps ?? DEFAULTS.maxExecutionSteps;
    if (maxSteps < 1 || maxSteps > DEFAULTS.MAX_EXECUTION_STEPS_HARD_LIMIT) {
        errors.push({
            code: 'invalid_max_steps',
            message: `maxExecutionSteps 必须在 1..${DEFAULTS.MAX_EXECUTION_STEPS_HARD_LIMIT} 之间`,
        });
    }
    // —— 环检测（Tarjan SCC）——
    const adj = buildAdjacency((def.edges ?? []).map(e => ({ source: e.source.nodeId, target: e.target.nodeId })));
    const loops = detectLoops(def.nodes.map(n => n.id), adj);
    if (loops.length > 0) {
        warnings.push({ code: 'cycle_detected', message: `检测到 ${loops.length} 个循环，运行前需确认 Loop 上限配置` });
        // LoopConfig 覆盖检查：SCC 节点集合是否已有对应 loop 配置
        const configured = new Set();
        for (const loop of def.loops ?? []) {
            configured.add([...loop.nodeIds].sort().join(','));
        }
        loops.forEach((scc, i) => {
            const key = [...scc].sort().join(',');
            if (!configured.has(key)) {
                warnings.push({
                    code: 'loop_unconfigured',
                    message: `循环 #${i + 1}（${scc.join(' ⇄ ')}）缺少 maxIterations 配置，运行时按默认 ${DEFAULTS.maxIterations} 处理`,
                });
            }
        });
    }
    // —— 可达性：从 start 出发不可达的节点 ——
    const reachable = reachableFrom(starts[0]?.id, adj, nodeIds);
    for (const n of def.nodes) {
        if (n.type !== 'start' && !reachable.has(n.id)) {
            warnings.push({ code: 'unreachable_node', message: `节点 ${n.id} 从 start 不可达`, nodeId: n.id });
        }
    }
    return { valid: errors.length === 0, errors, warnings, loops };
}
function reachableFrom(start, adj, all) {
    const seen = new Set();
    if (!start || !all.has(start))
        return seen;
    const queue = [start];
    while (queue.length) {
        const cur = queue.pop();
        if (seen.has(cur))
            continue;
        seen.add(cur);
        for (const next of adj.get(cur) ?? []) {
            if (all.has(next) && !seen.has(next))
                queue.push(next);
        }
    }
    return seen;
}
/** 便捷构造：由 SCC 结果生成 LoopConfig（保存时补全缺失配置用） */
export function loopsFromSccs(sccs, existing, defaultMaxIterations = DEFAULTS.maxIterations) {
    const result = [...(existing ?? [])];
    sccs.forEach((scc, i) => {
        const key = [...scc].sort().join(',');
        const found = result.some(l => [...l.nodeIds].sort().join(',') === key);
        if (!found) {
            result.push({ loopId: `loop_${String(result.length + 1).padStart(3, '0')}`, nodeIds: [...scc], maxIterations: defaultMaxIterations });
        }
    });
    return result;
}
