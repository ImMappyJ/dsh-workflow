/**
 * JsonRepo —— 通用 JSON 文件仓库（详细设计 §9）。
 * 原子写（tmp + rename）；目录：{base}/{collection}/{id}.json
 * 历史保留上限 FIFO（ExecutionRepository 用）。
 */
export declare class JsonRepo<T extends {
    id: string;
}> {
    private dir;
    private maxKeep;
    constructor(dir: string, maxKeep?: number);
    /** per-id 串行写锁：同一 id 的 save 排队执行，杜绝并发写同一目标文件（Windows rename 目标已存在会抛错） */
    private writeLocks;
    private file;
    init(): Promise<void>;
    save(item: T): Promise<T>;
    get(id: string): Promise<T | null>;
    list(): Promise<T[]>;
    remove(id: string): Promise<boolean>;
    /** FIFO 淘汰超出 maxKeep 的最旧文件（按 mtime） */
    private evict;
}
/** 组合四个仓库（详细设计 §9 的存储布局）。宽松类型：各仓库存不同 schema，统一按 any 读写 */
export interface PluginStorage {
    workflows: JsonRepo<any>;
    executions: JsonRepo<any>;
    presets: JsonRepo<any>;
    templates: JsonRepo<any>;
    /** Phase A：Workflow 版本快照仓库（key: {id}__v{rev}） */
    workflowVersions: JsonRepo<any>;
}
export declare function createStorage(baseDir: string, maxExecutionsKeep?: number): PluginStorage;
