/**
 * 真机级验证：工作目录联动宿主接口。
 * 非 mock 模式启动 createWorkflowServer，注入记录型假 apiProxy，
 * 通过完整 HTTP 链路创建带 workspaceDir 的工作流并运行，
 * 断言宿主 sessions.create 收到的 payload.cwd === 用户选择的工作目录。
 */
import { createWorkflowServer } from '../lib/index.js';

const WORKSPACE = 'D:/Development Program/demo';
const PORT = 4160;
const DATA_DIR = './phase0/tmp-e2e-cwd-link';

// ---- 记录型假 apiProxy：只验证 create 是否携带 cwd，prompt 直接产出终局帧 ----
const createdPayloads = [];
const apiProxy = {
  sessions: {
    async create(req) {
      createdPayloads.push(req.payload);
      return { result: { ok: true, value: { sessionId: 'sess-' + createdPayloads.length } } };
    },
    async prompt(req) {
      const sid = req.payload.sessionId;
      // 异步推帧：assistant/message → turn/end
      setTimeout(() => {
        for (const sub of muxSubs) {
          sub.push({ type: 'session/event', sessionId: sid, event: { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'done-' + sid }] } } } });
          sub.push({ type: 'session/event', sessionId: sid, event: { type: 'turn/end' } });
        }
      }, 5);
      return { result: { ok: true, value: { accepted: true } } };
    },
    async cancel() { return {}; },
  },
  events: {
    async *mux(req, signal) {
      const sub = { push() {} };
      const queue = [];
      const waiters = [];
      sub.push = (f) => {
        const w = waiters.shift();
        if (w) w(f); else queue.push(f);
      };
      muxSubs.push(sub);
      try {
        while (true) {
          if (queue.length) {
            yield { rpcId: 'mux', payload: queue.shift() };
            continue;
          }
          const f = await new Promise((resolve, reject) => {
            waiters.push(resolve);
            signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
          });
          yield { rpcId: 'mux', payload: f };
        }
      } finally {
        muxSubs.splice(muxSubs.indexOf(sub), 1);
      }
    },
  },
};
const muxSubs = [];

// ---- 启动服务（createWorkflowServer 内部自动 listen） ----
const server = createWorkflowServer({ mock: false, apiProxy, port: PORT, dataDir: DATA_DIR });
await new Promise((r) => setTimeout(r, 300));

const BASE = `http://127.0.0.1:${PORT}`;
const req = async (method, path, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// ---- 构造工作流（复用 e2e-cwd 形态，workspaceDir = 用户场景目录） ----
const node = (id, type) => ({
  id, type, name: id, position: { x: 0, y: 0 },
  identity: { name: `role-${id}` }, roleDescription: `desc-${id}`,
  inputContract: { description: '', processing: '', selection: '', ignore: '', constraints: [], sourceMode: 'all', selectedSourceNodeIds: [] },
  outputContract: { description: '', format: 'markdown', schema: null, requiredSections: [], targets: [], condition: null },
  modelConfig: { provider: 'deepseek', model: 'deepseek-chat' },
  runtimeConfig: { maxRuns: 5, timeoutMs: 120000, retry: { enabled: false, maxRetries: 0, backoffMs: 0 }, onFailure: 'fail_workflow' },
  metadata: {},
});
const defn = {
  version: '1.0', id: 'wf_cwd_link', name: 'cwd-link-e2e',
  createdAt: '2026-09-02T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z',
  nodes: [node('start', 'start'), node('writer', 'agent'), node('end', 'end')],
  edges: [
    { id: 'e0', source: { nodeId: 'start', output: 'main' }, target: { nodeId: 'writer', input: 'main' }, transform: { enabled: false, instruction: '' }, condition: null },
    { id: 'e1', source: { nodeId: 'writer', output: 'main' }, target: { nodeId: 'end', input: 'main' }, transform: { enabled: false, instruction: '' }, condition: null },
  ],
  settings: { maxExecutionSteps: 100, maxIterations: 10, timeoutMs: 300000, workspaceDir: WORKSPACE },
  loops: [], layout: {},
};

// 相对路径工作流（回归：宿主校验 cwd 必须绝对，旧代码会导致运行直接失败）
const defnRel = JSON.parse(JSON.stringify(defn));
defnRel.id = 'wf_cwd_rel';
defnRel.settings.workspaceDir = 'demo';

try {
  // 用例 1：绝对路径 → sessions.create 收到归一化 cwd
  const created = await req('POST', '/api/workflows', defn);
  console.log('create workflow:', created.status, JSON.stringify(created.body));
  const run = await req('POST', '/api/workflows/wf_cwd_link/run', { input: 'GO' });
  console.log('run:', run.status, run.body.executionId ?? run.body);
  const execId = run.body.executionId;
  if (!execId) throw new Error('no executionId');
  // 等待终局
  let st = {};
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    st = (await req('GET', `/api/executions/${execId}`)).body;
    if (['completed', 'failed', 'terminated'].includes(st.status)) break;
  }
  console.log('exec status:', st.status);
  console.log('exec workingDirectory:', JSON.stringify(st.workingDirectory));
  const absOk = createdPayloads.length > 0 && createdPayloads[0]?.cwd === WORKSPACE;
  console.log(absOk ? 'PASS[绝对路径]: cwd 已随 sessions.create 传给宿主' : 'FAIL[绝对路径]: cwd 未正确传递');

  // 用例 2：相对路径 → 不携带 cwd，且运行不失败（宿主回退默认目录）
  createdPayloads.length = 0;
  await req('POST', '/api/workflows', defnRel);
  const run2 = await req('POST', '/api/workflows/wf_cwd_rel/run', { input: 'GO' });
  const execId2 = run2.body.executionId;
  let st2 = {};
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    st2 = (await req('GET', `/api/executions/${execId2}`)).body;
    if (['completed', 'failed', 'terminated'].includes(st2.status)) break;
  }
  const relOk = st2.status === 'completed'
    && createdPayloads.length > 0 && createdPayloads[0]?.cwd === undefined;
  console.log(`PASS[相对路径]: 运行 ${st2.status}，create 未携带 cwd（宿主默认目录）`);
  console.log(relOk ? 'PASS[相对路径]: 不再因相对路径导致运行失败' : 'FAIL[相对路径]: 运行仍失败或 cwd 处理错误');
  console.log('---');
  console.log('sessions.create payloads:', JSON.stringify(createdPayloads));
  process.exit(absOk && relOk ? 0 : 1);
} finally {
  await new Promise((r) => server.close(r));
}
