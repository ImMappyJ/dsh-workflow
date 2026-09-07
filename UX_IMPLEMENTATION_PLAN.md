# dsh-workflow UX 优化实施计划（UX_IMPLEMENTATION_PLAN）

> 实施原则：不重写前端，不新增核心功能，在现有 JS/SVG 结构上重组织交互，复用现有 handler 与样式。每阶段完成后验证并回归。
>
> 关联文档：UX_AUDIT.md

---

## Phase 1：现状审计（文档产出）

- **产出**：UX_AUDIT.md（已生成）、UX_IMPLEMENTATION_PLAN.md（本文档）。
- **验证**：文档覆盖 17 项审计维度 + 分阶段实施拆解。

---

## Phase 2：三视图导航骨架

### 目标
将 `btn-mode-toggle` 二元切换升级为三视图导航（Workbench / Editor / Execution）。

### 页面（index.html）
- 新增 `#workbench-view` 容器，与 `#editor-view`、`#exec-view` 平级，位于 `#main` 内。
- 全局导航：在 Toolbar 顶部增加三视图 tab（或复用 mode-toggle 扩展为三态）。

### 组件
- `#workbench-view`：Workbench 列表容器（初始复用 Workbench modal 的数据渲染）。
- `#editor-view` / `#exec-view`：保持现状。

### 交互
- 点击导航 tab 切换视图（三选一显示），记录当前视图状态。
- 状态存入 localStorage（复用 `wf_mode` 扩展为 `wf_view`）。

### 状态
- 视图切换不破坏编辑/执行状态；切回 Editor 保留画布内容，切回 Execution 保留执行现场。

### API
- 无新增 API；Workbench 复用现有 `/api/workflows` 与 `/api/executions`。

### 数据模型
- 无变更。

### 验证
- Workbench→Editor→Execution 三视图可来回切换，编辑/执行状态保留。

---

## Phase 3：Workbench 独立视图

### 目标
把"我的工作流"从 modal 升级为独立视图，作为默认落地页，持续管理所有 Workflow。

### 页面（index.html）
- `#workbench-view` 内渲染：卡片列表 + 搜索框 + 排序 select + 状态过滤 chips + 新建按钮。
- 复用现有 `.wf-card` 样式与 Workbench 结构（exec-history-dialog 内部结构迁入）。

### 组件
- 卡片：Workflow 名 / 描述 / 版本 / 最近运行 / 状态 pill。
- 卡片操作：Open / Run / Duplicate / View History / Rename / Delete。

### 交互
- 打开页面默认进入 Workbench。
- 卡片"Open"→ 切到 Editor 并加载该 Workflow。
- 卡片"Run"→ 打开 run-dialog。
- 搜索/排序/过滤实时刷新列表。
- 保留 `exec-history-dialog` 作为执行历史详情弹窗（若仍有需要）。

### 状态
- `wf_view='workbench'` 默认；localStorage 记录最近视图。

### API
- 复用现有 `/api/workflows`（列表/加载/删除/重命名/复制）与 `/api/executions`（历史）。

### 数据模型
- 无变更。

### 验证
- 刷新页面默认进入 Workbench；Workflow 持久化可见；Open/Run/Duplicate/Rename/Delete 全部可用。

---

## Phase 4：Workflow Editor Toolbar 精简

### 目标
按 §16 原则精简 Toolbar，只留导航 + 名称 + 保存 + 运行 + ⋯。

### 页面（index.html）
- Toolbar 编辑模式精简为：导航 tab + wf-name + 保存 + 运行 + ⋯（More）。
- ⋯ 菜单收纳：示例模板、模板库、预设库、存为模板、导入、导出、删除、主题。

### 组件
- `#btn-more` + `#more-menu`：填充次要操作。

### 交互
- ⋯ 菜单项点击执行对应原有 handler（`$('btn-tpl-lib').onclick` 等保持不变，仅移动入口）。

### 状态
- 编辑模式隐藏编辑专用按钮的逻辑（`showEditorToolbar`）改为控制 ⋯ 菜单项显隐。

### API / 数据模型
- 无变更。

### 验证
- 编辑模式工具栏按钮数从 15+ 降到 ~6；全部功能仍可从 ⋯ 菜单访问。

---

## Phase 5：Execution 状态驱动操作 + Rework 入口

### 目标
状态驱动操作按钮严格按状态显隐；节点完成后提供显眼 Rework 入口。

### 页面（index.html）
- `#exec-bar` 保持暂停/继续/单步/停止（已有 updateControlButtons 状态驱动，验证并加强）。
- 节点详情/输出侧边栏增加 Rework 按钮（已完成节点）。

### 组件
- 侧边栏"节点详情"tab：completed 节点下方加 `[Rework From Here]` 按钮。
- "输出"tab：completed 节点输出区加 `[Rework]` 按钮。

### 交互
- 点击 Rework → 复用 `openReworkDialog(workflowId, executionId)` 打开 rework-dialog。
- 确认状态驱动的按钮显隐：running→暂停/停止；paused→继续/单步/停止；terminal→无控制按钮。

### 状态
- 基于 `EX.state.nodeStates[nodeId].status` 判断是否显示 Rework（completed/failed/success）。

### API
- 复用现有 rework API `/api/workflows/{id}/rework`。

### 数据模型
- 无变更。

### 验证
- 节点完成后侧边栏出现 Rework；点击可基于父 Run 创建新 Run。

---

## Phase 6：Review 主动通知 + Artifact 优先

### 目标
waiting_review 时主动提示；Artifact 优先于文本展示。

### 页面（index.html）
- `#exec-bar` 增加 Review 主动通知条（waiting_review 时显示"待审核" + Accept/Reject 操作，或跳转审核 tab）。

### 组件
- 侧边栏"输出"tab：优先展示 Artifact 文件列表（Preview/Edit/Diff/Download），文本折叠其次。

### 交互
- 有 waiting_review 节点时，exec-bar 或节点卡片醒目提示，点击跳转"审核" tab。
- Artifact 列表优先渲染，输出文本位于下方。

### 状态
- 轮询 `EX.state.reviewTasks` / `nodeStates` 检测 waiting_review。

### API / 数据模型
- 无变更。

### 验证
- 人工审核触发时出现主动提示；Artifact 优先展示。

---

## Phase 7：视觉统一 + 完整 UX 验收测试

### 目标
统一 Modal、Context Menu、卡片风格；执行提示词 Test 1-10 验收。

### 页面（index.html）
- 统一各对话框头部、按钮、间距（复用 CSS 变量）。

### 组件
- 统一 `.box`、`.modal-overlay`、`.wf-card`、ctx-menu 样式。

### 交互
- 无新增交互，聚焦一致性。

### 状态 / API / 数据模型
- 无变更。

### 验证（提示词 Test 1-10）
1. 创建 Workflow → 刷新 → 仍存在。
2. Workflow 执行 → 刷新 → Workflow 与 Execution 仍存在。
3. 执行完成 → 选择 Reviewer → Rework → 输入要求 → 从 Reviewer 继续运行。
4. Execution → 修改 Artifact → Continue。
5. Reviewer→improve→Analyst→Architect→Reviewer→finish→End（Loop 拓扑）。
6. 创建 Edge → 自动出现 Control Point → 拖动 → 保存 → 刷新 → 保留。
7. 创建 Loop → Arrow 不被 Node 遮挡。
8. Waiting for Review → UI 明确提示 → Accept/Reject/Edit。
9. Completed → 页面仍提供 Rework。
10. Workflow 已执行 → 修改 → 保存 → 新 Execution 用新 Version → 历史 Execution 不受影响。

---

*文档结束。按 Phase 顺序实施，每阶段运行项目验证并回归后再进入下一阶段。*
