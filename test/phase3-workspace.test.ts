/**
 * 第三阶段 Phase 8：Working Directory（§32-36 / Test 10 / Test 11）
 * - §36 安全边界：根盘符 / 系统目录拒绝；相对路径与缺失警告
 * - Test 11：Workflow 修改 Working Directory 后，旧 Execution 快照不变
 * - rework：工作目录跟随父执行快照（父快照优先）
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { createWorkflowServer } from '../src/index.js';
import { validateWorkspaceDir } from '../src/domain/workspace.js';
import {
  defaultSettings, type AgentNode, type WorkflowDefinition, type WorkflowEdge,
} from '../src/domain/types.js';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'wf-p3ws-'));
const PORT = 3700 + Math.floor(Math.random() * 100);
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
const wf = (id: string, workspaceDir: string): WorkflowDefinition => ({
  version: '1.0', id, name: id,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  nodes: [agent('start', 'start'), agent('mid'), agent('end', 'end')],
  edges: [edge(1, 'start', 'mid'), edge(2, 'mid', 'end')],
  settings: defaultSettings({ workspaceDir }),
  loops: [], layout: {},
});

afterAll(async () => { await server.close(); });

describe('Phase 8：§36 Working Directory 安全边界', () => {
  it('根盘符拒绝（C:/、D:\\、/）', () => {
    for (const dir of ['C:/', 'D:\\', '/']) {
      const r = validateWorkspaceDir(dir);
      expect(r.errors.some(e => e.code === 'workspace_root')).toBe(true);
    }
  });

  it('系统目录拒绝（Windows/System32、Program Files、/etc）', () => {
    for (const dir of ['C:/Windows/System32', 'c:\\program files\\app', 'C:/Users', '/etc/nginx', 'D:/Windows/Temp']) {
      const r = validateWorkspaceDir(dir);
      expect(r.errors.some(e => e.code === 'workspace_system'), dir).toBe(true);
    }
  });

  it('正常项目目录通过；相对路径与缺失仅警告', () => {
    expect(validateWorkspaceDir('D:/project/QuestMind').errors).toHaveLength(0);
    expect(validateWorkspaceDir('/home/dev/project').errors).toHaveLength(0);
    const rel = validateWorkspaceDir('my-project');
    expect(rel.errors).toHaveLength(0);
    expect(rel.warnings.some(w => w.code === 'workspace_relative')).toBe(true);
    const miss = validateWorkspaceDir(undefined);
    expect(miss.errors).toHaveLength(0);
    expect(miss.warnings.some(w => w.code === 'workspace_missing')).toBe(true);
  });

  it('validate 接口透出 workspace 校验结果', async () => {
    const bad = await j('POST', '/api/workflows/validate', wf('ws_bad', 'C:/'));
    expect(bad.status).toBe(200);
    expect((bad.body as { errors: { code: string }[] }).errors.some(e => e.code === 'workspace_root')).toBe(true);
    const good = await j('POST', '/api/workflows/validate', wf('ws_good', 'D:/project'));
    expect((good.body as { errors: unknown[] }).errors).toHaveLength(0);
  });
});

describe('Phase 8：Test 10/11 —— cwd 快照与继承', () => {
  it('Test 11：Workflow 修改 Working Directory 后，旧 Execution 快照不变', { timeout: 15000 }, async () => {
    await j('POST', '/api/workflows', wf('ws_snap', 'D:/project'));
    const run = await j('POST', '/api/workflows/ws_snap/run', { input: 'GO' });
    expect(run.status).toBe(200);
    const execId = (run.body as { executionId: string }).executionId;
    // 等待结束（mock 快速）
    let st = await j('GET', `/api/executions/${execId}`);
    for (let i = 0; i < 40 && !['success', 'failed', 'terminated'].includes((st.body as { status: string }).status); i++) {
      await new Promise(r => setTimeout(r, 100));
      st = await j('GET', `/api/executions/${execId}`);
    }
    // 修改工作流的工作目录为 v2
    const def2 = wf('ws_snap', 'D:/project-v2');
    def2.revision = 2;
    await j('POST', '/api/workflows', def2);
    // 旧执行快照保持 D:/project
    const r = await j('GET', `/api/executions/${execId}`);
    expect((r.body as { workingDirectory?: string }).workingDirectory).toBe('D:/project');
  });

  it('rework 的工作目录跟随父执行快照（即使 def 已改目录）', { timeout: 15000 }, async () => {
    // 用已完成且带 rework 链验证：直接建新工作流跑完 → 改目录 → rework
    await j('POST', '/api/workflows', wf('ws_rw', 'D:/project'));
    const run = await j('POST', '/api/workflows/ws_rw/run', { input: 'GO' });
    const execId = (run.body as { executionId: string }).executionId;
    let st = await j('GET', `/api/executions/${execId}`);
    for (let i = 0; i < 40 && !['success', 'failed', 'terminated'].includes((st.body as { status: string }).status); i++) {
      await new Promise(r => setTimeout(r, 100));
      st = await j('GET', `/api/executions/${execId}`);
    }
    const def2 = wf('ws_rw', 'D:/project-v2');
    def2.revision = 2;
    await j('POST', '/api/workflows', def2);
    const rw = await j('POST', '/api/workflows/ws_rw/rework', {
      parentExecutionId: execId, reworkNodeId: 'mid', input: '再来一次',
    });
    expect(rw.status).toBe(200);
    const newId = (rw.body as { executionId: string }).executionId;
    const r = await j('GET', `/api/executions/${newId}`);
    expect((r.body as { workingDirectory?: string }).workingDirectory).toBe('D:/project');
  });
});
