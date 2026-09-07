/**
 * NodeScheduler —— 依赖满足判定 + 循环重调度（详细设计 §5/§6）。
 *
 * 依赖语义：
 * - 输入版本号（inputVersion）= 所有直连上游的 output 记录总数（含 start 初始输入）。
 * - 循环节点：同一 Loop（SCC）内的上游为**可选依赖**（首轮尚无输出），Loop 外上游为必需依赖。
 *   环内上游产出新输出即可触发重跑。
 * - 非循环节点：全部上游为必需依赖（AND 汇合语义）。
 */
import type { ExecutionState, WorkflowDefinition, NodeId } from '../domain/types.js';
export declare class NodeScheduler {
    private def;
    private loopOfNode;
    /** 被禁用的节点集合（任务 2：执行时旁路，依赖透明传递） */
    private disabled;
    constructor(def: WorkflowDefinition);
    isDisabled(nodeId: string): boolean;
    private upstreamIds;
    /**
     * 有效上游：禁用节点视为旁路（bypass），依赖透过它们向其更上游传导；
     * 链式禁用逐层解析，环内禁用链用 seen 防环。
     */
    private resolveThroughDisabled;
    /** 有效上游（直连 + 禁用旁路解析） */
    private effectiveUpstreamIds;
    /** 必需上游：非同 loop 的上游（循环节点的环内上游可选）；禁用旁路后同判 */
    private requiredUpstreamIds;
    /** 上游 output 记录总数（含禁用旁路解析后的有效上游） */
    inputVersion(nodeId: string, state: ExecutionState): number;
    /** 入边是否全部放行（Review Gate，§58）：passable=false 的边阻塞下游 */
    edgesPassable(nodeId: string, state: ExecutionState): boolean;
    /**
     * §32/§33: 审核期冻结——仅阻塞正在等待人工评估的节点自身，不冻结整个环。
     * 触发条件：环内存在待审任务（人工正在评估，机械追加迭代会提前耗尽迭代预算）。
     * 环成员间的 pendingFeedback 不影响其他成员（§22/§23：review 独立于 loop）。
     */
    private loopAwaitingReview;
    /** 必需依赖全部有输出 */
    depsSatisfied(nodeId: string, state: ExecutionState): boolean;
    /** 缺失的必需依赖（deadlock 诊断用） */
    missingDeps(nodeId: string, state: ExecutionState): string[];
    /** 节点是否"想运行"：必需依赖满足、入边放行、环未冻结且（从未运行，或上游版本号超过上次运行时） */
    wouldRun(nodeId: string, state: ExecutionState): boolean;
    /** 候选可运行节点（不含 start/end；loop/maxRuns 由 LoopController 把关） */
    nextRunnable(state: ExecutionState): NodeId[];
    /** 所有节点到达终态 */
    allSettled(state: ExecutionState): boolean;
    /** 是否存在待处理的人工审核（引擎用于判定 waiting_review） */
    hasPendingReview(state: ExecutionState): boolean;
    /** 是否存在待人工提交的 Human Task（Phase 11，引擎用于判定 waiting_human） */
    hasPendingHumanTask(state: ExecutionState): boolean;
}
