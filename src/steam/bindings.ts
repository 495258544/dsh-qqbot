/**
 * QQ 用户 ↔ Steam 账号 绑定表
 * ─────────────────────────────────────────────────────────────
 * QQ 和 Steam 之间没有任何官方关联手段，所以这张表是整件事的地基：
 * 没有绑定，就只能查到「某个 SteamID」而不知道他是群里的谁。
 *
 * 两条写入通道：
 *   - 自助：群友说「我 Steam 是 xxx」，agent 调 qq_steam_bind 写入，
 *     key 取消息发送者的 openid，**不能用参数里的身份**，否则任何人都能替别人绑。
 *   - 预置：config.steam.friends（openid → steam 账号），管理员维护。
 *
 * 两者关系：配置是权威。每次启动先清掉 source='config' 的条目再按配置重写，
 * 这样从配置里删人 = 下次启动即解绑；source='self' 的自助绑定不受影响。
 */
import fs from 'node:fs';
import path from 'node:path';

export type BindingSource = 'self' | 'config';

export interface SteamBinding {
  /** SteamID64（永远只存这一种形态，vanity 在绑定时就解析掉） */
  steamId: string;
  /** 群里怎么称呼他（自助绑定时可留空，之后由 agent 补） */
  alias?: string;
  boundAt: number;
  source: BindingSource;
}

interface BindingFile {
  version: 1;
  bindings: Record<string, SteamBinding>;
}

/** 命中一条绑定的匹配方式，用于给回复文案加"我理解成了谁"的依据 */
export type BindingMatchBy = 'openid' | 'steamid' | 'alias';

export interface BindingHit {
  openid: string;
  binding: SteamBinding;
  matchedBy: BindingMatchBy;
}

export class BindingStore {
  private readonly file: string;
  private readonly logger: { info(msg: string): void; warn(msg: string): void };
  private cache: Record<string, SteamBinding> | undefined;

  constructor(dir: string, logger: { info(msg: string): void; warn(msg: string): void }) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'bindings.json');
    this.logger = logger;
  }

  /** 读全表（懒加载 + 内存缓存；文件损坏时降级为空表而不是抛错） */
  private read(): Record<string, SteamBinding> {
    if (this.cache !== undefined) return this.cache;
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<BindingFile>;
      const bindings = parsed.bindings ?? {};
      // 过滤掉形态不对的残留条目，避免旧版本数据把整张表带坏
      const clean: Record<string, SteamBinding> = {};
      for (const [openid, value] of Object.entries(bindings)) {
        if (value && typeof value.steamId === 'string' && /^\d{17}$/.test(value.steamId)) {
          clean[openid] = {
            steamId: value.steamId,
            ...(typeof value.alias === 'string' && value.alias !== '' ? { alias: value.alias } : {}),
            boundAt: Number(value.boundAt ?? 0),
            source: value.source === 'config' ? 'config' : 'self',
          };
        }
      }
      this.cache = clean;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.logger.warn(`steam: 绑定表读取失败，按空表处理: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.cache = {};
    }
    return this.cache;
  }

  /** 原子写：先写 .tmp 再 rename，避免进程被杀时留下半个 JSON */
  private write(bindings: Record<string, SteamBinding>): void {
    const payload: BindingFile = { version: 1, bindings };
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
    this.cache = bindings;
  }

  list(): Array<{ openid: string; binding: SteamBinding }> {
    return Object.entries(this.read()).map(([openid, binding]) => ({ openid, binding }));
  }

  get(openid: string): SteamBinding | undefined {
    return this.read()[openid];
  }

  size(): number {
    return Object.keys(this.read()).length;
  }

  /** 写入/覆盖一条绑定 */
  set(openid: string, binding: SteamBinding): void {
    const all = { ...this.read() };
    all[openid] = binding;
    this.write(all);
  }

  /** 解绑，返回是否真的删掉了 */
  remove(openid: string): boolean {
    const all = { ...this.read() };
    if (all[openid] === undefined) return false;
    delete all[openid];
    this.write(all);
    return true;
  }

  /**
   * 用配置预置同步绑定表。
   * 配置是权威：先清空所有 source='config' 的条目，再按配置重写；
   * 自助绑定（source='self'）原样保留。
   */
  syncFromConfig(friends: Record<string, string>): void {
    const all = { ...this.read() };
    let removed = 0;
    for (const [openid, binding] of Object.entries(all)) {
      if (binding.source === 'config') {
        delete all[openid];
        removed += 1;
      }
    }
    let written = 0;
    for (const [openid, steamId] of Object.entries(friends)) {
      if (!/^\d{17}$/.test(steamId)) {
        this.logger.warn(`steam: 配置里的 friends["${openid}"] 不是 SteamID64（需要 17 位数字），已跳过`);
        continue;
      }
      all[openid] = { steamId, boundAt: Date.now(), source: 'config' };
      written += 1;
    }
    this.write(all);
    if (written > 0 || removed > 0) {
      this.logger.info(`steam: 配置同步完成（预置 ${written} 条，清理旧配置条目 ${removed} 条）`);
    }
  }

  /**
   * 按任意标识找绑定，按优先级返回全部命中：
   *   openid 精确 → SteamID 精确 → 别名包含（不区分大小写）
   * 别名可能撞车（两个人都叫"老王"），所以返回数组由调用方决定怎么挑。
   */
  find(who: string): BindingHit[] {
    const query = String(who ?? '').trim();
    if (query === '') return [];
    const all = this.read();

    const byOpenid = all[query];
    if (byOpenid !== undefined) {
      return [{ openid: query, binding: byOpenid, matchedBy: 'openid' }];
    }

    if (/^\d{17}$/.test(query)) {
      const hits = Object.entries(all)
        .filter(([, b]) => b.steamId === query)
        .map(([openid, binding]) => ({ openid, binding, matchedBy: 'steamid' as const }));
      if (hits.length > 0) return hits;
    }

    const lower = query.toLowerCase();
    // openid 是 32 位十六进制串，拿一两个字去匹配会命中一大片；
    // 所以 openid 只接受较长（≥6）的包含匹配，别名则可以短词。
    const canMatchOpenid = lower.length >= 6;
    return Object.entries(all)
      .filter(([openid, b]) =>
        (b.alias ?? '').toLowerCase().includes(lower)
        || (canMatchOpenid && openid.toLowerCase().includes(lower)))
      .map(([openid, binding]) => ({ openid, binding, matchedBy: 'alias' as const }));
  }
}
