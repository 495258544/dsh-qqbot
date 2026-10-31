/**
 * 唤醒判定 · 什么时候该说话，什么时候该安静
 * ─────────────────────────────────────────────────────────────
 * 移植自 ai-companion-kit（MIT）packages/companion/src/wake.js。
 *
 * 把"要不要醒"拆成独立条件，任一命中才醒：
 *   atMention / nameMention / keywords / question / speakerIds /
 *   probability / anyMessage
 * 注：原版的 poke（拍一拍）在 QQ 官方 Bot API 无对应事件，未移植。
 * 另含「无限期潜水」概念：醒过一次后，一段时间内除非再次命中否则装没看见。
 */
import { detectQuestion, detectAddressee } from "./question-detect.js";
export class Waker {
    names;
    keywords;
    defaultProbability;
    configs = new Map();
    /** 唤醒后保持"活跃"的时长（毫秒）。活跃期内即使没被 @ 也照常对话。 */
    activeWindowMs;
    /** 同一个人的活跃窗口内，连续多少条无关消息后关掉他的窗口（默认 5 条） */
    idleDiveThreshold;
    /** 同时允许几个人的活跃窗口并存（默认 4；超了挤掉最旧的） */
    maxSpeakerWindows;
    /** 活跃期里"无关话题也偶尔插一句"的概率（默认 0.12；0 = 完全不插） */
    chimeInProbability;
    constructor(opts = {}) {
        this.names = (opts.names ?? []).filter(Boolean);
        this.keywords = (opts.keywords ?? []).filter(Boolean);
        this.defaultProbability = opts.probability ?? 0.05;
        this.activeWindowMs = opts.activeWindowMs ?? 10 * 60 * 1000;
        this.idleDiveThreshold = opts.idleDiveThreshold ?? 5;
        this.maxSpeakerWindows = Math.max(1, opts.maxSpeakerWindows ?? 4);
        this.chimeInProbability = Math.max(0, opts.chimeInProbability ?? 0.12);
    }
    /** 给某个会话设置唤醒配置 */
    setConfig(key, cfg = {}) {
        this.configs.set(key, {
            mode: 'diving', // 'diving' 潜水 | 'active' 活跃
            infinite: true, // 无限期，直到再次命中条件
            until: 0,
            atMention: true,
            nameMention: true,
            keywords: [],
            question: true,
            speakerIds: [],
            probability: this.defaultProbability,
            anyMessage: false,
            ...cfg,
        });
    }
    getConfig(key) {
        if (!this.configs.has(key))
            this.setConfig(key, {});
        return this.configs.get(key);
    }
    /** 现在是不是在潜水（潜水中 = 不该主动说话） */
    isDiving(key) {
        const c = this.getConfig(key);
        if (c.mode === 'active')
            return false;
        if (c.infinite)
            return true;
        return Date.now() < c.until;
    }
    /**
     * 把它从潜水里叫起来，并进入「活跃」状态一段时间。
     * 活跃期内（activeWindowMs）即使没被 @ 也照常对话，超时自动回潜水。
     * （修复：原实现只写 lastWakeAt 不改 mode，导致状态机形同虚设）
     */
    wake(key, userId) {
        const c = this.getConfig(key);
        const now = Date.now();
        c.mode = 'active';
        c.infinite = false;
        c.until = now + this.activeWindowMs;
        c.lastWakeAt = now;
        c.wakeCount = (c.wakeCount ?? 0) + 1;
        c.idleStreak = 0; // 会话级计数归零（兼容字段）
        // 按人开窗口：谁提到她，就只给谁开。
        const id = String(userId ?? '');
        if (id) {
            const sp = (c.speakers ??= {});
            sp[id] = { until: c.until, idleStreak: 0, lastWakeAt: now };
            this.evictSpeakerWindows(c);
        }
    }
    /** 窗口数超限时挤掉"最早到期"的那个（多人在同一群里提她时不会无限膨胀） */
    evictSpeakerWindows(c) {
        const sp = c.speakers;
        if (!sp)
            return;
        const ids = Object.keys(sp);
        if (ids.length <= this.maxSpeakerWindows)
            return;
        ids
            .sort((a, b) => (sp[a]?.until ?? 0) - (sp[b]?.until ?? 0))
            .slice(0, ids.length - this.maxSpeakerWindows)
            .forEach((id) => { delete sp[id]; });
    }
    /** 这个人现在是否还在活跃窗口内（清掉过期的） */
    isSpeakerActive(key, userId) {
        const c = this.getConfig(key);
        const id = String(userId ?? '');
        const sp = c.speakers;
        if (!id || !sp)
            return false;
        const w = sp[id];
        if (!w)
            return false;
        if (Date.now() >= w.until) {
            delete sp[id];
            return false;
        }
        return true;
    }
    /**
     * 关掉**某一个人**的窗口。他的无关计数到阈值时调用——
     * 群里其他人还在跟她说话，不影响别人。
     * 所有人都没窗口了，才把整个会话转回潜水。
     */
    closeSpeakerWindow(key, userId) {
        const c = this.getConfig(key);
        const id = String(userId ?? '');
        const sp = c.speakers;
        if (sp && id && sp[id])
            delete sp[id];
        // 还有别人的窗口活着 → 整个会话保持 active
        const alive = sp ? Object.keys(sp).filter((k) => (sp[k]?.until ?? 0) > Date.now()) : [];
        if (alive.length > 0) {
            const latest = Math.max(...alive.map((k) => sp[k].until));
            c.mode = 'active';
            c.until = latest;
            return;
        }
        this.dive(key);
    }
    /** 现在是否处于活跃对话期（被 @ 过且在窗口内） */
    isActive(key) {
        const c = this.getConfig(key);
        if (c.mode !== 'active')
            return false;
        if (c.infinite)
            return true;
        return Date.now() < c.until;
    }
    /**
     * 定期清理长期无活跃的会话配置（审查 m9）。
     * staleMs 太长会把活跃潜水误判为过期，太短又删得太勤 → 保守用 30 天。
     * 半衰指标：最后一次唤醒距今。返回清理数。
     */
    prune(staleMs = 30 * 24 * 3600_000) {
        const now = Date.now();
        let removed = 0;
        for (const [key, c] of this.configs) {
            // 只清"唤醒过一次且很久没再醒"的会话；从未醒过的潜水配置保守保留
            // 否则 getConfig 惰性创建的 key 会在第二次 prune 被误删、丢掉潜水语义
            if (c.lastWakeAt !== undefined && c.lastWakeAt < now - staleMs) {
                this.configs.delete(key);
                removed += 1;
            }
        }
        return removed;
    }
    /** 让它继续潜水（可以指定潜多久）。立即退出活跃态。 */
    dive(key, ms = 0) {
        const c = this.getConfig(key);
        c.mode = 'diving';
        c.infinite = !ms;
        c.until = ms ? Date.now() + ms : 0;
    }
    /** 兴趣上下文提供者（由外部注入，未注入则不做兴趣唤醒） */
    interestProvider;
    /** 名字提供者（动态名字：配置名 + 她接受的称呼） */
    nameProvider;
    /** 注入动态名字来源（SelfProfileService.acceptName 后自动生效） */
    setNameProvider(fn) {
        this.nameProvider = fn;
    }
    /** 当前生效的称呼列表（配置名 ∪ 动态名） */
    currentNames() {
        const dyn = this.nameProvider?.();
        return dyn && dyn.length > 0 ? [...new Set([...this.names, ...dyn])] : this.names;
    }
    /** 注入兴趣上下文来源（SelfProfileService 接入用） */
    setInterestProvider(fn) {
        this.interestProvider = fn;
    }
    /**
     * 兴趣匹配：返回命中的兴趣及综合权重。
     * 权重 = Σ(命中兴趣的 weight)，再按话痨度折算。
     */
    matchInterest(text) {
        const ctx = this.interestProvider?.();
        if (!ctx || ctx.interests.length === 0)
            return { hit: false, topics: [], probability: 0 };
        const hits = ctx.interests.filter((i) => i.weight > 0 && text.includes(i.topic));
        if (hits.length === 0)
            return { hit: false, topics: [], probability: 0 };
        const sumWeight = Math.min(1, hits.reduce((a, b) => a + b.weight, 0));
        const base = ctx.baseProbability ?? 0.5;
        // 被嫌吵后 chattiness 降低，接话概率同步下降
        const probability = Math.max(0, Math.min(1, ctx.chattiness * sumWeight * base));
        return { hit: true, topics: hits.map((h) => h.topic), probability };
    }
    /**
     * 组装「说话对象」判定的上下文：
     *  - 她的当前称呼（配置名 ∪ 动态名字）
     *  - 群里其他人的昵称（用来排除"这段话是在问别人"）
     *  - 她是不是刚说完话 / 正在跟她对话
     */
    addresseeContext(c, uid, ownsWindow) {
        return {
            names: this.currentNames(),
            otherNames: (c.speakerIds ?? []).map(String).filter((x) => x !== uid),
            inConversationWithMe: ownsWindow,
            sameSpeakerAsLast: ownsWindow && (c.lastWakeAt ?? 0) > 0,
        };
    }
    /** 判定一条消息要不要唤醒 */
    shouldWake(msg) {
        const c = this.getConfig(msg.key);
        const text = String(msg.text ?? '');
        const uid = String(msg.userId ?? '');
        // 潜水优先：owner 说话同样遵循潜水规则（方案A，不 @ 不醒）。
        // owner 身份不再强制叫醒——否则 owner 在群里发任何消息都会打断潜水，
        // 无法验证"不@→潜水→@→唤醒"的完整链路。
        if (Array.isArray(c.speakerIds) && c.speakerIds.map(String).includes(uid)) {
            return { wake: true, reason: 'speaker' };
        }
        if (c.anyMessage)
            return { wake: true, reason: 'anyMessage' };
        // 注意：删掉了原来的 `if (c.mode === 'active') return wake:true`。
        // 那条会让活跃期内每条消息都必醒 → 变成应答器（"去吧""走吧"刷屏）。
        // 现在活跃期的接话交给下面的概率判定。
        // @ / 引用：永远必醒（这是在明确叫它）
        if (c.atMention && (msg.isAtMe || msg.isQuoteMe))
            return { wake: true, reason: 'atMention' };
        // 活跃对话期内：**只对"值得接的话"放行**，无关闲聊一律不说话。
        //
        // 之前这里写成"纯概率 45%"，导致不分话题内容——有人在群里提了她一句，
        // 之后别人聊"今天好热""你吃了吗"，她照样按 45% 插话，很吵。
        // 正确做法：先判"这条话跟她有关吗"，再决定概率。
        //
        // 多人同时提她时：**每个提到她的人各有一个窗口、各自计无关条数**。
        // A 提了她、然后 A 聊了 5 句不相干的 → 只关 A 的窗口；
        // B 这时候提她一句，照常接 B 的话。别人聊什么不会算到 A 头上。
        if (msg.inActiveWindow) {
            const ctx = this.interestProvider?.();
            const chat = ctx?.chattiness ?? 1;
            const spk = c.speakers?.[uid];
            // 只有"提到过她的人"才有窗口；没提过她的人在这轮里只按@/名字/问句判
            const ownsWindow = spk !== undefined && Date.now() < spk.until;
            // ── 跟她有关的信号：命中就清零**这个人的**无关计数 ──
            const it = this.matchInterest(text);
            const q = detectQuestion(text);
            const addr = detectAddressee(text, this.addresseeContext(c, uid, ownsWindow));
            let wake = false;
            let reason = '';
            // ① 明确在问她（点名她 / 第二人称"你" / 她刚说完的省略句）
            //    问句 + 指向她 → 必接（这是"吃了吗""在干嘛"这类没问号的省略句）
            if (q.isQuestion && addr.explicit && addr.score >= 0.5) {
                wake = true;
                reason = 'active-window:explicit-question';
            }
            // ② 明确在问别人 → 一律不抢话，也不算到任何人头上
            else if (addr.excluded) {
                return { wake: false, reason: 'active-window:excluded' };
            }
            // ③ 省略主语的问句 + 这人刚提到过她（窗口就是他开的）→ 默认是问她
            //    这是"吃了吗""在干嘛""忙不忙"这类没问号没主语的句子能接上的关键：
            //    判据不是句子本身，而是"这句话出自刚跟她说话的那个人"
            else if (q.isQuestion) {
                wake = true;
                reason = `active-window:implicit-question(${q.score.toFixed(2)})`;
            }
            // ④ 命中她的兴趣 → 按概率接（有话说，但不打扰）
            else if (it.hit && it.probability > 0 && Math.random() < it.probability) {
                wake = true;
                reason = 'active-window:interest';
            }
            // ⑤ 偶尔插一句不相干的（低概率，让她不至于变成只会答问的机器）
            else if (ownsWindow && chat >= 0.8 && Math.random() < this.chimeInProbability) {
                wake = true;
                reason = 'active-window:chime-in';
            }
            if (wake) {
                if (spk)
                    spk.idleStreak = 0;
                // 收窄一下：同一句话只给"提到过她的人"记窗口时长
                return { wake: true, reason };
            }
            // ── 跟她无关：只累计**发言者自己**的计数 ──
            if (ownsWindow) {
                spk.idleStreak += 1;
                if (spk.idleStreak >= this.idleDiveThreshold) {
                    // 这个人连续 5 条都跟她无关 → 关掉他的窗口，别人不受影响
                    this.closeSpeakerWindow(msg.key, uid);
                    const stillActive = this.isActive(msg.key);
                    return { wake: false, reason: stillActive ? 'active-window:speaker-closed' : 'active-window:auto-dive' };
                }
                return { wake: false, reason: `active-window:irrelevant(${spk.idleStreak}/${this.idleDiveThreshold})` };
            }
            // 没提到过她的人聊不相干的事：不计数、不回答
            return { wake: false, reason: 'active-window:bystander' };
        }
        if (c.nameMention) {
            const hit = this.currentNames().find((n) => n && text.includes(n));
            if (hit)
                return { wake: true, reason: 'name:' + hit };
        }
        const kw = [...(c.keywords ?? []), ...this.keywords];
        if (kw.length) {
            const hit = kw.find((k) => k && text.includes(k));
            if (hit)
                return { wake: true, reason: 'keyword:' + hit };
        }
        // 兴趣驱动唤醒：命中她自己的兴趣 → 按 chattiness × 权重 × 基础概率 决定是否接话
        const it = this.matchInterest(text);
        if (it.hit && it.probability > 0 && Math.random() < it.probability) {
            return { wake: true, reason: 'interest:' + it.topics.join(',') };
        }
        // 潜水期的提问判定：同样换成 question-detect（带问号/怎么/为什么 这些太粗，
        // 「吃了吗」「在干嘛」「忙不忙」全漏）。这里更严：只有**确实像在问她**才醒。
        if (c.question) {
            const q = detectQuestion(text);
            const addr = detectAddressee(text, this.addresseeContext(c, uid, false));
            if (q.isQuestion && !addr.excluded && (addr.explicit || addr.score >= 0.4)) {
                return { wake: true, reason: `question(${q.score.toFixed(2)}${addr.explicit ? ',explicit' : ''})` };
            }
        }
        if (Number(c.probability) > 0 && Math.random() < Number(c.probability)) {
            return { wake: true, reason: 'probability' };
        }
        return { wake: false, reason: '' };
    }
}
//# sourceMappingURL=wake.js.map