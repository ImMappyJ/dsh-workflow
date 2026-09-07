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
export declare function lineDiff(oldText: string, newText: string): DiffResult;
/** 生成 unified-diff 风格文本摘要（审计/日志用） */
export declare function renderUnifiedDiff(result: DiffResult, maxLines?: number): string;
