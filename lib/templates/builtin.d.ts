/**
 * Phase 9 —— Preset / Template（详细设计 §12）
 *
 * 内置模板：代码维护、不可删除；用户模板走 JsonRepo。
 * instantiate 时替换 workflow id / name / 时间戳，节点 id 保持稳定（边引用无需重写）。
 */
import type { WorkflowDefinition } from '../domain/types.js';
export interface WorkflowTemplate {
    id: string;
    name: string;
    description: string;
    /** builtin 由代码提供，不可删除/覆盖；user 存于 templates 仓库 */
    category: 'builtin' | 'user';
    def: WorkflowDefinition;
    createdAt: string;
    updatedAt: string;
}
export declare const BUILTIN_TEMPLATES: WorkflowTemplate[];
/** 从模板实例化为新工作流：新 id / 新时间戳，节点与边结构原样保留 */
export declare function instantiateTemplate(tpl: WorkflowTemplate, newId: string, newName?: string): WorkflowDefinition;
