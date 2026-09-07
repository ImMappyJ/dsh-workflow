/**
 * WorkflowEngine —— 主循环（详细设计 §5）。
 * 纯逻辑：LLM 访问经 AgentRunner 接口注入，可离线全量测试。
 */
import { type Artifact, type ExecutionEvent, type ExecutionState, type HumanTask, type NodeId, type WorkflowDefinition } from '../domain/types.js';
import { EventBus } from './event-bus.js';
import type { AgentRunner } from './runner.js';
import { ArtifactManager } from './artifact-manager.js';
/**
 * 启动输入（第二阶段升级）：text 为主输入（兼容旧调用），
 * fields 为 inputSchema 提交的结构化字段（任务 5：Workflow Input）。
 */
export interface RunInput {
    text: string;
    /** key = InputSchemaField.name；值类型由字段类型决定 */
    fields?: Record<string, unknown>;
    /** Phase B（§10）：作为附加输入传入目标节点的 Artifact 引用（如 "src/auth/login.go" 或 "nodeId@v2"） */
    inputArtifacts?: string[];
    /** Phase B（§11）：人工修改过的 Artifact 引用——以此为起点（覆盖父输出，下游消费修改版） */
    modifiedArtifacts?: string[];
}
export interface ExecutionHandle {
    executionId: string;
    result: Promise<ExecutionState>;
}
export interface EngineOptions {
    runner: AgentRunner;
    /** 并行度上限，默认 4 */
    concurrency?: number;
    /** Artifact 落盘根目录（任务 5：大内容只存 Reference），缺省 ~/.dsh/workflow-plugin */
    dataDir?: string;
    /**
     * 第三阶段 §37/原则 3：执行终态钩子（completed/failed/terminated）。
     * 宿主用于将完整 ExecutionState 快照落盘——历史 Execution 重启后仍可查看（Test 6）。
     */
    onExecutionEnd?: (state: import('../domain/types.js').ExecutionState) => void | Promise<void>;
}
export declare class WorkflowEngine {
    private opts;
    private bus;
    private controls;
    private states;
    /** 每个执行的环控制器（resolveReview 需要判定源节点所属环以设置收敛冻结，§69） */
    private loopers;
    /** 每个执行的有效定义（submitHumanTask 需要节点 outputContract，Phase 11） */
    private defs;
    /** Phase A：终态持久化 Promise 队列（emit 记录，finally await），消除磁盘快照与重启的竞态 */
    private pendingPersist;
    /** Artifact 中心化管理（任务 5）：create/read/update/version/diff/restore */
    readonly artifacts: ArtifactManager;
    constructor(opts: EngineOptions);
    get eventBus(): EventBus;
    validate(def: WorkflowDefinition): import("../graph/validator.js").ValidationResult;
    subscribe(executionId: string, h: (e: ExecutionEvent) => void): () => void;
    getExecution(executionId: string): ExecutionState | undefined;
    /**
     * 人工审核决策入口（§61-63）。可在 waiting_review 或任意阶段调用；
     * 唤醒主循环继续调度。terminate 时置为 terminated 并终止整个 workflow。
     */
    resolveReview(executionId: string, taskId: string, action: 'accept' | 'reject' | 'edit' | 'accept_after_edit' | 'terminate', opts?: {
        comment?: string | null;
        content?: string;
        operator?: 'human' | 'system';
    }): import("./review-manager.js").DecisionOutcome;
    /**
     * 批量决策（任务 5 MVP：Accept All / Reject All）：
     * 对当前全部 pending 审核任务依次执行同一动作。reject 必须带统一意见。
     * 返回处理数量；中途单个任务失败不影响其余任务。
     */
    resolveAllReviews(executionId: string, action: 'accept' | 'reject', opts?: {
        comment?: string | null;
    }): number;
    /**
     * Phase 11 —— Human Task Node 运行时（§67：人工产出不伪装成 Agent Run）。
     * 依赖满足时创建人工任务并挂起节点，不调 LLM。
     */
    private createHumanTask;
    /**
     * 人工提交 Human Task 结果（§67）：内容登记为人工产出（createdBy=human），
     * 同步到 outputs 供下游 ContextManager 读取，节点置 success 并继续调度。
     */
    submitHumanTask(executionId: string, taskId: string, opts: {
        content: string;
        note?: string;
        operator?: string;
    }): HumanTask;
    /**
     * 大文本事后落盘（任务 5 / §55.2）：同步登记的 inline Artifact，
     * 若内容超过阈值则异步迁移为引用存储（JSON 中只留摘要 + storageRef）。
     * 人工提交等必须同步返回的路径用；不影响版本链与下游。
     */
    private spillOversize;
    /**
     * 恢复版本（任务 5：restore）：把目标版本内容以新人工版本追加（不可变链），
     * 并同步下游 outputs——后续运行节点拿到的是被恢复的内容。
     */
    restoreArtifact(executionId: string, nodeId: string, targetVersion: number): Promise<Artifact>;
    /**
     * 人工编辑 code Artifact（任务 5 / 验收场景 D）：提交整组文件 →
     * 追加新人工版本（不覆盖原始输出）；下游 outputs 同步拿到文件清单。
     */
    editCodeArtifact(executionId: string, nodeId: string, files: Array<{
        path: string;
        content: string;
        language?: string;
    }>, comment?: string | null): Promise<Artifact>;
    control(executionId: string, cmd: 'pause' | 'resume' | 'stop' | 'step'): void;
    run(def: WorkflowDefinition, input: RunInput): Promise<ExecutionHandle>;
    /**
     * Phase B（§10/§11）：解析 Artifact 引用 → {nodeId, artifact}。
     * 支持两种形式：裸引用 "src/auth/login.go"（按 nodeId/文件名在 artifacts 里模糊匹配最新版）；
     * 精确引用 "nodeId@v{n}"（指定节点指定版本）。
     */
    private resolveArtifactRef;
    /**
     * 第三阶段 §39-43 / Test 7-8：Rework From Here。
     * - 产生新 Execution（parentExecutionId + reworkNodeId），历史不可变（原则 3/4）
     * - 无关节点（起点上游）不重跑：状态置 success、输出/Artifact 从父执行继承（§41）
     * - 上下文继承（§40）：父输出/Artifact/反馈 + 新用户请求（经 pendingFeedback 通道注入 prompt）
     * - 起点之后的 Review Gate 在新产出时重新创建任务，不绕过审核（§43）
     */
    rework(def: WorkflowDefinition, parentState: ExecutionState, reworkNodeId: NodeId, input: RunInput): Promise<ExecutionHandle>;
    private executeLoop;
    /**
     * 无可运行节点时：想运行的候选节点是否全部因上限被拒。
     * 返回 'loop'（环上限）/ 'node'（节点 maxRuns，典型场景：连续 reject 重跑耗尽）/ false。
     */
    private limitTerminationCheck;
    private runNode;
    private markUnfinished;
    /** 审核超时处理（§70）：返回是否有处理动作（有的话主循环 continue 重新调度） */
    private handleTimedOutReviews;
    /** 最近的未处理审核超时时刻距当前的毫秒数；无则返回 null */
    private nearestReviewTimeout;
    private emit;
}
/**
 * 组合 start 节点初始内容（任务 5）：主输入文本 + 结构化字段按类型格式化。
 * 字段为空时退化为纯文本（旧行为）。文件/目录类字段以引用行呈现
 * （§55.2：路径只写引用，不把文件内容塞进 Prompt）。
 */
export declare function composeStartContent(def: WorkflowDefinition, input: RunInput): string;
