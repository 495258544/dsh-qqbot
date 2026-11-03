# dota-digest 投递核查 · 2026-11-03

## 本次结论
- 10:00-12:00 窗口**未发出**，但**不是** pickGroup/deliver 修复失败：当晚确实无人开黑。
- 5 个绑定账号中 3 人最后一场均为 11-01 23:06（距今 35h），被 `recentHours=24` 时效过滤全部丢弃 → items=0 → 不落盘。
- `dota-digest.json` 与 `dota-digest-history.json` 均不存在 → 模块自始至今零成功投递，与历史判断一致。
- 11-02 那份 2 条摘要在 10:00:17 被判定 `stale` 后 `clearDigest()` 删除，未进入投递路径。
- 修复代码在位：bootstrap.ts pickGroup(395) + ensureForProactive(423)，群 ID 已写入 `.dsh/profiles/web/cordis.patch.yml`。

## 发现的真问题
1. 日志文案误导：`items.length===0` 统一输出"这一晚没有值得说的战绩"，掩盖"24h 内无人开黑"（line 555）。
2. 查询无节流：digest 为 null 时 `tickQuery` 每 60s 重跑全部绑定 → 2h 窗口约 600 次 OpenDota 请求，有配额风险（line 493 仅对已有 digest 短路）。

## 附带核查
- Bun 1.4.4 于 09:29 落盘；`requires a local Bun` warn 最后一条 01:16Z(09:16)，09:31 轮次刷新不再 warn → 已生效，无需重启。

## 下次关注
- 有人开黑后（11-02 夜起算 24h 内）再查一次，确认 ensureForProactive + 固定群 ID 是否真的能把播报发出去。
