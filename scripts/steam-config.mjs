#!/usr/bin/env node
/**
 * 管理 Steam 凭据与主人账号
 * ─────────────────────────────────────────────────────────────
 * 用途：把「Steam Web API Key」和「主人自己的 Steam 账号」写进数据目录，
 *       不用去改只读的插件配置文件 cordis.patch.yml。
 *
 *       所有值都存在 ~/.dsh-qqbot/steam/settings.json（可用 --dir 换目录），
 *       和群友绑定放在一起 —— 整个目录拷走 = 凭据和主人账号一起迁移。
 *
 * 用法（参数顺序无关，可以一次给多个）：
 *   node scripts/steam-config.mjs                    # 查看当前状态（等同 --show）
 *   node scripts/steam-config.mjs --key <key>        # 设置 Steam Web API Key
 *   node scripts/steam-config.mjs --clear-key        # 清除已保存的 key
 *   node scripts/steam-config.mjs --owner <账号>      # 设置主人账号
 *   node scripts/steam-config.mjs --dir <path>       # 指定数据目录
 *
 * --owner 接受三种写法：
 *   76561198021492742                                直接给 17 位 SteamID64（不联网）
 *   https://steamcommunity.com/profiles/76561198021492742  主页链接，正则抠数字（不联网）
 *   https://steamcommunity.com/id/somebody  或  裸 vanity 名      需要联网解析（要 key）
 *
 * 安全：key 只打印前 4 位 + 后 4 位，完整 key 不会出现在控制台输出里。
 *
 * 退出码：0 成功 / 1 用法不对或缺 key / 2 网络或 Steam API 失败 / 3 未预期错误
 *
 * 网络：本机若有 HTTPS_PROXY 且 node 不信任代理证书，可这样跑：
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 NODE_USE_ENV_PROXY=1 node scripts/steam-config.mjs --show
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB_STEAM_DIR = path.join(HERE, '..', 'lib', 'steam');

// ── 编译产物自检 ──────────────────────────────────────────────
// 脚本跑的是 lib/ 下编译后的实现，不是 src/ 下的 TS。没 build 过就没有这些文件，
// 这时候必须明确告诉用户去 build，而不是抛一个看不懂的 MODULE_NOT_FOUND。
for (const name of ['settings.js', 'steam-api.js']) {
  if (!existsSync(path.join(LIB_STEAM_DIR, name))) {
    console.error(`✗ 找不到 lib/steam/${name} —— 项目还没编译过。`);
    console.error('  请先在项目根目录执行 npm run build，再回来跑本脚本。');
    process.exit(1);
  }
}

const { SettingsStore } = await import(pathToFileURL(path.join(LIB_STEAM_DIR, 'settings.js')).href);
const { SteamApi, SteamApiError } = await import(pathToFileURL(path.join(LIB_STEAM_DIR, 'steam-api.js')).href);

/** SettingsStore 只要这两个方法 */
const logger = {
  info: (msg) => console.log(`· ${msg}`),
  warn: (msg) => console.warn(`⚠ ${msg}`),
};

const USAGE = `用法：
  node scripts/steam-config.mjs                       查看当前状态（默认行为）
  node scripts/steam-config.mjs --owner <账号>         设置主人账号（17 位 ID / 主页链接 / 自定义 ID）
  node scripts/steam-config.mjs --key <key>            设置 Steam Web API Key
  node scripts/steam-config.mjs --clear-key            清除已保存的 key
  node scripts/steam-config.mjs --dir <path>           指定数据目录（默认 ~/.dsh-qqbot/steam）

key 申请地址：https://steamcommunity.com/dev/apikey
所有值都写在数据目录的 settings.json 里，不用去改 cordis.patch.yml。`;

/** 参数解析：顺序无关；缺值、多值、不认识的参数都算用法错误（退出码 1） */
function parseArgs(argv) {
  const args = { owner: '', key: '', clearKey: false, dir: '', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--show') continue; // 显式写出来也只是查看，不改变行为
    if (a === '--clear-key') {
      args.clearKey = true;
      continue;
    }
    if (a === '--owner' || a === '--key' || a === '--dir') {
      const value = argv[i + 1];
      // 值缺失、为空、或看起来像下一个参数，都当成用法错误
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new Error(`${a} 后面要跟一个值（当前收到「${value ?? '（没有）'}」）`);
      }
      args[a.slice(2)] = value;
      i += 1;
      continue;
    }
    throw new Error(`不认识的参数「${a}」`);
  }
  return args;
}

/** key 是凭据，任何输出场合都只显示前 4 位 + 后 4 位 */
function maskKey(key) {
  if (key === '') return '(未设置)';
  if (key.length <= 8) return '*'.repeat(key.length);
  return `${key.slice(0, 4)}${'*'.repeat(8)}${key.slice(-4)}`;
}

/** config = 来自插件选项，runtime = 用户后来在聊天/命令行里设的 */
function sourceText(source) {
  if (source === 'config') return 'config（插件选项）';
  if (source === 'runtime') return 'runtime（命令行/聊天写入）';
  return '(未记录)';
}

function formatTime(ms) {
  if (typeof ms !== 'number' || ms <= 0) return '(未知)';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 判断用户给的是哪种账号写法。
 * 纯数字 / profiles 链接不必联网，vanity 才需要调 ResolveVanityURL。
 */
function classifyAccount(raw) {
  const text = raw.trim();
  if (/^\d{17}$/.test(text)) return { kind: 'id', value: text };
  const profile = /\/profiles\/(\d{17})/.exec(text);
  if (profile !== null) return { kind: 'id', value: profile[1] };
  const vanity = /(?:steamcommunity\.com\/)?id\/([^/?#\s]+)/i.exec(text);
  if (vanity !== null) return { kind: 'vanity', value: decodeURIComponent(vanity[1]) };
  // 既不是 17 位数字也不是链接 —— 当成裸 vanity 名（数字串就不猜了，直接报错）
  if (/^[A-Za-z0-9_-]+$/.test(text) && !/^\d+$/.test(text)) return { kind: 'vanity', value: text };
  return { kind: 'bad', value: text };
}

/** 建一个 SteamApi；key 为空返回 null（本脚本对此有单独的处理文案） */
function makeApi(apiKey) {
  return apiKey === '' ? null : new SteamApi({ apiKey, timeoutMs: 20000 });
}

/** 打印当前状态 */
function printStatus(store) {
  const s = store.get();
  const line = '─'.repeat(64);
  console.log('Steam 凭据与主人账号');
  console.log(line);
  console.log(`数据文件　：${store.filePath}`);
  if (s.ownerSteamId === '') {
    console.log('主人账号　：(未设置)');
  } else {
    console.log(`主人账号　：${s.ownerSteamId}`);
    console.log(`　　　　　　来源 ${sourceText(s.ownerSource)}　更新于 ${formatTime(s.ownerUpdatedAt)}`);
  }
  if (s.apiKey === '') {
    console.log('API Key 　：(未设置)');
  } else {
    console.log(`API Key 　：${maskKey(s.apiKey)}　（已脱敏，完整 key 不打印）`);
    console.log(`　　　　　　来源 ${sourceText(s.apiKeySource)}　更新于 ${formatTime(s.apiKeyUpdatedAt)}`);
  }
  console.log(line);

  // 缺什么就提示下一步该敲什么，别让人自己去翻文档
  if (s.apiKey === '') {
    console.log('· 还没有 API Key，只能绑定不能查询。设置：');
    console.log('    node scripts/steam-config.mjs --key <你的 key>');
    console.log('  申请地址：https://steamcommunity.com/dev/apikey（域名随便填都行）');
  }
  if (s.ownerSteamId === '') {
    console.log('· 还没设主人账号（好友列表的起点）。设置：');
    console.log('    node scripts/steam-config.mjs --owner <主页链接或 17 位 SteamID64>');
  }
  if (s.apiKey !== '' && s.ownerSteamId !== '') {
    console.log('· 已就绪。要拉好友列表的话，这个账号的 Steam 隐私设置里');
    console.log('  「好友列表」需要设为公开（和个人资料、游戏详情是三个独立开关）。');
  }
  console.log('· 改完立即生效，不用重启宿主；也不用去改 cordis.patch.yml。');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`✗ ${err.message}`);
    console.error('');
    console.error(USAGE);
    return 1;
  }

  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  // --dir 给的是目录，settings.json 由 SettingsStore 自己拼
  const dir = args.dir !== '' ? path.resolve(args.dir) : path.join(homedir(), '.dsh-qqbot', 'steam');
  const store = new SettingsStore(dir, logger);

  // 顺序有意义：先 --key，这样同一次命令里 --owner 就能立刻联网确认昵称
  if (args.key !== '') {
    store.setApiKey(args.key);
    console.log(`✓ API Key 已写入　${maskKey(store.apiKey)}`);
  }

  if (args.clearKey) {
    const cleared = store.clearApiKey();
    console.log(cleared ? '✓ 已清除 API Key' : '· 本来就没有 API Key，无需清除');
  }

  if (args.owner !== '') {
    const info = classifyAccount(args.owner);
    if (info.kind === 'bad') {
      console.error(`✗ 「${info.value}」看不懂。请给 17 位 SteamID64，`);
      console.error('  或形如 https://steamcommunity.com/profiles/76561198021492742 的主页链接。');
      return 1;
    }

    let steamId = info.kind === 'id' ? info.value : '';
    if (info.kind === 'vanity') {
      const api = makeApi(store.apiKey);
      if (api === null) {
        console.error('✗ 解析自定义 ID 需要 API Key，请先 --key，或直接给 17 位 SteamID64');
        return 1;
      }
      console.log(`→ 解析自定义 ID「${info.value}」…`);
      try {
        steamId = await api.resolveVanity(info.value);
      } catch (err) {
        if (err instanceof SteamApiError && err.kind === 'unauthorized') {
          console.error('✗ API Key 无效或已被吊销（HTTP 403）。去 https://steamcommunity.com/dev/apikey 重新申请。');
        } else {
          console.error(`✗ 自定义 ID「${info.value}」解析失败：${err.message}`);
        }
        return 2;
      }
      console.log(`  解析结果：${steamId}`);
    }

    store.setOwner(steamId);
    console.log(`✓ 主人账号已写入　${steamId}`);

    // 已配 key 就顺手查一次昵称，让用户确认绑的是不是本人
    const api = makeApi(store.apiKey);
    if (api !== null) {
      try {
        const summary = (await api.getSummaries([steamId])).get(steamId);
        if (summary === undefined) {
          console.warn('⚠ Steam 没返回这个账号的资料，没法确认昵称（账号已写入）。');
          console.warn('  多半是隐私设置把个人资料设成了私密。');
        } else {
          console.log(`  确认一下是不是本人 —— Steam 昵称：${summary.personaName}`);
          if (summary.profileUrl !== undefined) console.log(`  主页：${summary.profileUrl}`);
        }
      } catch (err) {
        // 账号已经存好了，这里失败只是没能确认昵称
        if (err instanceof SteamApiError && err.kind === 'unauthorized') {
          console.warn('⚠ API Key 无效或已被吊销（HTTP 403），没法确认昵称（账号已写入）。');
        } else {
          console.warn(`⚠ 联网确认昵称失败：${err.message}（账号已写入）`);
        }
        console.warn('  确认不了也不影响使用，改天再跑一次 --show 即可。');
        return 2;
      }
    }
    console.log('· 提醒：要让机器人拉到好友列表，这个账号的 Steam 隐私设置里');
    console.log('  「好友列表」需要设为公开（和个人资料、游戏详情是三个独立开关）。');
  }

  // 不管做了什么，最后都把当前状态打一遍，省得再跑一次命令
  console.log('');
  printStatus(store);
  return 0;
}

const code = await main().catch((err) => {
  console.error('✗ 未预期的错误：', err);
  return 3;
});
if (code !== 0) process.exitCode = code;
