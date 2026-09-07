/**
 * AgentRunner 接口 + MockAgentRunner（Phase 2 关键测试资产，详细设计 §12）。
 * 真实实现 DshSessionProvider 在 Phase 3 接入宿主 apiProxy。
 */
export class MockAgentRunner {
    opts;
    callCounts = new Map();
    /** 每次调用的记录（供测试断言：哪些节点真正触发了 LLM，§67） */
    callRecords = [];
    constructor(opts = {}) {
        this.opts = opts;
    }
    async *run(req) {
        const call = (this.callCounts.get(req.node.id) ?? 0) + 1;
        this.callCounts.set(req.node.id, call);
        this.callRecords.push({ node: req.node, runIndex: req.runIndex, prompt: req.prompt });
        const scripts = this.opts.scriptsPerNode?.[req.node.id] ?? [];
        const script = scripts[Math.min(call - 1, scripts.length - 1)]
            ?? this.opts.defaultScript
            ?? { type: 'static', text: `mock output of ${req.node.id} #${req.runIndex}` };
        if (this.opts.delayMs) {
            await new Promise(r => setTimeout(r, this.opts.delayMs));
            if (req.signal?.aborted)
                throw new DOMException('aborted', 'AbortError');
        }
        if (script.type === 'error')
            throw new Error(script.message);
        const content = script.type === 'static' ? script.text
            : script.type === 'dynamic' ? script.fn(req)
                : JSON.stringify(script.value);
        // 模拟流式：分 3 片
        const third = Math.ceil(content.length / 3) || 1;
        for (let i = 0; i < content.length; i += third) {
            if (req.signal?.aborted)
                throw new DOMException('aborted', 'AbortError');
            yield { kind: 'delta', text: content.slice(i, i + third) };
        }
        yield {
            kind: 'done',
            sessionId: req.sessionId,
            record: {
                content,
                parsedJson: script.type === 'json' ? script.value : undefined,
                durationMs: 0,
                tokenUsage: { prompt: 100, completion: 50 },
                finishedAt: new Date().toISOString(),
            },
        };
    }
}
