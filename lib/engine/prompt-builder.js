/**
 * PromptBuilder —— 固定分段模板（详细设计 §4），UI 的 Prompt Viewer 可按分段标记还原。
 */
export function buildPrompt(node, ctx) {
    const ic = node.inputContract;
    const oc = node.outputContract;
    const targetNames = oc.targets
        .map(t => t /* engine 不持有图，名字由 caller 预替换或直接展示 id */)
        .join('、');
    // §27-29：Routing 选项——Agent 可指定 route 字段选择下游出口
    const routingOpts = node.metadata['__routingOptions'];
    const routingSection = routingOpts ? [
        '',
        '# ROUTING',
        '你的输出可包含 route 字段来选择下游出口。',
        `可选路由：${routingOpts}`,
        `输出格式建议：\`\`\`json\n{"route": "${routingOpts.split(', ')[0]}", "content": "..."}\n\`\`\``,
        '如不指定 route，所有下游出口均可通行。',
    ].join('\n') : '';
    const system = [
        '# IDENTITY',
        `你是${node.identity.name}。`,
        '',
        '# ROLE',
        node.roleDescription,
        '',
        '# INPUT CONTRACT',
        ic.description || '（无描述）',
        `处理方式：${ic.processing || '（无）'}`,
        `重点使用：${ic.selection || '（无）'}`,
        `忽略：${ic.ignore || '（无）'}`,
        ic.constraints.length ? `约束：\n${ic.constraints.map(c => `- ${c}`).join('\n')}` : '约束：（无）',
        '',
        '# OUTPUT CONTRACT',
        oc.description || '（无描述）',
        `输出格式：${oc.format}`,
        oc.requiredSections.length ? `必须包含：${oc.requiredSections.join('、')}` : '',
        targetNames ? `你的输出将交给：${targetNames}` : '',
        oc.schema ? `必须输出符合以下 JSON Schema 的 JSON：\n${JSON.stringify(oc.schema)}` : '',
        oc.condition ? `输出条件：${oc.condition}` : '',
        routingSection,
    ].filter(Boolean).join('\n');
    const inputSection = ctx.inputs.length === 0
        ? '（无上游输入）'
        : ctx.inputs.map(i => `## 来自 ${i.sourceName}（第 ${i.runIndex} 轮）\n${i.content}`).join('\n\n');
    // 需求 3：本地工作目录注入（engine 经 metadata 传入，不污染节点配置）
    const wsDir = node.metadata['__workspaceDir'] ?? '';
    const wsSection = wsDir ? [
        '# WORKSPACE',
        `本地工作目录：${wsDir}`,
        '需要编写/运行代码、撰写文档时，一律在该目录下操作（如创建 src/、docs/ 子目录）；',
        '交付物（代码文件、文档）写入该目录并在输出中给出文件路径，不要把大文件内容整段贴进回复。',
    ].join('\n') : '';
    const execution = [
        '请基于以上输入，严格按 OUTPUT CONTRACT 完成当前任务。现在开始。',
        // 循环提示：由 engine 在构建前通过 metadata 注入轮次
        node.metadata['__iterationHint'] ?? '',
        wsSection,
    ].filter(Boolean).join('\n');
    return { system, user: `# INPUT\n${inputSection}\n\n# EXECUTION\n${execution}` };
}
