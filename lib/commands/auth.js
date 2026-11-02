const DENIED = '⚠️ 无权限执行此命令';
/** 构造命令白名单鉴权回调 */
export function commandAllowlistAuth(config, logger) {
    return (ctx) => {
        // 管理类命令（/model /preset）必须**始终**校验主人身份，不能因为 c2cMode=open 就放开。
        //
        // 实测风险（2026-11-02 审查）：c2cMode=open 时原来直接 return true，
        // 于是任何能私聊到她的人都能改模型路由、切 preset —— 这相当于把她的"人格与通道"
        // 交给陌生人。open 只该放开"能跟她聊天"，不该放开"能改她"。
        if (config.access.c2cMode !== 'allowlist') {
            // open 模式下仍要求：要么在 c2cAllow 白名单里，要么在 persona.ownerOpenids 里
            const senderId = ctx.message.senderId;
            const owners = [
                ...config.access.c2cAllow,
                ...(config.persona?.ownerOpenids ?? []),
            ];
            if (owners.length === 0) {
                // 一个主人都没配：保守放行（否则升级后老用户一个命令都用不了）
                return true;
            }
            if (senderId && owners.includes(senderId))
                return true;
            logger?.warn(`im-qqbot: admin command denied (c2cMode=open but sender not owner): sender=${senderId ?? '(missing)'}`);
            return DENIED;
        }
        const senderId = ctx.message.senderId;
        if (!senderId || !config.access.c2cAllow.includes(senderId)) {
            logger?.warn(`im-qqbot: command auth denied: sender=${senderId ?? '(missing)'}`);
            return DENIED;
        }
        return true;
    };
}
//# sourceMappingURL=auth.js.map