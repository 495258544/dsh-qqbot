#!/usr/bin/env node
/**
 * 导出 Steam 好友列表为可填写的表格
 * ─────────────────────────────────────────────────────────────
 * 用途：把「Steam 好友」和「QQ 群里的人」对上号。
 *       QQ 和 Steam 之间没有任何自动关联手段，只能人工填一次。
 *
 * 用法：
 *   node scripts/steam-friends-export.mjs                  # 用 config 里的 ownerSteamId
 *   node scripts/steam-friends-export.mjs 7656119xxxxxxxxxx  # 指定起点账号
 *   node scripts/steam-friends-export.mjs --out D:/x.txt
 *
 * 输出（默认写到 ~/steam-friends.txt，同时生成同名 .tsv）：
 *   - .txt  给人看的表格，最后一列留空填 QQ 群昵称/QQ号
 *   - .tsv  制表符分隔，可直接粘进 Excel / WPS
 *
 * 前提：被查账号必须在 Steam 隐私设置里把「好友列表」设为公开，
 *       否则 Steam 返回 401，脚本会明确提示（这不是 bug）。
 *
 * 网络：本机若有 HTTPS_PROXY 且 node 不信任代理证书，可这样跑：
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 NODE_USE_ENV_PROXY=1 node scripts/steam-friends-export.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { SteamApi, SteamApiError } from '../lib/steam/steam-api.js';

const PATCH_FILE = path.join(homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml');

/** 从 profile 的 cordis.patch.yml 里抠出 steam 段（不引 yaml 依赖，按缩进取） */
function readSteamConfig() {
  const out = { apiKey: '', ownerSteamId: '' };
  let text;
  try {
    text = readFileSync(PATCH_FILE, 'utf8');
  } catch {
    return out;
  }
  const lines = text.split(/\r?\n/);
  let inSteam = false;
  let steamIndent = -1;
  for (const line of lines) {
    const m = /^(\s*)steam:\s*$/.exec(line);
    if (m) {
      inSteam = true;
      steamIndent = m[1].length;
      continue;
    }
    if (!inSteam) continue;
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= steamIndent) {
      inSteam = false;
      continue;
    }
    const kv = /^\s*(apiKey|ownerSteamId):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function parseArgs(argv) {
  const args = { steamId: '', out: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') {
      args.out = argv[i + 1] ?? '';
      i += 1;
    } else if (!a.startsWith('--') && args.steamId === '') {
      args.steamId = a;
    }
  }
  return args;
}

/** 按显示宽度补空格（中文占 2 格），让纯文本表格能对齐 */
function pad(value, width) {
  const text = String(value ?? '');
  let w = 0;
  for (const ch of text) w += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
  return text + ' '.repeat(Math.max(0, width - w));
}

/** 显示宽度（中文算 2 格） */
function displayWidth(value) {
  let w = 0;
  for (const ch of String(value ?? '')) w += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
  return w;
}

// PlayerSummary 的字段是 personaStateText / gameName，别和 FriendEntry 的 stateText 混用
const stateText = (s) => (s.gameName !== undefined ? `正在玩 ${s.gameName}` : s.personaStateText);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = readSteamConfig();
  const apiKey = cfg.apiKey;
  const steamId = args.steamId || cfg.ownerSteamId;

  if (apiKey === '') {
    console.error('✗ 没有找到 Steam Web API Key。请先填 profile 的 cordis.patch.yml → steam.apiKey');
    process.exit(1);
  }
  if (steamId === '') {
    console.error('✗ 没指定起点账号。用法：node scripts/steam-friends-export.mjs 7656119xxxxxxxxxx');
    console.error('  （或把它写进 cordis.patch.yml 的 steam.ownerSteamId）');
    process.exit(1);
  }
  if (!/^\d{17}$/.test(steamId)) {
    console.error(`✗ ${steamId} 不是 17 位 SteamID64。主页链接请先在浏览器地址栏里的数字部分取出来`);
    process.exit(1);
  }

  const api = new SteamApi({ apiKey, timeoutMs: 20000 });

  console.log(`→ 拉取 ${steamId} 的好友列表…`);
  let records;
  try {
    records = await api.getFriendList(steamId);
  } catch (err) {
    if (err instanceof SteamApiError) {
      if (err.kind === 'friendlist-private') {
        console.error('✗ 对方把「好友列表」设成了私密，Steam 拒绝返回（HTTP 401）。');
        console.error('  解决：Steam → 个人资料 → 编辑个人资料 → 隐私设置 → 把「好友列表」改成「公开」。');
        console.error('  注意这和「个人资料」「游戏详情」是三个独立开关。');
      } else if (err.kind === 'unauthorized') {
        console.error('✗ API Key 无效或已被吊销（HTTP 403）。去 https://steamcommunity.com/dev/apikey 重新申请。');
      } else {
        console.error(`✗ 失败了（${err.kind}）：${err.message}`);
      }
      process.exit(2);
    }
    throw err;
  }

  console.log(`  好友 ${records.length} 人，正在取昵称与主页地址…`);
  const ids = records.map((r) => r.steamId);
  const summaries = ids.length > 0 ? await api.getSummaries(ids) : new Map();
  const owner = (await api.getSummaries([steamId]).catch(() => new Map())).get(steamId);

  const rows = records.map((r) => {
    const s = summaries.get(r.steamId);
    return {
      steamId: r.steamId,
      friendSince: r.friendSince,
      name: s?.personaName && s.personaName !== '' ? s.personaName : '(昵称不可见)',
      profileUrl: s?.profileUrl ?? `https://steamcommunity.com/profiles/${r.steamId}/`,
      state: s !== undefined ? stateText(s) : '未知',
      inGame: s?.gameName,
      visibility: s?.visibility ?? 0,
    };
  });

  // 正在玩的排最前，其次在线，最后离线
  const rank = (r) => (r.inGame !== undefined ? 0 : r.state === '离线' ? 2 : 1);
  rows.sort((a, b) => (rank(a) - rank(b)) || a.name.localeCompare(b.name, 'zh-CN'));

  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const ownerName = owner?.personaName ?? '(未知)';

  // ── 纯文本表格 ──
  const head = ['#', 'Steam 昵称', '状态', 'SteamID64', '主页地址', 'QQ群昵称/QQ号'];
  const body = rows.map((r, i) => [
    String(i + 1),
    r.name,
    r.state,
    r.steamId,
    r.profileUrl,
    '',
  ]);

  const widths = head.map((h, col) => {
    const w = body.reduce((max, row) => Math.max(max, displayWidth(row[col])), 0);
    return Math.max(w, displayWidth(h)) + 2;
  });

  const lines = [];
  lines.push('Steam 好友列表');
  lines.push('='.repeat(100));
  lines.push(`起点账号：${ownerName}  (${steamId})`);
  if (owner?.profileUrl !== undefined && owner.profileUrl !== '') lines.push(`账号主页：${owner.profileUrl}`);
  lines.push(`好友总数：${rows.length} 人　·　导出时间：${stamp}`);
  lines.push('');
  lines.push('最后一列留空，填上这个人在 QQ 群里的昵称（或 QQ 号）。填完可以直接当群友称呼用。');
  lines.push('★ 标记 = 导出时正在玩游戏');
  lines.push('');
  lines.push(head.map((h, i) => pad(h, widths[i])).join(''));
  lines.push(widths.map((w) => '-'.repeat(w)).join(''));
  for (let i = 0; i < body.length; i += 1) {
    const row = [...body[i]];
    if (rows[i].inGame !== undefined) row[0] = `${row[0]} ★`;
    lines.push(row.map((cell, col) => pad(cell, widths[col])).join(''));
  }
  lines.push('');
  const playing = rows.filter((r) => r.inGame !== undefined);
  if (playing.length > 0) {
    lines.push('正在玩：');
    for (const r of playing) lines.push(`  · ${r.name} — ${r.inGame}`);
    lines.push('');
  }
  lines.push('说明：');
  lines.push('  · 主页地址形如 /id/xxx 的是对方设了自定义 ID；/profiles/数字 是不想露自定义 ID 的。');
  lines.push('  · 状态显示「离线」不代表不在线，只是没公开或没登录 Steam 客户端。');
  lines.push('  · 想查 Dota2 战绩，对方还需在游戏内设置里开启「公开比赛数据」。');

  const outPath = args.out !== '' ? args.out : path.join(homedir(), 'steam-friends.txt');
  const tsvPath = outPath.replace(/\.txt$/i, '') + '.tsv';
  writeFileSync(outPath, lines.join('\r\n') + '\r\n', 'utf8');

  // ── TSV（粘 Excel 用，不补空格） ──
  const tsv = [head.join('\t')];
  for (const r of rows) {
    tsv.push([r.name, r.state, r.steamId, r.profileUrl, ''].join('\t'));
  }
  writeFileSync(tsvPath, '\ufeff' + tsv.join('\r\n') + '\r\n', 'utf8');

  console.log(`\n✓ 已写出：`);
  console.log(`  ${outPath}`);
  console.log(`  ${tsvPath}　（制表符分隔，可直接粘进 Excel/WPS）`);
  console.log('');
  console.log(lines.slice(0, 8).join('\n'));
  if (rows.length > 0) {
    console.log('');
    console.log(head.map((h, i) => pad(h, widths[i])).join(''));
    console.log(widths.map((w) => '-'.repeat(w)).join(''));
    for (let i = 0; i < Math.min(body.length, 20); i += 1) {
      console.log(body[i].map((cell, col) => pad(cell, widths[col])).join(''));
    }
    if (body.length > 20) console.log(`… 其余 ${body.length - 20} 行见文件`);
  }
}

main().catch((err) => {
  console.error('✗ 未预期的错误：', err);
  process.exit(3);
});
