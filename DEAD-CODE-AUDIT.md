# 死代码审计（2026-11-02）

对象：`dsh-qqbot`，**HEAD `ec1e298`**（审计期间并发 3 次提交）。

## 一句话结论

**A 类 6、B 类 10、C 类 0、D 类 2。** 最严重是**情绪负向写入点被删了**：`onIgnored` 消失，情绪只剩正向——正是注释警告的"永远开心=没有心情"。

## 修复情况（同日，提交 `967b9f9` ~ `a50bc2f`）

报告里的 **A 类 6 条已全部修复**，每条都补了"调用点存在"的测试
（断言的是链路通，不是函数算得对 —— 否则把调用点删了测试照样绿）：

| # | 符号 | 修法 | 提交 |
|---|---|---|---|
| 1 | `onIgnored` | `PersonaService.observePeer()` 包装 budget 结算，按 streak 变化写情绪 | 967b9f9 |
| 2 | 口癖管线 | `judgeVoice` 里抽候选+转正；`pruneStale` 里退役 | 970576f |
| 3 | `maybeResetRoute` | 接进 `getOrCreate` 顶部 | e731f74 |
| 4 | `onRest` | 接进 `flushTurn`：距上轮 ≥6h 视为睡了一觉 | 967b9f9 |
| 5 | `recoverIfCalm` | 接进 `decaySelf`（6h 一次） | e731f74 |
| 6 | `recordNameCall` | 新增 `extractVocatives()` + `notePossibleName()` | e731f74 / a50bc2f |

其中 **#1（onIgnored）的报告结论直接命中了一次真实的回归**：
它是我在一次重构里改没的，编译过、测试绿、日志正常，什么都没发现。

`recordNameCall` 的接法还踩了一个额外教训：第一版提取规则太宽松，
拿 124 轮真实语料跑出来是「忙是忙」「藏事儿多累」「一回就一回」这类
句子开头的碎片。**规格只有在真实数据上跑过才算数** ——
单看逻辑觉得没问题，跑一次就知道差得远。

B 类 10 条、D 类 2 条未处理（多为"仅测试使用"或"有写无读"的低危项）。

## 清单

| # | 符号 | 文件:行 | 类 | 说明 | 严重度 |
|---|---|---|---|---|---|
| 1 | `onIgnored` | emotion.ts:264 | **A** | 唯一负向来源，调用点消失 | **高** |
| 2 | `extractCandidates`/`promoteHabits`/`retireStale`/`markUsed` | voice.ts:230/321/346/380 | **A** | 管线断开 | 高 |
| 3 | `maybeResetRoute` | session-manager.ts:309 | **A** | 声称每轮调，实无 | 高 |
| 4 | `onRest` | emotion.ts:282 | **A** | energy 唯一正向写入 | 中 |
| 5 | `recoverIfCalm` | self.ts:569 | **A** | 话痨度不回升 | 中 |
| 6 | `recordNameCall` | self.ts:262 | **A** | 候选不产生 | 中 |
| 7 | `renderRecent` | memory.ts:328 | **D** | 有写无读 | 中 |
| 8 | `prunePendingAttachments` | pending-attachments.ts:52 | **D** | 无调用 | 低 |
| 9 | `classifyUtterance` | question-detect.ts:424 | **B** | 被复刻 | 中 |
| 10 | `evidenceScore`/`maxItemsFor`/`reinforce`/`EVIDENCE_THRESHOLD` | memory-decay.ts:139-163 | **B** | 仅测试 | 低 |
| 11 | `dislikeLoad`/`dislikesTopic` | self.ts:515/507 | **B** | 另做 | 低 |
| 12 | `activeInterestCount` | self.ts:432 | **B** | 靠截断 | 低 |
| 13 | `recentFormMulti`/`invalidate` | dota/service.ts:402/429 | **B** | 未接 | 低 |
| 14 | `describeBinding` | steam/service.ts:772 | **B** | 无人调 | 低 |
| 15 | `getGroupActivityStore` | group-activity.ts:439 | **B** | 闭包 | 低 |
| 16 | `subscribe` | binding-service.ts:78 | **B** | 无订阅 | 低 |
| 17 | `isOnFallback`/`forget` | failover.ts:143/148 | **B** | 无人调 | 低 |
| 18 | `isActiveWindow` | clock.ts:87 | **B** | 各自实现 | 低 |

已排除：`tools.register` 回调 26 处、re-export、类型定义。

## 证据

```bash
grep -rhoE "(export (async )?function [a-zA-Z0-9_]+|^  [a-zA-Z0-9_]+\()" src/ --include=*.ts | sort -u
grep -rn "\b<name>\b" src/ --include=*.ts --exclude=*.test.ts | grep -v ':<defLine>:' | grep -vE ':[0-9]+:\s*import\b'
```

统计前**剥注释**（`decayInterests` 曾被 5 处注释命中）。

验证（均 `exclude=*.test.ts`）：`\.onIgnored(`、`\.onRest(`、`\.promoteHabits(|retireStale(|markUsed(`、`\.renderRecent(` 各 **0 行**；`extractCandidates`/`maybeResetRoute`/`recordNameCall`/`recoverIfCalm` 各仅 **1 行**（定义本身）。

## 逐个详解（A 类）

**#1（最严重）**：注释称它是"最重要的负向写入点：没有它，情绪只涨不跌"。旧版由 `markUnanswered`（service.ts:110）调用，`ec1e298` 后该行被删。后果：`valence` 只剩正向源，`speakWillingness()` 锁上限，`wake.ts:315` 与 `own-life.ts:319` 概率虚高。修法：`markUnanswered` 内恢复 `this.emotion.onIgnored();`。

**#2**：链路两端已接，**中间两环零调用**。样本满 60 条被 `shift()` 丢弃（voice.ts:208），`habits` 永空，`persona-health.ts:104` 仍报进度。接法：挂 `pruneStale()`。

**#3**：`maybeReset` 只被它调，它自己无人调，故 `clearOverride` 永不执行——429 后永久停在备用模型。

**#4/#5/#6**：`onRest`（:283 `+0.1`）是 energy 唯一正向 bump，其余全负向。`warmUp()` 仅在对方主动时 +0.2，缺时间维度恢复。`acceptName` 已通，但没人写 `names` 候选。

**#9**：wake.ts:381/468 手工复刻判定链，阈值已漂移。

## 给"情绪系统"的启示

死法两种：**没接上**（A）、**只接一半**（D）。本次还见第三种：**接上又被改掉**。

**规则：新字段必须在同一 PR 内写出消费者，且必须是四类闸门之一——概率、延迟、条数、枚举分支。写不出消费方的当场删掉。**

1. **接线检查**：grep 那行必须在**分支条件**里而非模板串。闸门是 `speakWillingness`→`wake.ts:315`，不是日志。
2. **成对提交**：写入与读取同一 commit。#2、#7、#8 全是半截——比没有更贵，健康检查会显示"在跑"。
3. **正负成对**：情绪必须同时有正负写入点，各加"调用点存在"测试。
4. **巡检要注册而非被记得**：`decaySelf()`、`recoverIfCalm()`、口癖管线都挂进 `pruneStale()`。

一句话：**算了但没用的字段，等于给模型写了一句它永远收不到的台词。**
