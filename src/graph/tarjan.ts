/**
 * Tarjan 强连通分量（SCC）——迭代实现，防深图栈溢出。
 * 用于环检测：|SCC|>1 或自环 → 存在循环。
 */

export type AdjacencyList = Map<string, string[]>;

export function buildAdjacency(edges: Array<{ source: string; target: string }>): AdjacencyList {
  const adj: AdjacencyList = new Map();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }
  return adj;
}

/**
 * 返回 SCC 列表。每个 SCC 是节点 id 数组（保持图内出现顺序，便于稳定输出/快照测试）。
 */
export function tarjanScc(nodeIds: string[], adj: AdjacencyList): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  for (const start of nodeIds) {
    if (indices.has(start)) continue;
    // 迭代 DFS：帧 = [node, childIndex]
    const frames: Array<{ node: string; ci: number }> = [{ node: start, ci: 0 }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame.ci === 0) {
        indices.set(frame.node, index);
        lowlink.set(frame.node, index);
        index++;
        stack.push(frame.node);
        onStack.add(frame.node);
      }
      const neighbors = adj.get(frame.node) ?? [];
      if (frame.ci < neighbors.length) {
        const w = neighbors[frame.ci++];
        if (!indices.has(w)) {
          frames.push({ node: w, ci: 0 });
        } else if (onStack.has(w)) {
          lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, indices.get(w)!));
        }
      } else {
        // 回溯
        frames.pop();
        if (lowlink.get(frame.node) === indices.get(frame.node)) {
          const scc: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            scc.push(w);
          } while (w !== frame.node);
          sccs.push(scc);
        }
        const parent = frames[frames.length - 1];
        if (parent) {
          lowlink.set(parent.node, Math.min(lowlink.get(parent.node)!, lowlink.get(frame.node)!));
        }
      }
    }
  }
  return sccs;
}

/**
 * 从 SCC 列表中筛出"循环节点集合"：
 * - |SCC| > 1（多节点环），或
 * - 单节点自环（adj 中存在 node→node）
 */
export function detectLoops(nodeIds: string[], adj: AdjacencyList): string[][] {
  return tarjanScc(nodeIds, adj).filter(scc =>
    scc.length > 1 || (adj.get(scc[0]) ?? []).includes(scc[0]),
  );
}
