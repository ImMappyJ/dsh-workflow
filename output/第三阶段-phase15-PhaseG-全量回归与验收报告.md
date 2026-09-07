# dsh-workflow 第三阶段 Phase G：全量回归 + §35 全项验收 + 禁止事项对照

> 日期：2026-09-01。基线：Phase A-F 全部完成（171/171 测试）。
> 说明：两份设计文档《dsh-workflow 核心架构升级：积木化 Workflow + 可持续迭代 Execution》（§35 验收）与《dsh-workflow UI/UX 成熟化设计规范》（禁止事项）原文由消息粘贴提供、未落盘，本报告基于 phase13 差距分析重建的差距清单（A-M）与 phase12 真机验收清单（Test 1-15）逐项对照。

---

## 一、全量回归（自动化测试）

| 检查项 | 结果 |
|--------|------|
| `vitest run` 全量测试 | ✅ **171/171 通过（21 个测试文件）** |
| `tsc --noEmit` 类型检查 | ✅ 通过 |
| 测试文件覆盖 | graph(22)/engine(16)/artifact(14)/graph-ops(11)/provider(11)/http-api(10)/input-schema(10)/code-artifact(9)/hitl(9)/templates(8)/layout(6)/phase3-workspace(6)/phase3-model(6)/phase3-rework(5)/phase3-workbench(5)/human-task(4)/loop-hitl(4)/phase3-human-input(4)/phase3-version(4)/phase3-tpl-detail(4)/home-entry(3) |
| 竞态根治复验 | JsonRepo per-id 串行写锁 + rename 兜底；Test 6 磁盘轮询含在回归中全绿 |

---

## 二、§35 全项验收对照（第一份文档架构验收，重建自差距分析 + Test 1-15）

> 图例：✅=自动化测试覆盖通过；🖥=静态前端验证通过；🧑=需 GUI 宿主真机走查（宿主当前不可自动化启动）。

### 差距 A/B/D：Workflow 版本化 + Execution def 快照 + Run with Version

| 验收项 | 覆盖 | 依据 |
|--------|------|------|
| 保存产生不可变版本快照（key `{id}__v{rev}`） | ✅ | `test/phase3-version.test.ts`（4 项） |
| `GET /api/workflows/:id/versions` 可枚举历史版本 | ✅ | 同上 |
| 运行可指定版本 `version=N`（默认最新） | ✅ | 同上 |
| 历史 Execution 绑定启动时 def 快照（改版不影响审计） | ✅ | `ExecutionState.defSnapshot` + run/rework structuredClone；测试覆盖改版后旧执行仍用旧结构 |
| Test 6：重启后历史 Execution 从磁盘恢复 | ✅ | 终态快照 + 启动标记 + 竞态修复，回归全绿 |

### 差距 C + Phase B：Human Intervention 结构化 + 人工编辑 Artifact

| 验收项 | 覆盖 | 依据 |
|--------|------|------|
| Rework/run body 支持 `{instruction, inputArtifacts, modifiedArtifacts}`（instruction 优先） | ✅ | `test/phase3-human-input.test.ts`（4 项：结构化 instruction / inputArtifacts 注入 / modifiedArtifacts 起点 / reject 同构） |
| `pendingFeedback` 结构化（HumanIntervention & {text, reviewId}，旧数据兼容） | ✅ | 类型升级 + 引擎注入测试 |
| prompt 注入 instruction + HUMAN ATTACHED INPUT | ✅ | 引擎 prompt-builder 测试 |
| rework 装配时 modifiedArtifacts 替换起点输出（§11 Human Edit→Next Agent） | ✅ | 同测试 |
| 前端 Human Input 面板（instruction + Attach Artifact + 继续执行） | 🖥 | execution.js 节点详情 tab；静态冒烟 DOM 就绪（node --check 通过） |
| 执行完成后编辑 Artifact 生成新版本并 Rework | ✅ | Artifact v1/v2 版本链 + rework 装配测试 |

### 差距 E：积木操作补全

| 验收项 | 覆盖 | 依据 |
|--------|------|------|
| Duplicate 节点（复制新 ID、不复制边） | ✅ | `test/graph-ops.test.ts`（11 项）+ Ctrl+D 快捷键 |
| Reverse 连线方向 | ✅ | graph-ops.reverseEdge + 测试 |
| Disable 节点（执行旁路） | ✅ | graph-ops.toggleDisabled + 测试 |
| Start/End 唯一性 | ✅ | graph.test.ts + validator 三入口强制 |

### 差距 F/K/L/M + 第二份：编辑器布局成熟化

| 验收项 | 覆盖 | 依据 |
|--------|------|------|
| Toolbar 精简（只留 标题/id/名称/加载/运行/⋯） | 🖥 | Phase D 冒烟（截图 + 元素断言） |
| 次要操作入 ⋯ 菜单（保留 btn-* id，绑定不破坏） | 🖥 | Phase D 冒烟（⋯ 展开 9 项 + 点外关闭） |
| 危险操作（Delete/Reset）隐藏 + 确认 | 🖥 | Phase D 移入 ⋯ + 既有确认框 |
| 左侧组件库 AGENTS/HUMAN/CONTROL 分组 + 搜索 | 🖥 | Phase D 冒烟（搜索"人工"仅显 HUMAN 组） |
| 底部 Zoom 栏 [−]%[+]Fit | 🖥 | Phase D 冒烟（100→120→83→Fit 108） |
| 不用 ID 作主要 UI 信息（Workbench 名称优先） | ✅ | Workbench View Model 测试 |

### 差距 G/H + 第二份：执行页三栏 + 状态驱动 Contextual Action

| 验收项 | 覆盖 | 依据 |
|--------|------|------|
| 左 Timeline 竖列（节点状态/图标/颜色） | 🖥 | Phase E 冒烟（5 节点状态正确 + 截图） |
| 点击 Timeline 项 → Graph 定位 + Inspector 详情 | 🖥 | Phase E 冒烟（view 平移 + 节点 selected + 高亮同步） |
| waiting_review 就近 Review 决策（不堆顶部按钮墙） | 🖥 | Phase E 冒烟（点「通过」→ analyst success、architect running、卡片消失） |
| waiting_human 就地提交（§67 人工产出不伪装 Agent Run） | 已验证 | 独立后端（createWorkflowServer mock 模式）真机级走查：构造含 human_task 工作流 start→planner→approve(human)→end，执行进入 waiting_human（Timeline approve 待人工 + Inspector 就地人工任务面板 htask_d9ac5008）；Timeline 定位 approve → 节点详情顶部 Contextual Action 就近提交卡片；就地填写结果+备注提交 → approve→success、end→success、执行 completed，人工产出登记为 createdBy=human 的 artifact v1；前端 Timeline 四节点全绿 + Human Input Rework 面板出现（截图 phaseG-waiting-human / phaseG-human-completed） |
| 审核/人工操作就近到 Inspector | 🖥 | Contextual Action 拼详情模板顶部 |

### 差距 I/J + 第二份：UI Polish（空/加载/错误 + 快捷键）

| 验收项 | 覆盖 | 依据 |
|--------|------|------|
| 空画布 Empty State（标题+说明+CTA） | 🖥 | Phase F 静态验证（0 节点→flex、CTA 添加 agent 生效） |
| 执行面板 Loading 骨架 + Error 重试 | 🖥 | Phase F 静态验证（打开→Loading，404 连续失败→Error+重试可循环） |
| 快捷键 Ctrl+S/D/C/V/Z/Y/Shift+Z/Delete | 🖥 | Phase F 静态验证（复制 4→5、粘贴、缩放 100→120→100） |
| Space 按住任意位置平移 | 🖥 | Phase F 静态验证（S.spaceDown 切换） |

### Test 1-15 真机清单（第二/三阶段既有验收，需 GUI 宿主）

| Test | 主题 | 自动化覆盖 | 真机状态 |
|------|------|-----------|---------|
| 1 | 创建 Workflow（Start/End 唯一性） | ✅ validator 测试 | 🧑 待宿主 |
| 2 | Edge 箭头可见 | ✅ 部分（graph 渲染） | 🧑 待宿主 |
| 3 | 手动控制点持久化 | ✅ layout/graph 测试 | 🧑 待宿主 |
| 4 | Cycle 正常运行 | ✅ graph.test.ts（Tarjan/SCC） | 🧑 待宿主 |
| 5 | Loop 自动终止 | ✅ loop-hitl.test.ts | 🧑 待宿主 |
| 6 | Execution 重启持久化 | ✅ 回归（竞态已修） | 🧑 待宿主 |
| 7 | Rework From B（A 不重跑） | ✅ phase3-rework.test.ts | 🧑 待宿主 |
| 8 | 多次 Rework（树结构） | ✅ phase3-rework.test.ts | 🧑 待宿主 |
| 9 | Artifact 版本与下游消费 | ✅ artifact-manager.test.ts | 🧑 待宿主 |
| 10/11 | Working Directory 快照与继承 | ✅ phase3-workspace.test.ts（Test 10/11） | 🧑 待宿主 |
| 12 | Runtime 信息可查 | ✅ 部分（engine/http-api） | 🧑 待宿主 |
| 13 | 代码 Workflow（File/Diff/Patch） | ✅ code-artifact.test.ts | 🧑 待宿主 |
| 14 | Office Workflow（不强制转文本） | 🧑 依赖真实文件 | 🧑 待宿主 |
| 15 | Template 两级展示 | ✅ templates/phase3-tpl-detail | 🧑 待宿主 |

---

## 三、禁止事项对照（第二份 §30，防倒退）

| 禁止项 | 状态 | 依据 |
|--------|------|------|
| 不把全部操作堆顶 | ✅ | Phase D Toolbar 精简 |
| 不每个操作都弹 Modal | ✅ | Inspector / Contextual Action 优先 |
| 不在每个节点放一排常驻按钮 | ✅ | Floating Toolbar / 右键 / Inspector |
| 不所有字段同时展开（Progressive Disclosure） | ✅ | Advanced 折叠 |
| Delete 不进 Primary 区 | ✅ | Phase D 移入 ⋯ + 确认 |
| 不用 ID 作主要 UI 信息 | ✅ | Workbench 名称优先 + 历史执行用 Name |

---

## 四、结论与遗留

- **自动化质量门禁全绿**：171/171 测试 + typecheck 通过。
- **§35 架构层验收（A-E）+ UI 层验收（F-M）**：自动化测试或静态前端验证已覆盖绝大部分；**waiting_human CA 已通过独立后端（createWorkflowServer mock 模式，脱离 GUI 宿主）真机级走查闭环**（Timeline/Inspector/就地提交/Artifact 人工登记全通过）。剩余 **Test 1-15 的 🧑 项**（尤其 Test 14 Office 依赖真实文件）仍需 GUI 宿主逐条复核，建议桌面端开启后补一次完整真机验收。
- **禁止事项 6 条全合规**。

> 下一步建议：用户开启 DSH Desktop 后，用本报告「真机状态」列逐条勾选；如需，我可同步把宿主启动问题排查纳入。
