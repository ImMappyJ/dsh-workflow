/**
 * ContextManager —— 防爆炸策略链（详细设计 §7）：
 * 来源过滤 → 只取每个上游最新一轮 → 单源截断 → 总量预算淘汰。
 */
import { type AgentNode, type ExecutionState, type WorkflowDefinition, type WorkflowEdge } from '../domain/types.js';
export interface InputContextItem {
    sourceNodeId: string;
    sourceName: string;
    runIndex: number;
    content: string;
    truncated: boolean;
}
export interface InputContext {
    inputs: InputContextItem[];
}
export interface ContextPolicy {
    maxInputCharsPerSource: number;
    maxTotalInputChars: number;
}
export declare const DEFAULT_CONTEXT_POLICY: ContextPolicy;
export declare class ContextManager {
    private def;
    private policy;
    constructor(def: WorkflowDefinition, policy?: ContextPolicy);
    /** node 的直连上游边（target 是 node 的边） */
    incomingEdges(nodeId: string): WorkflowEdge[];
    buildInputContext(node: AgentNode, state: ExecutionState): InputContext;
}
