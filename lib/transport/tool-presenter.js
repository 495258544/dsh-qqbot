/**
 * 工具调用结果 → Markdown 格式化
 *
 * 适配 QQ 消息通道：优先用工具自定义的 presentResult 视图，
 * fallback 到 raw text。错误始终展示，成功结果按 config 开关。
 */
const RESULT_PREVIEW_LIMIT = 1500;
/**
 * 将工具调用结果格式化为 Markdown 文本
 *
 * 返回 null 表示无需发送（无内容）。
 */
export function formatToolResult(name, rawArgs, data, toolsRegistry, agent) {
    // 1. 错误处理
    //
    // 真实事故（2026-11-01）：小羽试图调用一个不存在的工具 wait_agent，
    // 结果私聊里直接冒出：
    //   ❌ 工具 `wait_agent` 执行失败
    //   `ToolNotFoundError: UNKNOWN_TOOL`
    //
    // 这是**技术报错泄露给用户**，而且是从"她以为自己能做到"变成"当着用户面报错"，
    // 比不说还糟。这里分两类：
    //   - 工具不存在 / 不支持：用户视角完全无意义，**静默丢弃**（她本来就不该调用）
    //   - 其他执行失败：给出人话提示，不暴露内部错误码
    if (data.error) {
        const code = String(data.error.code ?? '');
        const isToolMissing = /UNKNOWN_TOOL|NOT_FOUND|ToolNotFound|not found/i.test(code)
            || /ToolNotFound|UNKNOWN_TOOL/i.test(String(data.error.name ?? ''));
        if (isToolMissing) {
            // 工具不存在：不展示。她自己会从"工具调用失败"里学到没有这个能力。
            return null;
        }
        return `（这个操作没成功：${name}）`;
    }
    // 2. 尝试工具自定义视图（presentResult）
    const view = presentResultView(name, rawArgs, data, toolsRegistry, agent);
    if (view) {
        const rendered = renderView(name, view);
        if (rendered)
            return rendered;
    }
    // 3. fallback raw text
    const block = data.message.content[0];
    const result = block !== undefined && block.type === 'tool-result' ? textOf(block.content) : '';
    if (!result)
        return null;
    return `🔧 \`${name}\` 完成\n${truncate(result)}`;
}
/** 调用工具自定义 presentResult，失败/不可用时返回 undefined */
function presentResultView(name, rawArgs, data, toolsRegistry, agent) {
    if (!toolsRegistry)
        return undefined;
    try {
        const tool = toolsRegistry.get(name, agent);
        if (tool?.presentResult === undefined)
            return undefined;
        const block = data.message.content[0];
        const content = block !== undefined && block.type === 'tool-result' ? block.content : [];
        return tool.presentResult(JSON.parse(rawArgs), {
            content,
            isError: block?.isError === true,
            ...(data.meta !== undefined ? { meta: data.meta } : {}),
        });
    }
    catch {
        return undefined;
    }
}
/** 将结构化视图渲染为 Markdown */
function renderView(name, view) {
    const header = `🔧 \`${name}\` 完成`;
    switch (view.card) {
        case 'terminal': {
            const output = (view.output ?? '').trimEnd();
            if (!output)
                return null;
            const exit = view.exitCode !== undefined && view.exitCode !== 0 ? `\n退出码 ${view.exitCode}` : '';
            return `${header}\n\`\`\`\n${output}\n\`\`\`${exit}`;
        }
        case 'diff': {
            return `${header}\n\`\`\`diff\n${truncate(renderDiffs(view.diffs))}\n\`\`\``;
        }
        case 'read': {
            const content = view.content ? textOf(view.content) : '';
            if (!content)
                return null;
            const path = view.path ? ` (${view.path})` : '';
            return `${header}${path}\n\`\`\`\n${truncate(content)}\n\`\`\``;
        }
        case 'generic':
        default: {
            const content = view.content ? textOf(view.content) : '';
            if (!content)
                return null;
            return `${header}\n${truncate(content)}`;
        }
    }
}
/** 提取 content blocks 中的纯文本 */
function textOf(content) {
    if (!Array.isArray(content))
        return '';
    return content
        .map((b) => {
        if (typeof b === 'object' && b !== null && b.type === 'text') {
            return b.text ?? '';
        }
        return '';
    })
        .filter(Boolean)
        .join('');
}
/** 渲染 diff hunks 为纯文本 */
function renderDiffs(diffs) {
    return diffs
        .map((d) => {
        if (typeof d === 'object' && d !== null) {
            const { path, hunks } = d;
            const body = (hunks ?? []).map((h) => h.text ?? '').join('\n');
            return path ? `--- ${path} ---\n${body}` : body;
        }
        return '';
    })
        .filter(Boolean)
        .join('\n');
}
/** 截断长文本，避免刷屏 */
function truncate(text) {
    if (text.length <= RESULT_PREVIEW_LIMIT)
        return text;
    return `${text.slice(0, RESULT_PREVIEW_LIMIT)}\n…（已截断）`;
}
//# sourceMappingURL=tool-presenter.js.map