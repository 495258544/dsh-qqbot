import { rememberForAttribution } from "../features/attribution-index.js";
/** 只有群聊需要（私聊不涉及合并转发归属问题） */
export function attributionRecorder(options) {
    return async (ctx, next) => {
        const msg = ctx.message;
        if (msg.kind !== 'group')
            return next();
        const groupId = msg.groupOpenid ?? msg.senderId;
        const text = (msg.content ?? '').trim();
        // 只存**文本**，不存图片本体：
        //  - 反查靠内容比对，图片没有可比对的文本（存 URL 也匹配不上引文）
        //  - 存图片或 base64 会吃光内存/磁盘（用户明确担心过这点）
        //  - 纯图片消息（content 为空）跳过即可，它本来也无从被"引用文字"命中
        if (groupId && text && msg.senderId) {
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