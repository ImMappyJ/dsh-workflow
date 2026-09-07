import { describe, it, expect, afterAll } from 'vitest';
import * as http from 'node:http';
import { createWorkflowServer, type WorkflowServer } from '../src/index.js';
import { defaultSettings, type AgentNode, type WorkflowDefinition } from '../src/domain/types.js';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp } from 'node:fs/promises';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'wf-test-'));
const PORT = 3190 + Math.floor(Math.random() * 100);
const server: WorkflowServer = createWorkflowServer({
  port: PORT,
  host: '127.0.0.1',
  mock: true,
  dataDir: tmp,
});
const BASE = `http://127.0.0.1:${PORT}`;

afterAll(async () => { await server.close(); });

function agent(id: string, type: 'start' | 'end' | 'agent' | 'human_task' = 'agent'): AgentNode {
  return {
    id, type, name: id, position: { x: 0, y: 0 },
    identity: { name: id }, roleDescription: id,
    inputContract: { description: '', processing: '', selection: '', ignore: '', constraints: [], sourceMode: 'all', selectedSourceNodeIds: [] },
    outputContract: { description: '', format: 'markdown', schema: null, requiredSections: [], targets: [], condition: null },
    modelConfig: { provider: 'deepseek', model: 'deepseek-chat' },
    runtimeConfig: { maxRuns: 5, timeoutMs: 120000, retry: { enabled: false, maxRetries: 0, backoffMs: 0 }, onFailure: 'fail_workflow' },
    metadata: {},
  };
}

const def: WorkflowDefinition = {
  version: '1.0', id: 'wf_demo', name: 'demo',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  nodes: [agent('start', 'start'), agent('b'), agent('end', 'end')],
  edges: [['start', 'b'], ['b', 'end']].map(([s, t], i) => ({
    id: `e${i}`, source: { nodeId: s, output: 'main' }, target: { nodeId: t, input: 'main' },
    transform: { enabled: false, instruction: '' }, condition: null,
  })),
  settings: defaultSettings(),
  loops: [],
  layout: {},
};

const j = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(BASE + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

describe('HTTP API 端到端（Mock runner）', () => {
  it('health 返回插件状态', async () => {
    const { status, body } = await j('GET', '/api/health');
    expect(status).toBe(200);
    expect(body.plugin).toBe('dsh-plugin-workflow');
    expect(body.mock).toBe(true);
  });

  it('保存非法 workflow 返回 400', async () => {
    const { status, body } = await j('POST', '/api/workflows', { id: 'bad', nodes: [], edges: [] });
    expect(status).toBe(400);
    expect(body.error).toContain('validation');
  });

  it('保存两个 End 节点被拒（§22：保存前 Domain 层校验）', async () => {
    const bad: WorkflowDefinition = {
      ...def, id: 'wf_two_ends',
      nodes: [agent('start', 'start'), agent('b'), agent('end', 'end'), agent('end2', 'end')],
      edges: [['start', 'b'], ['b', 'end'], ['b', 'end2']].map(([s, t], i) => ({
        id: `e${i}`, source: { nodeId: s, output: 'main' }, target: { nodeId: t, input: 'main' },
        transform: { enabled: false, instruction: '' }, condition: null,
      })),
    };
    const { status, body } = await j('POST', '/api/workflows', bad);
    expect(status).toBe(400);
    expect(JSON.stringify(body.issues)).toContain('multiple_end');
    // 且未落盘：读不到该 workflow
    const r2 = await j('GET', '/api/workflows/wf_two_ends');
    expect(r2.status).toBe(404);
  });

  it('保存 → 读取 → 列表 → 运行 → 状态 → 控制 → 删除 全链路', async () => {
    // 保存（自动补 loops）
    let r = await j('POST', '/api/workflows', def);
    expect(r.status).toBe(200);
    expect(r.body.saved).toBe(true);

    // 读取
    r = await j('GET', '/api/workflows/wf_demo');
    expect(r.body.id).toBe('wf_demo');

    // 列表
    r = await j('GET', '/api/workflows');
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.some((w: any) => w.id === 'wf_demo')).toBe(true);

    // 运行
    r = await j('POST', '/api/workflows/wf_demo/run', { input: 'HI' });
    expect(r.status).toBe(200);
    const { executionId } = r.body;
    expect(executionId).toBeTruthy();

    // 等运行完成，轮询状态
    let state: any;
    for (let i = 0; i < 50; i++) {
      const rr = await j('GET', `/api/executions/${executionId}`);
      if (rr.status === 200) state = rr.body;
      if (state?.status === 'completed') break;
      await new Promise(res => setTimeout(res, 50));
    }
    expect(state.status).toBe('completed');
    expect(state.outputs.b[0].content).toContain('mock output of b');

    // 控制 stop（已结束，幂等调用不报错）
    r = await j('POST', `/api/executions/${executionId}/control`, { cmd: 'stop' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    // 删除
    r = await j('DELETE', '/api/workflows/wf_demo');
    expect(r.body.removed).toBe(true);
  });

  it('删除工作流时级联清理其执行记录与版本快照', async () => {
    const d: WorkflowDefinition = {
      version: '1.0', id: 'wf_cascade', name: 'cascade',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      nodes: [agent('start', 'start'), agent('end', 'end')],
      edges: [['start', 'end']].map(([s, t], i) => ({
        id: `e${i}`, source: { nodeId: s, output: 'main' }, target: { nodeId: t, input: 'main' },
        transform: { enabled: false, instruction: '' }, condition: null,
      })),
      settings: defaultSettings(), loops: [], layout: {},
    };
    await j('POST', '/api/workflows', d);
    const run1 = await j('POST', '/api/workflows/wf_cascade/run', { input: 'GO' });
    expect(run1.status).toBe(200);
    const eid = run1.body.executionId;
    // 等执行完成落盘
    for (let i = 0; i < 50; i++) {
      const s = await j('GET', `/api/executions/${eid}`);
      if (s.body?.status === 'completed') break;
      await new Promise(res => setTimeout(res, 50));
    }
    // 执行历史中存在该工作流的记录
    const before = await j('GET', '/api/executions');
    expect(before.body.some((x: any) => x.workflowId === 'wf_cascade')).toBe(true);
    // 删除工作流 → 级联清理
    const del = await j('DELETE', '/api/workflows/wf_cascade');
    expect(del.body.removed).toBe(true);
    expect(del.body.removedExecutions).toBeGreaterThanOrEqual(1);
    const after = await j('GET', '/api/executions');
    expect(after.body.some((x: any) => x.workflowId === 'wf_cascade')).toBe(false);
    // 工作流本身也已移除
    const gone = await j('GET', '/api/workflows/wf_cascade');
    expect(gone.status).toBe(404);
  }, 15_000);

  it('SSE /api/events 收到事件', async () => {
    await j('POST', '/api/workflows', def);
    // 用原生 http 客户端（undici fetch 在流式响应上行为不稳定）
    const events: any[] = [];
    let contentType = '';
    const req = http.get(`${BASE}/api/events`, res => {
      contentType = String(res.headers['content-type'] ?? '');
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk: string) => {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (frame.startsWith('data: ')) {
            try { events.push(JSON.parse(frame.slice(6))); } catch { /* 忽略半帧 */ }
          }
        }
      });
    });
    // 等 headers
    await new Promise<void>(r => {
      if (contentType) return r();
      req.on('response', () => r());
      setTimeout(r, 2000);
    });
    expect(contentType).toContain('text/event-stream');

    const runResp = await j('POST', '/api/workflows/wf_demo/run', { input: 'X' });
    expect(runResp.status).toBe(200);

    // 等事件到达
    const deadline = Date.now() + 5000;
    while (events.length < 3 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }
    req.destroy();
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].type).toBe('workflow.started');
  }, 10_000);

  it('审核端点：waiting_review → accept → completed（§58-73）', async () => {
    const gated: WorkflowDefinition = {
      ...def,
      id: 'wf_review',
      edges: [
        { id: 'e0', source: { nodeId: 'start', output: 'main' }, target: { nodeId: 'b', input: 'main' }, transform: { enabled: false, instruction: '' }, condition: null, review: undefined },
        {
          id: 'e1', source: { nodeId: 'b', output: 'main' }, target: { nodeId: 'end', input: 'main' }, transform: { enabled: false, instruction: '' }, condition: null,
          review: { enabled: true, mode: 'required', allowedActions: ['accept', 'reject', 'edit', 'accept_after_edit', 'terminate'], timeout: null, onTimeout: 'pause' },
        },
      ],
    };
    let r = await j('POST', '/api/workflows', gated);
    expect(r.status).toBe(200);
    r = await j('POST', '/api/workflows/wf_review/run', { input: 'GO' });
    const { executionId } = r.body;

    // 轮询至 waiting_review，拿到 pending 审核任务
    let state: any;
    for (let i = 0; i < 100; i++) {
      state = (await j('GET', `/api/executions/${executionId}`)).body;
      if (state?.status === 'waiting_review') break;
      await new Promise(res => setTimeout(res, 20));
    }
    expect(state.status).toBe('waiting_review');
    const taskId = state.reviewTasks.find((t: any) => t.status === 'pending').id;

    // reject 不带意见 → 400（§61）
    r = await j('POST', `/api/executions/${executionId}/review`, { taskId, action: 'reject' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('审核意见');

    // accept 放行
    r = await j('POST', `/api/executions/${executionId}/review`, { taskId, action: 'accept', comment: 'LGTM' });
    expect(r.status).toBe(200);
    expect(r.body.taskStatus).toBe('accepted');

    // 等待结束并验证审计链（§66）
    for (let i = 0; i < 100; i++) {
      state = (await j('GET', `/api/executions/${executionId}`)).body;
      if (['completed', 'failed'].includes(state?.status)) break;
      await new Promise(res => setTimeout(res, 20));
    }
    expect(state.status).toBe('completed');
    expect(state.auditLog.map((a: any) => a.action)).toEqual(expect.arrayContaining(['request', 'accept']));

    await j('DELETE', '/api/workflows/wf_review');
  }, 15_000);

  it('Human Task 端到端：waiting_human → HTTP 提交 → completed（Phase 11）', async () => {
    const hdef: WorkflowDefinition = {
      ...def,
      id: 'wf_human_api',
      nodes: [agent('start', 'start'), agent('confirm', 'human_task'), agent('end', 'end')],
      edges: [['start', 'confirm'], ['confirm', 'end']].map(([s, t], i) => ({
        id: `h${i}`, source: { nodeId: s, output: 'main' }, target: { nodeId: t, input: 'main' },
        transform: { enabled: false, instruction: '' }, condition: null,
      })),
    };
    hdef.nodes.find(n => n.id === 'confirm')!.metadata = { taskPrompt: '请确认发布窗口' };

    let r = await j('POST', '/api/workflows', hdef);
    expect(r.status).toBe(200);
    r = await j('POST', '/api/workflows/wf_human_api/run', { input: 'GO' });
    const executionId = r.body.executionId;

    // 等待 waiting_human
    let state: any;
    for (let i = 0; i < 100; i++) {
      state = (await j('GET', `/api/executions/${executionId}`)).body;
      if (state?.status === 'waiting_human') break;
      await new Promise(res => setTimeout(res, 20));
    }
    expect(state.status).toBe('waiting_human');
    const taskId = state.humanTasks.find((t: any) => t.status === 'pending').id;

    // 空内容被拒（§67）
    r = await j('POST', `/api/executions/${executionId}/human-task`, { taskId, content: '  ' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('不能为空');

    // 正常提交后流转到完成，人工产出登记为 createdBy=human
    r = await j('POST', `/api/executions/${executionId}/human-task`, { taskId, content: '窗口已确认 20:00', note: 'QA 签字' });
    expect(r.status).toBe(200);
    expect(r.body.taskStatus).toBe('completed');

    for (let i = 0; i < 100; i++) {
      state = (await j('GET', `/api/executions/${executionId}`)).body;
      if (['completed', 'failed'].includes(state?.status)) break;
      await new Promise(res => setTimeout(res, 20));
    }
    expect(state.status).toBe('completed');
    expect(state.outputs.confirm.at(-1).content).toBe('窗口已确认 20:00');
    expect(state.artifacts.confirm.at(-1).createdBy).toBe('human');

    await j('DELETE', '/api/workflows/wf_human_api');
  }, 15_000);

  it('Review All + Artifact 集合审核 + restore（任务 5 / Phase 7）', async () => {
    // 双分支双门：b 完成后产生 2 个待审任务，用于批量操作；
    // 分支汇合到 end 验证 Accept All 后能走完。
    const gated: WorkflowDefinition = {
      ...def,
      id: 'wf_review_all',
      nodes: [agent('start', 'start'), agent('b'), agent('c1'), agent('c2'), agent('end', 'end')],
      edges: [
        { id: 'e0', source: { nodeId: 'start', output: 'main' }, target: { nodeId: 'b', input: 'main' }, transform: { enabled: false, instruction: '' }, condition: null },
        { id: 'e1', source: { nodeId: 'b', output: 'main' }, target: { nodeId: 'c1', input: 'main' }, transform: { enabled: false, instruction: '' }, condition: null,
          review: { enabled: true, mode: 'required', allowedActions: ['accept', 'reject', 'edit', 'accept_after_edit', 'terminate'], timeout: null, onTimeout: 'pause' } },
        { id: 'e2', source: { nodeId: 'b', output: 'main' }, target: { nodeId: 'c2', input: 'main' }, transform: { enabled: false, instruction: '' }, condition: null,
          review: { enabled: true, mode: 'required', allowedActions: ['accept', 'reject', 'edit', 'accept_after_edit', 'terminate'], timeout: null, onTimeout: 'pause' } },
        { id: 'e3', source: { nodeId: 'c1', output: 'main' }, target: { nodeId: 'end', input: 'main' }, transform: { enabled: false, instruction: '' }, condition: null },
        { id: 'e4', source: { nodeId: 'c2', output: 'main' }, target: { nodeId: 'end', input: 'main' }, transform: { enabled: false, instruction: '' }, condition: null },
      ],
    };
    let r = await j('POST', '/api/workflows', gated);
    expect(r.status).toBe(200);
    r = await j('POST', '/api/workflows/wf_review_all/run', { input: 'GO' });
    const { executionId } = r.body;

    let state: any;
    for (let i = 0; i < 100; i++) {
      state = (await j('GET', `/api/executions/${executionId}`)).body;
      if (state?.status === 'waiting_review') break;
      await new Promise(res => setTimeout(res, 20));
    }
    expect(state.status).toBe('waiting_review');
    const pending = state.reviewTasks.filter((t: any) => t.status === 'pending');
    expect(pending.length).toBe(2);
    // 任务 5：审核对象是 Artifact 集合，且包含源节点产出（兼容字段指向集合）
    for (const t of pending) {
      expect(Array.isArray(t.artifactIds)).toBe(true);
      expect(t.artifactIds).toContain(t.artifactId);
      expect(t.artifactIds.length).toBeGreaterThanOrEqual(1);
    }

    // Reject All 不带意见 → 400（§61）
    r = await j('POST', `/api/executions/${executionId}/review-all`, { action: 'reject' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('审核意见');

    // Accept All → 处理 2 个任务，随后完成（分支汇合）
    r = await j('POST', `/api/executions/${executionId}/review-all`, { action: 'accept', comment: '批量放行' });
    expect(r.status).toBe(200);
    expect(r.body.processed).toBe(2);

    for (let i = 0; i < 100; i++) {
      state = (await j('GET', `/api/executions/${executionId}`)).body;
      if (['completed', 'failed'].includes(state?.status)) break;
      await new Promise(res => setTimeout(res, 20));
    }
    expect(state.status).toBe('completed');

    // restore：b 的版本链恢复到 v1（追加新人工版本）
    r = await j('POST', `/api/executions/${executionId}/artifacts/restore`, { nodeId: 'b', targetVersion: 1 });
    expect(r.status).toBe(200);
    expect(r.body.newVersion).toBe(2);

    // diff：v1 → v2（恢复版本内容与 v1 相同 → 无差异）
    r = await j('POST', `/api/executions/${executionId}/artifacts/diff`, { nodeId: 'b', fromVersion: 1, toVersion: 2 });
    expect(r.status).toBe(200);
    expect(r.body.added).toBe(0);
    expect(r.body.removed).toBe(0);

    // diff 不存在版本 → 404；restore 非法参数 → 400
    r = await j('POST', `/api/executions/${executionId}/artifacts/diff`, { nodeId: 'b', fromVersion: 1, toVersion: 99 });
    expect(r.status).toBe(404);
    r = await j('POST', `/api/executions/${executionId}/artifacts/restore`, { nodeId: 'b' });
    expect(r.status).toBe(400);
    await j('DELETE', '/api/workflows/wf_review_all');
  }, 15_000);

  it('pick-directory：mock 无宿主时返回 200 {ok:true,path:null}（降级到 Python 后失败，返回空）', async () => {
    const r = await fetch(BASE + '/api/pick-directory', { method: 'POST' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.path).toBeNull();
  }, 30_000);

  it('pick-directory：宿主有 native 能力时转发绝对路径 / 取消降级为 null', async () => {
    const tmp2 = await mkdtemp(path.join(os.tmpdir(), 'wf-pick-'));
    const fakePick = {
      host: {
        async pickDirectory(_r: any) {
          return { result: { ok: true, value: { path: 'D:\\Development Program\\demo' } } };
        },
      },
    };
    const s2 = createWorkflowServer({ port: PORT + 13, host: '127.0.0.1', mock: true, apiProxy: fakePick as any, dataDir: tmp2 });
    try {
      const r = await fetch(`http://127.0.0.1:${PORT + 13}/api/pick-directory`, { method: 'POST' });
      expect(r.status).toBe(200);
      const b = await r.json();
      expect(b.ok).toBe(true);
      expect(b.path).toBe('D:/Development Program/demo');
      // 取消 → 降级到 Python（无 GUI 环境）→ 返回 200 {ok:true,path:null}
      (fakePick.host as any).pickDirectory = async () => ({ result: { ok: true, value: { path: null } } });
      const r2 = await fetch(`http://127.0.0.1:${PORT + 13}/api/pick-directory`, { method: 'POST' });
      expect(r2.status).toBe(200);
      expect((await r2.json()).path).toBeNull();
      // 宿主报错 → 降级到 Python（无 GUI 环境）→ 返回 200 {ok:true,path:null}
      (fakePick.host as any).pickDirectory = async () => ({ error: { message: 'boom' } });
      const r3 = await fetch(`http://127.0.0.1:${PORT + 13}/api/pick-directory`, { method: 'POST' });
      expect(r3.status).toBe(200);
      expect((await r3.json()).path).toBeNull();
    } finally {
      await s2.close();
    }
  }, 30_000);

  it('静态页返回 HTML', async () => {
    const r = await fetch(BASE + '/');
    expect(r.status).toBe(200);
    expect((await r.text())).toContain('DSH Workflow');
  });

  it('路径穿越被拒', async () => {
    const r = await fetch(BASE + '/..%2f..%2fetc%2fpasswd');
    expect([403, 404]).toContain(r.status);
  });
});
