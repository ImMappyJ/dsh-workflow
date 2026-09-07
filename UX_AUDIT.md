# dsh-workflow 用户交互审计（UX_AUDIT）

> 审计目标：不重新设计产品，而是理解现有功能与真实操作路径，找出认知负担、重复入口、操作位置不合理、状态反馈不足、Workflow/Execution 混淆等问题，在不破坏现有功能与核心架构的前提下重新组织交互。
>
> 审计日期：2026-09-04

---

## 1. 当前页面结构

纯 JS + SVG 单页应用，无路由框架。全部功能集中在：

| 文件 | 行数 | 职责 |
|------|-----|------|
| `index.html` | 600 | 页面骨架、全部 CSS、所有视图容器、全部对话框 |
| `editor.js` | 2122 | Workflow 编辑视图逻辑（画布/节点/边/属性/工作台/模板） |
| `execution.js` | 1178 | Execution 执行视图逻辑（Timeline/画布/侧边栏/流式） |
| `graph-ops.js` | 155 | 图操作（撤销历史/复制/禁用/布局） |
| `layout.js` | 139 | 执行画布自动布局 |

视图通过 `#editor-view` / `#exec-view` 两个容器 + `btn-mode-toggle` 按钮在"编辑 / 执行"间切换。其余功能以 modal 对话框叠加。

### 视图容器

```
#app
├─ #toolbar         全局工具栏（编辑模式 15+ 按钮）
├─ #main
│  ├─ #editor-view  编辑视图（默认）
│  │  ├─ #library        左：节点库
│  │  ├─ #canvas-wrap    中：编辑画布
│  │  └─ #inspector      右：属性面板（tabs）
│  └─ #exec-view    执行视图
│     ├─ #exec-bar       顶：执行控制栏
│     └─ #exec-main
│        ├─ #exec-timeline   左：Execution Timeline
│        ├─ #exec-canvas-wrap 中：执行画布 + 图例
│        └─ #exec-side        右：侧边栏（审核/节点详情/输出/审计/事件日志）
```

### 对话框（modal）

| 对话框 | 触发 | 用途 |
|--------|------|------|
| `#tpl-dialog` | 工具栏"模板库" | 工作流模板 |
| `#preset-dialog` | 工具栏"预设库" | 单节点预设 |
| `#import-dialog` | 工具栏"导入…" | 导入 JSON |
| `#exec-history-dialog` | 工具栏"我的工作流" | Workbench（管理工作流） |
| `#wb-del-dialog` | Workbench 内 | 删除执行确认 |
| `#confirm-dialog` | 全站 | 统一确认弹窗 |
| `#rework-dialog` | Workbench/右键 | Rework 面板 |
| `#run-dialog` | 运行按钮 | 启动执行（inputSchema 动态表单） |

---

## 2. 当前功能入口

| 功能 | 入口位置 | 类型 |
|------|---------|------|
| Workflow 创建 | 工具栏"新建"、Workbench 卡片 | 按钮/操作 |
| Workflow 编辑 | 工具栏 wf-id/wf-name + 画布 + Inspector | 主编辑区 |
| Node 创建 | 左节点库拖拽、画布右键 | 拖拽/右键 |
| Node 编辑 | 画布选中 → Inspector | 选择驱动 |
| Node 右键操作 | 画布右键菜单 | 右键菜单 |
| Edge 创建 | 节点端口拖拽、库内"连线" | 拖拽/点击 |
| Edge 控制点 | 画布选中 Edge 拖拽圆点 | 直接操作 |
| Workflow 保存 | 工具栏"保存"(Ctrl+S) | 按钮/快捷键 |
| Workflow 校验 | 工具栏"校验" | 按钮 |
| Workflow 运行 | 工具栏"▶ 运行"(仅执行模式显示) | 按钮 → 对话框 |
| Execution 查看 | mode-toggle 切执行视图 | 视图切换 |
| Review 审核 | 执行视图侧边栏"审核" tab | 侧边栏 |
| Rework | 右键菜单 / Workbench 卡片 | 右键/卡片操作 |
| Artifact | 执行侧边栏"节点详情" | 侧边栏 |
| 模板库 | 工具栏"模板库" | 按钮 → modal |
| 预设库 | 工具栏"预设库" | 按钮 → modal |
| 导入导出 | 工具栏"导入…"/"导出" | 按钮 → modal |
| 删除工作流 | 工具栏"删除工作流…" | 按钮 → 确认 |
| 主题切换 | 工具栏"◐ 主题" | 按钮 |

---

## 3. 当前用户操作流程

### Journey 1：创建 Workflow
```
工具栏「新建」→ 画布出现空 workflow → 从左侧拖节点 → 连线 → 配置 Inspector → 保存
```
问题：无"创建向导"，新建即进入空画布，无 Name/Working Directory 引导。

### Journey 2：编辑 Workflow
```
工具栏输入 wf-id/wf-name → 画布编辑 → 保存
```
问题：wf-id 是手动输入的字符串，用户需知道 id；无"从 Workbench 选择打开"的默认路径。

### Journey 3：运行 Workflow
```
工具栏「▶ 运行」→ run-dialog（主输入 + inputSchema 动态表单）→ 启动
```
问题：运行按钮在编辑/执行两模式显示逻辑已调整，但模式切换本身增加认知负担。

### Journey 4：查看运行过程
```
切到执行模式 → Execution 视图（Timeline + 画布 + 侧边栏）
```
问题：需手动 mode-toggle 切换，执行视图无"关联 Workflow 名"的清晰标注。

### Journey 5：人工审核
```
执行视图侧边栏「审核」tab → Accept/Reject/Edit
```
问题：无主动通知（waiting_review 时系统未在 exec-bar/节点上醒目提示"需要你做决定"）。

### Journey 6：人工修改成果
```
节点详情 → Artifact → Edit
```
问题：Artifact 与文本输出并列，未突出 Artifact 优先。

### Journey 7：Rework / 继续迭代
```
Workbench 卡片 → Rework 或右键菜单 → rework-dialog
```
问题：执行视图中节点完成后无显眼 Rework 入口（只在右键和 Workbench）。

---

## 4. 当前存在的交互问题

### 4.1 Toolbar 过载（最严重）
编辑模式工具栏包含 15+ 按钮：`保存 校验 新建 示例模板 模板库 预设库 存为模板 我的工作流 导入 导出 删除 运行 主题 ⋯`。
- **违反 §16**：Global Action→Top、Canvas→浮动、Node→右键、Config→Inspector、Advanced→More。
- 用户需要扫描大量按钮才能找到目标，认知负担高。

### 4.2 Workbench 是 modal 而非视图
- "我的工作流"通过 `exec-history-dialog` 弹出框遮屏，关闭后回到画布。
- **违反 §13**：Workbench 应成为独立视图，用于持续"管理我的 Workflow"，而非弹窗。

### 4.3 Workflow / Execution 无分层心智模型
- 靠 `btn-mode-toggle` 二元切换，没有 WORKFLOW→EXECUTIONS 的层级。
- 编辑视图顶部显示 wf-id/wf-name，执行视图顶部显示 exec-id，两者并列，用户易混淆"我在看哪个 Workflow 的哪次 Run"。

### 4.4 Rework 入口隐蔽
- Rework 只在：右键菜单"Rework From Here"、Workbench 卡片按钮。
- 执行视图中节点完成后无直接 Rework 操作，**违反 §11**（Rework 应成为明显核心操作）。

### 4.5 Review 主动通知不足
- waiting_review 时侧边栏"审核" tab 有内容，但无 exec-bar/节点上的醒目提示。
- **违反 §8**：系统应主动告诉用户"现在需要你做决定"。

### 4.6 状态驱动操作不彻底
- exec-bar 的 暂停/继续/单步/停止 有 `updateControlButtons` 按状态控制，但节点详情/输出等位置的上下文操作未完全状态驱动。

### 4.7 Command Menu 缺失
- 无 Ctrl+K 快捷命令面板（§28）。—— **列入非目标，避免新增功能。**

---

## 5. 功能之间的重复入口

| 功能 | 重复入口 |
|------|---------|
| Rework | 右键菜单 + Workbench 卡片（执行视图缺） |
| 运行 | 工具栏运行按钮 + Workbench 卡片"Run" |
| 打开 Workflow | 工具栏 wf-id 输入 + Workbench 卡片"Open" |
| 模板 | 工具栏"模板库"+"示例模板"+"存为模板" 三个按钮 |

---

## 6. Toolbar 问题

工具栏承担了过多职责，应精简为：**导航（视图切换）+ 当前 Workflow 标识 + 保存 + 运行 + ⋯（More）**。
- 模板库、预设库、存为模板 → 入 ⋯ 菜单。
- 导入、导出、删除、主题 → 入 ⋯ 菜单。
- 示例模板 → 入 Workbench 或 ⋯ 菜单。
- 校验 → 保存时自动校验，或入 ⋯ 菜单。

---

## 7. Modal 问题

现有 8 个 modal，其中 `exec-history-dialog`（Workbench）最应升级为视图。其余（导入/模板/预设/Rework/运行/确认）属合理的集中输入/确认场景，保留但统一视觉。

---

## 8. Context Menu 问题

Node/Edge/Canvas 三套右键菜单已较完整（编辑/运行/Rework/复制/克隆/禁用/存预设/查看契约/删除）。建议补充：
- Edge 右键：`Edit / Add Control Point / Remove Control Point / Edit Routing / Delete`。
- 保持现有良好结构。

---

## 9. Workflow / Execution 信息架构问题

当前无层级，二元切换。推荐引入"**Workflow → Executions**"心智：
- Workbench 列出 Workflows（卡片 + 版本 + 最近运行）。
- 打开 Workflow → Editor（顶部显示 Workflow 名 + 版本）。
- 运行 → Execution（顶部显示 Run # + 关联 Workflow 名）。
- 历史 Execution 从 Workflow 维度查看，而非全局弹窗。

---

## 10. Human Review 交互问题

- waiting_review 状态：系统应主动在 exec-bar 或节点卡片上提示"需要你做决定"，并明确 Accept/Reject/Edit。
- 侧边栏"审核" tab 保留，但顶部增加主动通知条。

---

## 11. Rework 交互问题

- 执行视图节点完成后，应在节点详情/输出侧边栏提供显眼 **Rework** 按钮（§11）。
- Rework 对话框保留（起点节点选择 + 补充输入），入口从 Workbench/右键扩展到执行视图节点。

---

## 12. Artifact 交互问题

- 输出侧边栏当前"节点详情"tab 展示文本与 artifact。
- 推荐 Artifact 优先（§23）：优先列出文件/artifact（Preview/Edit/Diff/Download），文本其次。

---

## 13. Loop / Routing 交互问题

- Loop 边文字（improve/finish）已通过 routingKey + Edge badge 展示。
- Routing 配置已在 Edge/Node Inspector 中，用户可理解。基本满足 §19-21，无大改。

---

## 14. 推荐的信息架构

三视图导航模型：

```
Workbench（工作台首页）
  └─ 我的 Workflows（卡片列表 + 搜索/排序/状态过滤）
       ├─ Open  → Editor
       ├─ Run   → Execution（新 Run）
       └─ View History / Rename / Delete / Duplicate

Editor（编辑某 Workflow）
  Left组件库 │ Center画布 │ Right Inspector
  顶部：Workflow 名 + 版本 + 保存 + 运行 + ⋯

Execution（运行某 Workflow）
  顶部：Run # + Workflow 名 + 状态驱动操作
  Timeline │ 画布 │ 侧边栏（审核/详情/输出）
```

---

## 15. 推荐的页面结构

1. **三视图容器**：`#workbench-view` / `#editor-view` / `#exec-view`，三选一显示。
2. **全局导航**：Workbench / Editor / Execution 三个 tab（替代 btn-mode-toggle）。
3. **Workbench 视图**：卡片化 workflow 列表（复用 wf-card 样式），搜索/排序/过滤/操作。
4. **Editor 精简**：Toolbar 只留 导航 + 名称 + 保存 + 运行 + ⋯。
5. **Execution 增强**：状态驱动操作 + Review 主动通知 + Rework 显眼入口 + Artifact 优先。

---

## 16. 推荐的用户操作路径

### 创建 Workflow
```
Workbench → 新建 → 输入名称/目录 → Editor
```
### 编辑 Workflow
```
Workbench → 打开某 Workflow → Editor → 拖节点/连线/配置 → 保存
```
### 运行
```
Editor → 运行 → run-dialog → 启动 → Execution
```
### 查看/审核/干预
```
Execution → 主动通知 → 审核/干预 → Rework（节点完成后）
```
### 继续迭代
```
Execution 完成 → 节点 Rework → 输入要求 → 新 Run（关联父 Run）
```

---

## 17. 每个页面保留/移除/移动的操作

### Workbench 视图（新增）
- 保留：卡片列表、搜索、排序、状态过滤、Open/Run/Duplicate/History/Rename/Delete。
- 新增：作为默认落地页。

### Editor 视图
- 保留：节点库、画布、Inspector、右键菜单、缩放栏、快捷键。
- 移除（移入 ⋯ 菜单）：示例模板、模板库、预设库、存为模板、导入、导出、删除、主题。
- 保留工具栏：Workbench/Editor/Execution 导航 + wf-name + 保存 + 运行 + ⋯。

### Execution 视图
- 保留：Timeline、画布、侧边栏（审核/节点详情/输出/审计/事件日志）、exec-bar 控制。
- 增强：状态驱动操作、Review 主动通知、节点完成后的 Rework 入口、Artifact 优先展示。

---

*文档结束。详见 UX_IMPLEMENTATION_PLAN.md 获取分阶段实施计划。*
