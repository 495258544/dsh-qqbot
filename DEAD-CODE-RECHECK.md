# 死代码修复复核（只读，2026-11-02）

对象：`/root/Documents/deepseek-harness/default-workspace/dsh-qqbot`，分支 `xiaoyu`，HEAD `8a94319`。
审计基线 `ec1e298`（11:56:15），修复区间 `967b9f9`(12:03) ~ `a50bc2f`(12:13)。
本次复核阶段全程未修改文件；随后的 M33 修订（见 `DESIGN-PERSONA.md` §十六）才动代码。

判定标准（按委托要求）：剥注释、排除 `*.test.ts`、排除定义行后看**非定义行命中**，再看那行是否在**分支条件**里，最后看**该条件在真实数据下能否成立**。第三步是本报告与审计报告最大的分歧点。

---

## 一、6 条逐条结论

### 汇总裁量表

| # | 符号 | 定义行 | 非定义非注释命中 | 命中位置（剥注释后原文） | 结论 |
|---|---|---|---|---|---|
| 1 | `onIgnored` | `persona/emotion.ts:272` | 1 | `service.ts:334` `if (after > before) this.emotion.onIgnored();` | **半截**：调用点在分支里，但生产路径上条件恒假 |
| 2 | `extractCandidates`/`promoteHabits`/`retireStale`/`markUsed` | `voice.ts:230/321/346/380` | 4/4 | `service.ts:593/596`、`service.ts:273`、`service.ts:568` | **接上了**（4/4 真调用），但输出质量实测不合格 |
| 3 | `maybeResetRoute` | `session-manager.ts:309` | 1 | `session-manager.ts:610` `this.maybeResetRoute(scope, peerId);` | **真修好**（调用点正确，在 `getOrCreate` 顶部） |
| 4 | `onRest` | `emotion.ts:290` | 1 | `service.ts:612` `if (last > 0 && now - last >= 6 * 3600_000) this.emotion.onRest();` | **真修好**（有跨进程重启缺陷，见隐患） |
| 5 | `recoverIfCalm` | `self.ts:569` | 1 | `service.ts:302` `this.self.recoverIfCalm(now);` | **接上了**（链路真：`pruneStale`→`decaySelf`），但当前数据下永不产生位移 |
| 6 | `recordNameCall` | `self.ts:262` | 1 | `service.ts:350` `const r = this.self.recordNameCall(name);` | **半截**：写入端接上了，读取端仍缺 → "点不动的按钮"还是点不动 |

### 逐条证据

#### #1 `onIgnored` —— 半截

grep（排除测试）：

```
$ grep -rn "onIgnored" src/ --include=*.ts --exclude=*.test.ts
src/persona/service.ts:315:   * 但我第一版把 onIgnored 写进了 budget 的 markUnanswered —— 编译不过，
src/persona/service.ts:334:      if (after > before) this.emotion.onIgnored();
src/persona/emotion.ts:272:  onIgnored(): void {
```

剥注释后只剩 1 行调用，且**确实在分支条件里**（不是模板串、不是每轮都调）：`observePeer()` 里比较 `unansweredStreak` 前后值，只有 `after > before` 才扣分。形式上完全符合审计标准。**但这条链在生产路径上跑不到。**

生产侧唯一调用者：

```
$ grep -rn "observePeer" src/ --include=*.ts --exclude=*.test.ts
src/gateway/bootstrap.ts:315:        svc.observePeer(ownerOpenid, record.lastActivity);
src/persona/service.ts:323:  observePeer(peerId: string, lastActivityAt: number): void {
```

`bootstrap.ts:315` 传的是 `record.lastActivity`。而同一段代码在它之前先调用了 `manager.ensureForProactive(...)`：

- `ensureForProactive` 里 `const live = this.sessions.get(key); if (live) return live;`，否则 `getOrCreate(...)`；
- `getOrCreate` 对已存在会话会 `existing.lastActivity = Date.now()`；新建会话在 `session-manager.ts:705` 写 `lastActivity: Date.now()`；
- 而 `sessionIdleTimeout` 默认 **30 分钟**（`config.ts:322`），own-life 间隔 4 小时 → 每次投递时私聊会话几乎必然已被回收 → 必然走"新建"分支 → `lastActivity = now`。

于是 `observePeer` 里：

```ts
const wasAnswered = wasProactive && lastActivityAt > (p?.lastProactiveAt ?? 0);
```

`lastActivityAt`（刚刚）恒大于 `lastProactiveAt`（4 小时前那次推送）→ `wasAnswered === true` → `if (wasProactive && !wasAnswered)` 不进 → **`onIgnored()` 永不执行**。

实地复现（用编译产物 `lib/`，模拟 bootstrap 的真实调用顺序，6 轮 own-life 周期）：

```
第1轮 observe 后 streak= 0  mutes= 0  valence= 0.0000
第2轮 observe 后 streak= 0  mutes= 0  valence= 0.0000
...
第6轮 observe 后 streak= 0  mutes= 0  valence= 0.0000
```

对照：喂测试里用的那个值（`Date.now() - 4h - 60s`，早于推送时刻）才扣分：

```
生产路径（新会话 lastActivity=now） valence: 0.0000 → 0.0000  降了? false
测试路径（lastActivity 早于推送）   valence: 0.0000 → -0.1200 降了? true
```

**连带后果（审计报告没提到、比 #1 本身更严重）**：`observePeer` 走的是 `budget.observe()`，而 `observe()` 的 `else if (!p.staleCounted) { p.staleCounted = true; this.markUnanswered(peerId); }` 分支同样因为 `wasAnswered` 恒真而永不执行。也就是说 `ProactiveBudget` 整套"没人理 → 3 天/14 天冷却 → 永久静默"退避机制**也是死的**。我上面那 6 轮模拟里 `unansweredStreak` 恒为 0、`mutedUntil` 恒为 0，即是证明。

**测试为什么绿**：`emotion.test.ts:522` 断言的是

```ts
svc.budget.recordProactive('u1');
svc.observePeer('u1', Date.now() - 60_000);   // ← 生产永远不会传这个形状的值
```

它测的是"`observePeer` 内部逻辑对不对"，不是"生产链路会不会走到"。这正是审计报告自己警告的"删了调用点测试照样绿"的镜像版本：**调用点在、测试绿、生产空转**。

#### #2 口癖管线 —— 接线真，质量假

grep（排除测试）：

```
$ grep -rn "extractCandidates\|promoteHabits\|retireStale\|markUsed" src/ --include=*.ts --exclude=*.test.ts
src/persona/service.ts:593:      const cands = this.voice.extractCandidates();
src/persona/service.ts:596:    this.voice.promoteHabits();
src/persona/service.ts:273:      const retired = this.voice.retireStale();
src/persona/service.ts:568:        if (h.style && text.includes(h.style)) this.voice.markUsed(h.id);
src/persona/voice.ts:230:  extractCandidates(): VoiceHabit[] {
src/persona/voice.ts:321:  promoteHabits(): number {
src/persona/voice.ts:346:  retireStale(now = Date.now()): number {
src/persona/voice.ts:380:  markUsed(id: string): void {
```

4 个函数 4 个真调用，都在分支里：`judgeVoice` 里 `if (this.voice.caughtSampleCount() >= 4)` 之后抽+转正；`pruneStale`（6h 定时器）里退役；`noteReplyChunk` 里 `if (h.style && text.includes(h.style))` 计使用。**接线层面：真修好，4/4。**

**但我把这条管线在真实数据上跑了一遍（复制副本到 `/tmp`，原文件未动）。** 用线上 `voice.json`（48 条正样本、0 条 habits）：

```
before habits: 0 samples: 48
[log] voice: 抽取 5 条候选口癖
   end:的。   count=2 state=candidate
   end:多。   count=2 state=candidate
   end:完了。 count=2 state=candidate
   end:一样。 count=2 state=candidate
   start:行,  count=2 state=candidate
[log] voice: 口癖「的。」转正
[log] voice: 口癖「多。」转正
[log] voice: 口癖「完了。」转正
[log] voice: 口癖「一样。」转正
[log] voice: 口癖「行,」转正
promoted: 5
active now: [ '的。', '多。', '完了。', '一样。', '行,' ]
```

渲染结果（`renderSection()` 会原样注入 system prompt）：

```
【你自己的一些说话习惯（视情况自由用，不强求；一轮最多用一条，连续两轮不要用同一条）】
- 当"想收尾时"时，可以用"的。"来表达。
- 当"想收尾时"时，可以用"多。"来表达。
- 当"想收尾时"时，可以用"完了。"来表达。
- 当"想收尾时"时，可以用"一样。"来表达。
```

两个结构性缺陷，接线通了就立刻暴露：

1. **`promoteHabits` 的转正门槛形同虚设。** 判据是 `h.count >= 2 && distinctEvidence >= 2`，而 `consider()` 里写死 `count: n`（`n >= 2` 是 `consider` 的入口条件），`evidence: samples.slice(0, 2)` 写死给 2 条且 `turnId` 必不相同 → **任何候选一产生就立刻满足转正条件，`promoteHabits` 永远是 100% 通过**。它不是在"把关"，是在"盖章"。
2. **抽取粒度是字符 n-gram，没有词边界。** 拿到的都是"的。""多。""行,,"这类标点尾巴。`FRAGMENT` 黑名单拦不住，因为没有语义判断。

也就是说：审计报告说这条"不只是没功能，是谎报健康"，现在**功能通了，但产出的是会污染 prompt 的垃圾** —— 从"谎报健康"变成"真报健康、真注入垃圾"。`persona-health.ts` 会开心地打印 `✅ 共 5 条，其中生效 5 条`。

#### #3 `maybeResetRoute` —— 真修好

```
$ grep -rn "maybeResetRoute" src/ --include=*.ts --exclude=*.test.ts
src/session/session-manager.ts:309:  maybeResetRoute(scope: ChatScope, peerId: string): void {
src/session/session-manager.ts:610:    this.maybeResetRoute(scope, peerId);
```

调用点确实在 `getOrCreate` 顶部（`session-manager.ts:592` 函数起、`:610` 调用），在 `if (existing) return` **之前**，所以已存在会话也会检查——审计报告说的"放在 getOrCreate 顶部而不是 openSession 里"这一点对上了。方法返回 `void`，不存在"忽略返回值"问题；幂等性由 `failover.maybeReset()` 内部 `cursor.delete` 保证。这是 6 条里最干净的一条。

小瑕疵（不影响判定）：`clearOverride` 只清持久化偏好，**当前活着的 agent 不会重建**（`rebuildSession` 只在 `setModelOverride` 里调）。所以"回主通道"要等会话被回收后重建才生效，最坏延迟一个 `sessionIdleTimeout`。

#### #4 `onRest` —— 真修好（有跨进程缺陷）

```
$ grep -rn "onRest" src/ --include=*.ts --exclude=*.test.ts
src/persona/service.ts:606:    // onRest 是 energy 的**唯一正向**来源，……
src/persona/service.ts:612:      if (last > 0 && now - last >= 6 * 3600_000) this.emotion.onRest();
src/persona/emotion.ts:290:  onRest(): void {
```

在 `flushTurn` 里，分支条件 `last > 0 && now - last >= 6h`，真调用。`flushTurn` 由 `outbound.ts:377/483` 在每轮 `turn/end` 调，链路真。

缺陷：`private lastTurnAt = 0`（`service.ts:200`）是**纯内存字段**，进程重启归零，`last > 0` 那一半条件会把重启后的第一次 `flushTurn` 挡掉（设计上正确），但重启后**第二次**就会因为 `now - last` 很小而不再触发——"睡了一觉"的时间维度在重启后丢失。不算致命，但"energy 唯一正向来源"依赖一个易失字段，值得记一笔。

#### #5 `recoverIfCalm` —— 接上了，但空转

```
$ grep -rn "recoverIfCalm" src/ --include=*.ts --exclude=*.test.ts
src/persona/self.ts:569:  recoverIfCalm(now = Date.now()): void {
src/persona/service.ts:302:      this.self.recoverIfCalm(now);
```

链路：`setInterval(6h)` → `pruneStale()` → `decaySelf()` → `recoverIfCalm(now)`。真接上，和审计报告"挂在 pruneStale 里"一致。

但函数体第一行就是 `if (g.lastComplainedAt === 0 || g.chattiness >= 1.0) return;`，而线上真实 `self.json` 是：

```
engagement: {'chattiness': 1, 'lastComplainedAt': 0, 'complaints': 0}
```

同时真实语料 130 轮里抱怨词命中 **0/130**。两个前提同时满足 → 每次调用立刻 return，什么都不做。功能上没写错（被判定的场景确实该是幂等空操作），但从"修好了没有"的角度：**这条修复至今零次生效，无法从数据上验证它对不对**。属于"接线正确、尚未被验证"。

#### #6 `recordNameCall` —— 半截（写入端接了，读取端仍缺）

```
$ grep -rn "recordNameCall\|extractVocatives\|notePossibleName" src/ --include=*.ts --exclude=*.test.ts
src/persona/service.ts:350:    const r = this.self.recordNameCall(name);
src/persona/question-detect.ts:375:export function extractVocatives(text: string): string[] {
src/middleware/persona-wake-gate.ts:183:        for (const n of extractVocatives(content)) {
src/middleware/persona-wake-gate.ts:184:          const r = persona.notePossibleName(n);
src/persona/question-detect.ts:362: * 为什么需要这个：`SelfProfileService.recordNameCall()` ……
src/persona/service.ts:347:  notePossibleName(name: string): { isNew: boolean; reachedThreshold: boolean } {
```

调用链是真的，且**在分支里**：`persona-wake-gate.ts:174` 的 `if (!ctx.state.collectOnly)` 内，只在"确实要回应"时才记。`notePossibleName` 还排除了已配置名和已接受名（`service.ts:348`），逻辑正确。写入端：真修好。

**但消费端仍然断着。** `recordNameCall` 把候选写进 `self.json.names`（`accepted:false, weight:0`），而候选名的所有读取者：

```
$ grep -rn "activeNames\|data.names" src/ --include=*.ts --exclude=*.test.ts
self.ts:254:  return this.data.names.filter((n) => n.accepted && n.weight > 0)...
self.ts:264/268/282/293:  (recordNameCall / acceptName / rejectName 内部)
```

`activeNames()` 过滤掉候选；`buildSections()`（`service.ts:355-395`）里**没有任何一段注入 names 候选**；`self.renderSection()` 只渲染 likes/hates；`persona-health.ts:134` 会打印，但那是 CLI，不是模型上下文。`qq_decide_name`（`tools.ts:180`）的 `name` 参数要模型自己填——**模型不知道存在哪些候选名，就永远不会去表态。**

于是 `wake-gate` 里这行日志：

```ts
if (r.reachedThreshold) logger.info(`persona: 称呼「${n}」被叫够了，等她表态（qq_decide_name）`);
```

会成为一条**永远等不到回应的日志**。审计报告说"等于一个永远点不动的按钮"，修完之后按钮的**写**端通了，**读**端没通——按钮依然点不动，只是日志里开始出现"等她表态"。

另外 `extractVocatives` 的"零误判"结论**不成立**。`a50bc2f` 的提交信息说"收紧到零误判"，但第三段规则是：

```ts
const voc = raw.match(/^([\u4e00-\u9fa5]{2,4})\s*[，,、]\s*(?:在吗|你在|你|在不在|干嘛|几点)/);
```

交替项里那个**光杆 `你`** 把门槛废掉了——任何"2~4 字 + 逗号 + 你…"都命中。实测（用编译产物 `lib/persona/question-detect.js`）：

```
"停一下，你先忙"     → ["停一下"]
"好的，你说吧"       → ["好的"]
"是啊，你说得对"     → ["是啊"]
"还行，你人呢"       → ["还行"]
"不知道，你问我"     → ["不知道"]
"太吵了，你闭嘴"     → ["太吵了"]
"小羽，在吗"         → ["小羽"]   （正例仍工作）
```

它自己的测试集恰好绕开了这条分支：`'写的不错，就像我并不完全了解你'`（逗号后是"就"）、`'被限速了，等一下'`（逗号后是"等"），所以"零误判"测出来是绿的。真实 100 轮语料上只命中 1 条（`小羽，几点了，你在干嘛`），所以**在这份语料上误判确实接近零**；但规则本身没到"零误判"，换个语料就会抽到"太吵了""停一下"当名字，而"太吵了"还会被 `wake-gate` 记成候选 → 阈值 3 后提示她去接受一个从没人叫过的名字。

---

## 二、情绪的正负写入点实际情况

`emotion.ts` 里 `bump()` 的 6 个调用（原文）：

```
emotion.ts:259  this.bump({ valence: 0.06, arousal: 0.12, energy: -0.01 });   onAddressed
emotion.ts:264  this.bump({ valence: 0.14, arousal: 0.08 });                 onReplied
emotion.ts:273  this.bump({ valence: -0.12, arousal: -0.05, energy: -0.03 }); onIgnored
emotion.ts:278  this.bump({ valence: -0.2, arousal: -0.15, energy: -0.05 });  onComplained
emotion.ts:286  this.bump({ energy: -0.08, arousal: -0.03 });                 onNightChat（valence 不动）
emotion.ts:291  this.bump({ energy: 0.1, arousal: -0.05 });                   onRest（valence 不动）
```

| 方向 | 符号 | Δvalence | 调用点 | 生产是否真触发 |
|---|---|---|---|---|
| 正 | `onAddressed` | +0.06 | `middleware/persona-wake-gate.ts:174`（`if (!collectOnly)`） | **是**：真实 130 轮里 130 次（每轮醒都记） |
| 正 | `onReplied` | +0.14 | `service.ts:622` `if (reply && user)` | **是**：真实 130 轮里 100 次 |
| 负 | `onIgnored` | −0.12 | `service.ts:334`（`observePeer` 内） | **否**：见 #1，条件恒假 |
| 负 | `onComplained` | −0.20 | `middleware/persona-wake-gate.ts:73`（命中 `COMPLAINT_RE`） | 通路真，但真实 130 轮命中 **0 次** |

**结论：正向 2 个、负向 2 个——不是"只有正向没有负向"那种最坏情况；但两个负向在实践中都调不动。** 有效负向写入点为 **0**。

用真实语料算实际配比：

```
语料轮数 130  onAddressed 次数 130  onReplied 次数 100
正向量合计 valence + 21.80
若按 own-life 实际上限 4 次/天、且只有没人理才计（假设全都没理）→ onIgnored 最多 - 0.48 /天
正负比 ≈ 45.4 : 1   （feiyu-mood 实测是 6.7:1）
```

把 130 轮按真实时间戳过一遍 `applyDeltas`（半衰期 24h/4h/12h 按现行参数）：

```
valence min/median/max: 0.200 1.000 1.000
>0.6 占比 97.7%   >0.85 占比 95.4%
energy min/max: 0.000 0.690   末值 0.445
speakWillingness 的范围: 1.08 ~ 1.40
```

**`valence` 中位数是 1.000（顶格）。** 报告说的"长期贴 1.4 上限"完全没变——修复 #1 之后仍然是贴顶。原因不是"负向写入点不存在"，而是"存在但触发不了"，加上正负比 45:1。

顺带修一个事实错误：审计报告写"`onIgnored` ……唯一负向来源"，这条在 `ec1e298` 时就是**错的**。取证：

```
$ git show ec1e298:src/persona/emotion.ts | grep -n "onComplained" -A 3
269:  onComplained(): void {
270-    this.bump({ valence: -0.2, arousal: -0.15, energy: -0.05 });

$ git show ec1e298:src/middleware/persona-wake-gate.ts | grep -n "onComplained"
72:      persona.emotion.onComplained();
```

审计当时就存在第二个负向写入点、而且有活调用。报告把"负向写入点被删了"讲成了"只剩正向"，夸大了严重度描述（不影响它发现问题的价值，但影响它对自身结论的可信度）。

---

## 三、四个闸门是否真实存在

结论：**四个闸门全部真实存在，且都在公式/条件里，不在日志或模板串里。**（这一点审计报告没说错。）

| 闸门 | 取值函数 | 注入点 | 消费点（分支/公式） | 判定 |
|---|---|---|---|---|
| ① 兴趣唤醒概率 | `speakWillingness` = `clamp(1 + 0.4*valence, 0.6, 1.4)` | `service.ts:235` `moodFactor:` | `wake.ts:315` `const probability = Math.max(0, Math.min(1, raw * (1 - 0.6*aversion) * mood));` → `wake.ts:412/461` `Math.random() < it.probability` | **真闸门** |
| ② 打字延迟 | `typingSpeedFactor` = `clamp(1.35 - 0.5*energy, 0.8, 1.4)` | `service.ts:254` `speed:` | `humanize.ts:101` `const speed = this.mood?.().speed ?? 1; ms *= speed;` | **真闸门** |
| ③ 分条数 | `burstLimit` = `arousal >= 0.3 ? min(2,cap) : 1` | `service.ts:254` `burst:` | `humanize.ts:123` `const want = this.mood?.().burst ?? this.burstMax; return Math.max(1, Math.min(this.burstMax, want));` | **真闸门**（但动态范围≈0，见下） |
| ④ 主动开口概率 | `speakWillingness`（同上） | `service.ts:417` `moodFactor: () =>` | `own-life.ts:319` `const p = Math.max(0, Math.min(1, rollProbability * (moodFactor?.() ?? 1)));` → `:320` `if (intervalMs > 0 && p < 1 && Math.random() >= p)` → `skipped:'roll-missed'` | **真闸门** |

`own-life.ts:319` 附近的完整逻辑（原文）：

```ts
if (nowTs - Number(state.lastFiredAt || 0) >= intervalMs) {
  const p = Math.max(0, Math.min(1, rollProbability * (moodFactor?.() ?? 1)));
  if (intervalMs > 0 && p < 1 && Math.random() >= p) {
    log(`掷骰未中（${(p * 100).toFixed(0)}%），这次不打扰`);
    return { ok: false, skipped: 'roll-missed' };
  }
  return fire('day', nowTs);
}
```

`rollProbability` 默认 0.7，乘 mood（0.6~1.4），再夹 [0,1] —— 是标准概率掷骰，写法正确。

**但"闸门存在"≠"闸门在起作用"，三点实测问题：**

1. **①④ 的输入锁死。** 闸门本身正确，可输入 `valence` 中位数 1.000 → `speakWillingness` 恒 1.40 → 概率恒为上限。闸门变成常量。这不是闸门的错，是 §二 的输入问题。
2. **③ 动态范围几乎为零。** `burstLimit` 阈值是 `arousal >= 0.3`，而 `BASELINE.arousal = 0.3` —— **基线恰好落在阈值上**。`arousal` 只有 `onAddressed(+0.12)/onReplied(+0.08)` 抬，`onIgnored/onComplained/onNightChat/onRest` 全压。真实语料里正向写入占绝对多数 → `arousal >= 0.3` 几乎恒真 → `burst` 恒 2 → "激动时连发两条"实际是"默认就发两条"。闸门在，可它区分不出激动和平静。
3. **② 的输入跟着 #4 走。** `energy` 末值 0.445（"有点累"），说明 `onRest` 那 +0.1 不足以抵消 `onNightChat` 的 −0.08 和 `onAddressed` 的 −0.01；`typingSpeedFactor(0.445) ≈ 1.13`，比基线慢 13%。属于"闸门有效但参数偏悲观"。

---

## 四、`emotion.ts` 里有没有新死代码

按同一方法（剥注释、排除测试、排除定义行）逐个扫 `emotion.ts` 的每个导出与每个写入点：

| 符号 | 全量命中 | 非定义消费者 | 判定 |
|---|---|---|---|
| `onAddressed` | 3 | `persona-wake-gate.ts:174` | 活 |
| `onReplied` | 3 | `service.ts:622` | 活 |
| `onIgnored` | 3 | `service.ts:334` | 活（但条件恒假，见 #1） |
| `onComplained` | 2 | `persona-wake-gate.ts:73` | 活 |
| `onNightChat` | 2 | `service.ts:625` | 活 |
| `onRest` | 3 | `service.ts:612` | 活 |
| `speakWillingness` | 6 | `service.ts:235`、`service.ts:417`、`wake.ts:87`(注释) | 活（两处注入） |
| `typingSpeedFactor` | 4 | `service.ts:254` | 活 |
| `burstLimit` | 4 | `service.ts:254` | 活 |
| `describeEmotion` | 5 | `service.ts:281`（日志）、`tools.ts:724`（给模型的 `qq_check_mood`） | 活 |
| `regress` | 4 | `emotion.ts:119/218/241`（类内） | 活 |
| `applyDeltas` | 2 | `emotion.ts:247`（`bump` 内） | 活 |
| `bump` | 7 | `emotion.ts` 内 6 处 | 活 |
| `current` | 99 | `service.ts:235/253/281/417`、`tools.ts:718` 等 | 活 |

**结论：`emotion.ts` 里"有定义、无调用"的 A 类死代码 = 0 个。** 审计报告这一步的修复是有效的，而且 `describeEmotion` 还额外接进了 `qq_check_mood`（模型可见），比审计要求更完整。

但要补一句更重要的判断：**这个文件现在的问题不是"死代码"，而是"活着的空转代码"。** `onIgnored`、`onComplained`、`recoverIfCalm` 三个都有定义、有调用点、有分支，却在真实数据下一次都不触发。`grep` 行数统计法（审计报告用的唯一指标）对这类**结构性缺陷完全失效**——它只问"有没有人调"，不问"调的时候条件成不成立"。

顺带核对时间线：审计报告说 `emotion.ts` 是"新文件"，并不可靠——`git log --follow` 显示它首现于 `b9ed065`（11:54:25），审计基线是 `ec1e298`（11:56:15），审计时它就已经存在了。

---

## 五、总体判断

### 可信度：**中等偏低。结论方向对，三条"已修复"的成色不足，且自我评价明显过于乐观。**

先说它对的地方（该承认的就承认）：

- **6 条 A 类的 grep 判定全部准确。** 我逐条复核，`ec1e298` 时它们确实各只有 1 行（定义本身）；现在 8 个都出现了真实调用行，且 `onIgnored`/`onRest`/`recordNameCall` 三个都确实在**分支条件**里而不是模板串——符合它自己定的"接线检查"标准。
- **四个闸门确实存在**，且都在概率公式/延迟乘子/条件判断里，`own-life.ts:319` 与 `wake.ts:315` 的位置描述准确。
- **"接上又被改掉"这个死法类型确实存在**，`onIgnored` 那次回归是真的。
- `maybeResetRoute` 修得干净，位置论证（为什么放 `getOrCreate` 顶部）也对。

再说它不可信的地方，按严重度排：

1. **`onIgnored`（#1）在生产路径上永不触发。** 调用点在、测试绿、但 `observePeer` 收到的是刚创建会话的 `lastActivity = now`，恒大于上次推送时刻。6 轮实地模拟：`unansweredStreak` 恒 0、`valence` 恒 0.0000。**报告把"接线通了"当成"问题解决了"。** 顺带发现它连带的 `ProactiveBudget` 退避机制也是死的——这一点审计报告完全没提。
2. **"唯一负向写入点"是事实错误。** `onComplained` 在 `ec1e298` 就存在且有活调用。夸大严重度会让"修好了"显得比实际更重要。
3. **`recordNameCall`（#6）只修了写端。** 候选名没有任何注入点，`buildSections()` 里没有、`renderSection()` 里没有、`qq_decide_name` 收不到列表。日志开始打印"等她表态"，但她永远不知道该对哪个名字表态。"点不动的按钮"依然点不动。
4. **`extractVocatives` 的"零误判"是假的。** 第三段规则的 `你` 分支实测抽出 `停一下`/`好的`/`是啊`/`还行`/`不知道`/`太吵了`。它的测试集恰好绕开了这条分支。真实语料上确实没误判（100 轮 1 正中），所以**在这份数据上结论碰巧成立**——但那是数据选得好，不是规则严。
5. **口癖管线（#2）虽然接线 4/4，但产出实测是垃圾**：`的。`/`多。`/`完了。`/`一样。`/`行,`，并且 `promoteHabits` 的判据让任何候选 100% 自动转正。这不是"死代码"，是"活着的坏代码"，比死代码更贵——它会真的注入 prompt。
6. **测试断言强度不足，且这个失败模式与报告自己定的规则同构。** `emotion.test.ts:522` 喂 `Date.now() - 60_000`，生产喂刚创建的 `lastActivity`。报告警告"删了调用点测试照样绿"，它没意识到反面也成立：**调用点留着、条件恒假，测试一样绿。**

### 还有哪些隐患

1. **修复还没上线。** 运行中的 bot 进程启动于 **11:08:41**，而所有修复提交在 **11:54:25 ~ 12:13:41** 之间；插件是软链到本仓库，`lib/` 在 12:13:10 才重建。Node ESM 不会热更服务端模块。硬证据：线上 `voice.json` 有 **48 条正样本（≥4 的抽取门槛）**、`habits` 却是 **0 条**——如果 `judgeVoice` 的新管线在跑，`extractCandidates` 早就该抽过至少一次。**"765 passing" 是源码层面的绿，线上仍是旧代码。**
2. **`maybeResetRoute` 回主通道要等会话重建**，`clearOverride` 只动持久化偏好，当前活着的 agent 不会重建。最坏延迟一个 `sessionIdleTimeout`（默认 30min），且只在 `getOrCreate` 被调用时才检查。
3. **`onRest` 依赖纯内存的 `lastTurnAt`**，进程重启后" slept 6h" 的判断失真；energy 的唯一正向来源压在易失字段上。
4. **`burstLimit` 的阈值 0.3 与 `BASELINE.arousal = 0.3` 恰好重合**，闸门③在基线处就在边界上，实际区分不出激动与平静。
5. **审计方法本身的盲区**：全程只用 `grep 行数` 作指标，能抓"没接上"，抓不到"接上了但触发不了"。这次的 #1、#5、#6 三条都恰好落在盲区里。建议下次加一步：**对每个新接线，用线上真实状态文件跑一遍，看它到底有没有产生位移**（我这次对 `voice.json`、`turns.jsonl` 就是这么做的，立刻暴露了问题）。
6. **`B` 类 10 条、`D` 类 2 条仍未处理**，我抽检其中 6 个（`activeInterestCount`/`dislikesTopic`/`dislikeLoad`/`renderRecent`/`prunePendingAttachments`/`isActiveWindow`）确认仍是"非定义行 1 = 只有定义"，与报告"未处理"的自述一致，不算虚报。

### 一句话回答委托的问题

**"6 个死代码修好了吗？"—— 接线：6/6 都真的接上了；生效：3/6（#2 通但产出垃圾、#3 干净、#4 基本可用），另外 3 条（#1 条件恒假、#5 当前空转、#6 读端缺失）是"接上了但没效果"。**

所以这份修复**值得肯定的是"动手改了、且改对了 grep 层面的病灶"**，**不值得采信的是"已全部修复"这个结论**——按它自己定的标准（"闸门是概率/延迟/条数/枚举，接线要在分支条件里"），#1 和 #6 都还没过线，而 #1 恰恰是它自称"命中了一次真实回归、最重要"的那一条。
