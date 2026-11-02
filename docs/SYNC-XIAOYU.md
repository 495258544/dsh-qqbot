# 与 xiaoyu 分支的同步记录

> 这份文档存在的唯一目的：**下次再同步时不用重新推演一遍**。
> 每次同步追加一节，别覆盖历史。

---

## 2026-11-03 · 第一次同步（阶段一 + 阶段二）

| 项 | 值 |
|---|---|
| 同步分支（本地） | `sync/xiaoyu-20261103`（从 `work` 拉出） |
| 远端分支 | `origin/xiaoyu` |
| 远端同步点 | `e220f56` · 2026-11-02 17:10 · "docs: 小黑盒文章 + dsh-bili-whale 源码调查笔记入库" |
| 分叉时点 | 共同祖先 `f5b34a1`（= `origin/main`），同步时本地 20 提交、远端 30 提交 |
| 同步方式 | **按提交手工移植**，未做 merge / rebase |
| 同步后验证 | `tsc` 0 错，`vitest` 634/634 通过 |

### 拉取命令（有坑）

```bash
# 只写 FETCH_HEAD，不会创建 origin/xiaoyu 引用
git fetch origin xiaoyu

# 要建引用必须显式指定 refspec
git fetch origin xiaoyu:refs/remotes/origin/xiaoyu
```

### 已吸收

| 提交 | 内容 | 落地方式 |
|---|---|---|
| `d885e7d` | 给她真正的浏览能力 + 工具报错不再泄露给用户 | `tools.ts`、`tool-presenter.ts`、`tool-error-hiding.test.ts` 整取；`service.ts` 新增 `surf()` |
| `970576f` | 口癖管线断了 + 健康检查在谎报 | `persona-health.ts`、`voice.test.ts` 整取；`service.ts` 的 `judgeVoice` 接上 `extractCandidates`/`promoteHabits`，`pruneStale` 补 `retireStale()` |
| `a50bc2f` | 称呼提取收紧到零误判 | 捆绑：`question-detect.ts` 新增 `extractVocatives`（收紧版）+ `service.notePossibleName()` + `persona-wake-gate.ts` 接线 |
| `cc9132d`（部分） | 上游 0.5.5 修复包 | 见下表，只取 7 个文件 |

`cc9132d` 实际取了这些（都是本地未改过、或本地缺失的）：

| 文件 | 修的是什么 |
|---|---|
| `src/shared/dirs.ts`（新增） | `~/.dsh-qqbot` 单一事实源，解决 workspace 文件发送被误拒 |
| `src/transport/attachment.ts` | 按 magic bytes 校正图片扩展名（修"读图工具全挂"、表情归档错标） |
| `src/model/prefs-store.ts` | 原子写 + 写前合并（修"QQ 里丢上下文"） |
| `src/setup/qr-svg.ts` | 二维码裂图 |
| `src/media/vision-tool.ts` | settings.yaml 注释不被抹掉 |
| `src/host/adapter.ts` | 授权补丁 |
| `src/commands/auth.ts`（新增）+ `misc.ts` / `index.ts` / `types.ts` | `/bot-me` 命令 + 管理命令白名单鉴权（open 模式下 `/model` `/preset` 仍校验主人） |

配套取了 5 个测试：`attachment.test.ts`、`prefs-store.test.ts`、`vision-tool.test.ts`、`adapter.test.ts`、`auth.test.ts` / `auth-open-mode.test.ts`。

### 明确跳过（下次别重新纠结）

| 跳过项 | 原因 |
|---|---|
| `1d99f21` / `41dbb8d` / `dbe5656` / `64c07ce` | 这四个是本地 `work` 分支的**旧快照**被 cherry-pick 过去，`src/steam`、`src/dota` 比本地少 739 行。取过来等于回退证书降级、称呼取群名、`otherNames`、digest 修复 |
| 情绪/厌恶/记忆衰减那一串（`2930a17` `5c8b98b` `1ece8cb` `0e00481` `b9ed065` `ec1e298` `6639d48` `d4871b2` `967b9f9` `bb0280a` `5495da4` `bb44321` `8c6cde0`） | 需要新增 `emotion.ts` + `memory-decay.ts` + `word-match.ts`，并改写 `service.ts` / `wake.ts` / `persona-wake-gate.ts` / `self.ts` —— 这四处正好是本地热重载、`otherNames`、`atSomeoneElse` 的落点。只能整块移植，不能 cherry-pick |
| `5a2802a` | 死代码清理删掉了 `dota/service.ts` 的 `recentFormMulti`/`invalidate` 和 `question-detect.ts` 的 `classifyUtterance`，本地单场解析还在用 |
| `e731f74` | 依赖 `5a2802a` 的结论；另外它给 `a50bc2f` 带的接线里有 `persona.emotion.onAddressed()`，本地无 `emotion` 模块 |
| `cc9132d` 里 `config.ts` 的 `c2cMode: default('open')` | 回退 0.5.4 的"私聊默认白名单"。**这一行绝对不能跟** |
| `cc9132d` 里的 `src/session/session-manager.ts` | 它是整套 sessionId 机制重构（SHA-256 确定性派生 → prefs 映射 + `mintSessionId()` UUID），牵涉存量会话迁移；而本地在该文件另有 steam section 注入 + `listLiveGroups()` 改动。当前没踩到"会话列表打不开"的 bug，风险大于收益 |
| 所有远端 `lib/*.js` | `lib/` 是入库的编译产物。远端那份是用其 30 个提交的 src 编出来的，覆盖会让本地的 runtime 热重载、steam、digest 全部错位。正确做法：改完 `src/` 跑 `npm run build` |

### 本地必须守住的文件

合并/同步时**任何情况下都不要整文件取远端版本**：

- `src/persona/wake.ts` —— 远端没有 `atSomeoneElse` / `otherNames` / `keywordsProvider`
- `src/middleware/persona-wake-gate.ts` —— 远端没有 `mentionsOtherPeople`、三源 `extraNames`、称呼候选接线
- `src/persona/service.ts` —— 远端没有 `RuntimeConfig` 热重载、`surf()`、`notePossibleName()`
- `src/persona/question-detect.ts` —— 远端没有 `hitMe`（"同时叫两人"不排除）
- `src/steam/*`、`src/dota/*`、`src/persona/dota-digest.ts` —— 本地整体领先
- `src/config.ts` —— `c2cMode` 默认值必须保持 `allowlist`

### 下次怎么继续

```bash
git fetch origin xiaoyu:refs/remotes/origin/xiaoyu
git log --oneline e220f56..origin/xiaoyu          # 上次同步点之后的新提交
```

逐个看 `git show --stat <sha>`，再按本文档的判据决定：
1. 碰 `src/steam` / `src/dota` / `dota-digest` / 上面那五个"必须守住"的文件 → 手工并，绝不整取
2. 新增独立模块（本地没有）→ 可以整取，但先确认它的 import 在本地都存在
3. 依赖本地不存在的东西（`emotion` / `decaySelf` / `dislike`）→ 跳过或做整块移植
4. 测试文件跟着源文件一起取，取完跑 `npx vitest run` 验证

同步完成后：更新本文件的"远端同步点"，打标签 `synced-xiaoyu-<sha>-<yyyymmdd>`。

---

## 2026-11-03 · 第二次同步（补齐上次"刻意跳过"的部分）

用户要求"全部都要"，所以把上次跳过的两块做完了。同步点没变，仍是 `origin/xiaoyu @ e220f56`。

| 提交 | 内容 |
|---|---|
| `b9dcdd2` | `cc9132d` 的 `session-manager.ts` 加固 + 可回退开关 |
| `c598a3b` | 情绪/厌恶/记忆衰减子系统（13 个提交 + 隐藏依赖 `d16166b`） |

### session-manager 那块的真相（纠正第一次的判断）

第一次同步时我判断"这是 sessionId 机制重构，风险高，跳过"。子代理复核后**推翻了**：
本地 `HEAD` 与该文件在 `cc9132d^1` 的 blob **字节相同**（`2240f98`），
也就是说 prefs 映射 + `mintSessionId()` 那套机制**本地早就在跑**，
`cc9132d` 只是补三道保险 —— 是零冲突补丁，不是重构。

它修的是两个**当时正活着**的 bug：
1. `resolvePersistedPreset` 调了宿主不存在的 `persistence.load()` → TypeError 被 `catch` 吞掉 →
   preset 的 `started` 锁定一直静默失效。改用 `host.sessionHeader()`。
2. resume 任何失败都静默 `mintSessionId()` 并**覆盖 prefs** → 老会话还在盘上但没人引用 →
   群里那个人聊过的内容无声断代，而且她表现正常。改为先 `stat` 求证，确认不在盘上才建。

另加 `DSH_SESSION_RECOVERY=recreate` 环境变量：默认 strict（拒重建，防重复 id）；
设成 recreate 则沿用原 id 重建（可用性优先，id 不变不丢记忆）。线上出事一个变量回退。

### 情绪子系统的落地方式

| 层 | 做法 |
|---|---|
| 新增模块 | `word-match.ts` / `emotion.ts` / 各自测试 —— 整取 e220f56 终版（不要用 `b9ed065` 初版：半衰期 6h 睡一觉就归零、`daily` 不传递导致日上限失效） |
| 本地零改动的 4 个文件 | `self.ts` / `surf.ts` / `humanize.ts` / `own-life.ts` —— 整取，无冲突 |
| `service.ts` | `git apply --3way` 打 `f5b34a1..e220f56` 的补丁，10 处冲突逐个人工解：**保留本地的 RuntimeConfig 热重载 / `surf()` / `notePossibleName` / `judgeVoice`，接入 emotion 等** |
| `tools.ts` | 从 `d885e7d`（本地当前版本）打补丁到 e220f56 —— 干净应用，0 冲突 |
| `wake.ts` | 只手工改三处（import `matchesTopic`、`InterestContext` 加 `dislikes`/`moodFactor`、`matchInterest` 换公式）。`addresseeContext` 保持本地版 |
| `persona-wake-gate.ts` | 只加两行：抱怨处 `onComplained()`、`collectOnly` 块首 `onAddressed()` |
| `bootstrap.ts` | 2 行：`budget.observe` → `observePeer`，入参换成 `existing?.lastActivity` |

**又一个"接线通了但跑不通"的例子（已修）**：
`bootstrap` 原来传 `record.lastActivity`，那是 `ensureForProactive` 刚写进去的 `Date.now()`，
拿它判"上次主动消息被理了吗"永远为真 → `unansweredStreak` 永不增长 →
整套「3天/14天/永久静默」退避从来没生效过。改成投递**之前**的活跃时间。

### 现在的同步范围（与第一次的差别）

第一次"跳过"清单里，`cc9132d` 的 session-manager、情绪子系统那 13 个提交，这次都已经吸收。
仍然不取的，只有：

| 仍不取 | 原因 |
|---|---|
| `cc9132d` 里 `config.ts` 的 `c2cMode: default('open')` | 代码默认值保持 `allowlist`（安全默认不退化）；**你这台实例的开放改成在 profile 里写 `c2cMode: open`**，要收回改回来即可 |
| `1d99f21/41dbb8d/dbe5656/64c07ce` | 本地旧快照，会回退 steam/dota 修复 |
| `5a2802a` / `e731f74` | 死代码清理会删掉本地还在用的 `classifyUtterance`；后者依赖前者 |
| 全部远端 `lib/*.js` | 编译产物，一律本地 `npm run build` |

---

## 2026-11-03 · 第三次同步（远端 `4afe637`，13 个提交）

| 项 | 值 |
|---|---|
| 远端同步点 | `4afe637`（上次是 `e220f56`） |
| 提交 | `ee3b8a0` |
| 主题 | 几乎全是 B 站视频能力 + 一批注释/时区修正 |

### 吸收了

| 提交 | 内容 | 方式 |
|---|---|---|
| `9ec22bd` | 字幕时间轴（原来 join 掉 from/to 且只取前 40 句 ≈ 90 秒）→ 按分钟选最长句 + 接官方 outline | 按文件 patch |
| `8b6ce35` | 合集先给分 P 目录（`pages[].title`，不是 `part`）+ 弹幕高能时刻 | 按文件 patch |
| `c6eb71a` | `runBili()` 薄壳（失败时从 `err.stdout` 捞 bili 自己写的错误）+ `page` 参数 + `bili-health.ts` 自检 | 按文件 patch |
| `cbb8254` | `render()` 措辞：字幕/目录标成「原料不是结论」并给挑选标准（没有引入 LLM） | 按文件 patch |
| `6e648af` | `tool-presenter` 正则去掉 `NOT_FOUND\|not found`（消息凭空消失的 bug） | 手工改 1 行 |
| 时区（多文件） | `diary.ts` / `screen-watch.ts` 的 `getHours/getDate` → 显式时区 | 整文件取 |
| 注释 | 「容器无 tzdata」→「启动时未设 TZ」；去掉「文章实测参数 C1」假出处；`self.ts` 厌恶半衰期注释 72h/24h → 90天/30天（原注释与常量差 30 倍） | 批量改 |

**这 4 个 bili 提交全部是本地进程内的纯 TS 规则**，一条都不依赖 MCP —— 所以保留 `qq_bili_check` 手写工具，同时拿到了全部改进。按顺序 patch（`git show <sha> -- <src 路径> \| git apply`）4 个全部干净应用，零冲突。

### 跳过（附理由，下次别重新纠结）

| 提交 | 理由 |
|---|---|
| `3f9752f` 改用 MCP + skill、砍掉手写工具 | **净能力倒退**：`server.py` 的 18 个工具里**没有 frames（画面帧）**，丢掉结构化 output schema，搜索只返回纯文本。还要用户改宿主 cordis.yml、装 Python + `mcp>=2.3`。仓库自己的 `8186bcb` 已论证「DSH 能 exec，MCP 无收益」 |
| `a1fb1b3` bili-mcp 加 4 个工具 | 没有 MCP 就是 0 价值；真需要那几个能力，在手写工具里加分支更便宜 |
| `ab1d9ba` 去掉 C1 假出处 | 已手工改注释（没整取，本地 bootstrap 有 149 行定制） |
| `5bb3818` 的 `surf.ts` B 站 Layer 0 | `biliHot()` 用同步 `execFileSync` + 20s timeout，而 `surfTopic` 是同步函数、被手动触发和定时轮次共用 → 会卡住 QQ 消息循环 |
| `bili-mcp/**`、`comment-audit.md` 等调研文档 | 本地无对应上下文，进仓库只是噪声 |
| 所有 `lib/*.js` | 编译产物，本地 `npm run build` |

### 特别注意

`bili-health.ts` 取了模块和测试，但**没有接进 bootstrap**：它同步跑 4 次 `execFileSync`（实测 7.6s），
接在启动的 `setTimeout` 里会阻塞事件循环。需要时手动跑，或改成异步 `execFile` 再接线。

`diary.ts` / `screen-watch.ts` 这两个时区 bug 是**上一轮（e220f56）漏掉的** ——
当时只看了 `clock.ts` 的改动就以为已经覆盖，实际上这两个文件本地仍等于 `f5b34a1`。
教训：**同步"时区/工具"类改动时，要 grep 一遍全仓的 `getHours()/getDate()`，而不是只跟改了哪个文件。**
