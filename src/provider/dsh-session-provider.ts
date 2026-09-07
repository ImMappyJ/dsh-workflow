/**
 * DshSessionProvider —— AgentRunner 的宿主实现（Phase 3，联调修订版）。
 *
 * 链路：每次节点运行 = 独立 session（输入由引擎显式注入，隔离干净、token 可控）
 *   sessions.create({payload:{}})  → {sessionId}
 *   events.mux(...)                → AsyncIterable<{rpcId,payload:MuxFrame}>（先订阅）
 *   sessions.prompt(...)           → {accepted}
 *   逐帧消费：assistant/chunk → 实时 yield delta；assistant/message → 最终输出；turn/end → 完成
 *
 * 实时流式通过 AsyncQueue（生产者-消费者）实现：pump 把 mux 帧推入队列，
 * run() 消费队列即时转发，不再等轮次结束批量回放。
 */

import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { AgentRunner, AgentRunRequest, AgentRunChunk } from '../engine/runner.js';

/**
 * 归一化工作目录为宿主可接受的 cwd：
 *  - 仅绝对路径可用（宿主 sessions.create 校验 cwd 必须绝对，相对路径会直接报错）；
 *  - 统一为正斜杠（Node/宿主均接受，避免反斜杠转义问题）。
 * 不合法时返回 undefined，调用方回退为不传 cwd（宿主用默认目录）。
 */
export function normalizeWorkspaceCwd(workspaceDir: string | undefined): string | undefined {
  if (!workspaceDir || !String(workspaceDir).trim()) return undefined;
  const raw = String(workspaceDir).trim();
  if (!isAbsolute(raw)) return undefined;
  return raw.replace(/\\/g, '/');
}

/** 宿主 apiProxy 的最小结构类型（宽松以适配版本差异） */
export interface ApiProxyLike {
  sessions: {
    create(req: { rpcId: string; payload: Record<string, unknown> }, signal?: AbortSignal): Promise<{ result?: { ok?: boolean; value?: { sessionId?: string }; error?: { message?: string } } } | { sessionId?: string }>;
    prompt(req: { rpcId: string; payload: { sessionId: string; mode: 'queue'; content: Array<{ type: 'text'; text: string }> } }, signal?: AbortSignal): Promise<{ result?: { ok?: boolean; value?: { accepted?: boolean }; error?: { message?: string } } }>;
    cancel(req: { rpcId: string; payload: { sessionId: string } }, signal?: AbortSignal): Promise<unknown>;
  };
  events: {
    mux(req: { rpcId: string; payload: Record<string, unknown> }, signal?: AbortSignal): AsyncIterable<{ rpcId: string; payload: MuxFrame }>;
  };
}

export interface MuxFrame {
  type: string;
  sessionId?: string;
  event?: SessionEvent;
}

export interface SessionEvent {
  type: string;
  seq?: number;
  time?: number;
  data?: any;
}

export interface DshSessionProviderOptions {
  /** 整轮兜底超时（ms），超时后中止订阅 */
  turnTimeoutMs?: number;
  /** 诊断钩子：每个属于本 session 的事件回调（用于观察真实帧结构） */
  onFrame?: (frame: MuxFrame) => void;
}

// ---------------------------------------------------------------- 纯函数（可单测）

/** 从 assistant/message 事件提取完整文本 */
export function extractMessageText(event: SessionEvent): string {
  const content = event.data?.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
    .map((p: any) => p.text)
    .join('');
}

/** 从 assistant/chunk 事件提取流式 delta。真实帧（实测）：
 *   chunk.type === 'text-delta'      → 正文增量（{text}）
 *   chunk.type === 'reasoning-delta' → 思考增量（{text}）
 * 兼容文档形态：chunk.type === 'delta' + blocks/text/delta.text。
 * 返回 {text, kind}：kind 为 'text' | 'reasoning'；无内容时 text 为空串。 */
export function extractDelta(event: SessionEvent): { text: string; kind: 'text' | 'reasoning' } {
  const chunk = event.data?.chunk;
  if (!chunk) return { text: '', kind: 'text' };
  // 真实形态：text-delta / reasoning-delta
  if (chunk.type === 'text-delta' && typeof chunk.text === 'string') return { text: chunk.text, kind: 'text' };
  if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') return { text: chunk.text, kind: 'reasoning' };
  if (chunk.type !== 'delta') return { text: '', kind: 'text' };
  // 文档形态 1：chunk.blocks: [{type:'text', text}]
  if (Array.isArray(chunk.blocks)) {
    const t = chunk.blocks
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('');
    return { text: t, kind: 'text' };
  }
  // 文档形态 2：chunk.delta / chunk.text 直给
  if (typeof chunk.text === 'string') return { text: chunk.text, kind: 'text' };
  if (typeof chunk.delta?.text === 'string') return { text: chunk.delta.text, kind: 'text' };
  return { text: '', kind: 'text' };
}

/** 旧名兼容：只取文本内容 */
export function extractDeltaText(event: SessionEvent): string {
  return extractDelta(event).text;
}

/** 从 assistant/message 提取 usage → NodeOutputRecord.tokenUsage */
export function extractUsage(event: SessionEvent): { prompt: number; completion: number } | undefined {
  const u = event.data?.usage;
  if (!u) return undefined;
  const prompt = u.inputTokens ?? u.promptTokens ?? 0;
  const completion = u.outputTokens ?? u.completionTokens ?? 0;
  return prompt || completion ? { prompt, completion } : undefined;
}

/** 从 RpcResponse 里解包 value（兼容 ok()/raw 两种返回形态） */
function unwrap<T>(resp: any): T {
  if (resp?.result?.ok === false) {
    throw new Error(resp.result.error?.message ?? 'apiProxy rpc failed');
  }
  if (resp?.result?.value !== undefined) return resp.result.value as T;
  if (resp?.ok === false) throw new Error(resp.error?.message ?? 'apiProxy rpc failed');
  return resp as T;
}

// ---------------------------------------------------------------- AsyncQueue

/** 简易异步队列：生产者推入，消费者 for-await 即时读取 */
class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<{ resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void }> = [];
  private finished = false;
  private error: unknown = null;

  push(v: T): void {
    const w = this.waiters.shift();
    if (w) w.resolve({ value: v, done: false });
    else this.items.push(v);
  }

  end(): void {
    if (this.finished) return;
    this.finished = true;
    while (this.waiters.length) this.waiters.shift()!.resolve({ value: undefined as any, done: true });
  }

  setError(e: unknown): void {
    if (this.finished) return;
    this.error = e;
    this.finished = true;
    while (this.waiters.length) this.waiters.shift()!.reject(e);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.error) return Promise.reject(this.error);
        if (this.finished) return Promise.resolve({ value: undefined as any, done: true });
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}

// ---------------------------------------------------------------- provider

export class DshSessionProvider implements AgentRunner {
  constructor(private api: ApiProxyLike, private opts: DshSessionProviderOptions = {}) {
    this.opts.turnTimeoutMs ??= 300_000;
  }

  async *run(req: AgentRunRequest): AsyncIterable<AgentRunChunk> {
    const started = Date.now();
    const rpcId = () => `wf-${randomUUID()}`;

    // 1. 获取或创建 DSH Session（§4：节点持久绑定 Conversation，首次创建，后续复用）
    const cwd = normalizeWorkspaceCwd(req.workspaceDir);
    let sessionId = req.sessionId;
    let isNewSession = false;
    if (!sessionId) {
      // 首次执行：创建新 session
      const created = unwrap<{ sessionId?: string }>(
        await this.api.sessions.create({
          rpcId: rpcId(),
          payload: cwd ? { cwd } : {},
        }),
      );
      sessionId = created.sessionId;
      if (!sessionId) throw new Error('sessions.create 未返回 sessionId');
      isNewSession = true;
    } else {
      // 复用已有 session：尝试 prompt，如果 session 已被删除则回退创建新 session
      // （§5：用户可能直接在 DSH 中删除 Conversation）
      try {
        const testResp = await this.api.sessions.prompt({
          rpcId: rpcId(),
          payload: { sessionId, mode: 'queue', content: [{ type: 'text', text: '' }] },
        });
        // prompt 成功 → session 存在，直接复用
        // 但空 prompt 可能被拒绝，所以需要检查返回值
        const accepted = unwrap<{ accepted?: boolean }>(testResp);
        if (!accepted.accepted) throw new Error('session not available');
      } catch {
        // session 不存在或被删除：创建新 session
        const created = unwrap<{ sessionId?: string }>(
          await this.api.sessions.create({
            rpcId: rpcId(),
            payload: cwd ? { cwd } : {},
          }),
        );
        sessionId = created.sessionId;
        if (!sessionId) throw new Error('sessions.create 未返回 sessionId');
        isNewSession = true;
      }
    }

    // 2. 先订阅 mux（避免 prompt 后事件早于订阅丢失），帧推入队列
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), this.opts.turnTimeoutMs!);
    const queue = new AsyncQueue<SessionEvent>();
    let pumpError: unknown = null;

    const pump = (async () => {
      try {
        for await (const frame of this.api.events.mux({ rpcId: rpcId(), payload: {} }, ac.signal)) {
          const p = frame.payload;
          if (p?.type === 'session/event' && p.sessionId === sessionId && p.event) {
            try { this.opts.onFrame?.(p); } catch { /* 诊断不影响主流程 */ }
            queue.push(p.event);
            if (p.event.type === 'turn/end') break;
          }
        }
      } catch (e) {
        pumpError = e;
        queue.setError(e);
        return;
      } finally {
        queue.end();
      }
    })();

    try {
      // 3. 发 prompt
      const text = `${req.prompt.system}\n\n${req.prompt.user}`;
      const accepted = unwrap<{ accepted?: boolean }>(
        await this.api.sessions.prompt({
          rpcId: rpcId(),
          payload: { sessionId, mode: 'queue', content: [{ type: 'text', text }] },
        }),
      );
      if (!accepted.accepted) throw new Error('sessions.prompt 未被接受');

      // 4. 实时消费：delta 即时转发，message 留存为最终输出，turn/end 结束
      let lastMessage: SessionEvent | null = null;
      for await (const ev of queue) {
        if (ev.type === 'assistant/chunk') {
          const d = extractDelta(ev);
          if (d.text) yield { kind: 'delta', text: d.text, deltaKind: d.kind };
        } else if (ev.type === 'assistant/message') {
          lastMessage = ev;
        } else if (ev.type === 'turn/end') {
          break;
        }
      }

      const content = lastMessage ? extractMessageText(lastMessage) : '';
      if (!content) {
        if (pumpError && !(pumpError instanceof DOMException && pumpError.name === 'AbortError')) {
          throw pumpError instanceof Error ? pumpError : new Error(String(pumpError));
        }
        throw new Error(`session ${sessionId} 未产出 assistant 消息（turn 超时或空回复）`);
      }

      yield {
        kind: 'done',
        sessionId,
        record: {
          content,
          durationMs: Date.now() - started,
          tokenUsage: lastMessage ? extractUsage(lastMessage) : undefined,
          finishedAt: new Date().toISOString(),
        },
      };
    } finally {
      clearTimeout(timeout);
      ac.abort();
      // 非阻塞清理：stop 必须即时响应（宿主对 abort 的响应可能滞后数秒），
      // pump 收尾与会话释放在后台完成；abort 信号已传达终止意图，重复产出无人消费、无副作用。
      void pump.catch(() => {});
      void Promise.resolve(this.api.sessions.cancel({ rpcId: rpcId(), payload: { sessionId } })).catch(() => {});
    }
  }
}
