import { describe, it, expect } from 'vitest';
import {
  extractMessageText,
  extractDelta,
  extractDeltaText,
  extractUsage,
  DshSessionProvider,
  normalizeWorkspaceCwd,
  type ApiProxyLike,
  type MuxFrame,
} from '../src/provider/dsh-session-provider.js';
import type { AgentRunRequest } from '../src/engine/runner.js';
import { buildPrompt } from '../src/engine/prompt-builder.js';
import { InputContextEmpty } from './helpers.js';

// ---------------------------------------------------------------- 纯函数（fixture 来自 harness-integration.md 附 I 的真实帧）

describe('DshSessionProvider 帧解析', () => {
  it('extractMessageText：标准 assistant/message', () => {
    const ev = {
      type: 'assistant/message', seq: 60, time: 1748000005000,
      data: {
        message: { role: 'assistant', content: [{ type: 'text', text: '答案' }] },
        usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 0 },
      },
    };
    expect(extractMessageText(ev as never)).toBe('答案');
  });

  it('extractMessageText：多段 text 拼接、忽略非 text', () => {
    const ev = {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'a' }, { type: 'tool-call' }, { type: 'text', text: 'b' }] } },
    };
    expect(extractMessageText(ev as never)).toBe('ab');
  });

  it('extractUsage：input/output 映射', () => {
    const ev = { data: { usage: { inputTokens: 1200, outputTokens: 340 } } };
    expect(extractUsage(ev as never)).toEqual({ prompt: 1200, completion: 340 });
  });

  it('extractUsage：无 usage 返回 undefined', () => {
    expect(extractUsage({ data: {} } as never)).toBeUndefined();
  });

  it('extractDelta：真实 text-delta 帧（实测结构）', () => {
    const ev = { data: { chunk: { type: 'text-delta', index: 0, text: '正文增量' } } };
    expect(extractDelta(ev as never)).toEqual({ text: '正文增量', kind: 'text' });
  });

  it('extractDelta：真实 reasoning-delta 帧（实测结构）', () => {
    const ev = { data: { chunk: { type: 'reasoning-delta', index: 0, text: ' ' } } };
    expect(extractDelta(ev as never)).toEqual({ text: ' ', kind: 'reasoning' });
  });

  it('extractDelta：文档形态 blocks', () => {
    const ev = { data: { chunk: { type: 'delta', blocks: [{ type: 'text', text: '片段' }] } } };
    expect(extractDeltaText(ev as never)).toBe('片段');
  });

  it('extractDelta：block-start/finish/usage 等辅助帧返回空', () => {
    expect(extractDelta({ data: { chunk: { type: 'block-start' } } } as never).text).toBe('');
    expect(extractDelta({ data: { chunk: { type: 'finish' } } } as never).text).toBe('');
    expect(extractDelta({ data: { chunk: { type: 'usage' } } } as never).text).toBe('');
  });
});

// ---------------------------------------------------------------- 集成：模拟 apiProxy 全链路

function fakeApiProxy(script: { deltas: string[]; final: string; usage?: any }) {
  const created = new Set<string>();
  const createPayloads: Array<Record<string, unknown>> = [];
  const frames: MuxFrame[] = [];
  let promptCount = 0;
  const waiters: Array<() => void> = [];

  async function* mux(): AsyncIterable<{ rpcId: string; payload: MuxFrame }> {
    let i = 0;
    while (true) {
      while (i < frames.length) {
        yield { rpcId: 'mux', payload: frames[i] };
        i++;
      }
      // 无帧时挂起等待新帧
      await new Promise<void>(r => waiters.push(r));
    }
  }

  const push = (f: MuxFrame) => {
    frames.push(f);
    waiters.splice(0).forEach(w => w());
  };

  const api: ApiProxyLike = {
    sessions: {
      async create(req: { payload: Record<string, unknown> }) {
        createPayloads.push(req.payload);
        const sessionId = `session-${Math.random().toString(36).slice(2, 8)}`;
        created.add(sessionId);
        return { result: { ok: true, value: { sessionId } } };
      },
      async prompt(req: { payload: { sessionId: string } }) {
        promptCount++;
        const sid = req.payload.sessionId;
        // 异步产出事件流
        setTimeout(() => {
          for (const d of script.deltas) {
            push({ type: 'session/event', sessionId: sid, event: { type: 'assistant/chunk', data: { chunk: { type: 'delta', blocks: [{ type: 'text', text: d }] } } } });
          }
          push({
            type: 'session/event', sessionId: sid,
            event: {
              type: 'assistant/message',
              data: {
                message: { role: 'assistant', content: [{ type: 'text', text: script.final }] },
                usage: script.usage,
              },
            },
          });
          push({ type: 'session/event', sessionId: sid, event: { type: 'turn/end' } });
        }, 5);
        return { result: { ok: true, value: { accepted: true } } };
      },
      async cancel() { return {}; },
    },
    events: { mux: ((req: any, signal: AbortSignal) => muxWithSignal(signal)) as never },
  };

  async function* muxWithSignal(signal: AbortSignal) {
    const inner = mux();
    while (true) {
      const next = await Promise.race([
        inner.next(),
        new Promise<never>((_, rej) => signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')), { once: true })),
      ]);
      if (next.done) return;
      yield next.value;
    }
  }

  return { api, stats: { get promptCount() { return promptCount; }, createPayloads } };
}

const NODE: AgentRunRequest = {
  node: {
    id: 'b', type: 'agent', name: 'b', position: { x: 0, y: 0 },
    identity: { name: '评审员' }, roleDescription: '评审',
    inputContract: { description: '', processing: '', selection: '', ignore: '', constraints: [], sourceMode: 'all', selectedSourceNodeIds: [] },
    outputContract: { description: '', format: 'markdown', schema: null, requiredSections: [], targets: [], condition: null },
    modelConfig: { provider: 'deepseek', model: 'deepseek-chat' },
    runtimeConfig: { maxRuns: 5, timeoutMs: 120000, retry: { enabled: false, maxRetries: 0, backoffMs: 0 }, onFailure: 'fail_workflow' },
    metadata: {},
  },
  inputContext: InputContextEmpty,
  prompt: { system: 'SYS', user: 'USER' },
  runIndex: 1,
};

describe('DshSessionProvider 集成（模拟 apiProxy）', () => {
  it('全链路：create → prompt → mux 收集 → delta 转发 + done 记录', async () => {
    const fake = fakeApiProxy({ deltas: ['你', '好'], final: '你好', usage: { inputTokens: 10, outputTokens: 2 } });
    const provider = new DshSessionProvider(fake.api, { turnTimeoutMs: 2000 });

    const chunks: any[] = [];
    for await (const c of provider.run(NODE)) chunks.push(c);

    const deltas = chunks.filter(c => c.kind === 'delta');
    const done = chunks.find(c => c.kind === 'done');
    expect(deltas.map(d => d.text).join('')).toBe('你好');
    expect(deltas.every(d => d.deltaKind === 'text')).toBe(true);
    expect(done.record.content).toBe('你好');
    expect(done.record.tokenUsage).toEqual({ prompt: 10, completion: 2 });
    expect(done.record.durationMs).toBeGreaterThanOrEqual(0);
    expect(fake.stats.promptCount).toBe(1);
  });

  it('prompt 拼接 system+user 并原样送达', async () => {
    let sentText = '';
    const fake = fakeApiProxy({ deltas: [], final: 'ok' });
    (fake.api.sessions.prompt as any) = async (req: any) => {
      sentText = req.payload.content[0].text;
      setTimeout(() => {
        // 直接终局
      }, 0);
      return { result: { ok: true, value: { accepted: true } } };
    };
    // 用真实 prompt builder 产物
    const prompt = buildPrompt(NODE.node, { inputs: [{ sourceNodeId: 'a', sourceName: 'A', runIndex: 1, content: 'IN', truncated: false }] });
    const provider = new DshSessionProvider(fake.api, { turnTimeoutMs: 2000 });
    try {
      for await (const _ of provider.run({ ...NODE, prompt })) { /* drain */ }
    } catch { /* 可能因无 assistant 消息失败，此处只验证 prompt 送达 */ }
    expect(sentText).toContain('# IDENTITY');
    expect(sentText).toContain('评审员');
    expect(sentText).toContain('# INPUT');
    expect(sentText).toContain('IN');
  });

  it('turn 超时且无 assistant 消息 → 抛错', async () => {
    const fake = fakeApiProxy({ deltas: [], final: '' });
    // final 为空 → provider 抛错
    const provider = new DshSessionProvider(fake.api, { turnTimeoutMs: 100 });
    await expect(async () => {
      for await (const _ of provider.run(NODE)) { /* drain */ }
    }).rejects.toThrow(/未产出 assistant/);
  });

  it('工作目录联动：绝对路径 workspaceDir 归一化为 cwd 传入 sessions.create', async () => {
    // 绝对路径（含反斜杠 Windows 形态）→ 归一化为正斜杠 cwd
    const fake1 = fakeApiProxy({ deltas: [], final: 'ok' });
    const p1 = new DshSessionProvider(fake1.api, { turnTimeoutMs: 2000 });
    await p1.run({ ...NODE, workspaceDir: 'D:\\Development Program\\demo' })[Symbol.asyncIterator]().next();
    expect(fake1.stats.createPayloads[0]).toEqual({ cwd: 'D:/Development Program/demo' });

    // 未配置工作目录 → payload 不携带 cwd（宿主用默认目录）
    const fake2 = fakeApiProxy({ deltas: [], final: 'ok' });
    const p2 = new DshSessionProvider(fake2.api, { turnTimeoutMs: 2000 });
    await p2.run(NODE)[Symbol.asyncIterator]().next();
    expect(fake2.stats.createPayloads[0]).toEqual({});
  });

  it('工作目录联动：相对路径不传给宿主（宿主校验 cwd 必须绝对，否则运行失败）', async () => {
    // 相对路径 → 视为未配置，payload 不携带 cwd（宿主回退默认目录）
    const fake = fakeApiProxy({ deltas: [], final: 'ok' });
    const provider = new DshSessionProvider(fake.api, { turnTimeoutMs: 2000 });
    await provider.run({ ...NODE, workspaceDir: 'demo' })[Symbol.asyncIterator]().next();
    expect(fake.stats.createPayloads[0]).toEqual({});
  });

  it('normalizeWorkspaceCwd：仅绝对路径可用，统一正斜杠', () => {
    expect(normalizeWorkspaceCwd('D:\\Development Program\\demo')).toBe('D:/Development Program/demo');
    expect(normalizeWorkspaceCwd('D:/projects/myapp')).toBe('D:/projects/myapp');
    expect(normalizeWorkspaceCwd('/home/user/proj')).toBe('/home/user/proj');
    expect(normalizeWorkspaceCwd('demo')).toBeUndefined();
    expect(normalizeWorkspaceCwd('')).toBeUndefined();
    expect(normalizeWorkspaceCwd(undefined)).toBeUndefined();
    expect(normalizeWorkspaceCwd('   ')).toBeUndefined();
  });
});
