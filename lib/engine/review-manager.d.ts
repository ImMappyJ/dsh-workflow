/**
 * ReviewManager（§58-70）—— ReviewTask 创建与决策应用。
 * 纯状态转换（对 ExecutionState 的修改 + 返回副作用描述），引擎负责发事件与唤醒等待。
 */
import type { EdgeId, ExecutionState, NodeId, ReviewAction, ReviewTask, WorkflowEdge } from '../domain/types.js';
/** 节点完成后，对配置了 required 审核的出边创建 ReviewTask */
export declare function createReviewTask(state: ExecutionState, executionId: string, edge: WorkflowEdge, artifactId: string): ReviewTask;
export interface DecisionOutcome {
    /** 需要唤醒主循环 */
    wake: boolean;
    /** 直接终止整个 workflow */
    terminate: boolean;
    /** reject：需要携带反馈重跑的节点 */
    feedbackTarget?: NodeId;
    task: ReviewTask;
}
/**
 * 应用人工决策（§61-63）：
 * - accept：放行该边
 * - edit / accept_after_edit：人工修改 Artifact（版本 +1）后放行
 * - reject：退回上游节点，注入反馈重跑（不覆盖、不是简单重试）
 * - terminate：终止整个 workflow
 */
export declare function resolveReview(state: ExecutionState, taskId: string, action: ReviewAction, opts?: {
    comment?: string | null;
    content?: string;
    operator?: 'human' | 'system';
}): DecisionOutcome;
/**
 * §22/§36：节点级审核任务创建（不绑定 Edge）。
 * 审核只检查输出质量（Accept/Reject），不决定路由路径。
 * 审核通过后，由 Routing Decision 选择下游出口。
 */
export declare function createNodeReviewTask(state: ExecutionState, executionId: string, nodeId: NodeId, artifactId: string, reviewCfg: NonNullable<import('../domain/types.js').AgentNode['review']>): ReviewTask;
/** 当前待处理的 ReviewTask */
export declare function pendingReviews(state: ExecutionState): ReviewTask[];
export type { EdgeId };
