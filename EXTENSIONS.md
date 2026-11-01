# 本地扩展清单（相对上游 fork）

本仓库在 `495258544/dsh-qqbot` 之上叠加了一批**自研功能**。上游由另一个人维护、会不定期更新，
这份清单用来回答两个问题：

1. 哪些东西是我们加的（出问题先看这些）？
2. 合并上游时，哪些文件最可能冲突、冲突时该保留谁？

> 约定：`work` 分支放我们的改动；`main` 只用于同步上游，不直接提交业务改动。

## 一、模块清单

| 模块 | 文件 | 作用 | 合并风险 |
|---|---|---|---|
| Steam 状态 | `src/steam/{settings,bindings,steam-id,steam-api,service,tools,index}.ts` | 查群友在线/在玩什么、好友列表、自助绑定、凭据运行时存储 | 低（上游基本不碰 `src/steam`） |
| Dota 战绩 | `src/dota/{heroes,heroes-data,opendota,service,tools,index}.ts` | 最近战绩、单场详细解析（经济/对位/目标/曲线/团战） | 低 |
| 战绩隔夜播报 | `src/persona/dota-digest.ts` | 凌晨查已绑定群友 → 次日 10-12 点发群活跃气氛（3 天内同类不重复） | **中**（在 `src/persona` 下，上游常改） |
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
persona:
  dotaDigestEnabled: true
  dotaDigestGroupId: ''
  dotaDigestQueryHours: [3, 7]
  dotaDigestDeliverHours: [10, 12]
  dotaDigestRecentHours: 24
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
