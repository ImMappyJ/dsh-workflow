/**
 * WorkflowEngine —— 主循环（详细设计 §5）。
 * 纯逻辑：LLM 访问经 AgentRunner 接口注入，可离线全量测试。
 */
import { randomUUID } from 'node:crypto';
import { EventBus } from './event-bus.js';
import { LoopController } from './loop-controller.js';
import { ContextManager } from './context-manager.js';
import { NodeScheduler } from './scheduler.js';
import { buildPrompt } from './prompt-builder.js';
import { validateWorkflow, loopsFromSccs } from '../graph/validator.js';
import { ArtifactManager, INLINE_LIMIT } from './artifact-manager.js';
import { kindFromFormat, kindFromLegacyType, validateInputFields, effectiveRevision } from '../domain/types.js';
import { createReviewTask, createNodeReviewTask, resolveReview as applyReviewDecision, pendingReviews } from './review-manager.js';
let execSeq = 0;
export class WorkflowEngine {
    opts;
    bus = new EventBus();
    controls = new Map();
    states = new Map();
    /** 每个执行的环控制器（resolveReview 需要判定源节点所属环以设置收敛冻结，§69） */
    loopers = new Map();
    /** 每个执行的有效定义（submitHumanTask 需要节点 outputContract，Phase 11） */
    defs = new Map();
    /** Phase A：终态持久化 Promise 队列（emit 记录，finally await），消除磁盘快照与重启的竞态 */
    pendingPersist = new Map();
    /** Artifact 中心化管理（任务 5）：create/read/update/version/diff/restore */
    artifacts;
    constructor(opts) {
        this.opts = opts;
        this.artifacts = new ArtifactManager({ dataDir: opts.dataDir });
    }
    get eventBus() { return this.bus; }
    validate(def) {
        return validateWorkflow(def);
    }
    subscribe(executionId, h) {
        return this.bus.on('*', h);
    }
    getExecution(executionId) {
        return this.states.get(executionId);
    }
    /**
     * 人工审核决策入口（§61-63）。可在 waiting_review 或任意阶段调用；
     * 唤醒主循环继续调度。terminate 时置为 terminated 并终止整个 workflow。
     */
    resolveReview(executionId, taskId, action, opts = {}) {
        const state = this.states.get(executionId);
        if (!state)
            throw new Error(`execution ${executionId} 不存在（可能已结束）`);
        const outcome = applyReviewDecision(state, taskId, action, opts);
        this.emit(executionId, 'review.resolved', { action, taskId, status: outcome.task.status, comment: opts.comment ?? null }, outcome.task.sourceNodeId, outcome.task.edgeId);
        const ctrl = this.controls.get(executionId);
        if (outcome.terminate) {
            state.status = 'terminated';
            state.error = { code: 'review_terminated', message: opts.comment ?? '人工终止 workflow' };
            this.markUnfinished(state, 'cancelled');
            this.emit(executionId, 'workflow.terminated', { reason: 'review terminated' });
            if (ctrl)
                ctrl.stopRequested = true; // 主循环顶部短路返回，保留 terminated 状态
        }
        // reject：复位上游节点状态，携带反馈重跑（§62：新任务上下文而非简单重试）
        if (outcome.feedbackTarget) {
            const ns = state.nodeStates[outcome.feedbackTarget];
            if (ns) {
                ns.status = 'idle';
                ns.lastInputVersion = 0; // 强制 wouldRun 重新成立（输入版本未变也要重跑）
            }
            // 复位相关边的 passable 状态，使下次产出能重新触发审核（§55：边保持阻塞阻断了重审）
            const effectiveDef = this.defs.get(executionId);
            if (effectiveDef) {
                for (const e of effectiveDef.edges.filter(e => e.source.nodeId === outcome.feedbackTarget)) {
                    if (state.edgeState[e.id]?.passable === false && e.review?.enabled) {
                        state.edgeState[e.id].passable = true;
                    }
                }
            }
        }
        // accept / edit：源节点的全部审核任务均已处理时，解除 waiting_review（§59）
        if (!outcome.terminate) {
            const srcId = outcome.task.sourceNodeId;
            const ns = state.nodeStates[srcId];
            const isNodeReview = outcome.task.edgeId === '__node__';
            if (ns?.status === 'waiting_review'
                && !state.reviewTasks.some(t => t.sourceNodeId === srcId && t.status === 'pending')) {
                ns.status = 'success';
                // 节点级审核通过后，触发 Routing Decision（§34）：
                // 如果节点有 routingMode 配置，需在调度循环中执行路由决策。
                // MVP 简化：所有下游边默认放行（passable = true），路由决策后续 Phase 完善。
            }
            // Loop 终止仅依赖 Max Iterations + Max Node Runs 双重限制（§32/§33），
            // review accept 不再触发环收敛（review 独立于 loop，§22/§23）。
        }
        if (ctrl?.reviewWaiter) {
            ctrl.reviewWaiter();
            ctrl.reviewWaiter = null;
        }
        return outcome;
    }
    /**
     * 批量决策（任务 5 MVP：Accept All / Reject All）：
     * 对当前全部 pending 审核任务依次执行同一动作。reject 必须带统一意见。
     * 返回处理数量；中途单个任务失败不影响其余任务。
     */
    resolveAllReviews(executionId, action, opts = {}) {
        const state = this.states.get(executionId);
        if (!state)
            throw new Error(`execution ${executionId} 不存在（可能已结束）`);
        if (action === 'reject' && !opts.comment)
            throw new Error('Reject All 必须提供统一审核意见（§61）');
        const pending = state.reviewTasks.filter(t => t.status === 'pending').map(t => t.id);
        for (const taskId of pending) {
            try {
                this.resolveReview(executionId, taskId, action, { comment: opts.comment ?? null });
            }
            catch { /* 单个任务异常（如已被并发处理）跳过 */ }
        }
        return pending.length;
    }
    /**
     * Phase 11 —— Human Task Node 运行时（§67：人工产出不伪装成 Agent Run）。
     * 依赖满足时创建人工任务并挂起节点，不调 LLM。
     */
    createHumanTask(def, state, node, scheduler) {
        const ns = state.nodeStates[node.id];
        ns.lastInputVersion = scheduler.inputVersion(node.id, state);
        ns.status = 'waiting_human';
        ns.iteration = (state.nodeRunCount[node.id] ?? 0) + 1;
        state.nodeRunCount[node.id] = ns.iteration;
        state.stepCount++;
        const task = {
            id: `htask_${randomUUID().slice(0, 8)}`,
            executionId: state.executionId,
            nodeId: node.id,
            prompt: node.metadata?.['taskPrompt'] || node.roleDescription || '请完成此人工任务并提交结果。',
            status: 'pending',
            content: null,
            note: null,
            createdAt: new Date().toISOString(),
        };
        (state.humanTasks ??= []).push(task);
        this.emit(state.executionId, 'human_task.requested', { taskId: task.id, prompt: task.prompt }, node.id);
    }
    /**
     * 人工提交 Human Task 结果（§67）：内容登记为人工产出（createdBy=human），
     * 同步到 outputs 供下游 ContextManager 读取，节点置 success 并继续调度。
     */
    submitHumanTask(executionId, taskId, opts) {
        const state = this.states.get(executionId);
        if (!state)
            throw new Error(`execution ${executionId} 不存在（可能已结束）`);
        const task = state.humanTasks?.find(t => t.id === taskId);
        if (!task)
            throw new Error(`human task ${taskId} 不存在`);
        if (task.status !== 'pending')
            throw new Error(`human task ${taskId} 已处理（${task.status}）`);
        if (typeof opts.content !== 'string' || opts.content.trim() === '') {
            throw new Error('Human Task 提交内容不能为空（§67）');
        }
        task.status = 'completed';
        task.content = opts.content;
        task.note = opts.note ?? null;
        task.resolvedAt = new Date().toISOString();
        const nodeId = task.nodeId;
        const def = this.defs.get(executionId);
        const node = def?.nodes.find(n => n.id === nodeId);
        const format = node?.outputContract.format === 'json' ? 'json'
            : node?.outputContract.format === 'plaintext' ? 'plaintext' : 'markdown';
        // 人工产出直接登记为人工版本（无 Agent 原始版，故 version=1，createdBy=human）
        const versions = state.artifacts[nodeId] ??= [];
        const artifact = {
            id: `artifact_${randomUUID().slice(0, 8)}`,
            type: format,
            content: opts.content,
            sourceNodeId: nodeId,
            version: versions.length + 1,
            createdBy: 'human',
            parentVersion: versions.length ? versions[versions.length - 1].version : null,
            createdAt: new Date().toISOString(),
        };
        versions.push(artifact);
        // 大内容事后落盘（任务 5）：不阻塞提交，异步迁移为引用存储；失败静默（仅丢失磁盘副本，不损坏版本链）
        void this.spillOversize(state, artifact, opts.content).catch(() => { });
        // 同步 outputs：下游 ContextManager 直接读取（与 Agent 产出同构）
        const finishedAt = new Date().toISOString();
        (state.outputs[nodeId] ??= []).push({ runIndex: state.nodeStates[nodeId]?.iteration ?? 1, content: opts.content, durationMs: 0, finishedAt });
        const ns = state.nodeStates[nodeId];
        if (ns)
            ns.status = 'success';
        this.emit(executionId, 'human_task.completed', { taskId, artifactId: artifact.id, note: opts.note ?? null }, nodeId);
        const ctrl = this.controls.get(executionId);
        ctrl?.humanWaiter?.();
        if (ctrl)
            ctrl.humanWaiter = null;
        return task;
    }
    /**
     * 大文本事后落盘（任务 5 / §55.2）：同步登记的 inline Artifact，
     * 若内容超过阈值则异步迁移为引用存储（JSON 中只留摘要 + storageRef）。
     * 人工提交等必须同步返回的路径用；不影响版本链与下游。
     */
    async spillOversize(state, artifact, content) {
        if (Buffer.byteLength(content, 'utf8') <= INLINE_LIMIT)
            return;
        const created = await this.artifacts.create({
            executionId: state.executionId,
            nodeId: artifact.sourceNodeId,
            kind: artifact.kind ?? kindFromLegacyType(artifact.type),
            content,
            createdBy: artifact.createdBy,
        });
        if (created.storage !== 'reference' || !created.storageRef)
            return;
        // 就地改写（同一条 Artifact，版本号不变）
        artifact.storage = 'reference';
        artifact.storageRef = created.storageRef;
        artifact.content = created.content;
    }
    /**
     * 恢复版本（任务 5：restore）：把目标版本内容以新人工版本追加（不可变链），
     * 并同步下游 outputs——后续运行节点拿到的是被恢复的内容。
     */
    async restoreArtifact(executionId, nodeId, targetVersion) {
        const state = this.states.get(executionId);
        if (!state)
            throw new Error(`execution ${executionId} 不存在（可能已结束）`);
        const artifact = await this.artifacts.restore(state, nodeId, targetVersion);
        (state.artifacts[nodeId] ??= []).push(artifact);
        // 下游可见内容同步（与 humanEditArtifact 同构）
        const outputs = state.outputs[nodeId];
        if (outputs?.length) {
            const full = await this.artifacts.read(artifact);
            outputs[outputs.length - 1] = { ...outputs[outputs.length - 1], content: full };
        }
        this.emit(executionId, 'artifact.restored', { nodeId, targetVersion, newVersion: artifact.version }, nodeId);
        return artifact;
    }
    /**
     * 人工编辑 code Artifact（任务 5 / 验收场景 D）：提交整组文件 →
     * 追加新人工版本（不覆盖原始输出）；下游 outputs 同步拿到文件清单。
     */
    async editCodeArtifact(executionId, nodeId, files, comment = null) {
        const state = this.states.get(executionId);
        if (!state)
            throw new Error(`execution ${executionId} 不存在（可能已结束）`);
        const chain = state.artifacts[nodeId] ?? [];
        const prev = [...chain].reverse().find(a => Array.isArray(a.files));
        if (!prev)
            throw new Error(`节点 ${nodeId} 无 code Artifact，无法编辑`);
        // 合并语义：提交可只带被修改的文件；content 为 null/空串视为"未修改"，从上一版本回填（大文件前端无内存内容）。
        const submitted = new Map(files.map(f => [f.path, f]));
        const merged = [];
        for (const f of prev.files ?? []) {
            const sub = submitted.get(f.path);
            if (sub && sub.content != null && sub.content !== '') {
                merged.push({ path: f.path, content: sub.content, language: sub.language ?? f.language });
                submitted.delete(f.path);
            }
            else {
                merged.push({ path: f.path, content: await this.artifacts.readCodeFile(prev, f.path), language: f.language });
            }
        }
        // 提交中新出现的文件（人工新增）
        for (const sub of submitted.values()) {
            if (sub.content != null)
                merged.push({ path: sub.path, content: sub.content, language: sub.language });
        }
        const artifact = await this.artifacts.updateCode({
            executionId,
            prev,
            files: merged,
            createdBy: 'human',
            reviewComment: comment,
        });
        chain.push(artifact);
        // 下游可见内容同步：最新 output 替换为文件清单（§72）
        const outputs = state.outputs[nodeId];
        if (outputs?.length) {
            outputs[outputs.length - 1] = { ...outputs[outputs.length - 1], content: artifact.content };
        }
        this.emit(executionId, 'artifact.edited', { nodeId, kind: 'code', newVersion: artifact.version, files: merged.length }, nodeId);
        return artifact;
    }
    control(executionId, cmd) {
        const c = this.controls.get(executionId);
        if (!c)
            return;
        if (cmd === 'pause') {
            c.paused = true;
            const st = this.states.get(executionId);
            if (st)
                st.status = 'paused';
            this.emit(executionId, 'execution.paused');
        }
        if (cmd === 'resume') {
            c.paused = false;
            c.stepMode = false;
            const st = this.states.get(executionId);
            if (st && st.status === 'paused')
                st.status = 'running';
            this.emit(executionId, 'execution.resumed');
            c.resumeWaiter?.();
            c.resumeWaiter = null;
        }
        if (cmd === 'stop') {
            c.stopRequested = true;
            c.resumeWaiter?.();
            c.stepWaiter?.();
            c.reviewWaiter?.();
            c.reviewWaiter = null;
            c.humanWaiter?.();
            c.humanWaiter = null;
        }
        if (cmd === 'step') {
            c.stepMode = true;
            c.stepWaiter?.();
            c.stepWaiter = null; // 放行一步
        }
    }
    async run(def, input) {
        // 运行前校验并补全 LoopConfig
        const validation = this.validate(def);
        if (!validation.valid) {
            throw new Error(`workflow invalid: ${validation.errors.map(e => e.message).join('; ')}`);
        }
        // Input Schema 校验（任务 5：提交字段必须符合定义，含必填/类型/选项范围）
        const fieldErrors = validateInputFields(def.inputSchema, input.fields);
        if (fieldErrors.length) {
            throw new Error(`输入字段校验失败：${fieldErrors.join('；')}`);
        }
        const loops = loopsFromSccs(validation.loops, def.loops);
        const effectiveDef = { ...def, loops };
        const executionId = `exec_${Date.now()}_${++execSeq}`;
        const state = {
            executionId,
            workflowId: def.id,
            // 第三阶段 §5/原则 1：启动时快照 revision 与工作目录，Workflow 后续修改不影响本执行
            workflowVersion: effectiveRevision(def),
            defSnapshot: structuredClone(effectiveDef),
            workingDirectory: def.settings?.workspaceDir,
            userInput: input.text,
            createdBy: 'human',
            status: 'running',
            startedAt: new Date().toISOString(),
            stepCount: 0,
            nodeRunCount: {},
            loopCount: {},
            nodeStates: Object.fromEntries(def.nodes.map(n => [n.id, { status: 'idle', iteration: 0, inputReady: [], attempt: 0 }])),
            outputs: {},
            artifacts: {},
            edgeState: Object.fromEntries(def.edges.map(e => [e.id, { passable: true }])),
            reviewTasks: [],
            auditLog: [],
            pendingFeedback: {},
            // §32/§33: Loop 终止仅依赖执行上限，不再使用 convergedLoops
            humanTasks: [],
        };
        this.states.set(executionId, state);
        const ctrl = {
            paused: false, stepMode: false, stopRequested: false,
            resumeWaiter: null, stepWaiter: null, reviewWaiter: null, humanWaiter: null,
            reviewTimer: null, handledReviewTimeouts: new Set(),
        };
        this.controls.set(executionId, ctrl);
        const scheduler = new NodeScheduler(effectiveDef);
        const looper = new LoopController(effectiveDef);
        const ctxMgr = new ContextManager(effectiveDef);
        this.loopers.set(executionId, looper);
        this.defs.set(executionId, effectiveDef);
        const result = this.executeLoop(effectiveDef, state, ctrl, scheduler, looper, ctxMgr, input)
            .finally(async () => {
            state.endedAt = new Date().toISOString();
            if (ctrl.reviewTimer) {
                clearTimeout(ctrl.reviewTimer);
                ctrl.reviewTimer = null;
            }
            this.controls.delete(executionId);
            this.loopers.delete(executionId);
            this.defs.delete(executionId);
            // Phase A：等待终态快照落盘完成，再让 result resolve（Test 6 重启后必读到终态）
            await this.pendingPersist.get(executionId);
            this.pendingPersist.delete(executionId);
        });
        return { executionId, result };
    }
    /**
     * Phase B（§10/§11）：解析 Artifact 引用 → {nodeId, artifact}。
     * 支持两种形式：裸引用 "src/auth/login.go"（按 nodeId/文件名在 artifacts 里模糊匹配最新版）；
     * 精确引用 "nodeId@v{n}"（指定节点指定版本）。
     */
    resolveArtifactRef(state, ref) {
        const m = ref.match(/^(.*)@v(\d+)$/);
        if (m) {
            const nodeId = m[1];
            const ver = Number(m[2]);
            const art = (state.artifacts?.[nodeId] ?? []).find(a => a.version === ver);
            return art ? { nodeId, artifact: art } : null;
        }
        // 先按 nodeId 精确；再按文件名（code files / fileName / content 摘要）模糊
        if (state.artifacts?.[ref]?.length) {
            const chain = state.artifacts[ref];
            return { nodeId: ref, artifact: chain.at(-1) };
        }
        for (const [nodeId, chain] of Object.entries(state.artifacts ?? {})) {
            const art = [...chain].reverse().find(a => a.id === ref || a.storageRef?.fileName === ref ||
                (Array.isArray(a.files) && a.files.some(f => f.path === ref)));
            if (art)
                return { nodeId, artifact: art };
        }
        return null;
    }
    /**
     * 第三阶段 §39-43 / Test 7-8：Rework From Here。
     * - 产生新 Execution（parentExecutionId + reworkNodeId），历史不可变（原则 3/4）
     * - 无关节点（起点上游）不重跑：状态置 success、输出/Artifact 从父执行继承（§41）
     * - 上下文继承（§40）：父输出/Artifact/反馈 + 新用户请求（经 pendingFeedback 通道注入 prompt）
     * - 起点之后的 Review Gate 在新产出时重新创建任务，不绕过审核（§43）
     */
    async rework(def, parentState, reworkNodeId, input) {
        const node = def.nodes.find(n => n.id === reworkNodeId);
        if (!node)
            throw new Error(`rework 节点 ${reworkNodeId} 不存在于当前定义`);
        if (node.type === 'start' || node.type === 'end')
            throw new Error('start/end 不可作为 Rework 起点');
        const validation = this.validate(def);
        if (!validation.valid) {
            throw new Error(`workflow invalid: ${validation.errors.map(e => e.message).join('; ')}`);
        }
        const loops = loopsFromSccs(validation.loops, def.loops);
        const effectiveDef = { ...def, loops };
        const executionId = `exec_${Date.now()}_${++execSeq}`;
        const scheduler = new NodeScheduler({ ...def, loops });
        // 下游闭包：起点及其传递下游需要重跑；start/end 永不重跑
        const rerun = new Set([reworkNodeId]);
        const queue = [reworkNodeId];
        while (queue.length) {
            const cur = queue.shift();
            for (const e of effectiveDef.edges) {
                if (e.source.nodeId === cur && !rerun.has(e.target.nodeId)) {
                    rerun.add(e.target.nodeId);
                    queue.push(e.target.nodeId);
                }
            }
        }
        for (const n of effectiveDef.nodes) {
            if ((n.type === 'start' || n.type === 'end') && n.id !== reworkNodeId)
                rerun.delete(n.id);
        }
        // 基底 = 父状态深拷贝（继承但不污染，原则 17）；关键身份字段换成新执行
        const inherited = JSON.parse(JSON.stringify(parentState));
        const state = {
            ...inherited,
            executionId,
            parentExecutionId: parentState.executionId,
            reworkNodeId,
            // §4/原则 1：rework 基于当前 Definition 版本（可能已演进）
            workflowVersion: effectiveRevision(def),
            // Phase A：rework 快照当前 effectiveDef（覆盖继承的父快照——rework 跑的是最新版本）
            defSnapshot: structuredClone(effectiveDef),
            // Phase 8（§33/Test 11）：rework 是父执行的延续，工作目录跟随父快照（父快照优先，def 仅在父无快照时兜底）
            workingDirectory: parentState.workingDirectory ?? def.settings?.workspaceDir,
            userInput: input.text,
            createdBy: 'human',
            status: 'running',
            startedAt: new Date().toISOString(),
            endedAt: undefined,
            error: undefined,
            stepCount: 0,
            nodeRunCount: {},
            loopCount: {},
            // 节点状态策略（§41）：
            //  - 起点：idle——首跑条件“上游有输出”（继承输出满足）→ 立即重跑；
            //  - 其它重跑节点：success + 冻结在继承输入版本——继承旧输出不触发，
            //    上游（起点）新产出使输入版本增长后才重跑一次（否则 idle 会被旧输出提前触发）；
            //  - 无关节点：success + MAX——永不重跑。
            nodeStates: Object.fromEntries(effectiveDef.nodes.map(n => {
                if (n.id === reworkNodeId)
                    return [n.id, { status: 'idle', iteration: 0, inputReady: [], attempt: 0 }];
                if (rerun.has(n.id)) {
                    // 冻结在继承输入版本（inputs 来自父执行继承的 outputs）
                    return [n.id, { status: 'success', iteration: 0, inputReady: [], attempt: 0, lastInputVersion: scheduler.inputVersion(n.id, inherited) }];
                }
                return [n.id, { status: 'success', iteration: 0, inputReady: [], attempt: 0, lastInputVersion: Number.MAX_SAFE_INTEGER }];
            })),
            reviewTasks: [],
            edgeState: Object.fromEntries(effectiveDef.edges.map(e => [e.id, { passable: true }])),
            pendingFeedback: {
                ...(inherited.pendingFeedback ?? {}),
                // §40：新用户请求经反馈通道进入起点 prompt（复用 reject 闭环机制）
                // Phase B（§10）：结构化干预——instruction 为主指令，inputArtifacts 附加输入，modifiedArtifacts 人工修改版起点
                [reworkNodeId]: {
                    instruction: input.text,
                    text: input.text,
                    reviewId: 'rework',
                    inputArtifacts: input.inputArtifacts ?? [],
                    modifiedArtifacts: input.modifiedArtifacts ?? [],
                    createdAt: new Date().toISOString(),
                },
            },
            // §32/§33: Loop 终止仅依赖执行上限，不再使用 convergedLoops
        };
        // Phase B（§11 modifiedArtifacts）：人工直接修改的 Artifact 作为起点——把引用节点的最新输出替换为修改版
        // （不重跑该节点——rework 闭包外节点保持 success 冻结；下游 buildInputContext 消费修改版）
        if (input.modifiedArtifacts?.length) {
            for (const ref of input.modifiedArtifacts) {
                const hit = this.resolveArtifactRef(inherited, ref);
                if (!hit)
                    continue;
                const outs = state.outputs[hit.nodeId];
                if (outs?.length)
                    outs[outs.length - 1] = { ...outs[outs.length - 1], content: hit.artifact.content };
            }
        }
        this.states.set(executionId, state);
        const ctrl = {
            paused: false, stepMode: false, stopRequested: false,
            resumeWaiter: null, stepWaiter: null, reviewWaiter: null, humanWaiter: null,
            reviewTimer: null, handledReviewTimeouts: new Set(),
        };
        this.controls.set(executionId, ctrl);
        const looper = new LoopController(effectiveDef);
        const ctxMgr = new ContextManager(effectiveDef);
        this.loopers.set(executionId, looper);
        this.defs.set(executionId, effectiveDef);
        const result = this.executeLoop(effectiveDef, state, ctrl, scheduler, looper, ctxMgr, input)
            .finally(async () => {
            state.endedAt = new Date().toISOString();
            if (ctrl.reviewTimer) {
                clearTimeout(ctrl.reviewTimer);
                ctrl.reviewTimer = null;
            }
            this.controls.delete(executionId);
            this.loopers.delete(executionId);
            this.defs.delete(executionId);
            // Phase A：等待终态快照落盘完成，再让 result resolve（Test 6 重启后必读到终态）
            await this.pendingPersist.get(executionId);
            this.pendingPersist.delete(executionId);
        });
        return { executionId, result };
    }
    // ---------------------------------------------------------------- main loop
    async executeLoop(def, state, ctrl, scheduler, looper, ctxMgr, input) {
        this.emit(state.executionId, 'workflow.started');
        // 禁用节点（任务 2）：执行时直接旁路——标记 skipped 不产出，
        // 依赖透传由调度器 resolveThroughDisabled 处理（下游视为直接依赖其上游）
        for (const n of def.nodes) {
            if (n.disabled === true && n.type !== 'start' && n.type !== 'end') {
                state.nodeStates[n.id].status = 'skipped';
                this.emit(state.executionId, 'node.skipped', { reason: 'disabled' }, n.id);
            }
        }
        // start 节点：注入初始输入（任务 5：主输入 + 结构化字段拼接，下游管线零改动）
        const startNode = def.nodes.find(n => n.type === 'start');
        state.outputs[startNode.id] = [{
                runIndex: 1, content: composeStartContent(def, input), durationMs: 0,
                finishedAt: new Date().toISOString(),
            }];
        state.nodeStates[startNode.id] = { status: 'success', iteration: 1, inputReady: [], attempt: 0 };
        state.stepCount++;
        while (true) {
            // stop：仅在尚未因失败/终止改变状态时才视为用户取消
            if (ctrl.stopRequested) {
                if (state.status === 'running') {
                    state.status = 'cancelled';
                    this.markUnfinished(state, 'cancelled');
                    this.emit(state.executionId, 'workflow.terminated', { reason: 'user stop' });
                }
                else {
                    this.markUnfinished(state, 'skipped');
                }
                return state;
            }
            if (ctrl.paused) {
                await new Promise(r => { ctrl.resumeWaiter = r; });
                continue;
            }
            if (ctrl.stepMode) {
                ctrl.stepMode = false;
                await new Promise(r => { ctrl.stepWaiter = r; });
                if (ctrl.paused || ctrl.stepMode)
                    continue;
            }
            // 全局 step 硬检查（先于调度与 loop 判定，防止被 loop/deadlock 分支吞掉）
            if (state.stepCount >= def.settings.maxExecutionSteps) {
                state.status = 'terminated';
                state.error = { code: 'max_steps', message: `reached maxExecutionSteps=${def.settings.maxExecutionSteps}` };
                this.markUnfinished(state, 'skipped');
                this.emit(state.executionId, 'workflow.terminated', { reason: 'max steps' });
                return state;
            }
            // end 节点是汇点：依赖满足且入边放行才视为成功（§58：审核未过的边不能到达终点）
            for (const endNode of def.nodes.filter(n => n.type === 'end')) {
                const st = state.nodeStates[endNode.id];
                if ((st.status === 'idle' || st.status === 'waiting')
                    && scheduler.depsSatisfied(endNode.id, state)
                    && scheduler.edgesPassable(endNode.id, state)) {
                    st.status = 'success';
                    st.iteration = 1;
                    this.emit(state.executionId, 'node.completed', { sink: true }, endNode.id);
                }
            }
            // Human Task Node 调度（Phase 11，§67）：满足依赖的人工任务节点即刻派发任务，
            // 不调 LLM；人工提交前的下游被阻塞，其他并行分支不受影响。
            for (const hn of def.nodes.filter(n => n.type === 'human_task')) {
                const hst = state.nodeStates[hn.id];
                const alreadyPending = (state.humanTasks ?? []).some(t => t.nodeId === hn.id && t.status === 'pending');
                if (hst && !alreadyPending
                    && scheduler.wouldRun(hn.id, state)
                    && looper.beforeNodeStart(hn.id, state).allowed) {
                    this.createHumanTask(def, state, hn, scheduler);
                }
            }
            const runnable = scheduler.nextRunnable(state)
                .filter(id => looper.beforeNodeStart(id, state).allowed);
            if (runnable.length === 0) {
                // Review Gate：存在待处理人工审核（§58）——先处理超时，再挂起等待人工决策。
                // 注：有其他可运行节点时不阻塞全局（审核只阻塞该边），故仅在无可运行节点时挂起。
                if (scheduler.hasPendingReview(state)) {
                    if (this.handleTimedOutReviews(def, state, ctrl))
                        continue;
                    state.status = 'waiting_review';
                    this.emit(state.executionId, 'review.requested', { waiting: pendingReviews(state).map(t => t.id) });
                    await new Promise(r => {
                        ctrl.reviewWaiter = r;
                        // 超时唤醒（§70）：最近的 timeoutAt 到达时重新检查超时策略，不能死等人工
                        const delay = this.nearestReviewTimeout(state, ctrl);
                        if (delay !== null) {
                            ctrl.reviewTimer = setTimeout(() => {
                                ctrl.reviewTimer = null;
                                ctrl.reviewWaiter?.();
                                ctrl.reviewWaiter = null;
                            }, delay);
                        }
                    });
                    if (ctrl.reviewTimer) {
                        clearTimeout(ctrl.reviewTimer);
                        ctrl.reviewTimer = null;
                    }
                    // 等待期间可能被 resolveReview 改为 terminated；其他情况恢复 running（TS 无法感知异步修改）
                    if (state.status !== 'terminated')
                        state.status = 'running';
                    continue; // stopRequested/terminate 在下一轮顶部处理
                }
                // Human Task：存在待人工提交的任务（§67）——与审核同理，仅阻塞该分支；
                // 无可运行 Agent 时挂起等待人工输入。
                if (scheduler.hasPendingHumanTask(state)) {
                    state.status = 'waiting_human';
                    this.emit(state.executionId, 'review.requested', { waiting: (state.humanTasks ?? []).filter(t => t.status === 'pending').map(t => t.id) });
                    await new Promise(r => { ctrl.humanWaiter = r; });
                    if (state.status !== 'terminated')
                        state.status = 'running';
                    continue;
                }
                // 先判上限终止：候选节点全部因环上限/节点运行上限（含 reject 重跑耗尽，§69）被拒，
                // 避免误报为 deadlock（§69：Reject 循环必须受 Loop Controller 统一管理）
                const limitHit = this.limitTerminationCheck(def, state, looper, scheduler);
                if (limitHit) {
                    state.status = 'failed';
                    state.error = limitHit === 'loop'
                        ? { code: 'max_loop_iterations', message: 'maximum loop iterations exceeded' }
                        : { code: 'max_node_runs', message: 'node maxRuns exhausted (possibly by repeated review rejects, §69)' };
                    this.markUnfinished(state, 'skipped');
                    this.emit(state.executionId, 'loop.terminated', { reason: limitHit === 'loop' ? 'max iterations' : 'node maxRuns' });
                    this.emit(state.executionId, 'workflow.failed', { code: state.error.code });
                    return state;
                }
                if (scheduler.allSettled(state)) {
                    state.status = 'completed';
                    this.emit(state.executionId, 'workflow.completed');
                    return state;
                }
                state.status = 'failed';
                const blocked = def.nodes
                    .filter(n => !['success', 'skipped', 'cancelled', 'failed'].includes(state.nodeStates[n.id]?.status ?? 'idle'))
                    .map(n => ({ node: n.id, missing: scheduler.missingDeps(n.id, state) }));
                state.error = { code: 'deadlock', message: `no runnable nodes, blocked: ${JSON.stringify(blocked)}` };
                this.markUnfinished(state, 'skipped');
                this.emit(state.executionId, 'workflow.failed', { code: 'deadlock' });
                return state;
            }
            // 有界并行；同时确保不越过全局 step 上限（本轮装不下的留到下轮，下轮顶即终止）
            const room = Math.max(0, def.settings.maxExecutionSteps - state.stepCount);
            const batch = runnable.slice(0, Math.min(this.opts.concurrency ?? 4, room));
            if (batch.length === 0) {
                state.status = 'terminated';
                state.error = { code: 'max_steps', message: `reached maxExecutionSteps=${def.settings.maxExecutionSteps}` };
                this.markUnfinished(state, 'skipped');
                this.emit(state.executionId, 'workflow.terminated', { reason: 'max steps' });
                return state;
            }
            await Promise.all(batch.map(id => this.runNode(def, state, ctrl, looper, ctxMgr, id, scheduler)));
        }
    }
    /**
     * 无可运行节点时：想运行的候选节点是否全部因上限被拒。
     * 返回 'loop'（环上限）/ 'node'（节点 maxRuns，典型场景：连续 reject 重跑耗尽）/ false。
     */
    limitTerminationCheck(def, state, looper, scheduler) {
        const candidates = def.nodes
            .filter(n => n.type === 'agent' && scheduler.wouldRun(n.id, state));
        if (candidates.length === 0)
            return false;
        const decisions = candidates.map(n => looper.beforeNodeStart(n.id, state));
        if (!decisions.every(d => !d.allowed))
            return false;
        return decisions.every(d => d.level === 'loop') ? 'loop' : 'node';
    }
    async runNode(def, state, ctrl, looper, ctxMgr, nodeId, scheduler) {
        const node = def.nodes.find(n => n.id === nodeId);
        const ns = state.nodeStates[nodeId];
        ns.lastInputVersion = scheduler.inputVersion(nodeId, state); // 记录本次运行的输入版本
        ns.status = 'running';
        ns.iteration = (state.nodeRunCount[nodeId] ?? 0) + 1;
        state.nodeRunCount[nodeId] = ns.iteration;
        state.stepCount++;
        // loop 迭代计数事件
        const loopId = looper.loopIdOf(nodeId);
        if (loopId) {
            state.loopCount[loopId] = looper.currentIteration(loopId, state);
            this.emit(state.executionId, 'loop.iteration', { loopId, iteration: state.loopCount[loopId] }, nodeId);
        }
        this.emit(state.executionId, 'node.started', { runIndex: ns.iteration }, nodeId);
        // 迭代提示（循环语义：参考上一轮修正）
        if (loopId && ns.iteration > 1) {
            node.metadata['__iterationHint'] = `这是你在本循环中的第 ${ns.iteration} 次执行，请参考上一轮输出中反馈的问题进行修正。`;
        }
        const inputContext = ctxMgr.buildInputContext(node, state);
        // 需求 3：工作目录经 metadata 注入 prompt（不改动节点配置本身）
        if (def.settings?.workspaceDir)
            node.metadata['__workspaceDir'] = def.settings.workspaceDir;
        // §27-29：Routing 选项注入——告知 Agent 可选出口，以便在输出中指定 route 字段
        if (node.routingMode === 'agent') {
            const outgoingRoutes = def.edges
                .filter(e => e.source.nodeId === nodeId && e.routingKey)
                .map(e => e.routingKey);
            if (outgoingRoutes.length > 0) {
                node.metadata['__routingOptions'] = outgoingRoutes.join(', ');
            }
        }
        const prompt = buildPrompt(node, inputContext);
        // Reject 反馈闭环（§62）/ Human Input（§8/§10）：新任务上下文 = 原任务 + 上次产出 + 人工指令
        const feedback = state.pendingFeedback[nodeId];
        if (feedback) {
            const prev = state.outputs[nodeId]?.at(-1)?.content ?? '';
            const instruction = feedback.instruction ?? feedback.text;
            prompt.user += [
                '',
                '# HUMAN REVIEW FEEDBACK',
                '你之前提交了以下工作成果：',
                prev,
                '',
                '人工指令：',
                instruction,
                '',
                '请基于上述指令重新完成任务，确保回应其中的每一个要求。',
            ].join('\n');
            // Phase B（§10 inputArtifacts）：把用户附加的 Artifact 内容一并注入 prompt
            const attached = (feedback.inputArtifacts ?? []).map(ref => this.resolveArtifactRef(state, ref)).filter(Boolean);
            if (attached.length) {
                prompt.user += '\n\n# HUMAN ATTACHED INPUT\n' + attached.map(a => `[来源 ${a.nodeId} @v${a.artifact.version}]\n${a.artifact.content}`).join('\n---\n');
            }
            delete state.pendingFeedback[nodeId];
        }
        const rc = node.runtimeConfig;
        const maxAttempts = rc.retry.enabled ? rc.retry.maxRetries + 1 : 1;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (ctrl.stopRequested) {
                ns.status = 'cancelled';
                return;
            }
            ns.attempt = attempt;
            const started = Date.now();
            try {
                let content = '';
                let record = null;
                // §4：节点持久化绑定 DSH Conversation——优先复用已有 sessionId
                const existingSessionId = node.metadata['conversationId'];
                const stream = this.opts.runner.run({
                    node, inputContext, prompt, runIndex: ns.iteration,
                    signal: undefined,
                    workspaceDir: state.workingDirectory,
                    sessionId: existingSessionId,
                });
                let stoppedMidStream = false;
                for await (const chunk of stream) {
                    // stop 即时响应（不等本次 LLM 调用自然结束）：
                    // for-await 在 break 时会自动调用迭代器的 return()，通知底层终止流；
                    // 丢弃部分产出、取消节点
                    if (ctrl.stopRequested) {
                        stoppedMidStream = true;
                        break;
                    }
                    if (chunk.kind === 'delta') {
                        content += chunk.text;
                        this.emit(state.executionId, 'node.thinking', { delta: chunk.text, deltaKind: chunk.deltaKind ?? 'text' }, nodeId);
                    }
                    else {
                        record = chunk.record;
                        // §4：持久化节点 ↔ sessionId 绑定（新创建或已更新时写回）
                        if (chunk.sessionId && chunk.sessionId !== existingSessionId) {
                            node.metadata['conversationId'] = chunk.sessionId;
                            // 由 API 层在 handle.result.finally() 中持久化 def（含 conversationId）
                        }
                    }
                }
                if (stoppedMidStream) {
                    ns.status = 'cancelled';
                    this.emit(state.executionId, 'node.failed', { reason: 'stopped by user', runIndex: ns.iteration }, nodeId);
                    return;
                }
                const finalRecord = record ?? {
                    content, durationMs: Date.now() - started, finishedAt: new Date().toISOString(),
                };
                (state.outputs[nodeId] ??= []).push({ runIndex: ns.iteration, ...finalRecord });
                // Artifact 登记（§64 + 任务 5）：Agent 产出 = v1 Artifact；
                // 大内容经 ArtifactManager 自动落盘转引用存储（§55.2：不塞 JSON）
                const artifact = await this.artifacts.create({
                    executionId: state.executionId,
                    nodeId,
                    kind: kindFromFormat(node.outputContract.format),
                    content: finalRecord.content,
                    createdBy: 'agent',
                    mimeType: node.outputContract.format === 'json' ? 'application/json' : undefined,
                });
                (state.artifacts[nodeId] ??= []).push(artifact);
                this.emit(state.executionId, 'node.output_generated', { runIndex: ns.iteration, artifactId: artifact.id }, nodeId);
                // §22/§36：节点级 Review Gate（输出质量门）——审核只检查数据质量，不决定路由路径
                // 审核通过后，继续执行 Routing Decision 和边级审核
                if (node.review?.enabled && node.review.mode === 'required') {
                    const rtask = createNodeReviewTask(state, state.executionId, nodeId, artifact.id, node.review);
                    this.emit(state.executionId, 'review.requested', { taskId: rtask.id, artifactId: artifact.id, mode: node.review.mode }, nodeId, undefined);
                    ns.status = 'waiting_review'; // §59：等待人工审核
                    this.emit(state.executionId, 'node.completed', { runIndex: ns.iteration, durationMs: finalRecord.durationMs, gated: true }, nodeId);
                    return;
                }
                // Routing Decision（§27-29）：根据节点 routingMode 和输出内容，决定哪些出边可通行
                // - agent：匹配输出中的 route 值与出边的 routingKey
                // - static（默认）：全部出边可通行
                // - condition / human：由条件表达式/人工选择（留待后续 Phase）
                if (node.routingMode === 'agent') {
                    const route = extractRouteFromOutput(finalRecord.content, node.outputContract.format);
                    for (const e of def.edges.filter(e => e.source.nodeId === nodeId)) {
                        if (e.routingKey) {
                            const match = route !== undefined && e.routingKey === route;
                            state.edgeState[e.id] = { ...state.edgeState[e.id], passable: match };
                            if (!match) {
                                this.emit(state.executionId, 'edge.skipped', { edgeId: e.id, reason: `routingKey mismatch: expected "${e.routingKey}", got "${route ?? '(undefined)'}"` }, nodeId, e.id);
                            }
                        }
                    }
                }
                // Edge-level Review Gate（§55-58）：required 的出边创建审核任务并阻塞流转；optional MVP 默认自动通过
                let gated = false;
                for (const e of def.edges.filter(e => e.source.nodeId === nodeId)) {
                    if (state.edgeState[e.id]?.passable === false)
                        continue; // routing 已拒绝的边不再触发审核
                    this.emit(state.executionId, 'edge.triggered', { edgeId: e.id }, nodeId, e.id);
                    if (e.review?.enabled && e.review.mode === 'required') {
                        const task = createReviewTask(state, state.executionId, e, artifact.id);
                        this.emit(state.executionId, 'review.requested', { taskId: task.id, artifactId: artifact.id, mode: e.review.mode }, nodeId, e.id);
                        gated = true;
                    }
                }
                ns.status = gated ? 'waiting_review' : 'success'; // §59
                this.emit(state.executionId, 'node.completed', { runIndex: ns.iteration, durationMs: finalRecord.durationMs, gated }, nodeId);
                return;
            }
            catch (err) {
                if (attempt < maxAttempts) {
                    ns.status = 'running';
                    this.emit(state.executionId, 'node.retrying', { attempt, error: String(err) }, nodeId);
                    await new Promise(r => setTimeout(r, rc.retry.backoffMs * 2 ** (attempt - 1)));
                    continue;
                }
                // 最终失败
                if (rc.onFailure === 'skip') {
                    ns.status = 'skipped';
                    this.emit(state.executionId, 'node.skipped', { error: String(err) }, nodeId);
                    return;
                }
                ns.status = 'failed';
                state.status = 'failed';
                state.error = { code: 'node_failed', message: String(err), nodeId };
                this.emit(state.executionId, 'node.failed', { error: String(err) }, nodeId);
                this.emit(state.executionId, 'workflow.failed', { nodeId });
                ctrl.stopRequested = true; // 终止主循环
                return;
            }
        }
    }
    // ---------------------------------------------------------------- helpers
    markUnfinished(state, status) {
        for (const ns of Object.values(state.nodeStates)) {
            if (['idle', 'waiting', 'queued', 'running', 'waiting_review', 'waiting_human'].includes(ns.status))
                ns.status = status;
        }
        // 挂起中的人工任务一并取消（Phase 11）
        for (const t of state.humanTasks ?? []) {
            if (t.status === 'pending')
                t.status = 'cancelled';
        }
    }
    /** 审核超时处理（§70）：返回是否有处理动作（有的话主循环 continue 重新调度） */
    handleTimedOutReviews(def, state, ctrl) {
        const nowMs = Date.now();
        const timedOut = state.reviewTasks.filter(t => t.status === 'pending' && t.timeoutAt
            && !ctrl.handledReviewTimeouts.has(t.id)
            && new Date(t.timeoutAt).getTime() <= nowMs);
        for (const task of timedOut) {
            ctrl.handledReviewTimeouts.add(task.id);
            const edge = def.edges.find(e => e.id === task.edgeId);
            const onTimeout = edge?.review?.onTimeout ?? 'pause';
            state.auditLog.push({
                reviewId: task.id, artifactId: task.artifactId, action: 'timeout', operator: 'system',
                comment: `审核超时，策略=${onTimeout}`, fromVersion: null, toVersion: null,
                timestamp: new Date().toISOString(),
            });
            this.emit(state.executionId, 'review.timeout', { taskId: task.id, onTimeout }, task.sourceNodeId, task.edgeId);
            if (onTimeout === 'auto_accept') {
                this.resolveReview(state.executionId, task.id, 'accept', { comment: '审核超时，自动通过', operator: 'system' });
            }
            else if (onTimeout === 'auto_reject') {
                this.resolveReview(state.executionId, task.id, 'reject', { comment: '审核超时，自动打回', operator: 'system' });
            }
            else if (onTimeout === 'fail') {
                applyReviewDecision(state, task.id, 'terminate', { comment: '审核超时导致失败', operator: 'system' });
                state.status = 'failed';
                state.error = { code: 'review_timeout', message: '审核超时（onTimeout=fail）' };
                this.markUnfinished(state, 'skipped');
                this.emit(state.executionId, 'workflow.failed', { code: 'review_timeout' });
                ctrl.stopRequested = true;
            }
            // pause：保持等待（默认策略，不替用户做决定）
        }
        return timedOut.length > 0;
    }
    /** 最近的未处理审核超时时刻距当前的毫秒数；无则返回 null */
    nearestReviewTimeout(state, ctrl) {
        const nowMs = Date.now();
        let min = null;
        for (const t of state.reviewTasks) {
            if (t.status !== 'pending' || !t.timeoutAt || ctrl.handledReviewTimeouts.has(t.id))
                continue;
            const delay = Math.max(0, new Date(t.timeoutAt).getTime() - nowMs);
            if (min === null || delay < min)
                min = delay;
        }
        return min;
    }
    emit(executionId, type, payload, nodeId, edgeId) {
        const state = this.states.get(executionId);
        // 第三阶段：终态事件 → 完整快照持久化钩子（单一出口，四个终态全覆盖）
        if (state && ['workflow.completed', 'workflow.failed', 'workflow.terminated'].includes(type)) {
            // Phase A：终态持久化 await 化——finally 中等待其完成，保证 result resolve 前快照已落盘（消除 Test 6 竞态）
            try {
                this.pendingPersist.set(executionId, Promise.resolve(this.opts.onExecutionEnd?.(state)).catch(() => { }));
            }
            catch { /* 持久化失败不影响运行时 */ }
        }
        this.bus.emit({
            type,
            executionId,
            workflowId: state?.workflowId ?? '',
            nodeId,
            edgeId,
            timestamp: Date.now(),
            payload,
        });
    }
}
/**
 * 组合 start 节点初始内容（任务 5）：主输入文本 + 结构化字段按类型格式化。
 * 字段为空时退化为纯文本（旧行为）。文件/目录类字段以引用行呈现
 * （§55.2：路径只写引用，不把文件内容塞进 Prompt）。
 */
export function composeStartContent(def, input) {
    const fields = input.fields ?? {};
    const defs = def.inputSchema?.fields ?? [];
    if (!defs.length)
        return input.text;
    const lines = [input.text];
    const fieldLines = [];
    for (const f of defs) {
        const v = fields[f.name];
        if (v === undefined || v === null || (typeof v === 'string' && v.trim() === ''))
            continue;
        const label = f.label ?? f.name;
        switch (f.type) {
            case 'file':
            case 'directory':
                fieldLines.push(`${label}: [${f.type}:${v}]`);
                break;
            case 'files':
                fieldLines.push(`${label}: ${v.map(p => `[file:${p}]`).join(', ')}`);
                break;
            case 'artifact':
                fieldLines.push(`${label}: [artifact:${v}]`);
                break;
            case 'json':
                fieldLines.push(`${label}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
                break;
            case 'boolean':
                fieldLines.push(`${label}: ${v === 'true' || v === true ? 'true' : 'false'}`);
                break;
            default:
                fieldLines.push(`${label}: ${String(v)}`);
        }
    }
    if (fieldLines.length)
        lines.push('\n[启动参数]\n' + fieldLines.join('\n'));
    return lines.join('\n');
}
/**
 * §27：从 Agent 输出中提取 route 值，用于 routingKey 匹配。
 * - JSON 格式：尝试解析顶层 route 字段
 * - Markdown 格式：查找 route: 或 route：开头的行
 * - 解析失败或无 route 字段返回 undefined（所有出边放行）
 */
function extractRouteFromOutput(content, format) {
    if (format === 'json') {
        try {
            const parsed = JSON.parse(content);
            if (typeof parsed.route === 'string')
                return parsed.route;
            // 兼容嵌套结构：result.route
            if (parsed.result && typeof parsed.result.route === 'string')
                return parsed.result.route;
        }
        catch { /* 非 JSON 回退到 markdown 解析 */ }
    }
    // Markdown/plaintext：查找 route: 或 route：开头的行
    const match = content.match(/^route\s*[:：]\s*(\S+)/m);
    return match?.[1] ?? undefined;
}
