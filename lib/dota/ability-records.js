/**
 * 技能记录 —— 每次解析 OMG 局就把技能组合存一份
 * ─────────────────────────────────────────────────────────────
 * 为什么要存：
 *   OpenDota 的 match 详情是一次性快照，每次查都得重新拉。
 *   而这个群几乎只打技能征召，「某人上一把拿了什么技能」「这套组合赢没赢」
 *   这类问题隔几天再问就很常见 —— 存下来才查得动，也才可能看出"他老爱拿什么"。
 *
 * 存哪：
 *   `~/.dsh-qqbot/dota/ability-records.json`（和 `steam/` 同级，整个目录拷走即可迁移）
 *
 * 为什么不放进 persona 的数据目录：
 *   这是 Dota 模块自己的东西，和人格记忆无关；混在一起以后清理会互相牵连。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
/** 最多留多少场（约等于几个月的量，再多也没人翻） */
const MAX_MATCHES = 500;
export class AbilityRecordStore {
    file;
    logger;
    cache = null;
    constructor(dir, logger) {
        const root = dir !== undefined && dir !== '' ? dir : path.join(os.homedir(), '.dsh-qqbot', 'dota');
        this.file = path.join(root, 'ability-records.json');
        this.logger = logger ?? { warn() { } };
    }
    /** 数据文件绝对路径（诊断用） */
    get filePath() {
        return this.file;
    }
    read() {
        if (this.cache !== null)
            return this.cache;
        try {
            const raw = fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '');
            const parsed = JSON.parse(raw);
            const matches = parsed.matches !== null && typeof parsed.matches === 'object' ? parsed.matches : {};
            this.cache = { version: 1, matches: matches };
        }
        catch (err) {
            const code = err.code;
            if (code !== 'ENOENT') {
                // 坏文件不该让战绩查询挂掉，按空处理即可
                this.logger.warn(`dota: 技能记录读取失败，按空处理（${err instanceof Error ? err.message : String(err)}）`);
            }
            this.cache = { version: 1, matches: {} };
        }
        return this.cache;
    }
    write(data) {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const tmp = `${this.file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
            fs.renameSync(tmp, this.file);
        }
        catch (err) {
            // 落盘失败只记一条 warn —— 记录是附加价值，不能反过来影响查询
            this.logger.warn(`dota: 技能记录落盘失败（忽略）: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /** 写入/覆盖一场（同一场重复解析就覆盖，幂等） */
    put(rec) {
        const data = this.read();
        data.matches[String(rec.matchId)] = rec;
        // 超过上限时按时间淘汰最旧的
        const keys = Object.keys(data.matches);
        if (keys.length > MAX_MATCHES) {
            const sorted = keys.sort((a, b) => (data.matches[a]?.at ?? 0) - (data.matches[b]?.at ?? 0));
            for (const k of sorted.slice(0, keys.length - MAX_MATCHES))
                delete data.matches[k];
        }
        this.write(data);
    }
    /** 取某一场的记录 */
    get(matchId) {
        return this.read().matches[String(matchId)];
    }
    /** 最近的若干场（新的在前） */
    recent(limit = 10) {
        const all = Object.values(this.read().matches);
        all.sort((a, b) => b.at - a.at);
        return all.slice(0, Math.max(1, Math.floor(limit)));
    }
    /** 已记录多少场 */
    size() {
        return Object.keys(this.read().matches).length;
    }
}
//# sourceMappingURL=ability-records.js.map