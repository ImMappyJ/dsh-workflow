/**
 * dsh-plugin-workflow —— Cordis 宿主插件入口。
 *
 * 职责（Phase 3：API 层 + 静态页占位；编辑器 UI 在 Phase 4/5 落地 public/）：
 *  - 进程内组装：WorkflowEngine + DshSessionProvider(ctx.apiProxy)
 *  - 独立端口 HTTP 服务（默认 3090）：
 *      GET    /api/health                     探活（apiProxy 接入状态）
 *      GET    /api/workflows                  列出
 *      POST   /api/workflows                  创建/保存（校验，环图自动补 LoopConfig）
 *      GET    /api/workflows/:id              读取
 *      DELETE /api/workflows/:id              删除
 *      POST   /api/workflows/:id/run          运行（body: {input})
 *      GET    /api/executions/:id             运行状态
 *      POST   /api/executions/:id/control     控制（body: {cmd: pause|resume|stop|step}）
 *      POST   /api/executions/:id/review      人工审核决策（body: {taskId, action, comment?, content?}）
 *      GET    /api/events?executionId=...     SSE 事件流（25s 心跳）
 *      GET    /api/models                     可用模型列表（透传宿主）
 *  - Phase 9 Preset/Template：
 *      GET    /api/templates                  列表（内置 + 用户）
 *      POST   /api/templates                  把当前工作流存为用户模板（body: {def, name, description}）
 *      DELETE /api/templates/:id              删除用户模板（内置不可删）
 *      POST   /api/templates/:id/instantiate  从模板创建工作流（body: {id, name?}）
 *  - 静态资源：public/（磁盘直读，支持热重载）
 */
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WorkflowEngine } from './engine/engine.js';
import { MockAgentRunner } from './engine/runner.js';
import { DshSessionProvider } from './provider/dsh-session-provider.js';
import { createStorage } from './storage/repo.js';
import { loopsFromSccs } from './graph/validator.js';
import { BUILTIN_TEMPLATES, instantiateTemplate } from './templates/builtin.js';
import { DEFAULTS, effectiveRevision } from './domain/types.js';
export const name = 'dsh-plugin-workflow';
// 只声明必填的 apiProxy。webServer（任务 3 入口路由）不能进 inject：
// 部分 profile（如 desktop）不提供 dsh-host-webserver，必填依赖会让插件树加载失败。
// webServer 改用 ctx.get('webServer') 免 inject 可选探测（cordis 官方支持的无 inject 读取）。
export const inject = ['apiProxy'];
// 零依赖：不导出 Config Schema（对齐已验证的参考插件形态），默认值在 apply 内合并
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
};
/** 可独立测试的服务器组装（不依赖 cordis ctx） */
export function createWorkflowServer(opts) {
    // 帧诊断缓冲（最近 500 帧，用于观察真实 assistant/chunk 结构）
    const frameLog = [];
    const runner = opts.mock
        ? new MockAgentRunner()
        : new DshSessionProvider(opts.apiProxy, {
            onFrame: frame => {
                frameLog.push({ t: new Date().toISOString(), type: frame.event?.type ?? '?', event: frame.event });
                if (frameLog.length > 500)
                    frameLog.shift();
            },
        });
    const storage = createStorage(opts.dataDir);
    void storage.workflows.init();
    void storage.executions.init();
    // 第三阶段 §37/原则 3：终态完整快照落盘（历史 Execution 重启后可查，Test 6）
    const engine = new WorkflowEngine({
        runner, dataDir: opts.dataDir,
        // Phase A：返回 Promise，引擎 finally await 其完成——保证 result resolve 前快照已落盘（消除 Test 6 竞态）
        onExecutionEnd: (state) => storage.executions.save({ ...state, id: state.executionId }).catch(() => { }),
    });
    // 活跃 execution 的状态引用
    const liveStates = new Map();
    const server = createServer((req, res) => {
        void handle(req, res).catch(e => {
            if (!res.headersSent)
                json(res, 500, { error: String(e?.message ?? e) });
            else
                try {
                    res.end();
                }
                catch { /* ignore */ }
        });
    });
    async function handle(req, res) {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const p = url.pathname;
        if (p.startsWith('/api/'))
            return api(req, res, url);
        return serveStatic(req, res, url);
    }
    // ---------------------------------------------------------------- API
    async function api(req, res, url) {
        const p = url.pathname;
        const method = req.method ?? 'GET';
        if (p === '/api/health') {
            return json(res, 200, {
                plugin: name,
                apiProxy: Boolean(opts.apiProxy),
                mock: Boolean(opts.mock),
                port: opts.port,
            });
        }
        if (p === '/api/models' && opts.apiProxy) {
            const r = await opts.apiProxy.llm?.models?.({ rpcId: randomUUID(), payload: {} });
            return json(res, 200, r?.result?.value ?? r ?? {});
        }
        // 工作目录选择：三级降级——宿主 native picker → Python tkinter 系统原生对话框 → 空
        if (p === '/api/pick-directory' && method === 'POST') {
            // 1) 宿主原生 picker（native capability，宿主弹系统对话框）
            if (opts.apiProxy && opts.apiProxy.host?.pickDirectory) {
                try {
                    const r = await opts.apiProxy.host.pickDirectory({ rpcId: randomUUID(), payload: {} });
                    if (!r?.error) {
                        const p = r?.result?.value?.path ?? null;
                        if (p)
                            return json(res, 200, { ok: true, path: String(p).replace(/\\/g, '/') });
                        // p === null → 宿主对话框未弹出或用户取消，继续降级
                    }
                }
                catch (_) { /* 宿主异常 → 降级 */ }
            }
            // 2) Python tkinter 系统原生文件夹选择器（Windows SHBrowseForFolderW API，可独立弹窗）
            //    测试环境无 GUI，跳过 Python 降级
            if (!process.env.VITEST) {
                const script = path.join(__dirname, '../public/pick-folder.py');
                try {
                    await fs.access(script);
                    const p = await new Promise((resolve) => {
                        const child = execFile('python', [script], { timeout: 30000, windowsHide: true }, (err, stdout) => {
                            if (err) {
                                resolve(null);
                                return;
                            }
                            const v = stdout.trim();
                            resolve(v || null);
                        });
                    });
                    if (p)
                        return json(res, 200, { ok: true, path: p });
                }
                catch (_) { /* Python 不可用 → 返回空，前端提示手动输入 */ }
            }
            return json(res, 200, { ok: true, path: null });
        }
        if (p === '/api/frames' && method === 'GET') {
            return json(res, 200, { count: frameLog.length, frames: frameLog });
        }
        // ---- 节点预设库（需求 4：人才市场式节点模板）----
        // 预设 = 单个节点的完整配置快照（身份/契约/模型/运行时），插入时生成新 id。
        let m;
        if (p === '/api/presets' && method === 'GET') {
            const list = await storage.presets.list();
            return json(res, 200, list.map(pr => ({
                id: pr.id, name: pr.name, description: pr.description,
                nodeType: pr.node?.type, model: pr.node?.modelConfig?.model,
                createdAt: pr.createdAt,
            })));
        }
        if (p === '/api/presets' && method === 'POST') {
            const body = await readBody(req);
            if (!body.node || !['agent', 'human_task'].includes(body.node.type)) {
                return json(res, 400, { error: '仅 Agent / 人工任务节点可存为预设' });
            }
            const now = new Date().toISOString();
            const preset = {
                id: `preset_${randomUUID().slice(0, 8)}`,
                name: body.name?.trim() || body.node.name || '未命名预设',
                description: body.description?.trim() || (body.node.roleDescription || '').slice(0, 80),
                node: { ...structuredClone(body.node), id: '', position: { x: 0, y: 0 } },
                createdAt: now,
            };
            await storage.presets.save(preset);
            return json(res, 200, { saved: true, preset: { id: preset.id, name: preset.name } });
        }
        if ((m = p.match(/^\/api\/presets\/([^/]+)$/)) && method === 'DELETE') {
            const ok = await storage.presets.remove(m[1]);
            return json(res, ok ? 200 : 404, { removed: ok });
        }
        if ((m = p.match(/^\/api\/presets\/([^/]+)$/)) && method === 'GET') {
            const pr = await storage.presets.get(m[1]);
            if (!pr)
                return json(res, 404, { error: '预设不存在' });
            return json(res, 200, pr);
        }
        // ---- templates（Phase 9） ----
        if (p === '/api/templates' && method === 'GET') {
            const userTemplates = await storage.templates.list();
            const all = [...BUILTIN_TEMPLATES, ...userTemplates];
            return json(res, 200, all.map(t => ({
                id: t.id, name: t.name, description: t.description, category: t.category,
                nodeCount: t.def.nodes.length, edgeCount: t.def.edges.length,
            })));
        }
        if ((m = p.match(/^\/api\/templates\/([^/]+)$/)) && method === 'GET') {
            const tpl = BUILTIN_TEMPLATES.find(t => t.id === m[1]) ?? (await storage.templates.get(m[1]));
            if (!tpl)
                return json(res, 404, { error: 'template not found' });
            return json(res, 200, tpl);
        }
        if (p === '/api/templates' && method === 'POST') {
            const body = await readBody(req);
            if (!body.def?.id)
                return json(res, 400, { error: '缺少 def（完整工作流定义）' });
            const validation = engine.validate(body.def);
            if (!validation.valid)
                return json(res, 400, { error: 'validation failed', issues: validation.errors });
            const now = new Date().toISOString();
            const tpl = {
                id: `tpl_${randomUUID().slice(0, 8)}`,
                name: body.name?.trim() || body.def.name || '未命名模板',
                description: body.description?.trim() || '',
                category: 'user',
                def: body.def,
                createdAt: now, updatedAt: now,
            };
            await storage.templates.save(tpl);
            return json(res, 200, { saved: true, template: { id: tpl.id, name: tpl.name } });
        }
        if ((m = p.match(/^\/api\/templates\/([^/]+)$/)) && method === 'DELETE') {
            if (BUILTIN_TEMPLATES.some(t => t.id === m[1]))
                return json(res, 400, { error: '内置模板不可删除' });
            return json(res, 200, { removed: await storage.templates.remove(m[1]) });
        }
        if ((m = p.match(/^\/api\/templates\/([^/]+)\/instantiate$/)) && method === 'POST') {
            const tplId = m[1];
            const body = await readBody(req);
            const tpl = BUILTIN_TEMPLATES.find(t => t.id === tplId) ?? (await storage.templates.get(tplId));
            if (!tpl)
                return json(res, 404, { error: 'template not found' });
            const newId = body.id?.trim() || `${tplId.replace(/^tpl_/, 'wf_')}_${randomUUID().slice(0, 6)}`;
            if (await storage.workflows.get(newId))
                return json(res, 400, { error: `工作流 ${newId} 已存在` });
            const def = instantiateTemplate(tpl, newId, body.name);
            const validation = engine.validate(def);
            def.loops = loopsFromSccs(validation.loops, def.loops);
            await storage.workflows.save(def);
            return json(res, 200, { created: true, workflow: def });
        }
        // ---- workflows CRUD ----
        if (p === '/api/workflows' && method === 'GET') {
            return json(res, 200, await storage.workflows.list());
        }
        // 只校验不保存（编辑器“校验”按钮）
        if (p === '/api/workflows/validate' && method === 'POST') {
            const def = await readBody(req);
            if (!def?.id)
                return json(res, 400, { error: '缺少 id' });
            const validation = engine.validate(def);
            return json(res, 200, {
                valid: validation.valid,
                errors: validation.errors,
                warnings: validation.warnings,
                loops: validation.loops,
            });
        }
        if (p === '/api/workflows' && method === 'POST') {
            const def = await readBody(req);
            if (!def?.id)
                return json(res, 400, { error: '缺少 id' });
            const validation = engine.validate(def);
            if (!validation.valid)
                return json(res, 400, { error: 'validation failed', issues: validation.errors });
            // 环图自动补全 LoopConfig（允许保存，符合 §6.1 决策）
            def.loops = loopsFromSccs(validation.loops, def.loops);
            def.updatedAt = new Date().toISOString();
            // 第三阶段 §4：保存时自增 revision（旧 Definition 从 1 起算），历史 Execution 绑定旧版本
            const prev = await storage.workflows.get(def.id);
            def.revision = prev ? effectiveRevision(prev) + 1 : 1;
            await storage.workflows.save(def);
            // Phase A（§4/§5）：每次保存产生不可变版本快照（key: {id}__v{rev}），历史版本可随时还原/运行
            await storage.workflowVersions.save({
                id: `${def.id}__v${def.revision}`,
                workflowId: def.id,
                revision: def.revision,
                savedAt: def.updatedAt,
                def: JSON.parse(JSON.stringify(def)),
            }).catch(() => { });
            return json(res, 200, { saved: true, warnings: validation.warnings, workflow: def });
        }
        // 导入：接收 JSON 定义，校验后另存为新 id（或覆盖已有）
        if (p === '/api/workflows/import' && method === 'POST') {
            const def = await readBody(req);
            if (!def?.id || !def?.nodes)
                return json(res, 400, { error: '无效的工作流定义：缺少 id 或 nodes' });
            const validation = engine.validate(def);
            if (!validation.valid)
                return json(res, 400, { error: '导入定义校验失败', issues: validation.errors });
            def.loops = loopsFromSccs(validation.loops, def.loops);
            def.updatedAt = new Date().toISOString();
            if (!def.createdAt)
                def.createdAt = def.updatedAt;
            const prev = await storage.workflows.get(def.id);
            def.revision = prev ? effectiveRevision(prev) + 1 : 1;
            await storage.workflows.save(def);
            return json(res, 200, { imported: true, warnings: validation.warnings, workflow: def });
        }
        // Phase A（§4/§24）：版本快照列表——历史 Version 可枚举、可还原、可指定运行
        if ((m = p.match(/^\/api\/workflows\/([^/]+)\/versions$/)) && method === 'GET') {
            const id = m[1];
            const all = await storage.workflowVersions.list();
            const versions = all
                .filter(v => v.workflowId === id)
                .sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0))
                .map(v => ({
                revision: v.revision,
                savedAt: v.savedAt,
                name: v.def?.name,
                nodeCount: v.def?.nodes?.length ?? 0,
                edgeCount: v.def?.edges?.length ?? 0,
            }));
            return json(res, 200, versions);
        }
        if ((m = p.match(/^\/api\/workflows\/([^/]+)$/))) {
            const id = m[1];
            if (method === 'GET') {
                // Phase A：?version=N 返回指定历史版本快照（§24：Run with Version N）
                const qv = url.searchParams.get('version');
                if (qv) {
                    const snap = await storage.workflowVersions.get(`${id}__v${qv}`);
                    return snap?.def ? json(res, 200, snap.def) : json(res, 404, { error: 'version not found' });
                }
                const def = await storage.workflows.get(id);
                return def ? json(res, 200, def) : json(res, 404, { error: 'not found' });
            }
            if (method === 'DELETE') {
                // 级联清理：删除工作流时一并移除其全部执行记录（磁盘快照 + 引擎内存态）与版本快照
                const diskExecs = await storage.executions.list();
                const memExecs = [...engine.states.values()];
                const execIds = new Set([
                    ...diskExecs.filter((x) => x && x.workflowId === id).map((x) => x.executionId ?? x.id),
                    ...memExecs.filter((x) => x && x.workflowId === id).map((x) => x.executionId ?? x.id),
                ]);
                for (const eid of execIds) {
                    const st = engine.states.get(eid);
                    if (st && !['completed', 'failed', 'terminated', 'cancelled'].includes(st.status)) {
                        try {
                            engine.control(eid, 'stop');
                        }
                        catch { /* 已结束则忽略 */ }
                    }
                    await storage.executions.remove(eid).catch(() => { });
                    engine.states.delete(eid);
                }
                // 版本快照：key 为 {workflowId}__v{rev}
                const versions = await storage.workflowVersions.list();
                const matchedVersions = versions.filter((v) => v && (v.workflowId === id || (v.id ?? '').startsWith(`${id}__v`)));
                for (const v of matchedVersions) {
                    await storage.workflowVersions.remove(v.id).catch(() => { });
                }
                const removed = await storage.workflows.remove(id);
                return json(res, 200, { removed, removedExecutions: execIds.size, removedVersions: matchedVersions.length });
            }
        }
        // ---- run ----
        // 第三阶段 §39/Test 7-8：Rework From Here —— 从历史执行的某节点继续
        if ((m = p.match(/^\/api\/workflows\/([^/]+)\/rework$/)) && method === 'POST') {
            const def = await storage.workflows.get(m[1]);
            if (!def)
                return json(res, 404, { error: 'workflow not found' });
            // Phase B（§10）：结构化 Human Intervention——instruction 为主指令，inputArtifacts 附加输入，modifiedArtifacts 人工修改版起点
            const body = await readBody(req);
            if (!body.parentExecutionId || !body.reworkNodeId) {
                return json(res, 400, { error: 'parentExecutionId 与 reworkNodeId 必填' });
            }
            // 父状态：内存优先，回退磁盘快照（历史执行）
            const parentState = engine.states.get(body.parentExecutionId)
                ?? await storage.executions.get(body.parentExecutionId);
            if (!parentState)
                return json(res, 404, { error: 'parent execution not found' });
            try {
                const handle = await engine.rework(def, parentState, body.reworkNodeId, {
                    text: body.instruction ?? body.input ?? '',
                    fields: body.fields,
                    inputArtifacts: body.inputArtifacts,
                    modifiedArtifacts: body.modifiedArtifacts,
                });
                // 同 run：快速完成时终态快照已落盘，不再覆盖启动标记
                const rst = engine.getExecution(handle.executionId);
                if (!rst || !['completed', 'failed', 'terminated'].includes(rst.status)) {
                    await storage.executions.save({
                        id: handle.executionId, executionId: handle.executionId,
                        workflowId: def.id, status: 'running', startedAt: new Date().toISOString(),
                    }).catch(() => { });
                }
                return json(res, 200, { executionId: handle.executionId, parentExecutionId: body.parentExecutionId, reworkNodeId: body.reworkNodeId });
            }
            catch (e) {
                return json(res, 400, { error: String(e?.message ?? e) });
            }
        }
        if ((m = p.match(/^\/api\/workflows\/([^/]+)\/run$/)) && method === 'POST') {
            const body = await readBody(req);
            // Phase A（§24）：指定 version 时用该历史版本运行，否则用最新
            let def = null;
            if (body.version != null) {
                const snap = await storage.workflowVersions.get(`${m[1]}__v${body.version}`);
                def = snap?.def ?? null;
            }
            else {
                def = await storage.workflows.get(m[1]);
            }
            if (!def)
                return json(res, 404, { error: 'workflow not found' });
            try {
                // 任务 5：透传结构化启动字段（引擎按 inputSchema 校验）；Phase B：可带附加/修改 Artifact
                const handle = await engine.run(def, { text: body.input ?? '', fields: body.fields, inputArtifacts: body.inputArtifacts, modifiedArtifacts: body.modifiedArtifacts });
                // 第三阶段：不再每事件写最小标记（会与终态完整快照竞态覆盖）；
                // 启动时写一次标记（进行中可见），终态完整快照由 onExecutionEnd 钩子负责。
                // await 保证启动标记先落盘，终态完整快照必然在其后（顺序不可颠倒）
                // Phase 10 修复：mock/快速执行可能在 run 返回前已完成且终态快照已落盘；
                // 此时再写启动标记会把终态覆盖回 running。仅对未结束的执行写标记。
                const st0 = engine.getExecution(handle.executionId);
                if (!st0 || !['completed', 'failed', 'terminated'].includes(st0.status)) {
                    await storage.executions.save({
                        id: handle.executionId, executionId: handle.executionId,
                        workflowId: def.id, status: 'running', startedAt: new Date().toISOString(),
                    }).catch(() => { });
                }
                const unsub = engine.subscribe(handle.executionId, () => { });
                liveStates.set(handle.executionId, unsub);
                void handle.result.finally(async () => {
                    // §4：持久化节点 ↔ Conversation 绑定（engine 在 runNode 中已设置 node.metadata.conversationId）
                    try {
                        // 清理临时 metadata（__ 前缀为引擎注入的运行时数据，不持久化）
                        for (const n of def.nodes) {
                            if (n.metadata?.['conversationId']) {
                                const cleanMeta = {};
                                for (const [k, v] of Object.entries(n.metadata)) {
                                    if (!k.startsWith('__'))
                                        cleanMeta[k] = v;
                                }
                                n.metadata = cleanMeta;
                            }
                        }
                        await storage.workflows.save(def);
                    }
                    catch { /* 非关键路径：conversationId 持久化失败不影响执行结果 */ }
                    setTimeout(() => {
                        liveStates.get(handle.executionId)?.();
                        liveStates.delete(handle.executionId);
                    }, 60_000);
                });
                return json(res, 200, { executionId: handle.executionId });
            }
            catch (e) {
                return json(res, 400, { error: String(e?.message ?? e) });
            }
        }
        // ---- executions ----
        // 第三阶段 §37：执行历史列表（内存活跃 + 磁盘快照合并，按 startedAt 降序）
        if (p === '/api/executions' && method === 'GET') {
            const disk = await storage.executions.list();
            const mem = [...engine.states.values()];
            const byId = new Map();
            for (const d of disk)
                byId.set(d.executionId ?? d.id, d);
            for (const s of mem)
                byId.set(s.executionId, s); // 内存（活跃/最新）优先
            // 按 workflowId 过滤（工作流卡片「迭代」入口）：同一工作流的历次执行（迭代链）
            const wfFilter = (url.searchParams.get('workflowId') ?? '').trim();
            const items = [...byId.values()]
                .filter(x => x && (x.executionId || x.id))
                .filter(x => !wfFilter || x.workflowId === wfFilter)
                .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')))
                .map(x => ({
                executionId: x.executionId ?? x.id,
                workflowId: x.workflowId,
                workflowVersion: x.workflowVersion ?? 1,
                status: x.status,
                startedAt: x.startedAt,
                endedAt: x.endedAt,
                parentExecutionId: x.parentExecutionId ?? null,
                reworkNodeId: x.reworkNodeId ?? null,
                workingDirectory: x.workingDirectory ?? null,
                userInput: (x.userInput ?? '').slice(0, 120),
            }));
            // Workbench View Model（§23/§28）：主信息为 workflowName + runNumber，技术 ID 退居详情
            const wfList = await storage.workflows.list();
            const wfNames = new Map(wfList.map(w => [w.id, w.name]));
            const byWf = new Map();
            for (const it of items) {
                const k = it.workflowId ?? '';
                if (!byWf.has(k))
                    byWf.set(k, []);
                byWf.get(k).push(it);
            }
            const runNo = new Map();
            for (const arr of byWf.values()) {
                arr.sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')));
                arr.forEach((it, i) => runNo.set(it.executionId, i + 1)); // Run #N：同一 Workflow 第 N 次运行（§24）
            }
            const view = items.map(it => ({
                ...it,
                workflowName: wfNames.get(it.workflowId) ?? it.workflowName ?? `（工作流已删除：${it.workflowId}）`,
                runNumber: runNo.get(it.executionId) ?? 1,
                updatedAt: it.endedAt ?? it.startedAt,
            }));
            return json(res, 200, view);
        }
        if ((m = p.match(/^\/api\/executions\/([^/]+)$/)) && method === 'GET') {
            const id = m[1];
            const state = engine.states?.get?.(id);
            if (state) {
                const wf0 = await storage.workflows.get(state.workflowId);
                return json(res, 200, { ...state, workflowName: wf0?.name ?? state.workflowName ?? null });
            }
            // 第三阶段：内存没有时回退磁盘快照（历史 Execution，Test 6）
            const disk = await storage.executions.get(id);
            if (!disk)
                return json(res, 404, { error: 'execution not found' });
            const wf = await storage.workflows.get(disk.workflowId);
            return json(res, 200, { ...disk, workflowName: wf?.name ?? disk.workflowName ?? null });
        }
        // Workbench（§10-13）：删除 Execution —— 绝不触碰 Workflow Definition；保护 Execution Tree
        if ((m = p.match(/^\/api\/executions\/([^/]+)$/)) && method === 'DELETE') {
            const id = m[1];
            const st = engine.states?.get?.(id);
            if (st && !['completed', 'failed', 'terminated', 'cancelled'].includes(st.status)) {
                return json(res, 409, { error: '执行仍在运行，请先终止后再删除' });
            }
            const disk = await storage.executions.get(id);
            if (!disk && !st)
                return json(res, 404, { error: 'execution not found' });
            // §13：存在子 Rework 时禁止直接删除，避免 Execution Tree 断裂
            const all = await storage.executions.list();
            const memStates = [...engine.states.values()];
            const child = all.find(x => x && x.parentExecutionId === id)
                || memStates.find(x => x && x.parentExecutionId === id);
            if (child) {
                return json(res, 409, { error: `该执行存在 Rework 子执行（${child.executionId ?? child.id}），请先删除子执行` });
            }
            const removed = await storage.executions.remove(id);
            return json(res, 200, { removed, workflowId: disk?.workflowId ?? null });
        }
        if ((m = p.match(/^\/api\/executions\/([^/]+)\/control$/)) && method === 'POST') {
            const body = await readBody(req);
            const cmds = ['pause', 'resume', 'stop', 'step'];
            if (!cmds.includes(body.cmd))
                return json(res, 400, { error: `cmd 必须是 ${cmds.join('/')}` });
            engine.control(m[1], body.cmd);
            return json(res, 200, { ok: true });
        }
        // 人工审核决策（§58-73）：accept / reject / edit / accept_after_edit / terminate
        if ((m = p.match(/^\/api\/executions\/([^/]+)\/review$/)) && method === 'POST') {
            const body = await readBody(req);
            const actions = ['accept', 'reject', 'edit', 'accept_after_edit', 'terminate'];
            if (!body.taskId)
                return json(res, 400, { error: 'taskId 必填' });
            if (!body.action || !actions.includes(body.action))
                return json(res, 400, { error: `action 必须是 ${actions.join('/')}` });
            try {
                const outcome = engine.resolveReview(m[1], body.taskId, body.action, {
                    comment: body.comment ?? null, content: body.content,
                });
                return json(res, 200, { ok: true, taskStatus: outcome.task.status });
            }
            catch (e) {
                return json(res, 400, { error: String(e?.message ?? e) });
            }
        }
        // 批量审核决策（任务 5 MVP：Accept All / Reject All）
        if ((m = p.match(/^\/api\/executions\/([^/]+)\/review-all$/)) && method === 'POST') {
            const body = await readBody(req);
            if (!body.action || !['accept', 'reject'].includes(body.action)) {
                return json(res, 400, { error: 'action 必须是 accept/reject' });
            }
            try {
                const count = engine.resolveAllReviews(m[1], body.action, { comment: body.comment ?? null });
                return json(res, 200, { ok: true, processed: count });
            }
            catch (e) {
                return json(res, 400, { error: String(e?.message ?? e) });
            }
        }
        // Human Task 提交（Phase 11，§67）：人工产出不伪装成 Agent Run
        if ((m = p.match(/^\/api\/executions\/([^/]+)\/human-task$/)) && method === 'POST') {
            const body = await readBody(req);
            if (!body.taskId)
                return json(res, 400, { error: 'taskId 必填' });
            try {
                const task = engine.submitHumanTask(m[1], body.taskId, { content: body.content ?? '', note: body.note });
                return json(res, 200, { ok: true, taskStatus: task.status });
            }
            catch (e) {
                return json(res, 400, { error: String(e?.message ?? e) });
            }
        }
        // Artifact 恢复到指定版本（任务 5：不可变链上追加人工版本）
        if ((m = p.match(/^\/api\/executions\/([^/]+)\/artifacts\/restore$/)) && method === 'POST') {
            const body = await readBody(req);
            if (!body.nodeId)
                return json(res, 400, { error: 'nodeId 必填' });
            if (typeof body.targetVersion !== 'number')
                return json(res, 400, { error: 'targetVersion 必填（数字）' });
            try {
                const artifact = await engine.restoreArtifact(m[1], body.nodeId, body.targetVersion);
                return json(res, 200, { ok: true, newVersion: artifact.version, artifactId: artifact.id });
            }
            catch (e) {
                return json(res, 400, { error: String(e?.message ?? e) });
            }
        }
        // Artifact 版本对比（任务 5：diff，行级）
        if ((m = p.match(/^\/api\/executions\/([^/]+)\/artifacts\/diff$/)) && method === 'POST') {
            const body = await readBody(req);
            if (!body.nodeId)
                return json(res, 400, { error: 'nodeId 必填' });
            const state = engine.getExecution(m[1]);
            if (!state)
                return json(res, 404, { error: 'execution not found' });
            const chain = state.artifacts[body.nodeId] ?? [];
            const from = chain.find(a => a.version === body.fromVersion);
            const to = chain.find(a => a.version === body.toVersion);
            if (!from)
                return json(res, 404, { error: `v${body.fromVersion} 不存在` });
            if (!to)
                return json(res, 404, { error: `v${body.toVersion} 不存在` });
            const result = await engine.artifacts.diff(from, to);
            return json(res, 200, {
                from: { version: from.version, createdBy: from.createdBy },
                to: { version: to.version, createdBy: to.createdBy },
                added: result.added, removed: result.removed, degraded: result.degraded,
                ops: result.ops,
            });
        }
        // Code 版本对比（任务 5 / 验收场景 B）：按文件集合 diff；from/to 缺省取最后两个版本。
        if ((m = p.match(/^\/api\/executions\/([^/]+)\/artifacts\/code-diff$/)) && method === 'POST') {
            const body = await readBody(req);
            if (!body.nodeId)
                return json(res, 400, { error: 'nodeId 必填' });
            const state = engine.getExecution(m[1]);
            if (!state)
                return json(res, 404, { error: 'execution not found' });
            const chain = (state.artifacts[body.nodeId] ?? []).filter(a => Array.isArray(a.files));
            if (!chain.length)
                return json(res, 404, { error: `节点 ${body.nodeId} 无 code Artifact` });
            const to = chain.find(a => a.version === body.toVersion) ?? chain.at(-1);
            const from = chain.find(a => a.version === body.fromVersion) ?? chain[chain.indexOf(to) - 1];
            if (!from || !to)
                return json(res, 404, { error: 'code 版本不足，无法对比' });
            const files = await engine.artifacts.diffCode(from, to);
            return json(res, 200, {
                from: { version: from.version, createdBy: from.createdBy },
                to: { version: to.version, createdBy: to.createdBy },
                files,
            });
        }
        // 读取 code Artifact 单个文件全文（前端查看器用）
        if ((m = p.match(/^\/api\/executions\/([^/]+)\/artifacts\/code-file$/)) && method === 'POST') {
            const body = await readBody(req);
            if (!body.nodeId || !body.path)
                return json(res, 400, { error: 'nodeId 与 path 必填' });
            const state = engine.getExecution(m[1]);
            if (!state)
                return json(res, 404, { error: 'execution not found' });
            const chain = (state.artifacts[body.nodeId] ?? []).filter(a => Array.isArray(a.files));
            const art = chain.find(a => a.version === body.version) ?? chain.at(-1);
            if (!art)
                return json(res, 404, { error: 'code Artifact 不存在' });
            try {
                const content = await engine.artifacts.readCodeFile(art, body.path);
                return json(res, 200, { path: body.path, content, version: art.version });
            }
            catch (e) {
                return json(res, 404, { error: String(e?.message ?? e) });
            }
        }
        // 人工编辑 code Artifact（任务 5：提交整组文件 → 新版本，不覆盖原始）
        if ((m = p.match(/^\/api\/executions\/([^/]+)\/artifacts\/code-edit$/)) && method === 'POST') {
            const body = await readBody(req);
            if (!body.nodeId)
                return json(res, 400, { error: 'nodeId 必填' });
            if (!Array.isArray(body.files) || !body.files.length)
                return json(res, 400, { error: 'files 必填（非空数组）' });
            try {
                const artifact = await engine.editCodeArtifact(m[1], body.nodeId, body.files, body.comment ?? null);
                return json(res, 200, { ok: true, newVersion: artifact.version, artifactId: artifact.id });
            }
            catch (e) {
                return json(res, 400, { error: String(e?.message ?? e) });
            }
        }
        // ---- SSE ----
        if (p === '/api/events' && method === 'GET') {
            const executionId = url.searchParams.get('executionId');
            return sse(res, executionId);
        }
        return json(res, 404, { error: `unknown api path ${p}` });
    }
    function sse(res, executionId) {
        res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
        });
        const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
        res.write(': connected\n\n'); // 立即 flush headers，客户端 fetch 才能拿到响应头
        const send = (e) => {
            if (executionId && e.executionId !== executionId)
                return;
            res.write(`data: ${JSON.stringify(e)}\n\n`);
        };
        const unsub = engine.eventBus.on('*', send);
        reqClose(res, () => {
            clearInterval(heartbeat);
            unsub();
        });
    }
    // ---------------------------------------------------------------- static
    async function serveStatic(req, res, url) {
        let rel = decodeURIComponent(url.pathname);
        if (rel === '/')
            rel = '/index.html';
        const target = path.normalize(path.join(PUBLIC_DIR, rel));
        if (!target.startsWith(PUBLIC_DIR + path.sep))
            return json(res, 403, { error: 'forbidden' });
        try {
            const data = await fs.readFile(target);
            res.writeHead(200, { 'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
            res.end(data);
        }
        catch {
            json(res, 404, { error: 'not found' });
        }
    }
    server.listen(opts.port, opts.host);
    return {
        port: opts.port,
        close: () => new Promise(resolve => {
            for (const unsub of liveStates.values())
                unsub();
            liveStates.clear();
            server.close(() => resolve());
        }),
        async renderLanding() {
            const list = await storage.workflows.list();
            const base = `http://${opts.host === '0.0.0.0' ? '127.0.0.1' : opts.host}:${opts.port}`;
            const rows = list.length
                ? list.map(w => `<tr>
            <td><a href="${base}/?wf=${encodeURIComponent(w.id)}">${escHtml(w.name || w.id)}</a></td>
            <td style="color:#888;font-size:12px">${escHtml(w.id)}</td>
            <td>${(w.nodes ?? []).length} 节点 · ${(w.edges ?? []).length} 连线</td>
            <td style="color:#888;font-size:12px">${escHtml((w.updatedAt ?? '').slice(0, 16).replace('T', ' '))}</td>
          </tr>`).join('')
                : '<tr><td colspan="4" style="color:#888;text-align:center;padding:24px">暂无工作流——<a href="' + base + '/">打开编辑器新建</a></td></tr>';
            return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>Workflow 多 Agent 编排</title>
<style>
  body { font-family: -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 40px; background: #f6f7f9; color: #222; }
  .card { max-width: 760px; margin: 0 auto; background: #fff; border-radius: 10px; padding: 28px 32px; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #888; font-size: 13px; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  td { padding: 10px 8px; border-bottom: 1px solid #eee; }
  a { color: #2f6fed; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .open { margin-top: 18px; }
</style>
</head>
<body>
  <div class="card">
    <h1>Workflow · 多 Agent 编排</h1>
    <div class="sub">dsh-plugin-workflow · 共 ${list.length} 个工作流 · 独立服务 ${base}/</div>
    <table>${rows}</table>
    <div class="open"><a href="${base}/">↗ 打开完整编辑器</a></div>
  </div>
</body>
</html>`;
        },
    };
}
function escHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// ---------------------------------------------------------------- helpers
function json(res, status, body, extra = {}) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extra });
    res.end(JSON.stringify(body));
}
function readBody(req, limit = 8 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > limit) {
                reject(new Error('body too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            if (chunks.length === 0)
                return resolve({});
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            }
            catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}
function reqClose(res, fn) {
    res.on('close', fn);
}
// ---------------------------------------------------------------- cordis 入口
export function apply(ctx, rawConfig = {}) {
    const config = {
        port: DEFAULTS.defaultPort,
        host: '127.0.0.1',
        mock: false,
        dataDir: '',
        ...rawConfig,
    };
    const dataDir = config.dataDir
        ? path.resolve(config.dataDir)
        : path.join(process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh'), 'workflow-plugin');
    const server = createWorkflowServer({
        apiProxy: ctx.apiProxy ?? ctx.get?.('apiProxy', false) ?? ctx.get?.('apiProxy'),
        port: config.port,
        host: config.host,
        mock: config.mock,
        dataDir,
    });
    ctx.on('dispose', () => { void server.close(); });
    // 任务 3（Phase 9）：DSH Home 入口——经宿主 Plugin API ctx.webServer.register 挂载，
    // 不侵入 DSH 核心（§55.7）；宿主无导航注册 API，/workflow 路由作为页面入口，
    // 深链跳转独立端口 3090 的完整编辑器。webServer 不可用时静默降级（保留独立入口）。
    // 注意：不得直接访问 ctx.webServer 属性（cordis 会抛 cannot get property without inject）；
    // 用 ctx.get() 免 inject 探测，缺服务/未激活时返回 undefined → 延迟重试数次后降级。
    const tryMountWorkflowEntry = () => {
        const webServer = ctx.get?.('webServer') ?? ctx.webServer;
        if (!webServer?.register)
            return false;
        try {
            webServer.register({
                kind: 'exact',
                path: '/workflow',
                handler: (req, res) => {
                    void server.renderLanding()
                        .then(html => {
                        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
                        res.end(html);
                    })
                        .catch(e => {
                        if (!res.headersSent)
                            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
                        res.end(`workflow 落地页渲染失败：${e?.message ?? e}`);
                    });
                },
            });
            ctx.logger?.info?.(`workflow 入口已挂载：宿主 /workflow → 独立服务 ${config.port}`);
            return true;
        }
        catch (e) {
            ctx.logger?.warn?.(`workflow 入口挂载失败（保留独立端口）：${e?.message ?? e}`);
            return true; // 已尝试挂载，不再重试
        }
    };
    if (!tryMountWorkflowEntry()) {
        // webServer 服务可能晚于本插件激活：短重试，仍无则降级为独立端口入口。
        let attempts = 0;
        const timer = setInterval(() => {
            attempts += 1;
            if (tryMountWorkflowEntry() || attempts >= 5) {
                clearInterval(timer);
                if (attempts >= 5)
                    ctx.logger?.warn?.('宿主未提供 webServer 注册能力，仅保留独立端口入口');
            }
        }, 500);
        timer.unref?.();
    }
    ctx.logger?.info?.(`workflow plugin 已上线: http://${config.host}:${config.port}/`);
}
export default apply;
