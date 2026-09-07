/**
 * Phase 9 —— Preset/Template 测试
 * 覆盖：内置列表 / 用户模板保存 / 实例化 / 删除保护 / 实例化进编辑器往返
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createWorkflowServer, type WorkflowServer } from '../src/index.js';
import { BUILTIN_TEMPLATES, instantiateTemplate } from '../src/templates/builtin.js';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp } from 'node:fs/promises';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'wf-tpl-test-'));
const PORT = 3300 + Math.floor(Math.random() * 100);
const server: WorkflowServer = createWorkflowServer({
  port: PORT, host: '127.0.0.1', mock: true, dataDir: tmp,
});
const BASE = `http://127.0.0.1:${PORT}`;

afterAll(async () => { await server.close(); });

async function j(method: string, p: string, body?: unknown) {
  const r = await fetch(BASE + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

describe('Phase 9 模板系统', () => {
  it('内置模板列表可用且含三个预设', async () => {
    const r = await j('GET', '/api/templates');
    expect(r.status).toBe(200);
    const ids = r.body.map((t: any) => t.id);
    expect(ids).toContain('tpl_review_pipeline');
    expect(ids).toContain('tpl_loop_refine');
    expect(ids).toContain('tpl_parallel_collect');
    expect(r.body.every((t: any) => t.category === 'builtin')).toBe(true);
  });

  it('从内置模板实例化：新 id、节点结构保留、环图自动补 LoopConfig', async () => {
    const r = await j('POST', '/api/templates/tpl_loop_refine/instantiate', { id: 'wf_from_tpl', name: '我的迭代环' });
    expect(r.status).toBe(200);
    const wf = r.body.workflow;
    expect(wf.id).toBe('wf_from_tpl');
    expect(wf.name).toBe('我的迭代环');
    expect(wf.nodes.map((n: any) => n.id).sort()).toEqual(['critic', 'end', 'start', 'writer']);
    expect(wf.loops.length).toBe(1);   // critic→writer 环（模板自带或自动补全）
    expect(wf.loops[0].maxIterations).toBe(3);
    expect(wf.loops[0].nodeIds.sort()).toEqual(['critic', 'writer']);
    // 时间戳是新的
    expect(new Date(wf.createdAt).getTime()).toBeGreaterThan(0);
  });

  it('重复实例化同 id 被拒', async () => {
    const r = await j('POST', '/api/templates/tpl_loop_refine/instantiate', { id: 'wf_from_tpl' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('已存在');
  });

  it('带 Review Gate 的模板实例化后可正常校验', async () => {
    const r = await j('POST', '/api/templates/tpl_review_pipeline/instantiate', { id: 'wf_review_tpl' });
    expect(r.status).toBe(200);
    const edge = r.body.workflow.edges.find((e: any) => e.id === 'e2');
    expect(edge.review?.enabled).toBe(true);
    expect(edge.review?.mode).toBe('required');
    const v = await j('POST', '/api/workflows/validate', r.body.workflow);
    expect(v.status).toBe(200);
    expect(v.body.valid).toBe(true);
  });

  it('保存用户模板并出现在列表', async () => {
    // 先存一个工作流作为模板来源
    const wf = instantiateTemplate(BUILTIN_TEMPLATES[2], 'wf_src', '源工作流');
    await j('POST', '/api/workflows', wf);
    const r = await j('POST', '/api/templates', { def: wf, name: '我的模板', description: '测试描述' });
    expect(r.status).toBe(200);
    const tplId = r.body.template.id;
    expect(tplId).toMatch(/^tpl_/);

    const list = await j('GET', '/api/templates');
    const mine = list.body.find((t: any) => t.id === tplId);
    expect(mine.category).toBe('user');
    expect(mine.name).toBe('我的模板');
    expect(mine.description).toBe('测试描述');

    // 删除用户模板
    const del = await j('DELETE', `/api/templates/${tplId}`);
    expect(del.status).toBe(200);
    expect(del.body.removed).toBe(true);
  });

  it('内置模板删除被拒', async () => {
    const r = await j('DELETE', '/api/templates/tpl_review_pipeline');
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('内置模板');
  });

  it('不存在的模板实例化返回 404', async () => {
    const r = await j('POST', '/api/templates/tpl_nope/instantiate', { id: 'wf_x' });
    expect(r.status).toBe(404);
  });

  it('非法定义不能存为模板', async () => {
    const bad = { id: 'bad', nodes: [], edges: [] };
    const r = await j('POST', '/api/templates', { def: bad as any });
    expect(r.status).toBe(400);
  });
});
