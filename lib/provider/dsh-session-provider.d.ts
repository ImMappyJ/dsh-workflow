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
import type { AgentRunner, AgentRunRequest, AgentRunChunk } from '../engine/runner.js';
/**
 * 归一化工作目录为宿主可接受的 cwd：
 *  - 仅绝对路径可用（宿主 sessions.create 校验 cwd 必须绝对，相对路径会直接报错）；
 *  - 统一为正斜杠（Node/宿主均接受，避免反斜杠转义问题）。
 * 不合法时返回 undefined，调用方回退为不传 cwd（宿主用默认目录）。
 */
export declare function normalizeWorkspaceCwd(workspaceDir: string | undefined): string | undefined;
/** 宿主 apiProxy 的最小结构类型（宽松以适配版本差异） */
export interface ApiProxyLike {
    sessions: {
        create(req: {
            rpcId: string;
            payload: Record<string, unknown>;
        }, signal?: AbortSignal): Promise<{
            result?: {
                ok?: boolean;
                value?: {
                    sessionId?: string;
                };
                error?: {
                    message?: string;
                };
            };
        } | {
            sessionId?: string;
        }>;
        prompt(req: {
            rpcId: string;
            payload: {
                sessionId: string;
                mode: 'queue';
                content: Array<{
                    type: 'text';
                    text: string;
                }>;
            };
        }, signal?: AbortSignal): Promise<{
            result?: {
                ok?: boolean;
                value?: {
                    accepted?: boolean;
                };
                error?: {
                    message?: string;
                };
            };
        }>;
        cancel(req: {
            rpcId: string;
            payload: {
                sessionId: string;
            };
        }, signal?: AbortSignal): Promise<unknown>;
    };
    events: {
        mux(req: {
            rpcId: string;
            payload: Record<string, unknown>;
        }, signal?: AbortSignal): AsyncIterable<{
            rpcId: string;
            payload: MuxFrame;
        }>;
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
/** 从 assistant/message 事件提取完整文本 */
export declare function extractMessageText(event: SessionEvent): string;
/** 从 assistant/chunk 事件提取流式 delta。真实帧（实测）：
 *   chunk.type === 'text-delta'      → 正文增量（{text}）
 *   chunk.type === 'reasoning-delta' → 思考增量（{text}）
 * 兼容文档形态：chunk.type === 'delta' + blocks/text/delta.text。
 * 返回 {text, kind}：kind 为 'text' | 'reasoning'；无内容时 text 为空串。 */
export declare function extractDelta(event: SessionEvent): {
    text: string;
    kind: 'text' | 'reasoning';
};
/** 旧名兼容：只取文本内容 */
export declare function extractDeltaText(event: SessionEvent): string;
/** 从 assistant/message 提取 usage → NodeOutputRecord.tokenUsage */
export declare function extractUsage(event: SessionEvent): {
    prompt: number;
    completion: number;
} | undefined;
export declare class DshSessionProvider implements AgentRunner {
    private api;
    private opts;
    constructor(api: ApiProxyLike, opts?: DshSessionProviderOptions);
    run(req: AgentRunRequest): AsyncIterable<AgentRunChunk>;
}
