# dsh-qqbot（Steam 扩展）安装与配置指南

本 fork 在官方 dsh-qqbot 基础上增加了：群友 Steam 在线/在玩状态、最近游戏、Dota2 战绩查询与调侃。

## 一、安装

- 手动：把本仓库作为 cordis 插件挂到 dsh 的 `web` profile 下，入口 `lib/index.js`（构建后）。
- Agent 安装：把本仓库交给 agent，让它按文末「给 agent 的提示词」完成安装与初始化配置。

构建：

```bash
npm install && npm run build
```

## 二、申请 Steam Web API Key

打开 https://steamcommunity.com/dev/apikey ，登录后 Domain Name 随便填（如 `localhost`），拿到 32 位十六进制 Key。

> 没有 Key 也能用：群友可自助绑定 SteamID、查公开资料会失败但绑定表照常工作。

## 三、三处必填配置（插件设置页 / cordis.patch.yml 都能改）

| 配置项 | 填什么 | 说明 |
|---|---|---|
| `steam.apiKey` | 刚申请的 Key | 只首次采纳；之后用 `scripts/steam-config.mjs --key` 改 |
| `steam.ownerSteamId` | 你的 SteamID64（17 位） | 拉好友列表的起点；Steam 隐私「好友列表」要设「公开」 |
| `access.c2cAllow` | **私聊里**你的 QQ openid | qq_steam_owner 改主人账号的权限依据 |
| `persona.ownerOpenids` | **群里**你的 QQ openid | 命中即必醒 + own-life 投递目标 |

### ⚠️ 关于 openid（极易踩坑）

QQ 机器人给同一用户分配的 `openid` 是 **按 bot/appid + 会话类型（群 / 私聊）隔离**的：

- 你在「群聊」里的 openid ≠ 「私聊」里的 openid；
- 不同 bot（不同 appid）看到的 openid 也完全不同。

所以 `c2cAllow`（私聊授权）和 `persona.ownerOpenids`（唤醒/投递）要填**对应上下文**的 openid，两者不一样是正常的。`qq_steam_owner` 会把这两处合并判断，任一处命中即视为主人。

**怎么拿到自己的 openid？** 任选其一：

1. 在目标会话（群或私聊）里和 bot 说句话，看 dsh 日志里这条消息带的 `openid`；
2. 用仓库诊断脚本从会话存档提取：

   ```bash
   node ~/.dsh-backup/diagnose/_scan-roster.mjs
   ```

   它会列出每个发言人的 openid 与昵称。

## 四、群友自助绑定（你不用手动维护）

群友在群里发一句自己的 Steam 主页（如 `https://steamcommunity.com/id/xxx` 或 `profiles/<数字>`），bot 自动用他发言的 openid 绑定。新朋友进来也说一句即可，无需改任何配置。

## 五、重启 & 验证

彻底重启 DSH NEXT（让新工具加载），然后：

```bash
node scripts/steam-config.mjs --show                        # 看当前 Key / 主人账号
node scripts/steam-config.mjs --owner <你的主页或SteamID64>  # 设主人账号
node scripts/steam-friends-export.mjs                       # 导出好友对照表（末列填群昵称）
```

在群里说「芋头最近在玩啥」「调侃一下小周的 Dota 战绩」即可。

想看**单场详细解析**就说「解析一下我这局」/「这局打得怎么样」/「看看 match 9065708025」——会给出经济、输出、正反补、队内排名、对位对比、首血/肉山/推塔、经济曲线、团战参与、双方阵容和出装（`qq_dota_match`）。

---

## 给 agent 的安装提示词（复制给安装 agent）

> 安装这个 dsh-qqbot fork 并启用 Steam 扩展。完成后按以下步骤引导我完成配置，每步都要向我确认：
>
> 1. 让我提供 Steam Web API Key（我去 https://steamcommunity.com/dev/apikey 申请，或我贴给你），你写入 `steam.apiKey`；
> 2. 让我提供我的 SteamID64（或 Steam 主页链接），你写入 `steam.ownerSteamId`；
> 3. 帮我取到我在「群聊」和「私聊」里的两个 QQ openid（用仓库诊断脚本 `_scan-roster.mjs` 从会话存档提取，或看日志），分别写入 `persona.ownerOpenids`（群里的）和 `access.c2cAllow`（私聊的）；
> 4. 提醒我：Steam 隐私设置里「好友列表」必须设为「公开」，否则拉不到好友；
> 5. 说明：配置项只作首次采纳，运行时改动走 `scripts/steam-config.mjs`，不会被旧配置冲掉；
> 6. 让我重启 DSH NEXT 后，在群里说一句自己的 Steam 主页完成绑定，并验证「查某群友状态」可用。

---

## 六、Dota 战绩播报（可选，默认关）

每天上午看一遍群友最近 24 小时的战绩，趁热到群里锐评一句。

**两阶段，中间用落盘摘要衔接（断电重启不丢、一天最多一次）：**

1. **上午查询**（`dotaDigestQueryHours`，默认 `[10,12]`）
   遍历**已绑定**的群友 → OpenDota 查最近几局 → 只保留「最近 24 小时内打过」的人（`dotaDigestRecentHours`，默认 `24`）→ 提炼亮点写入 `~/.dsh-qqbot/persona/app-<appId>/dota-digest.json`。
   这个点昨晚的比赛基本已经解析完，能看到经济曲线/团战这些细节。
2. **当天投递**（`dotaDigestDeliverHours`，默认 `[10,12]`）
   查询完成后，同一时段内读摘要 → 选群 → 只把**原始数据**（谁、什么情况、关键那局的英雄/KDA）作为内部提示注入群会话，**不预写文案**——让 agent 收到数据后自己组织语言，像老朋友随口吐槽，而不是念报表。

**亮点规则**（命中即收，每人最多 1 条，最多 `dotaDigestMaxItems` 条）：
3 连败 / 3 连胜 / 单局 KDA≥5 的 Carry 局 / 输局 KDA<0.8 且死≥8 的「送」局 / 24h 内打了 ≥5 局。

**目标群怎么选**（`dotaDigestGroupId` 留空即自动）：
按「和这群人的 Dota 相关度」打分——最近 72h 聊过 Dota 关键词（最高 100 分）> 群里有战绩当事人发言（每人 +30，封顶 60）> 最近活跃（≤24h 给 20）。只在**当前存活**的群会话里挑，死群不发。想固定发某个群就填该群 openid。

**关键词可配置**（`persona.dotaKeywords`）：
默认内置表已含 `dota / dota2 / 刀塔 / 刀圈 / 打刀 / 开黑 / 上号 / 上分 / 天梯 / 战绩 / 坑 / 送 / 划水 / 五黑 …`。不同群叫法不一样时在这里覆盖，例如：

```yaml
persona:
  dotaKeywords: ['dota', '刀塔', '打刀', '开黑', '五黑', '上号']
```

**注意**：
- 对方在 Dota2 里关掉「公开比赛数据」时查不到——这时**不会**说他没打过，只会跳过；
- 没人最近 24 小时打过 → 当天不落盘、也不发（不会硬凑内容）；
- **不会重复播**：同一个人同一类亮点（如"连败"）3 天内只播一次，历史存在 `dota-digest-history.json`，跨重启有效；
- **会占主动消息额度**：它在群里不是"回复某条消息"，而是主动推送，会消耗 `persona.maxProactivePerDay`（本机配了 10 条/天、两条间隔 ≥1 小时）；digest 自身还有 `dotaDigestMaxPerDay`（默认 1）这层限制；
- 群里打 Dota 频率低时可把 `dotaDigestRecentHours` 放宽到 `48` 或 `96`。
