/**
 * Steam 凭据与账号的运行时存储
 * ─────────────────────────────────────────────────────────────
 * 插件选项（cordis.patch.yml 的 steam.apiKey / steam.ownerSteamId）保留，
 * 但**不做固化值**：这两样都是数据，不是部署配置 ——
 *   apiKey        账号级凭据，会过期、会吊销，换 key 不该去改只读的 profile 文件
 *   ownerSteamId  主人自己的账号，换号、换设备、拷到另一台机器都要跟着走
 *
 * 所以真正生效的值落在这里（默认 ~/.dsh-qqbot/steam/settings.json）：
 *   整个 ~/.dsh-qqbot/steam 目录拷走 = 凭据 + 主人账号 + 群友绑定一起迁移，开箱即用。
 *
 * 优先级（用"配置指纹"而不是"谁先写谁赢"）：
 *   - 选项里填了值，且和上次消费过的不同 → 覆盖运行时值（用户确实在面板里改了）
 *   - 选项里填了值，但和上次消费过的相同 → 不动（这是旧值，不能反过来冲掉
 *     用户在聊天里 / 命令行里设的新值）
 *   - 选项为空 → 完全用运行时值
 *
 * 于是三种改法都能工作，互不打架：
 *   1. 在插件选项里改                       → 指纹变了，生效一次
 *   2. 聊天里说「我 Steam 主页是 xxx」       → 写运行时值，旧配置不会把它冲掉
 *   3. node scripts/steam-config.mjs --key / --owner → 同上，且不必重启宿主
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const empty = () => ({ ownerSteamId: '', apiKey: '' });
/** key 是凭据，指纹只用于比对，不还原原文 */
function keyFingerprint(key) {
    return createHash('sha256').update(key.trim()).digest('hex').slice(0, 16);
}
export class SettingsStore {
    file;
    logger;
    loaded = false;
    value = empty();
    /** 上次读盘时的文件 mtime，用于判断别的进程有没有改过 */
    mtimeAt;
    constructor(dir, logger) {
        fs.mkdirSync(dir, { recursive: true });
        this.file = path.join(dir, 'settings.json');
        this.logger = logger;
    }
    get filePath() {
        return this.file;
    }
    load() {
        if (this.loaded) {
            // 热重读：命令行脚本是另一个进程，改完盘后本进程要能立刻看到。
            // 只在 mtime 变化时才重读，正常路径上多一次 stat 的代价可以忽略。
            // 文件被删时 statMtime() 返回 undefined，和"上次读到的数字"不等 → 重读回空态，
            // 语义就变成"文件没了 = 回到未设置"，而不是抱着内存里的旧值不放。
            const mtime = this.statMtime();
            if (mtime !== this.mtimeAt)
                return this.readFromDisk(mtime);
            return this.value;
        }
        return this.readFromDisk(this.statMtime());
    }
    statMtime() {
        try {
            return fs.statSync(this.file).mtimeMs;
        }
        catch {
            return undefined;
        }
    }
    readFromDisk(mtime) {
        this.loaded = true;
        this.mtimeAt = mtime;
        try {
            const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            const owner = typeof parsed.ownerSteamId === 'string' ? parsed.ownerSteamId.trim() : '';
            const ownerOk = /^\d{17}$/.test(owner);
            const key = typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '';
            this.value = {
                ownerSteamId: ownerOk ? owner : '',
                ...(ownerOk
                    ? {
                        ownerSource: parsed.ownerSource === 'runtime' ? 'runtime' : 'config',
                        ownerUpdatedAt: Number(parsed.ownerUpdatedAt ?? 0),
                    }
                    : {}),
                apiKey: key,
                ...(key !== ''
                    ? {
                        apiKeySource: parsed.apiKeySource === 'runtime' ? 'runtime' : 'config',
                        apiKeyUpdatedAt: Number(parsed.apiKeyUpdatedAt ?? 0),
                    }
                    : {}),
                ...(typeof parsed.consumedOwnerSteamId === 'string' && /^\d{17}$/.test(parsed.consumedOwnerSteamId)
                    ? { consumedOwnerSteamId: parsed.consumedOwnerSteamId }
                    : {}),
                ...(typeof parsed.consumedApiKeyHash === 'string' && parsed.consumedApiKeyHash !== ''
                    ? { consumedApiKeyHash: parsed.consumedApiKeyHash }
                    : {}),
            };
            if (owner !== '' && !ownerOk) {
                this.logger.warn(`steam: settings.json 里的 ownerSteamId「${owner}」不是 17 位 SteamID64，已忽略`);
            }
        }
        catch (err) {
            if (err.code !== 'ENOENT') {
                this.logger.warn(`steam: settings.json 读取失败，按未设置处理: ${err instanceof Error ? err.message : String(err)}`);
            }
            this.value = empty();
        }
        return this.value;
    }
    /** 原子写：先写 .tmp 再 rename，避免进程被杀时留下半个 JSON */
    persist(next) {
        const payload = { version: 1 };
        if (next.ownerSteamId !== '') {
            payload.ownerSteamId = next.ownerSteamId;
            payload.ownerSource = next.ownerSource ?? 'runtime';
            payload.ownerUpdatedAt = next.ownerUpdatedAt ?? Date.now();
        }
        if (next.apiKey !== '') {
            payload.apiKey = next.apiKey;
            payload.apiKeySource = next.apiKeySource ?? 'runtime';
            payload.apiKeyUpdatedAt = next.apiKeyUpdatedAt ?? Date.now();
        }
        if (next.consumedOwnerSteamId !== undefined)
            payload.consumedOwnerSteamId = next.consumedOwnerSteamId;
        if (next.consumedApiKeyHash !== undefined)
            payload.consumedApiKeyHash = next.consumedApiKeyHash;
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
        fs.renameSync(tmp, this.file);
        this.value = next;
        this.loaded = true;
        // 自己写过的盘不用再热重读一次
        this.mtimeAt = this.statMtime();
    }
    get() {
        return { ...this.load() };
    }
    get ownerSteamId() {
        return this.load().ownerSteamId;
    }
    get apiKey() {
        return this.load().apiKey;
    }
    setOwner(steamId, source = 'runtime') {
        if (!/^\d{17}$/.test(steamId)) {
            throw new Error(`SettingsStore.setOwner: 只接受 17 位 SteamID64，收到「${steamId}」`);
        }
        this.persist({ ...this.load(), ownerSteamId: steamId, ownerSource: source, ownerUpdatedAt: Date.now() });
    }
    setApiKey(apiKey, source = 'runtime') {
        const key = apiKey.trim();
        if (key === '')
            throw new Error('SettingsStore.setApiKey: key 不能为空（要清除请用 clearApiKey）');
        // Steam key 一般是 32 位十六进制；只提示不拦死，免得以后改格式误伤
        if (!/^[0-9A-Fa-f]{32}$/.test(key)) {
            this.logger.warn('steam: API Key 看起来不是 32 位十六进制，仍按原样保存');
        }
        this.persist({ ...this.load(), apiKey: key, apiKeySource: source, apiKeyUpdatedAt: Date.now() });
    }
    clearApiKey() {
        const current = this.load();
        if (current.apiKey === '')
            return false;
        const next = { ...current, apiKey: '' };
        delete next.apiKeySource;
        delete next.apiKeyUpdatedAt;
        // 指纹也要一起清：否则用户清除后又在选项面板填回同一个 key，
        // applyConfig 会因为"和上次消费过的相同"而跳过，key 再也配不回来。
        delete next.consumedApiKeyHash;
        this.persist(next);
        return true;
    }
    /**
     * 合并插件选项。
     *
     * 只有「选项值和上次消费过的不同」时才覆盖 —— 这样选项面板能改，
     * 又不会让一句旧配置把用户后来设的账号悄悄改回去。
     */
    applyConfig(seed) {
        const current = this.load();
        const next = { ...current };
        let touched = false;
        const cfgOwner = (seed.ownerSteamId ?? '').trim();
        if (cfgOwner !== '') {
            if (!/^\d{17}$/.test(cfgOwner)) {
                this.logger.warn(`steam: 插件选项 steam.ownerSteamId「${cfgOwner}」不是 17 位 SteamID64，已跳过`);
            }
            else if (current.consumedOwnerSteamId !== cfgOwner) {
                next.ownerSteamId = cfgOwner;
                next.ownerSource = 'config';
                next.ownerUpdatedAt = Date.now();
                next.consumedOwnerSteamId = cfgOwner;
                touched = true;
                this.logger.info(`steam: 采纳插件选项里的主人账号 ${cfgOwner}（之后以 ${this.file} 为准）`);
            }
        }
        const cfgKey = (seed.apiKey ?? '').trim();
        if (cfgKey !== '') {
            const hash = keyFingerprint(cfgKey);
            if (current.consumedApiKeyHash !== hash) {
                next.apiKey = cfgKey;
                next.apiKeySource = 'config';
                next.apiKeyUpdatedAt = Date.now();
                next.consumedApiKeyHash = hash;
                touched = true;
                this.logger.info('steam: 采纳插件选项里的 API Key（之后以本文件为准）');
            }
        }
        if (touched)
            this.persist(next);
    }
}
//# sourceMappingURL=settings.js.map