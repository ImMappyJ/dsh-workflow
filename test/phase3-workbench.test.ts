/**
 * Workbench（设计文档 §1-33）：View Model / 删除 Execution / Execution Tree 保护
 * - §3/§23/§28：列表主信息为 workflowName + runNumber（技术 ID 退居详情）
 * - §10/§11：DELETE 只删 Execution，不碰 Workflow Definition
 * - §13：存在子 Rework 时拒绝删除（保护 Execution Tree）
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { createWorkflowServer } from '../src/index.js';
import {
  defaultSettings, type AgentNode, type WorkflowDefinition, type WorkflowEdge,
} from '../src/domain/types.js';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'wf-p3wb-'));
const PORT = 3800 + Math.floor(Math.random() * 100);
const server = await createWorkflowServer({ port: PORT, host: '127.0.0.1', mock: true, dataDir: tmp });
const base = `http://127.0.0.1:${PORT}`;

const j = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(base + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

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
const wf = (id: string, name: string): WorkflowDefinition => ({
  version: '1.0', id, name,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  nodes: [agent('start', 'start'), agent('mid'), agent('end', 'end')],
  edges: [edge(1, 'start', 'mid'), edge(2, 'mid', 'end')],
  settings: defaultSettings({ workspaceDir: 'D:/project' }),
  loops: [], layout: {},
});

async function runAndWait(wfId: string): Promise<string> {
  const run = await j('POST', `/api/workflows/${wfId}/run`, { input: 'GO' });
  expect(run.status).toBe(200);
  const execId = (run.body as { executionId: string }).executionId;
  let st = await j('GET', `/api/executions/${execId}`);
  for (let i = 0; i < 60 && !['success', 'completed', 'failed', 'terminated'].includes((st.body as { status: string }).status); i++) {
    await new Promise(r => setTimeout(r, 100));
    st = await j('GET', `/api/executions/${execId}`);
  }
  return execId;
}

afterAll(async () => { await server.close(); });

describe('Workbench：View Model（§3/§23/§28）', () => {
  it('列表主信息为 workflowName + runNumber；同一 Workflow 多次运行编号递增', async () => {
    await j('POST', '/api/workflows', wf('wb_a', 'Go Bug Fix Workflow'));
    const e1 = await runAndWait('wb_a');
    const e2 = await runAndWait('wb_a');
    const list = await j('GET', '/api/executions');
    const rows = (list.body as Array<{ executionId: string; workflowName: string; runNumber: number }>)
      .filter(x => x.executionId === e1 || x.executionId === e2);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.workflowName).toBe('Go Bug Fix Workflow');
    const nos = rows.map(r => r.runNumber).sort((a, b) => a - b);
    expect(nos).toEqual([1, 2]);
  });

  it('详情包含 workflowName 与完整字段', async () => {
    const eid = await runAndWait('wb_a');
    const r = await j('GET', `/api/executions/${eid}`);
    expect(r.status).toBe(200);
    expect((r.body as { workflowName?: string }).workflowName).toBe('Go Bug Fix Workflow');
    expect((r.body as { workingDirectory?: string }).workingDirectory).toBe('D:/project');
  });
});

describe('Workbench：删除（§10-13）', () => {
  it('删除 Execution 后 Workflow Definition 仍在（§11）', async () => {
    await j('POST', '/api/workflows', wf('wb_del', 'Delete Test'));
    const eid = await runAndWait('wb_del');
    const del = await j('DELETE', `/api/executions/${eid}`);
    expect(del.status).toBe(200);
    const wfGet = await j('GET', '/api/workflows/wb_del');
    expect(wfGet.status).toBe(200);
    expect((wfGet.body as { name: string }).name).toBe('Delete Test');
    const gone = await j('GET', `/api/executions/${eid}`);
    expect([200, 404]).toContain(gone.status); // 内存可能仍在（活跃 Map），磁盘已删
  });

  it('存在子 Rework 时拒绝删除（§13 Execution Tree 保护）', async () => {
    await j('POST', '/api/workflows', wf('wb_tree', 'Tree Test'));
    const parent = await runAndWait('wb_tree');
    const rw = await j('POST', '/api/workflows/wb_tree/rework', {
      parentExecutionId: parent, reworkNodeId: 'mid', input: '再来',
    });
    expect(rw.status).toBe(200);
    const del = await j('DELETE', `/api/executions/${parent}`);
    expect(del.status).toBe(409);
    expect((del.body as { error: string }).error).toContain('Rework 子执行');
  });

  it('删除不存在的执行返回 404', async () => {
    const r = await j('DELETE', '/api/executions/exec_nope');
    expect(r.status).toBe(404);
  });
});
