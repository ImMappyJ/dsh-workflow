/**
 * NodeScheduler —— 依赖满足判定 + 循环重调度（详细设计 §5/§6）。
 *
 * 依赖语义：
 * - 输入版本号（inputVersion）= 所有直连上游的 output 记录总数（含 start 初始输入）。
 * - 循环节点：同一 Loop（SCC）内的上游为**可选依赖**（首轮尚无输出），Loop 外上游为必需依赖。
 *   环内上游产出新输出即可触发重跑。
 * - 非循环节点：全部上游为必需依赖（AND 汇合语义）。
 */
export class NodeScheduler {
    def;
    loopOfNode = new Map();
    /** 被禁用的节点集合（任务 2：执行时旁路，依赖透明传递） */
    disabled;
    constructor(def) {
        this.def = def;
        for (const loop of def.loops ?? []) {
            for (const n of loop.nodeIds)
                this.loopOfNode.set(n, loop.loopId);
        }
        this.disabled = new Set(def.nodes.filter(n => n.disabled === true).map(n => n.id));
    }
    isDisabled(nodeId) {
        return this.disabled.has(nodeId);
    }
    upstreamIds(nodeId) {
        return this.def.edges.filter(e => e.target.nodeId === nodeId).map(e => e.source.nodeId);
    }
    /**
     * 有效上游：禁用节点视为旁路（bypass），依赖透过它们向其更上游传导；
     * 链式禁用逐层解析，环内禁用链用 seen 防环。
     */
    resolveThroughDisabled(ids) {
        const queue = [...ids];
        const seen = new Set(ids);
        const out = [];
        while (queue.length) {
            const u = queue.shift();
            if (this.disabled.has(u)) {
                for (const uu of this.upstreamIds(u)) {
                    if (!seen.has(uu)) {
                        seen.add(uu);
                        queue.push(uu);
                    }
                }
            }
            else {
                out.push(u);
            }
        }
        return out;
    }
    /** 有效上游（直连 + 禁用旁路解析） */
    effectiveUpstreamIds(nodeId) {
        return this.resolveThroughDisabled(this.upstreamIds(nodeId));
    }
    /** 必需上游：非同 loop 的上游（循环节点的环内上游可选）；禁用旁路后同判 */
    requiredUpstreamIds(nodeId) {
        const myLoop = this.loopOfNode.get(nodeId);
        const ups = this.effectiveUpstreamIds(nodeId);
        if (myLoop === undefined)
            return ups; // 非循环节点：全部必需
        return ups.filter(u => this.loopOfNode.get(u) !== myLoop);
    }
    /** 上游 output 记录总数（含禁用旁路解析后的有效上游） */
    inputVersion(nodeId, state) {
        return this.effectiveUpstreamIds(nodeId).reduce((s, u) => s + (state.outputs[u]?.length ?? 0), 0);
    }
    /** 入边是否全部放行（Review Gate，§58）：passable=false 的边阻塞下游 */
    edgesPassable(nodeId, state) {
        return this.def.edges
            .filter(e => e.target.nodeId === nodeId)
            .every(e => state.edgeState[e.id]?.passable !== false);
    }
    /**
     * §32/§33: 审核期冻结——仅阻塞正在等待人工评估的节点自身，不冻结整个环。
     * 触发条件：环内存在待审任务（人工正在评估，机械追加迭代会提前耗尽迭代预算）。
     * 环成员间的 pendingFeedback 不影响其他成员（§22/§23：review 独立于 loop）。
     */
    loopAwaitingReview(nodeId, state) {
        const myLoop = this.loopOfNode.get(nodeId);
        if (myLoop === undefined)
            return false;
        // 仅阻塞有 pending review 的节点自身，不阻塞同环其他成员
        return state.reviewTasks.some(t => t.status === 'pending' && t.sourceNodeId === nodeId);
    }
    /** 必需依赖全部有输出 */
    depsSatisfied(nodeId, state) {
        if (this.upstreamIds(nodeId).length === 0)
            return false; // 无入边（只有 start 合法）
        return this.requiredUpstreamIds(nodeId).every(u => (state.outputs[u]?.length ?? 0) > 0);
    }
    /** 缺失的必需依赖（deadlock 诊断用） */
    missingDeps(nodeId, state) {
        return this.requiredUpstreamIds(nodeId).filter(u => (state.outputs[u]?.length ?? 0) === 0);
    }
    /** 节点是否"想运行"：必需依赖满足、入边放行、环未冻结且（从未运行，或上游版本号超过上次运行时） */
    wouldRun(nodeId, state) {
        if (this.disabled.has(nodeId))
            return false; // 禁用节点永不参与调度（任务 2）
        if (!this.depsSatisfied(nodeId, state))
            return false;
        if (!this.edgesPassable(nodeId, state))
            return false; // Review Gate 阻塞（§58）
        if (this.loopAwaitingReview(nodeId, state))
            return false; // §69 审核期冻结：等待人工评估
        const ns = state.nodeStates[nodeId];
        if (!ns)
            return false;
        if (ns.status === 'idle' || ns.status === 'waiting') {
            // 首次运行：至少一个上游已有输出（防止环内节点在无任何输入时启动）
            return this.effectiveUpstreamIds(nodeId).some(u => (state.outputs[u]?.length ?? 0) > 0);
        }
        if (ns.status === 'skipped' || ns.status === 'cancelled')
            return false;
        return this.inputVersion(nodeId, state) > (ns.lastInputVersion ?? 0);
    }
    /** 候选可运行节点（不含 start/end；loop/maxRuns 由 LoopController 把关） */
    nextRunnable(state) {
        return this.def.nodes
            .filter(n => n.type === 'agent' && this.wouldRun(n.id, state))
            .map(n => n.id);
    }
    /** 所有节点到达终态 */
    allSettled(state) {
        return this.def.nodes.every(n => {
            const st = state.nodeStates[n.id];
            return !!st && ['success', 'skipped', 'cancelled', 'failed'].includes(st.status);
        });
    }
    /** 是否存在待处理的人工审核（引擎用于判定 waiting_review） */
    hasPendingReview(state) {
        return state.reviewTasks.some(t => t.status === 'pending');
    }
    /** 是否存在待人工提交的 Human Task（Phase 11，引擎用于判定 waiting_human） */
    hasPendingHumanTask(state) {
        return (state.humanTasks ?? []).some(t => t.status === 'pending');
    }
}
