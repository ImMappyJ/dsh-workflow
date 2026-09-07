/**
 * ContextManager —— 防爆炸策略链（详细设计 §7）：
 * 来源过滤 → 只取每个上游最新一轮 → 单源截断 → 总量预算淘汰。
 */
import { DEFAULTS, kindFromFormat, } from '../domain/types.js';
export const DEFAULT_CONTEXT_POLICY = {
    maxInputCharsPerSource: DEFAULTS.maxInputCharsPerSource,
    maxTotalInputChars: DEFAULTS.maxTotalInputChars,
};
export class ContextManager {
    def;
    policy;
    constructor(def, policy = DEFAULT_CONTEXT_POLICY) {
        this.def = def;
        this.policy = policy;
    }
    /** node 的直连上游边（target 是 node 的边） */
    incomingEdges(nodeId) {
        return this.def.edges.filter(e => e.target.nodeId === nodeId);
    }
    buildInputContext(node, state) {
        const contract = node.inputContract;
        const allUpstream = this.incomingEdges(node.id);
        // 1. 来源过滤（结构）
        const selected = contract.sourceMode === 'selected'
            ? allUpstream.filter(e => contract.selectedSourceNodeIds.includes(e.source.nodeId))
            : allUpstream;
        // 1b. 类型过滤（任务 5：acceptedTypes × outputContract.artifactTypes）：
        // 只有当下游声明 acceptedTypes 且上游声明 artifactTypes 且交集为空时才排除；
        // 任一未声明则视为兼容（不过滤），旧定义零迁移。
        const typeFiltered = selected.filter((edge) => {
            if (!contract.acceptedTypes?.length)
                return true;
            const upstream = this.def.nodes.find(n => n.id === edge.source.nodeId);
            if (!upstream)
                return true;
            const produced = upstream.outputContract.artifactTypes?.length
                ? upstream.outputContract.artifactTypes
                : [kindFromFormat(upstream.outputContract.format)]; // 未声明时按 format 推导
            return produced.some(k => contract.acceptedTypes.includes(k));
        });
        // 2. 记录选择：每个上游只取最新一轮 output；
        //    §73：includeReviewFeedback 时追加最近一次人工审核意见（附在来源后）
        const items = [];
        const includeFeedback = contract.includeReviewFeedback === true;
        for (const edge of typeFiltered) {
            const records = state.outputs[edge.source.nodeId] ?? [];
            const latest = records.at(-1);
            if (!latest)
                continue; // 上游尚无输出（被 skip 等）
            // §73：将最近一次人工审核意见一并传入（下游可据此参考）
            let content = latest.content;
            if (includeFeedback) {
                const approvedArtifact = state.artifacts[edge.source.nodeId]?.at(-1);
                const comment = approvedArtifact?.reviewComment;
                if (comment)
                    content += `\n[人工审核意见] ${comment}`;
            }
            const patchedLatest = { ...latest, content };
            // 截断（在审核意见拼接后）
            const max = this.policy.maxInputCharsPerSource;
            const truncated = patchedLatest.content.length > max;
            content = truncated ? patchedLatest.content.slice(0, max) + '\n...[已截断]' : patchedLatest.content;
            // 优先级：契约 selected > 契约 targets > 其他
            const priority = contract.sourceMode === 'selected' && contract.selectedSourceNodeIds.includes(edge.source.nodeId)
                ? 0
                : node.outputContract.targets.includes(edge.source.nodeId) ? 1 : 2;
            items.push({
                sourceNodeId: edge.source.nodeId,
                sourceName: this.def.nodes.find(n => n.id === edge.source.nodeId)?.name ?? edge.source.nodeId,
                runIndex: latest.runIndex,
                content,
                truncated,
                edge,
                priority,
            });
        }
        // 3. 总量预算：超额按优先级淘汰（同优先级淘汰内容更长的）
        const total = () => items.reduce((s, i) => s + i.content.length, 0);
        while (total() > this.policy.maxTotalInputChars && items.length > 1) {
            items.sort((a, b) => (b.priority - a.priority) || (b.content.length - a.content.length));
            items.pop();
        }
        // 恢复图内出现顺序，保证 Prompt 稳定（可快照测试）
        const order = new Map(this.def.edges.map((e, i) => [e.id, i]));
        items.sort((a, b) => (order.get(a.edge.id) ?? 0) - (order.get(b.edge.id) ?? 0));
        return {
            inputs: items.map(({ edge, priority: _p, ...rest }) => {
                // transform.instruction 附加到来源条目（MVP：注入 Prompt，不额外调用）
                const instr = edge.transform.enabled && edge.transform.instruction
                    ? `\n[传送指令] ${edge.transform.instruction}` : '';
                return { ...rest, content: rest.content + instr };
            }),
        };
    }
}
