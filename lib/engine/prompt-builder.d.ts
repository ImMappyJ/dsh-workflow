/**
 * PromptBuilder —— 固定分段模板（详细设计 §4），UI 的 Prompt Viewer 可按分段标记还原。
 */
import type { AgentNode } from '../domain/types.js';
import type { InputContext } from './context-manager.js';
export interface CompiledPrompt {
    system: string;
    user: string;
}
export declare function buildPrompt(node: AgentNode, ctx: InputContext): CompiledPrompt;
