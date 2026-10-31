import { rememberForAttribution } from "../features/attribution-index.js";
/** 只有群聊需要（私聊不涉及合并转发归属问题） */
export function attributionRecorder(options) {
    return async (ctx, next) => {
        const msg = ctx.message;
        if (msg.kind !== 'group')
            return next();
        const groupId = msg.groupOpenid ?? msg.senderId;
        const text = msg.content ?? '';
        // 没有正文（纯图片/表情）就不记 —— 反查靠内容，空内容无从匹配
        if (groupId && text.trim() && msg.senderId) {
            rememberForAttribution(options.appId, groupId, {
                senderId: msg.senderId,
                senderName: msg.senderName,
                content: text,
            });
        }
        return next();
    };
}
//# sourceMappingURL=attribution-recorder.js.map