/**
 * LoopController —— 三层限制（详细设计 §6）：
 * 1. 全局 stepCount  2. 节点 maxRuns  3. Loop maxIterations（SCC 内 max(runCount) 近似计数）
 */
import { type ExecutionState, type WorkflowDefinition } from '../domain/types.js';
export type LoopDecision = {
    allowed: true;
} | {
    allowed: false;
    level: 'global' | 'node' | 'loop';
    reason: string;
    loopId?: string;
};
export declare class LoopController {
    private def;
    private loopOfNode;
    constructor(def: WorkflowDefinition);
    /** 节点属于哪个 loop（未配置 LoopConfig 的 SCC 由 validator 生成默认配置，正常不应为空） */
    loopIdOf(nodeId: string): string | undefined;
    maxIterationsOf(loopId: string): number;
    nodeIdsOf(loopId: string): string[];
    /** 当前某 loop 的迭代轮次（SCC 内 max(runCount) 近似，§6.2） */
    currentIteration(loopId: string, state: ExecutionState): number;
    beforeNodeStart(nodeId: string, state: ExecutionState): LoopDecision;
}
