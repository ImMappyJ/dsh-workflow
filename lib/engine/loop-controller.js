/**
 * LoopController —— 三层限制（详细设计 §6）：
 * 1. 全局 stepCount  2. 节点 maxRuns  3. Loop maxIterations（SCC 内 max(runCount) 近似计数）
 */
import { DEFAULTS } from '../domain/types.js';
export class LoopController {
    def;
    loopOfNode = new Map(); // nodeId -> loopId
    constructor(def) {
        this.def = def;
        for (const loop of def.loops ?? []) {
            for (const n of loop.nodeIds)
                this.loopOfNode.set(n, loop.loopId);
        }
    }
    /** 节点属于哪个 loop（未配置 LoopConfig 的 SCC 由 validator 生成默认配置，正常不应为空） */
    loopIdOf(nodeId) {
        return this.loopOfNode.get(nodeId);
    }
    maxIterationsOf(loopId) {
        return this.def.loops.find(l => l.loopId === loopId)?.maxIterations ?? DEFAULTS.maxIterations;
    }
    nodeIdsOf(loopId) {
        return this.def.loops.find(l => l.loopId === loopId)?.nodeIds ?? [];
    }
    /** 当前某 loop 的迭代轮次（SCC 内 max(runCount) 近似，§6.2） */
    currentIteration(loopId, state) {
        return Math.max(0, ...this.nodeIdsOf(loopId).map(n => state.nodeRunCount[n] ?? 0));
    }
    beforeNodeStart(nodeId, state) {
        // 1. 全局
        if (state.stepCount >= this.def.settings.maxExecutionSteps) {
            return { allowed: false, level: 'global', reason: `reached maxExecutionSteps=${this.def.settings.maxExecutionSteps}` };
        }
        // 2. 节点
        const node = this.def.nodes.find(n => n.id === nodeId);
        const maxRuns = node.runtimeConfig?.maxRuns ?? this.def.settings.defaultNodeMaxRuns;
        if ((state.nodeRunCount[nodeId] ?? 0) >= maxRuns) {
            return { allowed: false, level: 'node', reason: `node ${nodeId} reached maxRuns=${maxRuns}` };
        }
        // 3. Loop：节点自身运行次数达上限即拒（SCC 内每轮各节点各跑一次的语义；
        //    全局安全仍由 maxExecutionSteps 兌底）
        const loopId = this.loopOfNode.get(nodeId);
        if (loopId) {
            const maxIt = this.maxIterationsOf(loopId);
            if ((state.nodeRunCount[nodeId] ?? 0) >= maxIt) {
                return { allowed: false, level: 'loop', reason: `loop ${loopId} reached maxIterations=${maxIt}`, loopId };
            }
        }
        return { allowed: true };
    }
}
