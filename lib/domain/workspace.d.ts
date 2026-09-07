/**
 * Working Directory 安全边界校验（§36 / Phase 8）。
 *
 * Agent 默认只能访问 Working Directory 及其允许的子目录；
 * 本模块在保存/运行前校验目录合法性，拒绝危险的根目录与系统目录。
 */
export interface WorkspaceIssue {
    code: string;
    message: string;
}
export interface WorkspaceValidation {
    errors: WorkspaceIssue[];
    warnings: WorkspaceIssue[];
}
export declare function validateWorkspaceDir(dir: string | undefined | null): WorkspaceValidation;
