/**
 * 行级 diff（任务 5：版本对比；Phase 8 Code Diff 复用）。
 * 经典 LCS 行对比，零依赖；对长文本有规模上限保护（超限降级为整段替换标注）。
 */

export type DiffOpType = 'same' | 'del' | 'add';

export interface DiffOp {
  type: DiffOpType;
  /** same/del 为旧侧行号（1-based），add 为新侧行号；连续同类型行共享起始行号由消费方聚合 */
  oldLine?: number;
  newLine?: number;
  text: string;
}

export interface DiffResult {
  ops: DiffOp[];
  /** 变更统计（渲染徽章用） */
  added: number;
  removed: number;
  /** 是否因规模超限而降级为整段替换 */
  degraded: boolean;
}

const MAX_LINES = 2000;   // LCS O(n*m)，超过则降级

export function lineDiff(oldText: string, newText: string): DiffResult {
  if (oldText === newText) return { ops: [], added: 0, removed: 0, degraded: false };

  const a = oldText.split('\n');
  const b = newText.split('\n');

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    // 降级：视为整段替换，保留摘要统计
    return {
      ops: [
        ...a.map((t, i) => ({ type: 'del' as const, oldLine: i + 1, text: t })),
        ...b.map((t, i) => ({ type: 'add' as const, newLine: i + 1, text: t })),
      ],
      added: b.length,
      removed: a.length,
      degraded: true,
    };
  }

  // LCS 长度表
  const n = a.length, m = b.length;
  const dp: Int32Array = new Int32Array((n + 1) * (m + 1));
  const idx = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[idx(i, j)] = a[i] === b[j]
        ? dp[idx(i + 1, j + 1)] + 1
        : Math.max(dp[idx(i + 1, j)], dp[idx(i, j + 1)]);
    }
  }

  // 回溯生成 ops
  const ops: DiffOp[] = [];
  let added = 0, removed = 0;
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', oldLine: i + 1, newLine: j + 1, text: a[i] });
      i++; j++;
    } else if (dp[idx(i + 1, j)] >= dp[idx(i, j + 1)]) {
      ops.push({ type: 'del', oldLine: i + 1, text: a[i] });
      removed++; i++;
    } else {
      ops.push({ type: 'add', newLine: j + 1, text: b[j] });
      added++; j++;
    }
  }
  while (i < n) { ops.push({ type: 'del', oldLine: i + 1, text: a[i] }); removed++; i++; }
  while (j < m) { ops.push({ type: 'add', newLine: j + 1, text: b[j] }); added++; j++; }

  return { ops, added, removed, degraded: false };
}

/** 生成 unified-diff 风格文本摘要（审计/日志用） */
export function renderUnifiedDiff(result: DiffResult, maxLines = 40): string {
  if (!result.ops.length) return '(无差异)';
  const lines: string[] = [];
  for (const op of result.ops.slice(0, maxLines)) {
    const prefix = op.type === 'same' ? ' ' : op.type === 'del' ? '-' : '+';
    const ln = op.type === 'del' ? op.oldLine : op.type === 'add' ? op.newLine : op.oldLine;
    lines.push(`${prefix}${String(ln).padStart(4)} | ${op.text}`);
  }
  if (result.ops.length > maxLines) lines.push(`…（共 ${result.ops.length} 行，已截断）`);
  if (result.degraded) lines.unshift('!! 文本过大，已降级为整段替换展示');
  return lines.join('\n');
}
