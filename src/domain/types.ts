/**
 * Core Domain —— 与详细技术设计 §2 一一对应。
 * 仅纯类型与默认值工厂，无任何宿主/UI 依赖。
 */

export type NodeId = string;
export type EdgeId = string;
export type PortName = 'main' | string;

export interface Position { x: number; y: number }

// ---------------------------------------------------------------- contracts

// ---------------------------------------------------------------- input schema（第二阶段任务 5）
// Workflow Input 与 Agent Input 经 Input Contract 分离（§55.6）：
//  - inputSchema 属于 Workflow（人→启动参数）；
//  - InputContract 属于 Agent 节点（上游→本节点的筛选与过滤）。

/** 输入字段类型谱系（任务 5） */
export type InputFieldType =
  | 'text' | 'number' | 'boolean' | 'select'
  | 'file' | 'files' | 'directory'
  | 'json' | 'artifact';

export interface InputSchemaField {
  /** 字段 key（提交时 fields[name]） */
  name: string;
  /** UI 显示名，缺省用 name */
  label?: string;
  type: InputFieldType;
  required?: boolean;
  default?: unknown;
  placeholder?: string;
  /** type=select 时的选项 */
  options?: string[];
  /** type=file/files/directory/artifact 时接受的 Artifact 类型 */
  acceptKinds?: ArtifactKind[];
}

export interface InputSchema {
  fields?: InputSchemaField[];
}

export interface InputContract {
  /** 上游给我的是什么 */
  description: string;
  /** 是否将人工审核意见一并传给本节点（§73） */
  includeReviewFeedback?: boolean;
  /** 如何预处理（结构化整理等） */
  processing: string;
  /** 重点使用哪些内容 */
  selection: string;
  /** 忽略哪些内容 */
  ignore: string;
  /** 输入约束（如"不得使用未验证假设"） */
  constraints: string[];
  sourceMode: 'all' | 'selected';
  /** sourceMode === 'selected' 时有效 */
  selectedSourceNodeIds: NodeId[];
  /**
   * 接受的上游 Artifact 类型（任务 5）：仅当上游节点声明了
   * outputContract.artifactTypes 且交集为空时排除该来源；
   * undefined = 不过滤（旧定义兼容）。
   */
  acceptedTypes?: ArtifactKind[];
}

export interface OutputContract {
  description: string;
  format: 'markdown' | 'json' | 'plaintext';
  /** 声明产出 Artifact 类型谱系（任务 5）：供下游 acceptedTypes 过滤；缺省按 format 推导 */
  artifactTypes?: ArtifactKind[];
  /** format=json 时启用校验（Phase 1 仅存不校验，校验在 runner） */
  schema: unknown | null;
  /** 如 ["Services","Communication"]，软校验 */
  requiredSections: string[];
  /** 声明性 targets：仅作 Prompt 提示与 UI 校验，不参与运行时路由 */
  targets: NodeId[];
  /** 自然语言输出条件 */
  condition: string | null;
}

// ---------------------------------------------------------------- node / edge

export type NodeType = 'start' | 'end' | 'agent' | 'human_task';

export interface ModelConfig {
  provider: 'deepseek';
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface RuntimeConfig {
  /** 节点级运行上限，默认 5 */
  maxRuns: number;
  /** 默认 120_000 */
  timeoutMs: number;
  retry: { enabled: boolean; maxRetries: number; backoffMs: number };
  onFailure: 'retry' | 'skip' | 'fail_workflow';
}

export interface AgentNode {
  id: NodeId;
  type: NodeType;
  /** UI 显示名："架构师" */
  name: string;
  position: Position;
  identity: { name: string };
  roleDescription: string;
  inputContract: InputContract;
  outputContract: OutputContract;
  modelConfig: ModelConfig;
  runtimeConfig: RuntimeConfig;
  metadata: Record<string, unknown>;
  /** 禁用节点：调度时视为不可运行，直接跳过并标记 skipped */
  disabled?: boolean;
  /** 路由决策模式（§29）：static=固定出口, condition=条件表达式, agent=Agent 自主决策, human=人工选择 */
  routingMode?: 'static' | 'condition' | 'agent' | 'human';
  /** 节点级审核配置（§22/§36）：输出质量门，审核通过后进入路由决策阶段 */
  review?: ReviewGateConfig;
}

export interface EdgeCondition {
  kind: 'expression';
  /** 如 "output.reviewPassed === false"；Phase 8 启用，MVP 恒 null */
  expression: string;
}

/**
 * 第三阶段 §16-23：Edge 路由配置。routing 属于 Workflow Definition（原则 9）；
 * mode=manual 的边不得被 Auto Layout 覆盖（原则 10）。
 */
export interface EdgeRouting {
  /** auto=布局自动计算；manual=用户手工调整过路径 */
  mode: 'auto' | 'manual';
  /** MVP 推荐 bezier（§21） */
  type: 'bezier' | 'straight' | 'orthogonal';
  /** 控制点（世界坐标）；manual 时生效，拖拽产生（§22） */
  points: Array<{ x: number; y: number }>;
}

/** §16/17：Edge = Data Contract——表达“源输出什么给目标”。先模型后 UI。 */
export interface EdgeDataFlow {
  /** 指定流转的 Artifact 键（默认全部） */
  artifactKeys?: string[];
  /** 目标输入映射：{ 目标输入名: 源输出名 } */
  inputMapping?: Record<string, string>;
}

export interface WorkflowEdge {
  id: EdgeId;
  source: { nodeId: NodeId; output: PortName };
  target: { nodeId: NodeId; input: PortName };
  /** MVP：自然语言指令，注入目标节点 Prompt，不发起额外 LLM 调用 */
  transform: { enabled: boolean; instruction: string };
  condition: EdgeCondition | null;
  /** 人工审核门（§56）：绑定在 Edge 上——"这个结果是否允许流向这个下游节点" */
  review?: ReviewGateConfig;
  /** 第三阶段：路由配置（可选，缺省 auto/bezier/无控制点） */
  routing?: EdgeRouting;
  /** 第三阶段：数据流契约（可选） */
  dataFlow?: EdgeDataFlow;
  /** 路由键（§27）：Agent 输出中的 route 值匹配此字段决定走哪条边 */
  routingKey?: string;
}

// ---------------------------------------------------------------- definition

export interface LoopConfig {
  loopId: string;
  /** 回路边上的节点集合（Tarjan SCC 结果） */
  nodeIds: NodeId[];
  /** 默认 3 */
  maxIterations: number;
}

export interface WorkflowSettings {
  maxExecutionSteps: number;   // 默认 100，硬上限 1000
  defaultNodeMaxRuns: number;  // 默认 5
  /** 需求 3：本地工作目录（可选）。设置后注入 prompt，Agent 在该目录读写代码/文档。 */
  workspaceDir?: string;
}

export interface WorkflowDefinition {
  version: '1.0';
  /**
   * 第三阶段 §4：单调递增的 Workflow 版本号（保存时自增）。
   * 旧 Definition 无此字段时按 1 处理（effectiveRevision）。
   * Execution 启动时快照该值，Workflow 后续修改不影响历史 Execution（原则 1）。
   */
  revision?: number;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  nodes: AgentNode[];
  edges: WorkflowEdge[];
  settings: WorkflowSettings;
  loops: LoopConfig[];
  /** 冗余存储，编辑器用 */
  layout: Record<NodeId, Position>;
  /** 启动输入 Schema（任务 5）：渲染启动表单与校验提交字段 */
  inputSchema?: InputSchema;
}

/**
 * 校验提交字段是否符合 inputSchema（任务 5）：
 * 返回错误列表，空 = 通过。缺失 schema / 无 fields 时宽松处理（兼容旧工作流）。
 */
export function validateInputFields(
  schema: InputSchema | undefined,
  fields: Record<string, unknown> | undefined,
): string[] {
  const errs: string[] = [];
  const defs = schema?.fields ?? [];
  const values = fields ?? {};
  for (const f of defs) {
    const v = values[f.name];
    const missing = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    if (f.required && missing) {
      errs.push(`缺少必填字段 ${f.label ?? f.name}（${f.type}）`);
      continue;
    }
    if (missing) continue;
    switch (f.type) {
      case 'number':
        if (typeof v !== 'number' && Number.isNaN(Number(v))) errs.push(`字段 ${f.name} 需要数字`);
        break;
      case 'boolean':
        if (typeof v !== 'boolean' && v !== 'true' && v !== 'false') errs.push(`字段 ${f.name} 需要布尔值`);
        break;
      case 'select':
        if (f.options?.length && !f.options.includes(String(v))) errs.push(`字段 ${f.name} 不在选项范围内`);
        break;
      case 'json':
        if (typeof v === 'string') {
          try { JSON.parse(v); } catch { errs.push(`字段 ${f.name} 不是合法 JSON`); }
        }
        break;
      case 'file':
      case 'directory':
        if (typeof v !== 'string') errs.push(`字段 ${f.name} 需要路径（字符串）`);
        break;
      case 'files':
        if (!Array.isArray(v)) errs.push(`字段 ${f.name} 需要路径数组`);
        break;
      default:
        break;   // text / artifact：字符串即可，不硬校验
    }
  }
  return errs;
}

// ---------------------------------------------------------------- execution state

export type WorkflowStatus =
  | 'running' | 'paused'
  | 'waiting_review'   // §59：Workflow Runtime 等待人工审核
  | 'waiting_human'    // Phase 11：等待 Human Task 输入
  | 'completed' | 'failed' | 'terminated' | 'cancelled';

export type NodeStatus =
  | 'idle' | 'queued' | 'running' | 'waiting'
  | 'waiting_review'   // §59：节点完成但出边在等人工审核
  | 'waiting_human'    // Phase 11：Human Task Node 等待人工输入
  | 'success' | 'failed' | 'skipped' | 'cancelled';

// ---------------------------------------------------------------- review gate (§55-58)

export type ReviewMode = 'automatic' | 'required' | 'optional';
export type ReviewAction = 'accept' | 'reject' | 'edit' | 'accept_after_edit' | 'terminate';
export type ReviewTimeoutAction = 'pause' | 'auto_accept' | 'auto_reject' | 'fail';

export interface ReviewGateConfig {
  /** 默认关闭；开启后按 mode 处理 */
  enabled: boolean;
  mode: ReviewMode;
  allowedActions: ReviewAction[];
  /** 秒；null = 不超时 */
  timeout: number | null;
  /** 默认 pause：人工审核不默认替用户做决定（§70） */
  onTimeout: ReviewTimeoutAction;
}

export interface ReviewTask {
  id: string;
  executionId: string;
  edgeId: string;
  sourceNodeId: string;
  targetNodeIds: string[];
  /** 主 Artifact（兼容：始终指向集合首项） */
  artifactId: string;
  /**
   * 审核的 Artifact 集合（任务 5：人工审的是节点产出的全部 Artifact，
   * 而不是一个文本）。缺省退化为 [artifactId]（旧数据兼容）。
   */
  artifactIds?: string[];
  status: 'pending' | 'accepted' | 'rejected' | 'terminated';
  comment: string | null;
  createdAt: string;
  resolvedAt?: string;
  timeoutAt?: string;   // createdAt + timeout
}

// ---------------------------------------------------------------- artifact (§64-65)

/** Phase 11：Human Task Node 任务（§67）——人作为执行主体，提供内容而非审核 */
export interface HumanTask {
  id: string;
  executionId: string;
  nodeId: NodeId;
  /** 展示给人工的任务说明（来自节点 roleDescription / metadata.prompt） */
  prompt: string;
  status: 'pending' | 'completed' | 'cancelled';
  /** 人工提交的内容（成为该节点输出，流向下游） */
  content: string | null;
  /** 人工附注（可选） */
  note: string | null;
  createdAt: string;
  resolvedAt?: string;
}

// ---------------------------------------------------------------- human intervention（Phase B，§8/§10/§11/§12）
// Human Input 与 Human Review 必须区分（§12）：
//   - Review  = 判断成果可否继续（Accept/Reject/Edit），已由 reviewTasks 表达；
//   - Input   = 向 Workflow 注入新的业务信息（改需求/发现问题/人工改 Artifact），本类型表达。
/** 人工干预（结构化，§10）——"Human Instruction + Artifact Mutation"，非简单 textarea */
export interface HumanIntervention {
  /** 指令文本（用户告诉 Agent 要做什么） */
  instruction: string;
  /** 目标节点（干预作用到的节点） */
  targetNode?: NodeId;
  /** 作为输入的 Artifact 引用（§10 inputArtifacts：把已有成果附加为下游输入） */
  inputArtifacts?: string[];
  /** 人工修改过的 Artifact（§11：用户直接改 Artifact → 新版本 → 作为后续起点） */
  modifiedArtifacts?: string[];
  /** 附加元数据（可选） */
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// ---------------------------------------------------------------- artifact（第二阶段任务 5）
// Artifact 反转为主数据：Agent 输出 = Artifact[]；content 只是文本类 Artifact 的 inline 形态。
// 兼容路线：type/content 为第一阶段字段保留，新增字段全部可选，旧序列化数据可直接加载。

/** Artifact 类型谱系（任务 5：输入/输出不再是纯文本） */
export type ArtifactKind =
  | 'text' | 'markdown' | 'json' | 'code'
  | 'file' | 'directory' | 'office' | 'image';

/** 大文件 / 实体文件只存引用，不塞进 JSON（§55.2） */
export interface ArtifactStorageRef {
  /** file=单个文件；directory=目录（Workspace） */
  kind: 'file' | 'directory';
  /** 磁盘绝对路径（插件数据区，如 ~/.dsh/workflow-plugin/artifacts/…） */
  path: string;
  sizeBytes?: number;
  sha256?: string;
  /** 原始文件名（供展示/下载） */
  fileName?: string;
  mimeType?: string;
}

/**
 * code Artifact 的单个文件（任务 5 / 验收场景 B：代码修改流）。
 * 小文件 inline；超过 INLINE_LIMIT 的文件落盘只存引用（§55.2）。
 */
export interface CodeFileEntry {
  /** Workspace 内相对路径，如 "src/main.ts" */
  path: string;
  /** inline 存储时为全文；磁盘引用时仅为摘要 */
  content: string;
  /** 大文件落盘后的引用 */
  storageRef?: ArtifactStorageRef;
  /** 语言标识（可选，供高亮/展示） */
  language?: string;
}

export interface Artifact {
  id: string;
  /** 第一阶段遗留字段（兼容）：markdown / json / plaintext；与 kind 同步维护 */
  type: 'markdown' | 'json' | 'plaintext';
  /** 第二阶段类型谱系（任务 5）；旧数据无此字段时按 type 推导 */
  kind?: ArtifactKind;
  mimeType?: string;
  /**
   * 内容。inline 存储时为全文；reference 存储时仅为摘要/展示文本，
   * 真实内容在 storageRef 指向的磁盘路径（§55.2：文件内容不塞 Node JSON）。
   */
  content: string;
  /** 存储形态，缺省视为 inline（旧数据兼容） */
  storage?: 'inline' | 'reference';
  /** storage === 'reference' 时必有 */
  storageRef?: ArtifactStorageRef;
  sourceNodeId: string;
  version: number;           // 1-based，人工修改递增（不覆盖原始输出）
  createdBy: 'agent' | 'human';
  parentVersion: number | null;
  /** accept 时的人工审核意见（供下游 includeReviewFeedback 使用，§73） */
  reviewComment?: string | null;
  createdAt: string;
  /**
   * code Artifact 的多文件模型（任务 5）：kind==='code' 时使用。
   * content 为文件清单摘要，真实内容在 files 里（大文件落盘）。
   */
  files?: CodeFileEntry[];
}

/** 第一阶段遗留 type 与 kind 的双向映射 */
export function kindFromLegacyType(t: Artifact['type']): ArtifactKind {
  return t === 'markdown' ? 'markdown' : t === 'json' ? 'json' : 'text';
}
export function legacyTypeFromKind(k: ArtifactKind): Artifact['type'] {
  return k === 'markdown' ? 'markdown' : k === 'json' ? 'json' : 'plaintext';
}
/** outputContract.format → kind（引擎登记 Artifact 用） */
export function kindFromFormat(format: string | undefined): ArtifactKind {
  if (format === 'markdown') return 'markdown';
  if (format === 'json') return 'json';
  return 'text';
}

export interface NodeOutputRecord {
  runIndex: number;
  content: string;
  parsedJson?: unknown;
  durationMs: number;
  tokenUsage?: { prompt: number; completion: number };
  finishedAt: string;
}

export interface NodeRuntimeState {
  status: NodeStatus;
  /** 当前第几次运行（含进行中） */
  iteration: number;
  inputReady: NodeId[];
  attempt: number;
  /** 上次运行时的上游输入版本号（上游 output 记录总数），用于循环重调度 */
  lastInputVersion?: number;
}

export interface ExecutionState {
  executionId: string;
  workflowId: string;
  /** 启动时快照的 Definition revision（§5/原则 1） */
  workflowVersion: number;
  /** Phase A（§5/§23）：启动时深拷贝的 Definition 本体快照——Workflow 改版不影响历史 Execution，审计始终可见旧结构 */
  defSnapshot?: WorkflowDefinition;
  status: WorkflowStatus;
  startedAt: string;
  endedAt?: string;
  /** 第三阶段 §5：Execution 一等公民字段（全部可选，旧执行按空处理） */
  parentExecutionId?: string;
  /** Rework 起点节点（§39） */
  reworkNodeId?: NodeId;
  /** 启动时的主输入文本 */
  userInput?: string;
  /** 工作目录快照（§33/原则 13）：Workflow 后续改目录不影响本执行 */
  workingDirectory?: string;
  createdBy?: 'human' | 'system';
  stepCount: number;
  nodeRunCount: Record<NodeId, number>;
  loopCount: Record<string, number>;
  nodeStates: Record<NodeId, NodeRuntimeState>;
  /** 每次运行一条（支持循环多轮） */
  outputs: Record<NodeId, NodeOutputRecord[]>;
  error?: { code: string; message: string; nodeId?: NodeId };
  /** 边级流转状态（Review Gate）：passable=false 时下游不得调度 */
  edgeState: Record<EdgeId, { passable: boolean; reviewTaskId?: string }>;
  /** Artifact 版本链（§64-65）：人工修改不覆盖原始输出 */
  artifacts: Record<NodeId, Artifact[]>;
  /** 人工审核任务列表 */
  reviewTasks: ReviewTask[];
  /** 审计记录（§66）；request 记录任务创建 */
  auditLog: Array<{
    reviewId: string;
    artifactId: string;
    action: ReviewAction | 'timeout' | 'request';
    operator: 'human' | 'system';
    comment: string | null;
    fromVersion: number | null;
    toVersion: number | null;
    timestamp: string;
  }>;
  /** reject 后待重跑的节点（携带反馈）；Phase B 升级为结构化干预（instruction/artifacts） */
  pendingFeedback: Record<NodeId, HumanIntervention & { text: string; reviewId: string }>;
  /** Phase 11：Human Task Node 的人工输入任务（§67：人工产出不伪装成 Agent Run） */
  humanTasks: HumanTask[];
}

// ---------------------------------------------------------------- events

export type WorkflowEventType =
  | 'workflow.started' | 'workflow.completed' | 'workflow.failed' | 'workflow.terminated'
  | 'human_task.requested' | 'human_task.completed'
  | 'artifact.restored' | 'artifact.edited'
  | 'node.queued' | 'node.started' | 'node.input_received'
  | 'node.thinking' | 'node.output_generated' | 'node.completed'
  | 'node.failed' | 'node.skipped' | 'node.retrying'
  | 'edge.triggered' | 'edge.skipped'
  | 'loop.iteration' | 'loop.terminated'
  | 'execution.paused' | 'execution.resumed'
  | 'review.requested' | 'review.resolved' | 'review.edited' | 'review.timeout';

export interface ExecutionEvent {
  type: WorkflowEventType;
  executionId: string;
  workflowId: string;
  nodeId?: NodeId;
  edgeId?: EdgeId;
  loopId?: string;
  timestamp: number;
  payload?: unknown;
}

// ---------------------------------------------------------------- defaults

export const DEFAULTS = {
  maxExecutionSteps: 100,
  MAX_EXECUTION_STEPS_HARD_LIMIT: 1000,
  defaultNodeMaxRuns: 5,
  maxIterations: 3,
  timeoutMs: 120_000,
  maxInputCharsPerSource: 8000,
  maxTotalInputChars: 24_000,
  defaultPort: 3090,
} as const;

export function defaultRuntimeConfig(partial?: Partial<RuntimeConfig>): RuntimeConfig {
  return {
    maxRuns: DEFAULTS.defaultNodeMaxRuns,
    timeoutMs: DEFAULTS.timeoutMs,
    onFailure: 'fail_workflow',
    ...partial,
    retry: { enabled: true, maxRetries: 2, backoffMs: 1000, ...partial?.retry },
  };
}

export function defaultSettings(partial?: Partial<WorkflowSettings>): WorkflowSettings {
  return {
    maxExecutionSteps: DEFAULTS.maxExecutionSteps,
    defaultNodeMaxRuns: DEFAULTS.defaultNodeMaxRuns,
    ...partial,
  };
}

// ---------------------------------------------------------------- 第三阶段辅助

/** §4：旧 Definition 无 revision 时按 1 处理（向后兼容） */
export function effectiveRevision(def: Pick<WorkflowDefinition, 'revision'>): number {
  return typeof def.revision === 'number' && def.revision >= 1 ? Math.floor(def.revision) : 1;
}

/** §20：边路由缺省值——auto/bezier/无控制点 */
export function effectiveRouting(edge: WorkflowEdge): EdgeRouting {
  return {
    mode: edge.routing?.mode === 'manual' ? 'manual' : 'auto',
    type: edge.routing?.type ?? 'bezier',
    points: Array.isArray(edge.routing?.points) ? edge.routing!.points : [],
  };
}
