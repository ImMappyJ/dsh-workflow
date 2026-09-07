/**
 * EventBus —— 发布订阅，UI/日志/存储均作为订阅者（详细设计 §3）。
 */

import type { ExecutionEvent, WorkflowEventType } from '../domain/types.js';

type Handler = (e: ExecutionEvent) => void;

export class EventBus {
  private handlers = new Map<WorkflowEventType | '*', Set<Handler>>();

  on(type: WorkflowEventType | '*', h: Handler): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(h);
    return () => this.handlers.get(type)?.delete(h);
  }

  emit(e: ExecutionEvent): void {
    for (const h of this.handlers.get(e.type) ?? []) {
      try { h(e); } catch { /* 订阅者异常不得影响引擎 */ }
    }
    for (const h of this.handlers.get('*') ?? []) {
      try { h(e); } catch { /* ignore */ }
    }
  }
}
