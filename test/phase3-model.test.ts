/**
 * 第三阶段 Phase 2-4：领域模型 + 关系确认 + 数据模型重构
 * - §4 revision 自增（保存时）、旧 Definition 按 1 归一
 * - §16-23 Edge routing/dataFlow 可选字段与 effectiveRouting 默认值
 * - §5/原则 1/13：Execution 快照（workflowVersion/workingDirectory/userInput/createdBy）
 * - §37/原则 3 + Test 6：终态完整快照落盘；新服务实例（模拟重启）仍可读历史
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { createWorkflowServer, type WorkflowServer } from '../src/index.js';
import {
  defaultSettings, effectiveRevision, effectiveRouting,
  type AgentNode, type WorkflowDefinition, type WorkflowEdge,
} from '../src/domain/types.js';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'wf-p3-'));
const PORT = 3400 + Math.floor(Math.random() * 100);
const PORT2 = PORT + 501; // 重启实例用新端口，避免 TIME_WAIT 冲突
let server: WorkflowServer;
let base = `http://127.0.0.1:${PORT}`;
const BASE = () => base;

function agent(id: string, type: 'start' | 'end' | 'agent' = 'agent'): AgentNode {
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
const edge = (i: number, s: string, t: string): WorkflowEdge => ({
  id: `e${i}`, source: { nodeId: s, output: 'main' }, target: { nodeId: t, input: 'main' },
  transform: { enabled: false, instruction: '' }, condition: null,
});
const wf = (id: string, over: Partial<WorkflowDefinition> = {}): WorkflowDefinition => ({
  version: '1.0', id, name: id,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  nodes: [agent('start', 'start'), agent('mid'), agent('end', 'end')],
  edges: [edge(1, 'start', 'mid'), edge(2, 'mid', 'end')],
  settings: defaultSettings({ workspaceDir: 'D:/project' }),
  loops: [], layout: {},
  ...over,
});

const j = async (method: string, p: string, body?: unknown, base?: string) => {
  const r = await fetch((base ?? BASE()) + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

describe('Phase 2：领域模型归一（向后兼容）', () => {
  it('旧 Definition 无 revision 按 1；有则原样', () => {
    expect(effectiveRevision({} as never)).toBe(1);
    expect(effectiveRevision({ revision: 7 } as never)).toBe(7);
    expect(effectiveRevision({ revision: 0 } as never)).toBe(1); // 非法值归一
  });

  it('旧 Edge 无 routing 默认 auto/bezier/无控制点；manual 保留', () => {
    const legacy = edge(1, 'a', 'b');
    const r = effectiveRouting(legacy);
    expect(r).toEqual({ mode: 'auto', type: 'bezier', points: [] });
    const manual: WorkflowEdge = { ...legacy, routing: { mode: 'manual', type: 'bezier', points: [{ x: 1, y: 2 }] } };
    expect(effectiveRouting(manual).mode).toBe('manual');
    expect(effectiveRouting(manual).points).toEqual([{ x: 1, y: 2 }]);
  });
});

describe('Phase 3-4：保存自增 revision + Execution 快照 + 历史持久化', () => {
  afterAll(async () => { await server?.close(); });

  it('保存：新建 revision=1，再存 revision=2', async () => {
    server = createWorkflowServer({ port: PORT, host: '127.0.0.1', mock: true, dataDir: tmp });
    const s1 = await j('POST', '/api/workflows', wf('wf_p3'));
    expect(s1.status).toBe(200);
    expect(s1.body.workflow.revision).toBe(1);
    const s2 = await j('POST', '/api/workflows', wf('wf_p3'));
    expect(s2.body.workflow.revision).toBe(2);
  });

  it('运行：Execution 带版本/工作目录/输入快照（§5/原则 13）', async () => {
    const run = await j('POST', '/api/workflows/wf_p3/run', { input: 'hello p3' });
    expect(run.status).toBe(200);
    const eid = run.body.executionId;
    // mock runner 立即完成；轮询终态
    let st: any = null;
    for (let i = 0; i < 20; i++) {
      st = (await j('GET', `/api/executions/${eid}`)).body;
      if (['completed', 'failed', 'terminated'].includes(st.status)) break;
      await new Promise(r => setTimeout(r, 300));
    }
    expect(st.status).toBe('completed');
    expect(st.workflowVersion).toBe(2);               // 快照启动时的 revision
    expect(st.workingDirectory).toBe('D:/project');  // 工作目录快照
    expect(st.userInput).toBe('hello p3');
    expect(st.createdBy).toBe('human');
    // 终态快照落盘为 fire-and-forget：轮询磁盘文件出现后再模拟重启，避免竞态
    const { access } = await import('node:fs/promises');
    const snapPath = path.join(tmp, 'executions', `${eid}.json`);
    // 注意：文件存在不等于终态已写入（启动标记同名先落盘），必须轮询到终态内容
    const { readFile } = await import('node:fs/promises');
    let reachedTerminal = false;
    for (let i = 0; i < 100; i++) {
      try {
        const disk = JSON.parse(await readFile(snapPath, 'utf-8'));
        if (['completed', 'failed', 'terminated'].includes(disk.status)) { reachedTerminal = true; break; }
      } catch { /* not yet */ }
      await new Promise(r => setTimeout(r, 100));
    }
    // Phase A：磁盘轮询不再静默超时——终态快照必须在重启前落盘，否则 Test 6 必然失败
    expect(reachedTerminal).toBe(true);
  });

  it('Test 6：新服务实例（模拟重启）仍可读历史 Execution', async () => {
    const list1 = await j('GET', '/api/executions');
    expect(list1.status).toBe(200);
    expect(list1.body.length).toBeGreaterThanOrEqual(1);
    const eid = list1.body[0].executionId;

    await server.close();
    // 同 dataDir 起新实例 = 模拟宿主重启
    base = `http://127.0.0.1:${PORT2}`;
    server = createWorkflowServer({ port: PORT2, host: '127.0.0.1', mock: true, dataDir: tmp });
    const st = (await j('GET', `/api/executions/${eid}`)).body;
    expect(st.executionId).toBe(eid);
    expect(st.status).toBe('completed');
    expect(st.workingDirectory).toBe('D:/project');
    // 列表端点同样可见（磁盘快照）
    const list2 = await j('GET', '/api/executions');
    expect(list2.body.some((x: any) => x.executionId === eid)).toBe(true);
    // 列表摘要字段齐全（§37 首页历史）
    const item = list2.body.find((x: any) => x.executionId === eid);
    expect(item).toMatchObject({ workflowId: 'wf_p3', workflowVersion: 2, status: 'completed' });
  });

  it('原则 3：历史 Execution 无修改端点（只读）', async () => {
    const list = await j('GET', '/api/executions');
    const eid = list.body[0].executionId;
    const put = await j('POST', `/api/executions/${eid}/control`, { cmd: 'resume' });
    // 已结束的执行控制应为 no-op 或 404，绝不能改状态
    const st = (await j('GET', `/api/executions/${eid}`)).body;
    expect(st.status).toBe('completed');
    expect([200, 404]).toContain(put.status);
  });
});
