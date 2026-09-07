/**
 * Phase 9 —— Preset / Template（详细设计 §12）
 *
 * 内置模板：代码维护、不可删除；用户模板走 JsonRepo。
 * instantiate 时替换 workflow id / name / 时间戳，节点 id 保持稳定（边引用无需重写）。
 */
import { defaultSettings } from '../domain/types.js';
// ---------------------------------------------------------------- helpers
function mkNode(type, id, x, y, role = '') {
    return {
        id, type, name: id, position: { x, y },
        identity: { name: id },
        roleDescription: role,
        inputContract: {
            description: '', processing: '', selection: '', ignore: '',
            constraints: [], sourceMode: 'all', selectedSourceNodeIds: [],
        },
        outputContract: { description: '', format: 'markdown', schema: null, requiredSections: [], targets: [], condition: null },
        modelConfig: { provider: 'deepseek', model: 'deepseek-chat' },
        runtimeConfig: {
            maxRuns: 5, timeoutMs: 180000,
            retry: { enabled: false, maxRetries: 1, backoffMs: 2000 },
            onFailure: 'fail_workflow',
        },
        metadata: {},
    };
}
function mkEdge(id, sourceId, targetId, review) {
    return {
        id,
        source: { nodeId: sourceId, output: 'main' },
        target: { nodeId: targetId, input: 'main' },
        transform: { enabled: false, instruction: '' },
        condition: null,
        review,
    };
}
const REVIEW_FULL = {
    enabled: true, mode: 'required',
    allowedActions: ['accept', 'reject', 'edit', 'accept_after_edit', 'terminate'],
    timeout: null, onTimeout: 'pause',
};
function skeleton(id, name, nodes, edges, loops = [], maxSteps = 200) {
    const ts = new Date(0).toISOString(); // 占位；instantiate 时刷新
    return {
        version: '1.0', id, name,
        createdAt: ts, updatedAt: ts,
        nodes, edges,
        settings: defaultSettings({ maxExecutionSteps: maxSteps }),
        loops,
        layout: {},
    };
}
// ---------------------------------------------------------------- builtin
/** 创建带完整输入/输出契约的专业节点 */
function mkNodePro(type, id, x, y, role, inputDesc, outputDesc, outputFormat = 'markdown', outSections = [], constraints = [], selection = '', processing = '') {
    const n = mkNode(type, id, x, y, role);
    n.inputContract.description = inputDesc;
    n.inputContract.selection = selection;
    n.inputContract.processing = processing;
    n.inputContract.constraints = constraints;
    n.outputContract.description = outputDesc;
    n.outputContract.format = outputFormat;
    n.outputContract.requiredSections = outSections;
    return n;
}
export const BUILTIN_TEMPLATES = [
    {
        id: 'tpl_review_pipeline',
        name: '分析→设计→评审（带人工审核）',
        description: '需求分析师 → 架构师 → 评审员三级流水线；架构师产出经人工 Review Gate 后才进入评审。',
        category: 'builtin',
        def: skeleton('tpl_review_pipeline', '分析→设计→评审', [
            mkNode('start', 'start', 60, 220),
            mkNode('agent', 'analyst', 280, 120, '需求分析师：把用户需求拆解为清晰的功能点清单，每条一行。'),
            mkNode('agent', 'architect', 280, 340, '架构师：基于功能点清单给出模块划分与关键技术选型，控制在 300 字内。'),
            mkNode('agent', 'reviewer', 560, 220, '评审员：审阅架构方案，指出 2-3 个最重要的风险与改进建议。'),
            mkNode('end', 'end', 800, 220),
        ], [
            mkEdge('e1', 'start', 'analyst'),
            mkEdge('e2', 'analyst', 'architect', REVIEW_FULL),
            mkEdge('e3', 'architect', 'reviewer'),
            mkEdge('e4', 'reviewer', 'end'),
        ]),
        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    },
    {
        id: 'tpl_loop_refine',
        name: '写作→评审迭代环（最多 3 轮）',
        description: '写作者与评审者构成迭代环：评审者给出修改意见 → 写作者参考修订，最多 3 轮后收敛输出。',
        category: 'builtin',
        def: skeleton('tpl_loop_refine', '写作→评审迭代环', [
            mkNode('start', 'start', 60, 220),
            mkNode('agent', 'writer', 320, 120, '写作者：根据需求产出初稿；若收到评审意见，逐条回应并修订。'),
            mkNode('agent', 'critic', 320, 340, '评审者：对稿件给出具体、可执行的修改意见（不超过 3 条）。'),
            mkNode('end', 'end', 640, 220),
        ], [
            mkEdge('e1', 'start', 'writer'),
            mkEdge('e2', 'writer', 'critic'),
            mkEdge('e3', 'critic', 'writer'), // 环回边
            mkEdge('e4', 'critic', 'end'),
        ], [
            { loopId: 'loop_refine', nodeIds: ['writer', 'critic'], maxIterations: 3 },
        ]),
        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    },
    {
        id: 'tpl_parallel_collect',
        name: '并行双视角→汇总',
        description: '两个 Agent 并行产出不同视角的分析（技术/业务），汇总者整合为一份结论。',
        category: 'builtin',
        def: skeleton('tpl_parallel_collect', '并行双视角→汇总', [
            mkNode('start', 'start', 60, 220),
            mkNode('agent', 'tech_view', 320, 100, '技术视角分析师：评估实现可行性、技术风险与依赖。'),
            mkNode('agent', 'biz_view', 320, 340, '业务视角分析师：评估用户价值、使用场景与成本收益。'),
            mkNode('agent', 'integrator', 600, 220, '汇总者：整合两份视角分析，产出一份结论与下一步建议。'),
            mkNode('end', 'end', 840, 220),
        ], [
            mkEdge('e1', 'start', 'tech_view'),
            mkEdge('e2', 'start', 'biz_view'),
            mkEdge('e3', 'tech_view', 'integrator'),
            mkEdge('e4', 'biz_view', 'integrator'),
            mkEdge('e5', 'integrator', 'end'),
        ]),
        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    },
    {
        id: 'tpl_local_code_demo',
        name: '本地代码 Demo（写码→运行验证）',
        description: '极简两段式：编码者在工作目录写一个小 demo 并运行验证，汇总成简短报告。实例化后请在「设置」页填写本地工作目录。',
        category: 'builtin',
        def: skeleton('tpl_local_code_demo', '本地代码 Demo', [
            mkNode('start', 'start', 60, 220),
            mkNode('agent', 'coder', 300, 220, '编码者：在工作目录下创建 demo/ 子目录，写一个不超过 40 行的可运行 demo（Python 或 Node.js 任选），实现需求描述的最小功能；写完后实际运行一次，把运行输出附在结果里。'),
            mkNode('agent', 'verifier', 560, 220, '验证者：阅读编码者的运行输出与代码路径，确认 demo 能跑通且符合需求；如发现问题给出 1-2 条具体修改建议，否则一句话确认通过。'),
            mkNode('end', 'end', 800, 220),
        ], [
            mkEdge('e1', 'start', 'coder'),
            mkEdge('e2', 'coder', 'verifier'),
            mkEdge('e3', 'verifier', 'end'),
        ]),
        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    },
    // ---- 专业预设（完整角色/输入/输出覆盖）----
    {
        id: 'tpl_research_design_review',
        name: '调研→方案→评审（三级流水线）',
        description: '调研员收集信息 → 方案设计师制定方案 → 评审员审阅，适用于方案选型场景。每个节点均含完整输入输出契约。',
        category: 'builtin',
        def: skeleton('tpl_research_design_review', '调研→方案→评审', [
            mkNode('start', 'start', 60, 220),
            mkNodePro('agent', 'researcher', 300, 100, '调研员：收集并整理与需求相关的资料、竞品信息、技术方案，输出调研摘要。', '接收用户需求描述或问题陈述，作为调研的起点。', '输出一份结构化的调研摘要，含背景、竞品分析、技术选项、推荐方向。', 'markdown', ['背景与需求', '竞品/技术选项', '优劣势对比', '推荐方向'], ['仅依赖公开或已有信息，不得编造数据', '引用需标注来源']),
            mkNodePro('agent', 'designer', 300, 340, '方案设计师：基于调研摘要设计技术方案，含模块划分、接口设计和实施路径。', '接收调研员的调研摘要，基于此设计详细方案。', '输出完整方案：架构、模块、接口、实施计划。', 'markdown', ['方案概述', '模块划分与职责', '接口设计', '技术选型与理由', '实施路径'], ['方案必须可落地', '每个模块需说明输入输出', '接口设计需标明数据格式']),
            mkNodePro('agent', 'reviewer', 560, 220, '评审员：审阅方案，从完整性、可行性、风险三个维度给出评价。', '接收方案设计师的完整方案文档。', '输出评审意见：完整性评价、可行性分析、风险点与改进建议。', 'markdown', ['完整性评价', '可行性分析', '风险点清单', '改进建议', '评审结论'], ['评价必须具体', '每个风险点需说明影响与概率', '改进建议需可操作']),
            mkNode('end', 'end', 800, 220),
        ], [
            mkEdge('e1', 'start', 'researcher'),
            mkEdge('e2', 'researcher', 'designer'),
            mkEdge('e3', 'designer', 'reviewer'),
            mkEdge('e4', 'reviewer', 'end'),
        ]),
        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    },
    {
        id: 'tpl_prd_tc',
        name: '产品需求→技术设计→测试用例',
        description: '产品经理撰写 PRD，技术负责人做技术设计，测试工程师编写测试用例，覆盖产品全流程。',
        category: 'builtin',
        def: skeleton('tpl_prd_tc', '产品需求→技术设计→测试用例', [
            mkNode('start', 'start', 60, 220),
            mkNodePro('agent', 'pm', 300, 100, '产品经理：将用户需求转化为结构化的产品需求文档（PRD），含功能列表、优先级、验收标准。', '接收原始用户需求或问题描述。', '输出完整的 PRD：功能列表、用户故事、优先级、验收标准。', 'markdown', ['功能列表与优先级', '用户故事', '验收标准', '边界条件'], ['优先级必须标注 P0/P1/P2', '每个功能需有明确验收标准']),
            mkNodePro('agent', 'tech_lead', 300, 340, '技术负责人：基于 PRD 设计技术方案，含系统架构、数据模型、API 设计。', '接收产品经理的 PRD 文档，作为技术设计的输入。', '输出技术方案文档：架构图、数据模型、API 设计、技术选型、实施计划。', 'markdown', ['系统架构', '数据模型设计', 'API 接口设计', '关键技术选型', '实施计划'], ['架构需考虑可扩展性', '数据模型需标注字段类型和约束', 'API 需标注入参出参']),
            mkNodePro('agent', 'tester', 560, 220, '测试工程师：基于 PRD 和技术方案编写测试用例，含功能测试、边界测试、异常测试。', '接收 PRD 和技术方案文档，作为测试用例编写的输入。', '输出测试用例集：功能测试用例、边界测试用例、异常测试用例。', 'markdown', ['功能测试用例', '边界条件测试', '异常场景测试', '回归测试清单'], ['每个测试用例需含前置条件、测试步骤、预期结果', '必须覆盖 P0 功能']),
            mkNode('end', 'end', 800, 220),
        ], [
            mkEdge('e1', 'start', 'pm'),
            mkEdge('e2', 'pm', 'tech_lead'),
            mkEdge('e3', 'tech_lead', 'tester'),
            mkEdge('e4', 'tester', 'end'),
        ]),
        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    },
    {
        id: 'tpl_data_pipeline',
        name: '数据采集→清洗→分析→报表',
        description: '四段式数据流水线：采集原始数据、清洗预处理、分析建模、生成可视化报表，附带完整数据契约。',
        category: 'builtin',
        def: skeleton('tpl_data_pipeline', '数据采集→清洗→分析→报表', [
            mkNode('start', 'start', 60, 220),
            mkNodePro('agent', 'collector', 260, 100, '数据采集员：根据需求采集原始数据，输出原始数据集及数据字典。', '接收数据需求描述：数据来源、字段、时间范围、采样方式。', '输出原始数据集文件路径及数据字典，含字段名、类型、样例值。', 'markdown', ['数据来源说明', '采集方式', '数据字典', '数据量统计'], ['需注明数据来源的时效性', '数据字典需含每个字段的样例值']),
            mkNodePro('agent', 'cleaner', 260, 340, '数据清洗员：对原始数据做清洗（去重、填充空值、格式统一、异常值处理），输出高质量数据集。', '接收采集员的原始数据集及数据字典。', '输出清洗后的数据集及清洗报告：清洗规则、处理行数、质量指标。', 'markdown', ['清洗规则清单', '处理统计', '质量指标', '清洗后数据字典'], ['去重规则需明确说明', '空值填充策略需合理', '异常值处理不得引入偏差']),
            mkNodePro('agent', 'analyst', 460, 220, '数据分析师：对清洗后的数据进行探索性分析，构建模型，产出分析结论。', '接收清洗后的数据集及清洗报告。', '输出分析报告：探索性分析结果、建模方法、模型评估、业务结论。', 'markdown', ['探索性分析', '建模方法选择', '模型评估指标', '业务结论与建议'], ['分析方法需与业务问题匹配', '模型评估结果需含置信度', '结论需与业务决策直接关联']),
            mkNodePro('agent', 'reporter', 660, 220, '报表生成员：将分析结果转化为可视化报表和结论摘要，输出可直接用于汇报的文档。', '接收数据分析师的分析报告、图表、模型结果。', '输出最终报表：摘要、可视化图表、关键发现、下一步建议。', 'markdown', ['执行摘要', '关键发现', '可视化图表', '业务建议', '下一步计划'], ['图表需有标题和注释', '关键发现需与业务目标对应', '建议需可执行']),
            mkNode('end', 'end', 860, 220),
        ], [
            mkEdge('e1', 'start', 'collector'),
            mkEdge('e2', 'collector', 'cleaner'),
            mkEdge('e3', 'cleaner', 'analyst'),
            mkEdge('e4', 'analyst', 'reporter'),
            mkEdge('e5', 'reporter', 'end'),
        ]),
        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    },
    {
        id: 'tpl_dual_track_review',
        name: '方案双轨评审（技术/业务并行）',
        description: '技术评估与业务评估并行执行，决策者综合两份意见做出最终决策。',
        category: 'builtin',
        def: skeleton('tpl_dual_track_review', '方案双轨评审', [
            mkNode('start', 'start', 60, 220),
            mkNodePro('agent', 'tech_eval', 320, 80, '技术评估员：从技术可行性、实现成本、技术风险、系统兼容性等维度评估方案。', '接收待评估的技术方案或产品方案文档。', '输出技术评估报告：可行性结论、技术风险、实现成本估算、替代方案建议。', 'markdown', ['可行性结论', '技术风险清单', '实现成本估算', '兼容性分析', '替代方案建议'], ['评估需基于具体技术栈', '风险需标注影响范围和概率', '成本估算需列出主要项目']),
            mkNodePro('agent', 'biz_eval', 320, 360, '业务评估员：从用户价值、市场机会、成本收益、风险等维度评估方案。', '接收待评估的技术方案或产品方案文档。', '输出业务评估报告：用户价值分析、市场机会、成本收益分析、业务风险。', 'markdown', ['用户价值分析', '市场机会评估', '成本收益分析', '业务风险', '综合建议'], ['用户价值需具体到场景', '成本收益需量化', '风险需标注影响等级']),
            mkNodePro('agent', 'decider', 600, 220, '决策者：综合技术评估和业务评估，做出最终决策，并给出决策理由。', '接收技术评估报告和业务评估报告，作为决策依据。', '输出决策结论：决策结果、核心理由、前提条件、后续行动。', 'markdown', ['决策结果', '核心理由', '前提条件', '后续行动', '风险接受声明'], ['决策理由需引用评估报告中的具体内容', '有条件通过需列明前提条件']),
            mkNode('end', 'end', 840, 220),
        ], [
            mkEdge('e1', 'start', 'tech_eval'),
            mkEdge('e2', 'start', 'biz_eval'),
            mkEdge('e3', 'tech_eval', 'decider'),
            mkEdge('e4', 'biz_eval', 'decider'),
            mkEdge('e5', 'decider', 'end'),
        ]),
        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    },
    {
        id: 'tpl_split_parallel_merge',
        name: '任务分解→并行执行→结果整合',
        description: '项目经理分解任务，两个执行者并行工作，整合者将结果合并为统一输出。',
        category: 'builtin',
        def: skeleton('tpl_split_parallel_merge', '任务分解→并行执行→结果整合', [
            mkNode('start', 'start', 60, 220),
            mkNodePro('agent', 'planner', 280, 220, '项目经理：将需求拆解为可并行执行的任务，明确每个任务的输入、输出、验收标准与依赖关系。', '接收项目需求或任务描述，作为任务分解的依据。', '输出任务分解清单：任务列表、输入输出说明、依赖关系、预期工期。', 'markdown', ['需求概述', '任务分解清单', '任务依赖关系', '预期工期', '验收标准'], ['任务粒度需适中', '依赖关系需标注阻塞/非阻塞', '每个任务需有明确验收标准']),
            mkNodePro('agent', 'worker_a', 280, 80, '执行者 A：独立完成分配的任务模块，按验收标准输出成果。', '接收项目经理分配的任务 A 的详细说明。', '输出任务 A 的完成成果，附简要说明。', 'markdown', ['任务说明', '完成成果', '遇到的问题与决策', '自检清单'], ['必须按验收标准自检', '遇到阻塞及时在成果中说明']),
            mkNodePro('agent', 'worker_b', 280, 360, '执行者 B：独立完成分配的任务模块，与执行者 A 并行工作。', '接收项目经理分配的任务 B 的详细说明。', '输出任务 B 的完成成果，附简要说明。', 'markdown', ['任务说明', '完成成果', '遇到的问题与决策', '自检清单'], ['必须按验收标准自检', '遇到阻塞及时在成果中说明']),
            mkNodePro('agent', 'integrator', 560, 220, '整合者：将两个并行执行者的成果合并为统一输出，消除冲突，补充总览。', '接收执行者 A 和执行者 B 的完成成果，合并为统一输出。', '输出整合后的完整成果：总览、合并内容、冲突处理说明。', 'markdown', ['总览', '合并内容', '冲突处理说明', '完整交付物'], ['合并时需检查两部分的一致性', '冲突需明确说明处理方式']),
            mkNode('end', 'end', 800, 220),
        ], [
            mkEdge('e1', 'start', 'planner'),
            mkEdge('e2', 'planner', 'worker_a'),
            mkEdge('e3', 'planner', 'worker_b'),
            mkEdge('e4', 'worker_a', 'integrator'),
            mkEdge('e5', 'worker_b', 'integrator'),
            mkEdge('e6', 'integrator', 'end'),
        ]),
        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    },
    {
        id: 'tpl_code_review_pipeline',
        name: '代码审查流水线（编码→静态检查→安全审查）',
        description: '开发工程师编写代码，代码审查员做静态检查，安全审查员做安全审计，三级审查流水线。',
        category: 'builtin',
        def: skeleton('tpl_code_review_pipeline', '代码审查流水线', [
            mkNode('start', 'start', 60, 220),
            mkNodePro('agent', 'developer', 300, 100, '开发工程师：根据需求实现功能代码，含单元测试，确保代码可运行。', '接收功能需求描述、技术方案、编码规范文档。', '输出功能代码与单元测试，附运行说明和依赖清单。', 'markdown', ['实现说明', '代码清单与路径', '单元测试', '运行说明', '依赖清单'], ['代码需含完整的错误处理', '单元测试覆盖率不低于 80%', '代码风格需符合规范']),
            mkNodePro('agent', 'code_reviewer', 300, 340, '代码审查员：检查代码风格、质量、边界条件、性能隐患，给出改进建议。', '接收开发工程师的代码、单元测试和运行说明。', '输出代码审查报告：风格检查、质量评估、边界条件分析、性能建议。', 'markdown', ['风格检查结果', '代码质量评估', '边界条件分析', '性能隐患', '综合建议'], ['风格问题需标注行号', '质量评估需具体到代码片段', '性能隐患需说明影响场景']),
            mkNodePro('agent', 'security_auditor', 560, 220, '安全审查员：检查代码中的安全漏洞，包括注入、越权、敏感信息泄露、XSS/CSRF 等。', '接收开发工程师的代码和代码审查员的审查报告。', '输出安全审计报告：漏洞清单、风险等级、修复建议。', 'markdown', ['安全审计范围', '漏洞清单', '风险等级', '修复建议', '安全合规结论'], ['漏洞需标注风险等级', '每个漏洞需说明攻击路径', '修复建议需具体到代码修改']),
            mkNode('end', 'end', 800, 220),
        ], [
            mkEdge('e1', 'start', 'developer'),
            mkEdge('e2', 'developer', 'code_reviewer'),
            mkEdge('e3', 'code_reviewer', 'security_auditor'),
            mkEdge('e4', 'security_auditor', 'end'),
        ]),
        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    },
];
// ---------------------------------------------------------------- instantiate
/** 从模板实例化为新工作流：新 id / 新时间戳，节点与边结构原样保留 */
export function instantiateTemplate(tpl, newId, newName) {
    const now = new Date().toISOString();
    const def = JSON.parse(JSON.stringify(tpl.def));
    def.id = newId;
    def.name = newName ?? tpl.name;
    def.createdAt = now;
    def.updatedAt = now;
    return def;
}
