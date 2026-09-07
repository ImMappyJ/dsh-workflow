/**
 * Tarjan 强连通分量（SCC）——迭代实现，防深图栈溢出。
 * 用于环检测：|SCC|>1 或自环 → 存在循环。
 */
export type AdjacencyList = Map<string, string[]>;
export declare function buildAdjacency(edges: Array<{
    source: string;
    target: string;
}>): AdjacencyList;
/**
 * 返回 SCC 列表。每个 SCC 是节点 id 数组（保持图内出现顺序，便于稳定输出/快照测试）。
 */
export declare function tarjanScc(nodeIds: string[], adj: AdjacencyList): string[][];
/**
 * 从 SCC 列表中筛出"循环节点集合"：
 * - |SCC| > 1（多节点环），或
 * - 单节点自环（adj 中存在 node→node）
 */
export declare function detectLoops(nodeIds: string[], adj: AdjacencyList): string[][];
