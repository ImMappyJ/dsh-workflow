/**
 * ArtifactManager（§64-65 + 第二阶段任务 5）—— Artifact 主数据管理。
 *
 * 核心原则：
 * 1. 人工修改不覆盖原始输出，形成 Original → Edited → Final 的版本链；
 *    下游拿到的永远是"最新已批准版本"（§72）。
 * 2. Artifact 反转为主数据：Agent 输出 = Artifact[]；文本类 Artifact 的
 *    content 是其 inline 形态（§55.4：Artifact 不设计成 string）。
 * 3. 大内容只存 Reference（§55.2）：超过 INLINE_LIMIT 的文本或显式文件
 *    落盘到 {dataDir}/artifacts/{executionId}/{artifactId}/，JSON 里只留
 *    storageRef + 摘要。
 *
 * 兼容：第一阶段自由函数（recordAgentArtifact/humanEditArtifact/
 * approvedArtifactOf/artifactVersions）保留签名，引擎与 review-manager
 * 无需改动即可继续工作。
 */
import type { Artifact, ArtifactKind, ExecutionState, NodeId } from '../domain/types.js';
import { kindFromFormat } from '../domain/types.js';
import { type DiffResult } from './diff.js';
/** 超过该字节数的文本内容落盘为引用存储（~64KB） */
export declare const INLINE_LIMIT: number;
/** code Artifact 按文件的 diff 结果（任务 5 / 验收场景 B） */
export interface FileDiffEntry {
    path: string;
    status: 'added' | 'removed' | 'modified' | 'unchanged';
    added: number;
    removed: number;
    /** modified 时的行级结果（added/removed 不带） */
    result?: DiffResult;
}
export interface ArtifactManagerOptions {
    /** 落盘根目录，缺省 ~/.dsh/workflow-plugin */
    dataDir?: string;
    /** inline 上限（字节），缺省 64KB；设为 0 表示全部落盘 */
    inlineLimit?: number;
}
export declare class ArtifactManager {
    private dataDir;
    private limit;
    constructor(opts?: ArtifactManagerOptions);
    private artifactDir;
    private ext;
    /**
     * 创建 Artifact（create）。Agent 产出或人工提交均走这里。
     * 大内容自动落盘转引用存储；调用方随后自行登记进 state 版本链，
     * 或直接用 registerText / registerFile 一步完成。
     */
    create(params: {
        executionId: string;
        nodeId: NodeId;
        kind: ArtifactKind;
        content?: string;
        /** 显式文件：从该路径复制进管理区并登记为引用存储 */
        sourcePath?: string;
        /** 显式目录（Workspace，任务 5）：登记为 directory 类型引用 */
        directory?: boolean;
        createdBy: 'agent' | 'human';
        reviewComment?: string | null;
        version?: number;
        parentVersion?: number | null;
        mimeType?: string;
    }): Promise<Artifact>;
    /** 读取完整内容（read）：inline 直接返回；reference 读磁盘 */
    read(artifact: Artifact): Promise<string>;
    /**
     * 创建 code Artifact（多文件）。单个文件超过阈值自动落盘，
     * files[].content 只留摘要（§55.2）；artifact.content 为文件清单。
     */
    createCode(params: {
        executionId: string;
        nodeId: NodeId;
        files: Array<{
            path: string;
            content: string;
            language?: string;
        }>;
        createdBy: 'agent' | 'human';
        reviewComment?: string | null;
        version?: number;
        parentVersion?: number | null;
    }): Promise<Artifact>;
    /** 读取 code Artifact 中单个文件的完整内容（inline 或磁盘） */
    readCodeFile(artifact: Artifact, filePath: string): Promise<string>;
    /** 更新 code Artifact（人工改文件 → 新版本，不覆盖原始输出） */
    updateCode(params: {
        executionId: string;
        prev: Artifact;
        files: Array<{
            path: string;
            content: string;
            language?: string;
        }>;
        createdBy?: 'agent' | 'human';
        reviewComment?: string | null;
    }): Promise<Artifact>;
    /**
     * code 版本对比（任务 5）：按文件集合 diff——added / removed / modified / unchanged，
     * modified 附行级结果；大文件走磁盘读取。
     */
    diffCode(a: Artifact, b: Artifact): Promise<FileDiffEntry[]>;
    /**
     * 更新（update）：人工编辑产生新版本（不覆盖原始输出，§64）。
     * 返回新 Artifact；调用方负责 push 进版本链并同步下游 outputs。
     */
    update(params: {
        executionId: string;
        prev: Artifact;
        content: string;
        createdBy?: 'agent' | 'human';
        reviewComment?: string | null;
    }): Promise<Artifact>;
    /** 版本对比（diff） */
    diff(a: Artifact, b: Artifact): Promise<DiffResult>;
    /** 版本链（version） */
    versions(state: ExecutionState, nodeId: NodeId): Artifact[];
    /**
     * 恢复到指定版本（restore）：不破坏不可变链——把目标版本内容
     * 作为新的人工版本追加（下游因此拿到被恢复的内容）。
     */
    restore(state: ExecutionState, nodeId: NodeId, targetVersion: number): Promise<Artifact>;
}
/** Agent 产出：登记 v1 Artifact（同步版，仅文本类；兼容引擎调用） */
export declare function recordAgentArtifact(state: ExecutionState, nodeId: NodeId, type: Artifact['type'], content: string): Artifact;
/**
 * 人工修改：追加 v+1 Artifact（createdBy=human），并把最新 output 记录的
 * content 替换为编辑后内容（下游因此拿到 Human Edited Artifact，§72）。
 */
export declare function humanEditArtifact(state: ExecutionState, nodeId: NodeId, content: string, comment?: string | null): Artifact;
/** 当前批准版本（最新版本） */
export declare function approvedArtifactOf(state: ExecutionState, nodeId: NodeId): Artifact | null;
/** 版本链（含 Agent 原始与历次人工修改） */
export declare function artifactVersions(state: ExecutionState, nodeId: NodeId): Artifact[];
export { kindFromFormat };
