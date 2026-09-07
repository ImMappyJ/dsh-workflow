/**
 * dsh-plugin-workflow —— Cordis 宿主插件入口。
 *
 * 职责（Phase 3：API 层 + 静态页占位；编辑器 UI 在 Phase 4/5 落地 public/）：
 *  - 进程内组装：WorkflowEngine + DshSessionProvider(ctx.apiProxy)
 *  - 独立端口 HTTP 服务（默认 3090）：
 *      GET    /api/health                     探活（apiProxy 接入状态）
 *      GET    /api/workflows                  列出
 *      POST   /api/workflows                  创建/保存（校验，环图自动补 LoopConfig）
 *      GET    /api/workflows/:id              读取
 *      DELETE /api/workflows/:id              删除
 *      POST   /api/workflows/:id/run          运行（body: {input})
 *      GET    /api/executions/:id             运行状态
 *      POST   /api/executions/:id/control     控制（body: {cmd: pause|resume|stop|step}）
 *      POST   /api/executions/:id/review      人工审核决策（body: {taskId, action, comment?, content?}）
 *      GET    /api/events?executionId=...     SSE 事件流（25s 心跳）
 *      GET    /api/models                     可用模型列表（透传宿主）
 *  - Phase 9 Preset/Template：
 *      GET    /api/templates                  列表（内置 + 用户）
 *      POST   /api/templates                  把当前工作流存为用户模板（body: {def, name, description}）
 *      DELETE /api/templates/:id              删除用户模板（内置不可删）
 *      POST   /api/templates/:id/instantiate  从模板创建工作流（body: {id, name?}）
 *  - 静态资源：public/（磁盘直读，支持热重载）
 */
import { type ApiProxyLike } from './provider/dsh-session-provider.js';
export declare const name = "dsh-plugin-workflow";
export declare const inject: string[];
export interface WorkflowServer {
    port: number;
    close(): Promise<void>;
    /**
     * 宿主入口落地页（任务 3 / Phase 9，SSR HTML）：工作流清单 + 深链跳转独立端口编辑器。
     * 由 apply() 经 ctx.webServer.register({kind:'exact', path:'/workflow'}) 挂载；
     * 只用宿主 Plugin API，不侵入 DSH 核心（§55.7）。也可单独调用用于测试。
     */
    renderLanding(): Promise<string>;
}
/** 可独立测试的服务器组装（不依赖 cordis ctx） */
export declare function createWorkflowServer(opts: {
    apiProxy?: ApiProxyLike;
    port: number;
    host: string;
    mock?: boolean;
    dataDir: string;
}): WorkflowServer;
export declare function apply(ctx: any, rawConfig?: any): void;
export default apply;
