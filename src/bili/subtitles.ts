/**
 * B 站字幕时间轴压缩（平台模块 src/bili/ 的内部实现）
 * 2026-11-10 从 persona/tools.ts 整块搬出，代码逐字未改。
 */
/** mm:ss */
export function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 把逐句字幕压成「每分钟一条」，保留时间轴（M35）。
 *
 * ## 为什么按分钟
 *
 * 用户要的是「哪几分钟真正讲到东西」——分钟是人的导航单位：
 * 他说"第 15 分钟在讲 ACL"，能直接跳过去；给秒级时间轴反而没法扫。
 *
 * ## 为什么每分钟取最长的两三句
 *
 * 字幕是口语，信息密度极不均匀。实测一个 27 分钟的教学视频：
 * 全文 8925 字，每句平均 12 字，直接给全文 ≈ 6000 tokens。
 * 每分钟只留最长的 2 句 → 1295 字（压缩 6.9 倍）≈ 863 tokens，
 * 而这两句通常就是这一分钟里"信息量最大"的话。
 *
 * **这只是压缩，不是判断"值不值得看"。**
 * 中文口语里"所以/但是/这个"全是填充词，纯统计找不到干货
 * （我试过按论述标记词打分，抽出来的是「默认路由啊策略路由是吧AACL路由」——
 * 标记词密但看不出在讲什么）。要判断值不值得看，必须再过一次语义。
 */
export function condenseSubtitlesByMinute(
  items: Array<{ from?: number; to?: number; content?: string }>,
  opts: { perMinute?: number } = {},
): Array<{ t: string; text: string }> {
  const per = Math.max(1, opts.perMinute ?? 2);
  const buckets = new Map<number, Array<{ at: number; text: string }>>();
  for (const it of items) {
    const text = String(it.content ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const at = Math.max(0, Number(it.from) || 0);
    const m = Math.floor(at / 60);
    const arr = buckets.get(m) ?? [];
    arr.push({ at, text });
    buckets.set(m, arr);
  }
  const out: Array<{ t: string; text: string }> = [];
  for (const m of [...buckets.keys()].sort((a, b) => a - b)) {
    const arr = buckets.get(m) ?? [];
    // 这一分钟里最长的几句 —— 长句通常承载更多信息（短句多是"啊""对吧"）
    const picked = [...arr].sort((a, b) => b.text.length - a.text.length).slice(0, per);
    // 按时间顺序还原，读起来才是连贯的
    picked.sort((a, b) => a.at - b.at);
    // 时间戳用这一分钟**第一句**的真实时间，而不是 m*60。
    // 否则 62 分 5 秒会被写成 62:00 —— 分钟内的秒位信息白丢了，
    // 而用户正是要按这个时间点去跳。
    const firstAt = arr.reduce((a, b) => Math.min(a, b.at), Number.POSITIVE_INFINITY);
    out.push({ t: mmss(Number.isFinite(firstAt) ? firstAt : m * 60), text: picked.map((x) => x.text).join(' ') });
  }
  return out;
}
