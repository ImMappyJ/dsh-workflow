/**
 * EventBus —— 发布订阅，UI/日志/存储均作为订阅者（详细设计 §3）。
 */
import type { ExecutionEvent, WorkflowEventType } from '../domain/types.js';
type Handler = (e: ExecutionEvent) => void;
export declare class EventBus {
    private handlers;
    on(type: WorkflowEventType | '*', h: Handler): () => void;
    emit(e: ExecutionEvent): void;
}
export {};
