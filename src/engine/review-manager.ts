/**
 * ReviewManager（§58-70）—— ReviewTask 创建与决策应用。
 * 纯状态转换（对 ExecutionState 的修改 + 返回副作用描述），引擎负责发事件与唤醒等待。
 */

import { randomUUID } from 'node:crypto';
import type {
  EdgeId,
  ExecutionState,
  NodeId,
  ReviewAction,
  ReviewTask,
  WorkflowEdge,
} from '../domain/types.js';
import { humanEditArtifact } from './artifact-manager.js';

function now(): string {
  return new Date().toISOString();
}

/** 节点完成后，对配置了 required 审核的出边创建 ReviewTask */
export function createReviewTask(
  state: ExecutionState,
  executionId: string,
  edge: WorkflowEdge,
  artifactId: string,
): ReviewTask {
  // 任务 5：审核对象 = 源节点当前版本链上的全部 Artifact（集合审核），
  // artifactId 兼容字段始终指向主产出（新登记的那个）
  const chain = state.artifacts[edge.source.nodeId] ?? [];
  const task: ReviewTask = {
    id: `review_${randomUUID().slice(0, 8)}`,
    executionId,
    edgeId: edge.id,
    sourceNodeId: edge.source.nodeId,
    targetNodeIds: [edge.target.nodeId],
    artifactId,
    artifactIds: chain.map(a => a.id).includes(artifactId)
      ? chain.map(a => a.id)
      : [artifactId],
    status: 'pending',
    comment: null,
    createdAt: now(),
    timeoutAt: edge.review?.timeout
      ? new Date(Date.now() + edge.review.timeout * 1000).toISOString()
      : undefined,
  };
  state.reviewTasks.push(task);
  (state.edgeState[edge.id] ??= { passable: true }).passable = false;
  (state.edgeState[edge.id]).reviewTaskId = task.id;
  audit(state, { reviewId: task.id, artifactId, action: 'request', operator: 'system', comment: null, fromVersion: null, toVersion: null });
  return task;
}

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
export function resolveReview(
  state: ExecutionState,
  taskId: string,
  action: ReviewAction,
  opts: { comment?: string | null; content?: string; operator?: 'human' | 'system' } = {},
): DecisionOutcome {
  const task = state.reviewTasks.find(t => t.id === taskId);
  if (!task) throw new Error(`review task ${taskId} 不存在`);
  if (task.status !== 'pending') throw new Error(`review task ${taskId} 已处理（${task.status}）`);

  const fromVersion = state.artifacts[task.sourceNodeId]?.at(-1)?.version ?? null;
  const operator = opts.operator ?? 'human';

  if (action === 'accept') {
    task.status = 'accepted';
    task.comment = opts.comment ?? null;
    task.resolvedAt = now();
    state.edgeState[task.edgeId].passable = true;
    // accept 时保留审核意见供下游 includeReviewFeedback 使用（§73）
    const latest = state.artifacts[task.sourceNodeId]?.at(-1);
    if (latest && opts.comment) latest.reviewComment = opts.comment;
    audit(state, { reviewId: taskId, artifactId: task.artifactId, action, operator, comment: opts.comment ?? null, fromVersion, toVersion: fromVersion });
    return { wake: true, terminate: false, task };
  }

  if (action === 'edit' || action === 'accept_after_edit') {
    if (typeof opts.content !== 'string') throw new Error('edit 必须提供 content');
    const artifact = humanEditArtifact(state, task.sourceNodeId, opts.content, opts.comment ?? null);
    task.status = 'accepted';
    task.comment = opts.comment ?? null;
    task.resolvedAt = now();
    state.edgeState[task.edgeId].passable = true;
    audit(state, { reviewId: taskId, artifactId: artifact.id, action, operator, comment: opts.comment ?? null, fromVersion, toVersion: artifact.version });
    return { wake: true, terminate: false, task };
  }

  if (action === 'reject') {
    if (!opts.comment) throw new Error('reject 必须提供审核意见（Reject Reason，§61）');
    task.status = 'rejected';
    task.comment = opts.comment;
    task.resolvedAt = now();
    // §62：创建新任务上下文（原任务 + 历史输出 + 反馈），由引擎注入下次执行
    // Phase B：与 rework 注入的结构化干预保持同构（instruction=审核意见，createdAt）
    state.pendingFeedback[task.sourceNodeId] = {
      instruction: opts.comment,
      text: opts.comment,
      reviewId: taskId,
      inputArtifacts: [],
      modifiedArtifacts: [],
      createdAt: new Date().toISOString(),
    };
    // 边保持阻塞；上游重跑完成后重新走审核
    audit(state, { reviewId: taskId, artifactId: task.artifactId, action, operator, comment: opts.comment, fromVersion, toVersion: null });
    return { wake: true, terminate: false, feedbackTarget: task.sourceNodeId, task };
  }

  if (action === 'terminate') {
    task.status = 'terminated';
    task.comment = opts.comment ?? null;
    task.resolvedAt = now();
    audit(state, { reviewId: taskId, artifactId: task.artifactId, action, operator, comment: opts.comment ?? null, fromVersion, toVersion: null });
    return { wake: true, terminate: true, task };
  }

  throw new Error(`未知审核动作: ${action}`);
}

/** 审计记录（§66）。action='request' 记录任务创建 */
function audit(state: ExecutionState, entry: Omit<ExecutionState['auditLog'][number], 'timestamp'>): void {
  state.auditLog.push({ ...entry, timestamp: now() });
}

/**
 * §22/§36：节点级审核任务创建（不绑定 Edge）。
 * 审核只检查输出质量（Accept/Reject），不决定路由路径。
 * 审核通过后，由 Routing Decision 选择下游出口。
 */
export function createNodeReviewTask(
  state: ExecutionState,
  executionId: string,
  nodeId: NodeId,
  artifactId: string,
  reviewCfg: NonNullable<import('../domain/types.js').AgentNode['review']>,
): ReviewTask {
  const chain = state.artifacts[nodeId] ?? [];
  const task: ReviewTask = {
    id: `review_${randomUUID().slice(0, 8)}`,
    executionId,
    edgeId: '__node__' as any,   // 标记为 node-level review
    sourceNodeId: nodeId,
    targetNodeIds: [],
    artifactId,
    artifactIds: chain.map(a => a.id).includes(artifactId)
      ? chain.map(a => a.id)
      : [artifactId],
    status: 'pending',
    comment: null,
    createdAt: now(),
    timeoutAt: reviewCfg.timeout
      ? new Date(Date.now() + reviewCfg.timeout * 1000).toISOString()
      : undefined,
  };
  state.reviewTasks.push(task);
  audit(state, { reviewId: task.id, artifactId, action: 'request', operator: 'system', comment: null, fromVersion: null, toVersion: null });
  return task;
}

/** 当前待处理的 ReviewTask */
export function pendingReviews(state: ExecutionState): ReviewTask[] {
  return state.reviewTasks.filter(t => t.status === 'pending');
}

export type { EdgeId };
