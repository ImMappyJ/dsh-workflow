/**
 * Phase 9（任务 3）：DSH Home 入口——只用宿主 Plugin API（ctx.webServer.register），
 * 不侵入 DSH 核心（§55.7）。宿主无导航注册 API 时，/workflow 落地页作为页面入口，
 * 深链跳转独立端口编辑器；独立端口 3090 保留为完整入口。
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { apply, createWorkflowServer, type WorkflowServer } from '../src/index.js';
import { defaultSettings, type AgentNode } from '../src/domain/types.js';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'wf-home-'));
const PORT = 3300 + Math.floor(Math.random() * 100);

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

describe('Phase 9：DSH Home 入口（任务 3）', () => {
  let server: WorkflowServer;
  afterAll(async () => { await server?.close(); });

  it('落地页：空状态 → 保存工作流后列出 + 深链带 ?wf=<id>', async () => {
    server = createWorkflowServer({ port: PORT, host: '127.0.0.1', mock: true, dataDir: tmp });

    // 空状态
    let html = await server.renderLanding();
    expect(html).toContain('暂无工作流');
    expect(html).toContain(`http://127.0.0.1:${PORT}/`);

    // 保存一个工作流（走保存端点，确保真实落盘）
    const def: any = {
      version: '1.0', id: 'wf_home', name: '首页测试流',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      nodes: [agent('start', 'start'), agent('mid'), agent('end', 'end')],
      edges: [['start', 'mid'], ['mid', 'end']].map(([s, t], i) => ({
        id: `e${i}`, source: { nodeId: s, output: 'main' }, target: { nodeId: t, input: 'main' },
        transform: { enabled: false, instruction: '' }, condition: null,
      })),
      settings: defaultSettings(), loops: [], layout: {},
    };
    const save = await fetch(`http://127.0.0.1:${PORT}/api/workflows`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(def),
    });
    expect(save.status).toBe(200);

    html = await server.renderLanding();
    expect(html).toContain('首页测试流');
    expect(html).toContain(`/?wf=wf_home`); // 深链 → 编辑器自动打开
    expect(html).toContain('3 节点 · 2 连线');
    expect(html).toContain('共 1 个工作流');
  });

  it('apply：宿主提供 webServer 时经 Plugin API 注册 /workflow 精确路由', async () => {
    const registered: Array<{ kind: string; path: string; handler: any }> = [];
    const logs: string[] = [];
    const fakeCtx: any = {
      apiProxy: undefined, // 走 mock 需要 apiProxy？apply 内 mock=false 但无 apiProxy → 用 mock 配置
      webServer: { register: (opt: any) => registered.push(opt) },
      logger: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) },
      on: () => {},
    };
    apply(fakeCtx, { port: PORT + 1, mock: true, dataDir: tmp });

    expect(registered).toHaveLength(1);
    expect(registered[0].kind).toBe('exact');
    expect(registered[0].path).toBe('/workflow');
    expect(logs.some(l => l.includes('/workflow'))).toBe(true);

    // 模拟宿主请求打到 handler：返回 SSR HTML（含已保存的工作流）
    let written = '';
    let status = 0;
    const fakeRes: any = {
      headersSent: false,
      writeHead(code: number) { status = code; },
      end(body: string) { written = body; },
    };
    await new Promise<void>(resolve => {
      registered[0].handler({ url: '/workflow' }, {
        ...fakeRes,
        end(body: string) { written = body; resolve(); },
      });
    });
    expect(status).toBe(200);
    expect(written).toContain('首页测试流');
  });

  it('apply：宿主无 webServer 时静默降级（保留独立端口，不抛错）', async () => {
    vi.useFakeTimers();
    try {
      const logs: string[] = [];
      const fakeCtx: any = {
        logger: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) },
        on: () => {},
      };
      expect(() => apply(fakeCtx, { port: PORT + 2, mock: true, dataDir: tmp })).not.toThrow();
      // 降级日志改为延迟产生（重试 5 次 × 500ms），推进假时钟到重试耗尽。
      vi.advanceTimersByTime(600 * 5);
      expect(logs.some(l => l.includes('仅保留独立端口'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
