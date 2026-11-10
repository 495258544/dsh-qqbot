# 本地扩展清单（相对上游 fork）

本仓库在 `495258544/dsh-qqbot` 之上叠加了一批**自研功能**。上游由另一个人维护、会不定期更新，
这份清单用来回答两个问题：

1. 哪些东西是我们加的（出问题先看这些）？
2. 合并上游时，哪些文件最可能冲突、冲突时该保留谁？

> 约定：`work` 分支放我们的改动；`main` 只用于同步上游，不直接提交业务改动。

## 〇、模块边界（2026-11-10 定稿，同步/cherry-pick 先读这节）

`src` 按目录分成两层，**接缝只有一处**（`src/gateway/bootstrap.ts`）：

```
src/
├─ 聊天核心（改这里 = 同步"聊天修订"）
│   transport/  session/  persona/  commands/
│   middleware/  features/  media/  ops/  host/
└─ 平台扩展（每个目录自成一体，挂了不牵连聊天）
    bili/    B 站 CLI + qq_bili_check + 输出字段自检（registerBiliTools）
    xhh/     小黑盒只读（registerXhhTools，默认关闭）
    steam/   群友 Steam 状态（registerSteamTools）
    dota/    Dota 战绩 + 凌晨 3 点解析预热（registerDotaTools）
```

> 共享层 `shared/`（profile 定位、出站归属、ego 可选依赖）两层都能依赖；
> `types.ts` / `config.ts` 是公共类型与配置，不属于任何平台。

三条硬规矩：

1. **平台模块禁止被聊天核心 import**，反向依赖（平台 → 核心）同样禁止。
   平台只准依赖 `types.ts` / `config.ts` 的类型与 `shared/`。
   需要平台能力时由 `bootstrap.ts` 注入 —— 例如 `persona/dota-digest.ts`
   的 `toAccountId` / `primaryAlias`，以及它的 `DigestForm` 形状镜像。

   既有例外（与 `xiaoyu` 分支一致，**禁止新增**）：
   - `steam/tools.ts` → `../session/index.ts`：只用 `DshAgent` / `SessionManager`
     两个类型，type-only，运行时零耦合。
   - `xhh/images.ts` → `../transport/attachment.ts` 的 `imageExtension()`：无状态纯函数。

   新代码需要这类能力时一律下沉 `shared/` 再两边引用。2026-11-10 已把
   `dota/warmup.ts` 原本依赖的 `persona/clock.ts` 正本下沉为 `shared/clock.ts`
   （`persona/clock.ts` 保留为 re-export），这条反向依赖已消除。
2. **每个平台自带 `register*Tools`**，bootstrap 统一接线。平台挂了 =
   它自己的工具不可用，聊天/日记/记忆照常；字段自检失败只记 warn，不阻塞启动。
3. **只同步聊天修订时**挑核心目录即可，平台目录整个跳过。冲突概率最高的
   共享文件只有 `config.ts`（各平台配置段集中、字段互不重叠）和
   `bootstrap.ts`（接线段分块注释，按块取舍）。

与 `xiaoyu` 分支的差异（2026-11-10 第五次同步后）：那边 B 站主体走官方 MCP，
本分支保留本地 `bili` CLI 的厚实现（`watch` 优先、`frames`、`subtitleOutline`、
结构化 `bvid`），**不能换成薄壳**；那边还有 `nga/`，本分支按用户要求不要 NGA。
因此**不要整分支 merge**，按 `docs/SYNC-XIAOYU.md` 的上次同步点手工移植。

## 一、模块清单

| 模块 | 文件 | 作用 | 合并风险 |
|---|---|---|---|
| Steam 状态 | `src/steam/{settings,bindings,steam-id,steam-api,service,tools,index}.ts` | 查群友在线/在玩什么、好友列表、自助绑定、凭据运行时存储 | 低（上游基本不碰 `src/steam`） |
| Dota 战绩 | `src/dota/{heroes,heroes-data,opendota,service,tools,index}.ts` | 最近战绩、单场详细解析（经济/对位/目标/曲线/团战） | 低 |
| 战绩播报 | `src/persona/dota-digest.ts` | 查最近 48h → 10-14 点发群锐评（3 天内同类不重复；平台能力由 bootstrap 注入） | **中**（在 `src/persona` 下，上游常改） |
| B 站平台 | `src/bili/{cli,subtitles,tools,bili-health,index}.ts` | 本地 `bili` CLI：视频信息 / AI 总结 / 字幕时间轴 / 弹幕 / 抽帧 / 合集目录 + 输出字段自检 | 低（独立目录，上游不碰） |
| 凌晨解析预热 | `src/dota/warmup.ts` | 每天 3:00 请求最近 30h 的比赛触发 OpenDota 解析；文件锁 + 落盘状态跨热重载幂等 | 低 |
| 群活跃度评分 | `src/features/group-activity.ts` | 按「Dota 相关度」给群打分，决定播报发哪个群 | **中**（`src/features` 上游也动） |
| 会话枚举 | `src/session/session-manager.ts` 的 `listLiveGroups()` | 列出存活群会话，供选群 | **中**（该文件上游常改） |
| 群消息埋点 | `src/transport/inbound.ts` 的 `recordGroupActivity(...)` | 只记聚合指标（时间戳/关键词命中/发言者），不留原文 | **中**（该文件上游常改） |
| 配置扩展 | `src/config.ts` 的 `steam`、`dota`、`persona.dotaDigest*`、`persona.dotaKeywords` | 上述功能的开关与参数 | **高**（上游常加字段，同文件必合） |
| 接线 | `src/gateway/bootstrap.ts` | 构造/启动 Steam、Dota、digest、群活跃度 | **中** |
| CLI | `scripts/steam-config.mjs`、`scripts/steam-friends-export.mjs` | 管理 Steam 凭据/主人账号；导出好友对照表 | 低 |
| 安装引导 | `SETUP.md` | 给其他用户/agent 的安装配置说明 | 低 |

## 二、新增配置项（都在 profile 的 `im-qqbot.config` 下）

```yaml
steam:            # apiKey / ownerSteamId 只作首次采纳，真正生效值在 ~/.dsh-qqbot/steam/settings.json
  enabled: true
  apiKey: ''
  ownerSteamId: ''
  friends: {}
  proactiveEnabled: true
dota:
  enabled: true
  includeWinLoss: true
  warmup:               # 凌晨 3 点触发 OpenDota 解析（只作用于后台预热，群聊查询不重试）
    enabled: true
    hour: 3
    withinHours: 30
    timeoutMs: 20000
    retries: 2
persona:
  dotaDigestEnabled: true
  dotaDigestGroupId: ''
  dotaDigestQueryHours: [10, 14]    # 代码默认 [10, 12]，本机 profile 覆盖
  dotaDigestDeliverHours: [10, 14]  # 代码默认 [10, 12]，本机 profile 覆盖
  dotaDigestRecentHours: 48         # 代码默认 24，本机 profile 覆盖
  dotaDigestMaxItems: 2
  dotaDigestMaxPerDay: 1
  dotaKeywords: []      # 空 = 内置默认（含「打刀」）
```

## 三、合并上游时的处理顺序

1. `git fetch origin && git merge origin/main`（在 `work` 分支上）。
2. 先解 **`src/config.ts`**：通常只是"双方各加字段"，两边都保留即可；不要整文件选边。
3. 再解 **`src/transport/inbound.ts`**：多半是 import 或埋点位置冲突，保留 `recordGroupActivity` 调用。
4. **`src/session/session-manager.ts`**：保住 `listLiveGroups()`。
5. **`lib/**` 的冲突一律不手改**：解决 `src` 后 `npm run build` 覆盖。
6. 收尾必须跑：`npx tsc --noEmit` + `npx vitest run` + `grep -r "<<<<<<<" src lib`。

## 四、标签

| 标签 | 含义 |
|---|---|
| `extensions-20261101` | 本轮扩展清单与合并上游（20 提交）后的状态 |
| `backup-before-upstream-20261101` | 合并前的安全点 |

## 五、改完要不要重启

原则：**数据即时生效，代码和启动配置才需要重启**。目标是日常调整（加人、改称呼、换词）都不用停 bot。

| 改什么 | 文件 | 生效方式 |
|---|---|---|
| 绑 Steam（加人/解绑/改称呼） | `~/.dsh-qqbot/steam/bindings.json` | **立即**（按 mtime 热重读） |
| Steam Key / 主人账号 | `~/.dsh-qqbot/steam/settings.json` | **立即** |
| 她的名字、关键词、群友称呼 | `<personaDataDir>/runtime.json` | **立即** |
| 她接受的称呼 / 兴趣 / 话痨度 | `<personaDataDir>/self.json` | **立即** |
| 群友昵称记忆 | `<personaDataDir>/memory/people.json` | **立即**（30s 缓存） |
| profile 里其它配置（时段、概率、开关） | `~/.dsh/profiles/web/cordis.patch.yml` | 重启 |
| 插件代码 | `src/` + `lib/` | **`dsh-unlag` 热重载**（不重启宿主）；无该插件时才重启 |

`<personaDataDir>` 一般是 `~/.dsh-qqbot/persona/app-<appId>/`。

### runtime.json 怎么用

改 profile 要重启，但「她叫什么」「群里都有谁」「哪些词该接」这三样变得最勤，所以单独放到数据目录：

```json
{
  "names": ["小深", "阿深"],
  "keywords": ["打刀", "开黑"],
  "otherNames": ["刘宗锴"]
}
```

语义是**追加**：profile 里那份是基线，这里只往上加，两边不用惦记对方。
写坏了会降级为空并记一条 warn，不会让她变哑巴。

改完不用做任何事，下一轮对话就按新的来。想加个人：

```bash
node -e "const p='<personaDataDir>/runtime.json';const fs=require('fs');const j=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{};j.otherNames=[...new Set([...(j.otherNames||[]),'某某'])];fs.writeFileSync(p,JSON.stringify(j,null,2))"
```

### 为什么代码改不了

插件没有加载器级的热重载（`fs.watch` + 重新 `import`），改 `lib/*.js` 只能重启宿主。
真要频繁改代码，就在开发时用 `dsh web` 前台跑，改完手动重启那一个进程，不影响 DSH NEXT。

但现在宿主已装 `dsh-unlag`：改完 `src` 跑 `npm run build` 生成 `lib`，推 `origin/work` 后
调用 `POST http://127.0.0.1:58124/dsh-unlag/reload`（带 `x-dsh-unlag: 1`）。
返回 `completion=full` / `failedEntries=[]` 且宿主 pid 不变，就表示运行时加载了新 `lib`。
**只改 `src` 不 build、或 build 了不 reload，线上跑的仍是旧代码** —— 这个坑踩过多次。
