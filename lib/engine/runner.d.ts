/**
 * AgentRunner 接口 + MockAgentRunner（Phase 2 关键测试资产，详细设计 §12）。
 * 真实实现 DshSessionProvider 在 Phase 3 接入宿主 apiProxy。
 */
import type { AgentNode, NodeOutputRecord } from '../domain/types.js';
import type { CompiledPrompt } from './prompt-builder.js';
import type { InputContext } from './context-manager.js';
export interface AgentRunRequest {
    node: AgentNode;
    inputContext: InputContext;
    prompt: CompiledPrompt;
    /** 本节点第几次运行（1-based），供 mock 脚本与迭代语义使用 */
    runIndex: number;
    signal?: AbortSignal;
    /** 工作流配置的工作目录（settings.workspaceDir，用户选择）；宿主会话以此作为 cwd */
    workspaceDir?: string;
    /** 节点持久化绑定的 DSH Conversation ID（复用已有对话上下文） */
    sessionId?: string;
}
export type AgentRunChunk = {
    kind: 'delta';
    text: string;
    deltaKind?: 'text' | 'reasoning';
} | {
    kind: 'done';
    record: Omit<NodeOutputRecord, 'runIndex'>;
    sessionId?: string;
};
export interface AgentRunner {
    run(req: AgentRunRequest): AsyncIterable<AgentRunChunk>;
}
export type MockScript = {
    type: 'static';
    text: string;
} | {
    type: 'dynamic';
    fn: (req: AgentRunRequest) => string;
} | {
    type: 'error';
    message: string;
} | {
    type: 'json';
    value: unknown;
};
export interface MockOptions {
    delayMs?: number;
    /** 第 n 次运行（1-based）使用第 n-1 个脚本，越界用最后一个 */
    scriptsPerNode?: Record<string, MockScript[]>;
    defaultScript?: MockScript;
}
export declare class MockAgentRunner implements AgentRunner {
    private opts;
    private callCounts;
    /** 每次调用的记录（供测试断言：哪些节点真正触发了 LLM，§67） */
    readonly callRecords: Array<{
        node: AgentNode;
        runIndex: number;
        prompt: CompiledPrompt;
    }>;
    constructor(opts?: MockOptions);
    run(req: AgentRunRequest): AsyncIterable<AgentRunChunk>;
}
