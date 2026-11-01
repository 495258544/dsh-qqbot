import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore, type SteamSettingsLogger } from './settings.ts';

/** 17 位 SteamID64 样例（互不相等，便于断言「值是否被改写」） */
const OWNER_A = '76561198000000001';
const OWNER_B = '76561198000000002';
const OWNER_C = '76561198000000003';

/** 自己实现的收集型 logger：把 info/warn 攒下来供断言，不依赖 mock 库 */
class CollectingLogger implements SteamSettingsLogger {
  readonly infos: string[] = [];
  readonly warns: string[] = [];

  info(msg: string): void {
    this.infos.push(msg);
  }

  warn(msg: string): void {
    this.warns.push(msg);
  }
}

let dir: string;
let logger: CollectingLogger;

/** 每个用例一个独立临时目录，避免落盘状态互相污染 */
function makeStore(): SettingsStore {
  return new SettingsStore(dir, logger);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-steam-settings-'));
  logger = new CollectingLogger();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('SettingsStore', () => {
  it('空目录：ownerSteamId / apiKey 均为空串，get() 不抛错', () => {
    const store = makeStore();

    expect(() => store.get()).not.toThrow();
    expect(store.get()).toEqual({ ownerSteamId: '', apiKey: '' });
    expect(store.ownerSteamId).toBe('');
    expect(store.apiKey).toBe('');
  });

  it('首次 applyConfig(ownerSteamId)：采纳配置值，source=config，记下 consumed', () => {
    const store = makeStore();

    store.applyConfig({ ownerSteamId: OWNER_A });

    expect(store.ownerSteamId).toBe(OWNER_A);
    expect(store.get().ownerSource).toBe('config');
    expect(store.get().consumedOwnerSteamId).toBe(OWNER_A);
  });

  it('runtime 改动后再次 applyConfig 同一个旧值：保持不变（旧配置不冲运行时）', () => {
    const store = makeStore();
    store.applyConfig({ ownerSteamId: OWNER_A });

    store.setOwner(OWNER_B);
    expect(store.ownerSteamId).toBe(OWNER_B);
    expect(store.get().ownerSource).toBe('runtime');

    store.applyConfig({ ownerSteamId: OWNER_A });

    expect(store.ownerSteamId).toBe(OWNER_B);
    expect(store.get().ownerSource).toBe('runtime');
  });

  it('applyConfig 换成第三个不同值：覆盖为配置新值', () => {
    const store = makeStore();
    store.applyConfig({ ownerSteamId: OWNER_A });
    store.setOwner(OWNER_B);

    store.applyConfig({ ownerSteamId: OWNER_C });

    expect(store.ownerSteamId).toBe(OWNER_C);
    expect(store.get().ownerSource).toBe('config');
    expect(store.get().consumedOwnerSteamId).toBe(OWNER_C);
  });

  it('apiKey：首次采纳 → runtime 改写 → 同 key 不回冲 → 新 key 覆盖', () => {
    const store = makeStore();

    store.applyConfig({ apiKey: 'KEY-A' });
    expect(store.apiKey).toBe('KEY-A');
    expect(store.get().apiKeySource).toBe('config');
    expect(store.get().consumedApiKeyHash).toBeTruthy();

    store.setApiKey('KEY-B');
    expect(store.apiKey).toBe('KEY-B');
    expect(store.get().apiKeySource).toBe('runtime');

    store.applyConfig({ apiKey: 'KEY-A' });
    expect(store.apiKey).toBe('KEY-B');
    expect(store.get().apiKeySource).toBe('runtime');

    store.applyConfig({ apiKey: 'KEY-C' });
    expect(store.apiKey).toBe('KEY-C');
    expect(store.get().apiKeySource).toBe('config');
  });

  it('选项值为空串：对已有运行时值零影响', () => {
    const store = makeStore();
    store.setOwner(OWNER_B);
    store.setApiKey('KEY-RUNTIME');
    const before = store.get();

    store.applyConfig({ ownerSteamId: '', apiKey: '' });

    expect(store.ownerSteamId).toBe(OWNER_B);
    expect(store.apiKey).toBe('KEY-RUNTIME');
    expect(store.get().ownerSource).toBe('runtime');
    expect(store.get().apiKeySource).toBe('runtime');
    expect(store.get().consumedOwnerSteamId).toBe(before.consumedOwnerSteamId);
    expect(store.get().consumedApiKeyHash).toBe(before.consumedApiKeyHash);
  });

  it('setOwner 非 17 位必须抛错；applyConfig 传非法值不抛错且跳过（保留原值）', () => {
    const store = makeStore();
    store.setOwner(OWNER_A);

    expect(() => store.setOwner('123')).toThrow(/17 位/);
    expect(store.ownerSteamId).toBe(OWNER_A);
    expect(() => store.setOwner('')).toThrow();
    expect(() => store.setOwner('7656119800000000a')).toThrow();

    expect(() => store.applyConfig({ ownerSteamId: '123' })).not.toThrow();
    expect(store.ownerSteamId).toBe(OWNER_A);
    expect(store.get().ownerSource).toBe('runtime');
    expect(logger.warns.some((m) => m.includes('123'))).toBe(true);
  });

  it('clearApiKey：有 key 返回 true 并清空，无 key 返回 false', () => {
    const store = makeStore();
    store.setApiKey('KEY-A');

    expect(store.clearApiKey()).toBe(true);
    expect(store.apiKey).toBe('');
    expect(store.get().apiKeySource).toBeUndefined();

    expect(store.clearApiKey()).toBe(false);
    expect(store.apiKey).toBe('');

    const fresh = makeStore();
    expect(fresh.clearApiKey()).toBe(false);
  });

  it('settings.json 损坏：不抛错，降级为全空，并 warn', () => {
    writeFileSync(join(dir, 'settings.json'), '{{{not json', 'utf8');

    const store = makeStore();

    expect(() => store.get()).not.toThrow();
    expect(store.ownerSteamId).toBe('');
    expect(store.apiKey).toBe('');
    expect(logger.warns.length).toBeGreaterThan(0);
  });

  it('写盘原子：正常写入后目录里不残留 .tmp 文件', () => {
    const store = makeStore();
    store.setOwner(OWNER_A);
    store.setApiKey('KEY-A');
    store.applyConfig({ ownerSteamId: OWNER_B });

    const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp'));
    expect(leftovers).toEqual([]);
    expect(readdirSync(dir)).toContain('settings.json');
  });

  it('跨进程热重读：别的进程改了 settings.json，本实例不重启也要读到新 ownerSteamId', () => {
    const store = makeStore();
    store.setOwner(OWNER_A);
    expect(store.ownerSteamId).toBe(OWNER_A);

    // 模拟 scripts/steam-config.mjs：另一个进程直接改盘（结构和 persist 落盘的一致）
    const file = join(dir, 'settings.json');
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(onDisk.version).toBe(1);
    expect(onDisk.ownerSteamId).toBe(OWNER_A);

    onDisk.ownerSteamId = OWNER_B;
    onDisk.ownerSource = 'runtime';
    onDisk.ownerUpdatedAt = Date.now();
    writeFileSync(file, JSON.stringify(onDisk, null, 2), 'utf8');

    // Windows 上 mtime 精度较粗，写入过快时 mtimeMs 可能和上次读盘相同导致重读不触发，
    // 这里显式把 mtime 推到未来一个明确不同的值。
    const future = new Date(Date.now() + 1000);
    utimesSync(file, future, future);

    expect(store.ownerSteamId).toBe(OWNER_B);
    expect(store.get().ownerSteamId).toBe(OWNER_B);
    expect(store.get().ownerSource).toBe('runtime');

    // 新实例当然也能读到（确认是盘上的真实结构，不是内存里自嗨）
    expect(makeStore().ownerSteamId).toBe(OWNER_B);

    // 热重读之后继续写盘，不能把外来的值弹回旧值
    store.setApiKey('KEY-A');
    expect(store.ownerSteamId).toBe(OWNER_B);
  });

  it('clearApiKey 之后 applyConfig 同一个 key：必须能重新采纳（consumedApiKeyHash 已一并清除）', () => {
    const store = makeStore();

    store.applyConfig({ apiKey: 'KEY-A' });
    const firstHash = store.get().consumedApiKeyHash;
    expect(store.apiKey).toBe('KEY-A');
    expect(firstHash).toBeTruthy();

    // 同一个 key 再配一次：指纹未变，不应重复采纳（对照组）
    store.setApiKey('KEY-B');
    store.applyConfig({ apiKey: 'KEY-A' });
    expect(store.apiKey).toBe('KEY-B');

    expect(store.clearApiKey()).toBe(true);
    expect(store.apiKey).toBe('');
    // 核心断言：指纹必须随 key 一起清掉，否则同一个 key 再也配不回来
    expect(store.get().consumedApiKeyHash).toBeUndefined();

    store.applyConfig({ apiKey: 'KEY-A' });
    expect(store.apiKey).toBe('KEY-A');
    expect(store.get().apiKeySource).toBe('config');
    expect(store.get().consumedApiKeyHash).toBe(firstHash);

    // 重新采纳后盘上也落了 key（热重读/新进程都能看到）
    expect(makeStore().apiKey).toBe('KEY-A');
  });

  it('clearApiKey 只动 key 相关字段，不动 owner 相关字段', () => {
    const store = makeStore();
    store.applyConfig({ ownerSteamId: OWNER_A });
    store.setApiKey('KEY-A');
    const before = store.get();

    expect(store.clearApiKey()).toBe(true);

    expect(store.ownerSteamId).toBe(OWNER_A);
    expect(store.get().ownerSource).toBe('config');
    expect(store.get().consumedOwnerSteamId).toBe(before.consumedOwnerSteamId);
  });

  it('文件被外部删除：语义是「回到未设置」，不是抱着内存旧值不放', () => {
    const store = makeStore();
    store.setOwner(OWNER_A);

    rmSync(join(dir, 'settings.json'));

    expect(() => store.get()).not.toThrow();
    expect(store.ownerSteamId).toBe('');
    expect(store.apiKey).toBe('');
    expect(makeStore().ownerSteamId).toBe('');
  });
});
