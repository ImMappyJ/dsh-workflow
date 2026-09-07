/**
 * 第四阶段 Phase A：Workflow 版本化 + Execution def 快照（§4/§5/§23/§24）
 * - 每次保存产生不可变版本快照；versions 可枚举
 * - 历史 Execution 绑定 defSnapshot，Workflow 改版不影响旧执行（审计永远可见旧结构）
 * - run 支持指定 version（Run with Version N）
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { createWorkflowServer } from '../src/index.js';
import {
  defaultSettings, type AgentNode, type WorkflowDefinition, type WorkflowEdge,
} from '../src/domain/types.js';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'wf-p3ver-'));
const PORT = 4100 + Math.floor(Math.random() * 100);
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

function agent(id: string, type: 'start' | 'end' | 'agent' = 'agent', name = id): AgentNode {
  return {
    id, type, name, position: { x: 0, y: 0 },
    identity: { name }, roleDescription: name,
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

function makeWf(id: string, name: string, nodeName = 'mid'): WorkflowDefinition {
  return {
    version: '1.0', id, name,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: new Date().toISOString(),
    nodes: [agent('start', 'start', 'Start'), agent('mid', 'agent', nodeName), agent('end', 'end', 'End')],
    edges: [edge(1, 'start', 'mid'), edge(2, 'mid', 'end')],
    settings: defaultSettings({ workspaceDir: 'D:/project' }),
    loops: [], layout: {},
  };
}

async function runAndWait(wfId: string, version?: number): Promise<{ id: string; status: string }> {
  const run = await j('POST', `/api/workflows/${wfId}/run`, { input: 'GO', ...(version != null ? { version } : {}) });
  expect(run.status).toBe(200);
  const execId = (run.body as { executionId: string }).executionId;
  let st = await j('GET', `/api/executions/${execId}`);
  for (let i = 0; i < 60 && !['success', 'completed', 'failed', 'terminated'].includes((st.body as { status: string }).status); i++) {
    await new Promise(r => setTimeout(r, 100));
    st = await j('GET', `/api/executions/${execId}`);
  }
  return { id: execId, status: (st.body as { status: string }).status };
}

afterAll(async () => { await server.close(); });

describe('Phase A：Workflow 版本化（§4/§5）', () => {
  it('每次保存自增 revision 并产生不可变版本快照', async () => {
    await j('POST', '/api/workflows', makeWf('va', 'Version A', 'v1-mid'));
    const def2 = makeWf('va', 'Version A', 'v2-mid');
    def2.revision = 2;
    await j('POST', '/api/workflows', def2);
    const versions = await j('GET', '/api/workflows/va/versions');
    expect(versions.status).toBe(200);
    const v = (versions.body as { revision: number; nodeCount: number }[]);
    expect(v.map(x => x.revision).sort((a, b) => b - a)).toEqual([2, 1]);
    // 指定版本可还原：v1 的节点名仍是 v1-mid
    const v1 = await j('GET', '/api/workflows/va?version=1');
    expect((v1.body as { nodes: { name: string }[] }).nodes.find(n => n.id === 'mid')?.name).toBe('v1-mid');
    const v2 = await j('GET', '/api/workflows/va?version=2');
    expect((v2.body as { nodes: { name: string }[] }).nodes.find(n => n.id === 'mid')?.name).toBe('v2-mid');
  });

  it('历史 Execution 绑定 defSnapshot：Workflow 改版后旧执行仍显示旧结构（§5/§23）', async () => {
    await j('POST', '/api/workflows', makeWf('vb', 'Snapshot B', 'old-mid'));
    const { id } = await runAndWait('vb');
    // 修改 Workflow（revision 自增 → v2），旧执行已落盘
    const def2 = makeWf('vb', 'Snapshot B', 'new-mid');
    def2.revision = 2;
    await j('POST', '/api/workflows', def2);
    // 旧执行详情：defSnapshot 里 mid 节点仍是 old-mid
    const r = await j('GET', `/api/executions/${id}`);
    expect(r.status).toBe(200);
    const snap = (r.body as { defSnapshot?: { nodes: { name: string }[] }; workflowVersion: number }).defSnapshot;
    expect(snap).toBeDefined();
    expect(snap!.nodes.find(n => n.id === 'mid')?.name).toBe('old-mid');
    expect((r.body as { workflowVersion: number }).workflowVersion).toBe(1);
  });

  it('run 指定 version：用历史版本运行（§24 Run with Version N）', async () => {
    await j('POST', '/api/workflows', makeWf('vc', 'RunVer', 'r1-mid'));
    await j('POST', '/api/workflows', makeWf('vc', 'RunVer', 'r2-mid')); // 存为 v2
    // 用 v1 运行
    const run1 = await runAndWait('vc', 1);
    const d1 = await j('GET', `/api/executions/${run1.id}`);
    const snap1 = (d1.body as { defSnapshot?: { nodes: { name: string }[] } }).defSnapshot;
    expect(snap1!.nodes.find(n => n.id === 'mid')?.name).toBe('r1-mid');
    // 用 v2 运行
    const run2 = await runAndWait('vc', 2);
    const d2 = await j('GET', `/api/executions/${run2.id}`);
    const snap2 = (d2.body as { defSnapshot?: { nodes: { name: string }[] } }).defSnapshot;
    expect(snap2!.nodes.find(n => n.id === 'mid')?.name).toBe('r2-mid');
  });

  it('不存在的版本返回 404', async () => {
    const r = await j('GET', '/api/workflows/va?version=99');
    expect(r.status).toBe(404);
  });
});
