/**
 * SteamID 解析与互转（零依赖）
 * ─────────────────────────────────────────────────────────────
 * 群里能收集到的输入形态非常杂：SteamID64、STEAM_0:1:xxx、[U:1:xxx]、
 * 个人主页链接、自定义 ID（vanity）、甚至带追踪参数的分享链接。
 * 先在这里归一成两种形态，后续才不用到处 if：
 *   - id64   —— 可以直接查 API
 *   - vanity —— 需要调 ResolveVanityURL 才能变成 id64
 *
 * 换算公式以 Valve 官方 wiki 为准（其自带示例数字有误，不要照抄）：
 *   accountId = SteamID64 - 76561197960265728
 *   STEAM_0:Y:Z 中 Y = accountId & 1，Z = accountId >> 1
 */

/** 个人账号 + Public universe 的 64 位基址 */
const ID64_BASE = 76561197960265728n;

/** 合法 SteamID64：17 位数字且不小于基址（更小的属于组/服务器账号） */
export function isSteamId64(value: string): boolean {
  if (!/^\d{17}$/.test(value)) return false;
  return BigInt(value) >= ID64_BASE;
}

/** SteamID64 → accountId（十进制字符串） */
export function steam64ToAccountId(id64: string): string {
  return (BigInt(id64) - ID64_BASE).toString();
}

/** SteamID64 → STEAM_x:Y:Z（x 为 universe，个人公开号固定 0） */
export function steam64ToSteam2(id64: string): string {
  const accountId = BigInt(id64) - ID64_BASE;
  return `STEAM_0:${accountId & 1n}:${accountId >> 1n}`;
}

/** SteamID64 → [U:1:accountId] */
export function steam64ToSteam3(id64: string): string {
  return `[U:1:${steam64ToAccountId(id64)}]`;
}

/** accountId(Y/Z) → SteamID64 */
function accountIdToSteam64(y: bigint, z: bigint): string {
  return (ID64_BASE + z * 2n + y).toString();
}

/** 个人主页地址（展示用） */
export function steamProfileUrl(id64: string): string {
  return `https://steamcommunity.com/profiles/${id64}`;
}

/** 游戏图标地址；img_icon_url 为空时回退到商店 header 图 */
export function steamGameIconUrl(appId: number, iconHash?: string): string {
  if (iconHash !== undefined && iconHash !== '') {
    return `https://media.steampowered.com/steamcommunity/public/images/apps/${appId}/${iconHash}.jpg`;
  }
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;
}

export type SteamIdParse =
  | { kind: 'id64'; id64: string }
  | { kind: 'vanity'; vanity: string }
  | { kind: 'invalid'; reason: string };

/**
 * 解析任意形态的 Steam 账号输入。
 * 不联网：vanity 只做形态判定，真正解析交给 ResolveVanityURL。
 */
export function parseSteamInput(raw: string): SteamIdParse {
  const text = String(raw ?? '').trim();
  if (text === '') return { kind: 'invalid', reason: '输入为空' };

  // 1. 纯 17 位数字
  if (isSteamId64(text)) return { kind: 'id64', id64: text };

  // 2. STEAM_x:Y:Z
  //    注意：这里忽略 universe（x）。社区里 STEAM_0:1:xxx 与 STEAM_1:1:xxx 都用来
  //    指同一个公开账号，而 SteamID64 恒为 universe=1，所以统一按 accountId 换算。
  //    代价是 STEAM_1 输入转回文本时会变成 STEAM_0 —— 指向同一账号，不影响使用。
  const steam2 = text.match(/^STEAM_[0-5]:([01]):(\d{1,10})$/i);
  if (steam2) {
    const y = steam2[1];
    const z = steam2[2];
    if (y !== undefined && z !== undefined) {
      return { kind: 'id64', id64: accountIdToSteam64(BigInt(y), BigInt(z)) };
    }
  }

  // 3. [U:1:accountId]
  const steam3 = text.match(/^\[U:1:(\d{1,10})\]$/i);
  if (steam3) {
    const accountId = steam3[1];
    if (accountId !== undefined) {
      const n = BigInt(accountId);
      return { kind: 'id64', id64: accountIdToSteam64(n & 1n, n >> 1n) };
    }
  }

  // 4. 链接形态：/profiles/<id64> 直接取数字，/id/<vanity> 走 vanity
  const fromUrl = parseProfileUrl(text);
  if (fromUrl !== undefined) return fromUrl;

  // 5. 纯数字但不足 17 位：多数是 accountId 或 QQ 号误填，明确拒绝而不是猜
  if (/^\d+$/.test(text)) {
    return { kind: 'invalid', reason: `${text} 不是 SteamID64（需要 17 位，可在 steamid.io 查询）` };
  }

  // 6. 剩下的当自定义 ID（只用合法字符，避免把一句中文当 ID 去打 API）
  if (/^[A-Za-z0-9_-]{2,64}$/.test(text)) return { kind: 'vanity', vanity: text };

  return { kind: 'invalid', reason: `无法识别的 Steam 账号: ${text.slice(0, 40)}` };
}

/** 从各种 Steam 链接里抽取 id64 / vanity */
function parseProfileUrl(text: string): SteamIdParse | undefined {
  if (!/steamcommunity\.com/i.test(text)) return undefined;

  const profile = text.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
  if (profile) {
    const id = profile[1];
    // 必须和裸数字输入走同一套校验：低于基址的是组/服务器账号，不是个人号。
    // 少了这一步，/profiles/ 链接就成了绕过校验的后门（已验证过的真实缺陷）。
    if (id !== undefined && isSteamId64(id)) return { kind: 'id64', id64: id };
    return { kind: 'invalid', reason: `链接里的 ${id ?? ''} 不是个人账号的 SteamID64（低于账号基址，可能是组或服务器 ID）` };
  }

  const vanity = text.match(/steamcommunity\.com\/id\/([A-Za-z0-9_-]+)/i);
  if (vanity) {
    const name = vanity[1];
    if (name !== undefined) return { kind: 'vanity', vanity: name };
  }

  return { kind: 'invalid', reason: '这是一个 Steam 链接，但既没有 /profiles/ 数字也没有 /id/ 名称' };
}
