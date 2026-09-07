/**
 * GraphValidator —— 结构校验 + 环检测（详细设计 §3 / §6.1）。
 * 错误（errors）阻止运行；警告（warnings）允许保存/运行但 UI 需提示。
 */
import { type AgentNode, type WorkflowDefinition, type WorkflowEdge } from '../domain/types.js';
export interface ValidationIssue {
    code: string;
    message: string;
    nodeId?: string;
    edgeId?: string;
}
export interface ValidationResult {
    valid: boolean;
    errors: ValidationIssue[];
    warnings: ValidationIssue[];
    /** 检测到的循环节点集合（SCC），调用方可据此生成/补全 LoopConfig */
    loops: string[][];
}
export declare function validateWorkflow(def: WorkflowDefinition): ValidationResult;
/** 便捷构造：由 SCC 结果生成 LoopConfig（保存时补全缺失配置用） */
export declare function loopsFromSccs(sccs: string[][], existing: WorkflowDefinition['loops'], defaultMaxIterations?: 3): import("../domain/types.js").LoopConfig[];
export type { AgentNode, WorkflowEdge };
