# 小羽 · 人设动态化 + 自主活动 设计方案

> 最后更新：2026-11-02（新增 §十六 M33 复核）
> 状态：M1~M32 已实施；M33 为复核后的修订（779 tests passing）

---

## 一、需求总览

| # | 需求 | 归属 |
|---|---|---|
| R1 | 称呼半自动学习：**喜欢了才接受** | 人设 |
| R2 | **感兴趣才接话**，否则潜水 | 人设 |
| R3 | 被嫌吵 → **降低接话频率**，但**继续读会话不发消息** | 人设 |
| R4 | 兴趣和喜恶**动态变化** | 人设 |
| R5 | 没提到她/兴趣 → **转被动**，直到被提及或命中兴趣 | 人设 |
| R6 | **自主冲浪**：低峰时段上网搜集感兴趣内容 | 自主活动 |
| R7 | **看手机屏幕**：感兴趣时主动搭话 | 自主活动（高风险） |
| R8 | **原仓库更新跟踪**（人设无关）：凌晨5点检查并自动判断可合并项 | 运维 |
| R9 | **移植代码也跟踪上游更新** | 运维 |

---

## 二、参考项目调研结论

从 GitHub 抓取的实际仓库文件树（`/tmp/tree_*.json`）：

| 项目 | 借鉴点 | 可移植性 |
|---|---|---|
| **MaiBot（麦麦）** | ①`weighted_sample` 加权采样：count→权重线性映射[1,5]<br>②人格 profile 持久化切换<br>③`maisaka_expression_selector` 表达筛选 | ⭐⭐⭐ 算法可直搬 |
| **generative_agents**（斯坦福小镇） | ①`importance/poignancy` 重要度<br>②`importance_trigger_curr` 触发阈值<br>③按重要度保留记忆 | ⭐⭐ 思想可借 |
| elizaOS / memobase / ai-town | 重型框架 / 记忆服务化 | ⭐ 不适用 |

**采纳的两条算法**：

```python
# 1. MaiBot 加权采样（兴趣选择）
weights = [1.0 + (count - min)/(max - min) * 4.0 for count in counts]  # 1~5
```

```python
# 2. generative_agents 重要度阈值（避免每条都跑重逻辑）
importance_trigger_curr -= cost
if importance_trigger_curr <= 0: 触发反思/整理
```

---

## 三、模块设计

### M1 · 状态机激活（最紧急）

**现状问题（实测确认）**：
- `wake()` 只写 `lastWakeAt`，**不改 mode**
- `dive()` 运行时**从未被调用**
- `isDiving()` 定义了**从未被使用**
- 结论：活跃/被动状态机是**空的**

**改法**（`src/persona/wake.ts`）：
```ts
wake(key) {
  const c = this.getConfig(key);
  c.mode = 'active';
  c.lastWakeAt = Date.now();
  c.until = Date.now() + activeWindowMs;   // 默认 10 分钟
  c.wakeCount = (c.wakeCount ?? 0) + 1;
}
dive(key) { this.getConfig(key).mode = 'diving'; }
isActive(key) {
  const c = this.getConfig(key);
  return c.mode === 'active' && (!c.until || Date.now() < c.until);
}
```

**接入流程**（`persona-wake-gate.ts`）：
```
群消息进来
 ├ 判定唤醒（@/名字/兴趣/关键词/提问）
 ├ 唤醒 → wake() → 回复 → 活跃 10 分钟
 ├ 活跃期内（未@也可） → 正常处理
 └ 非活跃 → ctx.stop() → 被动；history 照记（recordOnSkip 已开）
```

---

### M2 · `self.json` 自我画像

路径：`~/.dsh-qqbot/persona/app-{appId}/self.json`

```jsonc
{
  "names": [
    { "name": "小羽",     "weight": 1.0, "accepted": true,  "calledCount": 99, "source": "角色卡" },
    { "name": "小鲸鱼",   "weight": 0.0, "accepted": false, "calledCount": 2,  "askedAt": 1793... }
  ],
  "interests": [
    { "topic": "游戏", "weight": 0.6, "count": 5, "lastAt": 1793..., "findings": [] },
    { "topic": "咖啡", "weight": 0.3, "count": 2, "lastAt": 1793... }
  ],
  "engagement": {
    "chattiness": 1.0,          // 1.0 正常 → 0.1 几乎不说话
    "lastComplainedAt": 0,
    "complaints": 0
  },
  "screenWatch": {               // R7 专用
    "enabled": false,            // 默认关闭
    "allowedApps": [],           // 用户白名单
    "intervalMs": 1800000        // 30 分钟
  }
}
```

---

### M3 · 兴趣唤醒 + 动态更新

**唤醒概率**：
```
P = engagement.chattiness × normalize(interest.weight) × interestBaseProbability(0.5)
```

**更新规则**：

| 事件 | 变化 |
|---|---|
| 提到兴趣 | `weight += 0.05`（≤1.0），`count += 1`，`lastAt = now` |
| 因此接话**且被回应** | `weight += 0.1` |
| 因此接话**没人理** | `weight -= 0.05` |
| 7 天未提及 | 每天 `weight *= 0.95` |
| `weight < 0.1` | 从 interests 移除 |

---

### M4 · 称呼半自动学习（R1）

**规则**：
1. 新称呼第一次被叫 → `accepted:false`，`calledCount=1`
2. 被叫 **≥3 次** → 进入候选池（说明是长期习惯，不是偶然）
3. 小羽通过工具 `qq_accept_name` 表态 → `accepted:true` 才真正能唤醒
4. **她可以拒绝**（拒绝后仍 `accepted:false`，不唤醒）

**偏好判据（三条满足其一就接受）**：
- 该称呼被叫 ≥3 次
- 用户叫时语气亲近（含"我家/可爱的/我的"等）
- 小羽自己决定接受

---

### M5 · 被嫌吵收敛（R3）

**触发词**：`太吵` `别刷屏` `安静点` `闭嘴` `别发了` `少说点` `烦死了`

**触发**：
```
engagement.chattiness *= 0.3
engagement.lastComplainedAt = now
engagement.complaints += 1
```

**恢复**：
- 24h 未再被嫌 → `chattiness += 0.1`（上限 1.0）
- 用户主动说话 → `chattiness += 0.2`
- 连续被嫌 2 次 → `chattiness = 0.1`（近乎静默）

**注意**：即使静默，`historyBuffer` 仍记录所有群消息（`recordOnSkip: true`），下次被叫醒能接上上下文。

---

### M6 · 「自己的时间」上网冲浪（R6）🆕

#### 时段规则（用户明确）
| 时段 | 允许 |
|---|---|
| **凌晨 3:00–7:00** | 冲浪（浏览器 + 虚拟屏） |
| **中午 12:00–14:00** | 只用**内置浏览器 + 虚拟屏幕** |
| **息屏状态** | **只有虚拟屏幕可用**（不能操作实体屏） |

#### 启动流程
```
凌晨 2:00 → 主动向用户发消息「请求玩手机」
  ├ 用户同意 → 进入冲浪会话（3:00 开始）
  ├ 用户拒绝/不回复 → 不启动
  └ 3:00–7:00 时段结束后，或「没什么想看的了」→ 结束一轮，去休息
```

#### 冲浪动作
```ts
topInterests = self.interests 按 weight 排序取前 2-3 个
for (const it of topInterests) {
  const res = await surfWeb(it.topic)   // 能力来源见下
  self.interests[it].findings.push({
    at: now, summary: res.summary, source: res.url
  })
}
// 上限：每轮 findings 最多 5 条，防膨胀
```

#### 能力来源（实测结果 2026-10-31）
| 方式 | 状态 | 说明 |
|---|---|---|
| `web_search` | ❌ | 无 API key |
| **Bing 搜索（curl）** | ✅ **可用** | `https://cn.bing.com/search?q=xxx`，UA 必需，返回 10 条结果可解析 |
| **Hacker News API** | ✅ **可用** | `https://hacker-news.firebaseio.com/v0/topstories.json` + `/item/{id}.json` |
| **GitHub 仓库搜索** | ✅ 可用 | `https://api.github.com/search/repositories?q=...`（有速率限制） |
| V2EX API | ❌ 无响应 | |
| RSSHub | ❌ 无响应 | |
| `dsh-tool-vscreen` 开 App | ⚠️ 待实测 | |

**Bing 提取实测代码**：
```python
import re
h = open('/tmp/bing1.html',encoding='utf-8',errors='ignore').read()
# → 10 条结果，含标题+链接
m = re.findall(r'<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>(.+?)</a>', h, re.S)
```
实测样例输出：
```
游戏新闻_游戏新闻中心_3DM新闻 | https://www.3dmgame.com/news/game/
今天游戏新闻：PC、PS5、Xbox与Switch | GAMES.GG | https://games.gg/zh-CN/news/
游戏新闻中心::17173.com::中国游戏门户站 | https://news.17173.com/
```

**结论：自主冲浪的技术底座已打通** —— 用 `curl` + Bing 就够用。

#### ⚠️ 截图能力实测结论（2026-10-31）
| 能力 | 可用性 | 说明 |
|---|---|---|
| 前台 App | ✅ 251ms | `dumpsys activity activities`（容器侧 grep） |
| 息屏状态 | ✅ 272ms | `mWakefulness=Awake` |
| 设备概览 | ✅ 32ms | `/app/device` |
| **截图** | ❌ | `ACCESSIBILITY_UNAVAILABLE` —— **无障碍服务已装但没开**（`accessibility_enabled=0`） |
| **虚拟屏** | ❌ | `VSCREEN_DISCONNECTED, cleanupPending` |

**根因**：`dsh.android.client/com.deepseekharness.app.DshaAccessibilityService` 已声明，但开关关闭。
**修复**：设置 → 无障碍 → 打开 DSHA 服务。开启后截图预期恢复。

**已知限制**：
- 设备 shell 禁止管道、禁止 `screencap`
- 存在 `FLAG_SECURE`：开无障碍后若截图全黑，是第二层原因

#### 息屏检测（已实测可用）
```bash
adb-shell dumpsys power | grep mWakefulness
# → mWakefulness=Awake      屏幕亮着
# → mWakefulness=Asleep     息屏
```
**这是「息屏时只玩虚拟屏」判断依据。**

#### 一轮冲浪的完整流程
```
凌晨 2:00 ── 主动发 QQ 消息：「我能玩会儿手机吗？」
              ↓
用户同意 ──→ 进入待命，等 3:00
用户拒绝/不回复 ──→ 本轮不启动
              ↓
凌晨 3:00 ── 检查屏幕状态（mWakefulness）
              ├ Awake（亮屏）→ 浏览器 + 虚拟屏都可用
              └ Asleep（息屏）→ 只用虚拟屏
              ↓
冲浪（循环，最长到 7:00）
   ├ 从 self.interests 取 top 2-3
   ├ surfWeb(topic) 搜索/浏览
   ├ 结果写入 findings（每轮最多5条）
   └ 若「没什么想看的了」→ 提前结束
              ↓
7:00 或提前结束 ── 结束本轮，去休息（写日记/静默）
```

---

### M7 · 看手机屏幕主动搭话（R7）🆕⚠️

#### 实测能力矩阵（2026-10-31）

| 能力 | 结论 | 成本 |
|---|---|---|
| `/app/device` | ✅ 最廉价筛查（screen=on/off + app_foreground） | **3ms / 210B** |
| 前台 App（`dumpsys window` + `mFocusedApp`） | ✅ 稳定，6次一致 | **0.25s** |
| 控件树（`/app/ui/dump`） | ✅ 含完整屏幕文字 | **30-99ms / 21KB** |
| 截图（亮屏） | ✅ 可用 | 0.50s / **1.83MB** |
| 截图（息屏） | ⚠️ **返回 ok:true 但纯黑** | 别调！ |
| 唤醒屏幕 | ❌ **无任何 API** | 只能用户手动按电源键 |

**关键结论**：
1. **控件树比截图省 91 倍体积，且更快** → 默认用 dump，截图只作兜底
2. **息屏 screenshot 会假报成功**（返回 `{"ok":true}` 但纯黑 18,948B）→ **必须加硬门禁：`/app/device` 的 screen==off 直接跳过**
3. **Android 16 没有 `mResumedActivity`** → 用 `mFocusedApp`（注意 `mCurrentFocus` 会分叉，下拉通知栏会误判）
4. **`Intent { dat=... }` 会泄露完整 URL**（如 bilibili 的 aid/cid）→ 能知道在看哪个视频，但要当隐私数据
5. **无障碍会自己变**：启动时必须检查 `settings get secure accessibility_enabled`

#### 推荐的观察流程（成本优化）
```
心跳 30-60s：
  /app/device（3ms）
    ├ screen==off  → 整轮跳过（息屏啥也看不到）
    ├ app_foreground==false → 跳过
    └ 否则 → dumpsys window 拿 mFocusedApp（0.25s，仅包名变化时）
          ├ 命中隐私黑名单 → 跳过
          ├ 每 2-3 分钟（或用户发言后）→ /app/ui/dump（30-99ms）判内容
          └ 截图：≤1次/5分钟，仅在需要看画面时
```

#### 隐私排除规则（实测可行）
| 规则 | 依据 |
|---|---|
| R1 包名黑名单 | 支付/银行/密码/聊天工具 → `mFocusedApp` 直接命中，零成本 |
| R2 Activity 关键词 | `Password/Login/Pay/Wallet/Transfer/Verify` 等 |
| R3 控件树文字 | `付款/支付/验证码/余额/转账/身份证` 等 |
| R4 锁屏 | `KeyguardServiceDelegate` 的 `showing=true` |
| R5 息屏硬门禁 | `screen==off` 直接跳过 |
| R6 系统界面 | `com.android.systemui` / `com.miui.home` 跳过 |

⚠️ 实测澄清：`dumpsys window` 里的 `secure=true` **只在锁屏段**，**不能**用来判断单 App 的 FLAG_SECURE。

#### 🔴 通知栏隐私盲区（2026-10-31 补测，最重要）

**实测事故**：展开通知栏后 dump/screenshot，直接读到：
- 招商银行通知（含"尾号"等字样）
- 微博社会新闻推送
- B站正在播放的音频卡片（能看出用户在听什么）

**根因**：通知栏展开时
- `mCurrentFocus` = `Window{... u0 NotificationShade}`
- `/app/ui/dump` 的 `target.packageName` = `com.android.systemui`（**看着人畜无害**）
- 但 `nodes` 里是**完整的用户通知内容**

**必须加的规则**：
```python
# 读内容前先拦掉（包名黑名单在这里是盲区！）
if focused_pkg in ("com.android.systemui",) or current_focus == "NotificationShade":
    SKIP   # 不读 nodes、不读 text、不截图
```

**关键判据（两者分叉=遮挡）**：
| 用途 | 字段 |
|---|---|
| 判断"在用哪个 App" | `mFocusedApp`（不受遮挡影响） |
| 判断"屏幕现在显示什么" | `mCurrentFocus`（能识别通知栏/锁屏遮挡） |

**两者分叉时 → 判定为遮挡状态 → 跳过本轮。**

#### 其他修正
- **截图体量 1–2 MB 浮动**（取决于画面复杂度，非固定 1.83MB）
- **控件树有 200 节点上限**：复杂页面（长列表/聊天记录）会被截断，不能指望一次 dump 拿全
- **`/app/open?url=` 能唤醒屏幕**（走 ACTION_VIEW 把设备从 Dozing 拉起），但**会打断用户**，极慎重
- `/app/launch?pkg=` 在息屏时**无效**（实测 OK 但屏幕不亮）

#### 测耗电注意
测试期间设备在充电，**无法推断实际耗电**。需未充电状态单独测。



#### 流程
```
定时（默认 30 分钟）
 ├ 取当前前台 App 包名（轻量，不截图）
 ├ 若在白名单内 → 截图
 ├ 视觉模型理解内容
 ├ 判断是否与 interests 相关
 └ 相关 && chattiness > 0.5 && 预算允许 → 主动发 QQ 搭话
```

#### 隐私硬边界（必须排除，不可配置放宽）
- 支付类：支付宝 / 银行 / 微信支付
- 密码 / 验证码页面
- 私密聊天：QQ / 微信对话界面
- 相册 / 证件照 / 相框
- 输入法界面

#### 默认策略
- **默认关闭**（`screenWatch.enabled: false`）
- 只允许用户明确配置的 App 白名单
- 频率默认 30 分钟
- 每次观察后立即丢弃截图（不长期留存）

---

### M8 · 原仓库更新跟踪（R8）🆕（人设无关，独立定时任务）

#### 目标
凌晨 **5:00** 检查 fork 的上游仓库（`tencent-connect/dsh-qqbot`）有无更新。

#### 流程
```
1. git fetch 上游
2. 对比本地 fork 与上游的差异（commit + 文件级 diff）
3. 自动判断哪些可合并：
   ├ bug 修复 / 小改动 → 自动合并（跑测试通过后）
   ├ 大改动 / 冲突 / 不确定 → 不合并，留言提醒用户
   └ 记录判断结果到 /root/.dsh-qqbot/upstream-sync.log
4. 若判断不了 → 写提醒给用户（通过 QQ 私信或落盘备忘）
```

#### 输出
- `/root/.dsh-qqbot/upstream-sync.log`：每次检查的结论
- 需要用户决策的项：写入 `pending-review.md` + 主动告知

---

### M9 · 移植代码的上游跟踪（R9）🆕

**答案：应该跟踪。** 我们移植了 `ai-companion-kit`（persona/wake/memory/own-life/humanize 等）。

#### 做法
在 M8 的定时任务里一并检查：
```
跟踪的上游：
  - tencent-connect/dsh-qqbot       (fork 主体)
  - pinganbbOvO/ai-companion-kit    (persona 层移植源)
  - MaiBot 相关算法                 (weighted_sample 等思路)

检查：上游是否修改了我们移植过的文件
判断：改动是否值得同步（bug 修复=是；重构=看情况；不明确=问用户）
```

**记录文件**：`/root/.dsh-qqbot/upstream-tracking.json`
```jsonc
{
  "sources": [
    { "repo": "pinganbbOvO/ai-companion-kit", "ported": ["wake.js","memory.js","own-life.js"],
      "lastChecked": "...", "upstreamHead": "...", "ourBase": "..." }
  ]
}
```

---

### M10 · 目录/清单一致性校验

**规则确立**：
1. `_index.json` 是**唯一权威**（分类只看清单，不看目录名）
2. 目录只是物理容器，不承担分类语义
3. 定期自检：
   - 索引里的 path 是否都存在
   - 磁盘上是否有未入库的图（待分类）

**脚本**：`/tmp/sticker_pipeline/verify.cjs`
输出：孤儿文件 / 失效索引 / 重复图

---

## 四、实施顺序

| 顺序 | 模块 | 依赖 | 风险 | 备注 |
|---|---|---|---|---|
| 1 | M1 状态机激活 | 无 | 低 | 影响全部，必须最先 |
| 2 | M2 self.json | 无 | 低 | 数据基础 |
| 3 | M3 兴趣唤醒+动态 | M2 | 中 | |
| 4 | M4 称呼学习 | M2 | 中 | |
| 5 | M5 被嫌吵收敛 | M2 | 低 | |
| 6 | M10 一致性校验 | 无 | 低 | 独立，可穿插 |
| 7 | M6 上网冲浪 | M2+能力实测 | 中 | 需先验证搜索能力 |
| 8 | M7 看屏幕搭话 | M2+能力实测 | **高** | 隐私风险，默认关 |
| 9 | M8/M9 上游跟踪 | 无 | 低 | 独立定时任务 |

---

## 五、待确认 / 待实测

| 项 | 状态 |
|---|---|
| ego-browser 具体用法 | 待实测 |
| 哪些搜索源可用 | 待实测 |
| 虚拟屏开 App 可行性 | 待实测 |
| 截图+读屏权限 | 待实测 |
| 屏幕观察白名单 App | **等用户确认** |
| 主动搭话频率上限 | 现有 `maxProactivePerDay: 2` |

---

## 六、已确定的参数（按用户"按你建议来设定"）

| 参数 | 值 |
|---|---|
| 活跃窗口 | 10 分钟 |
| 兴趣基础唤醒概率 | 0.5 |
| 被嫌吵后 chattiness | → 0.3 |
| 兴趣衰减 | 7 天未提，每天 ×0.95 |
| 称呼接受门槛 | 被叫 ≥3 次 |
| 冲浪时段 | 凌晨 3–7 点；中午 12–14 点仅浏览器/虚拟屏 |
| 息屏时 | 仅虚拟屏 |
| 请玩手机时间 | 凌晨 2:00 |
| 上游检查时间 | 凌晨 5:00 |


---

## 七、调研结论与修正（2026-10-31，详见 research-digest.md）

调研报告 `/root/.dsh-qqbot/research-digest.md`（519行/65KB）指出了我们实现中的 **3 个真实缺陷**。

### 7.1 三个必须修正的设计问题

| # | 我们的问题 | 调研结论 | 修正方向 |
|---|---|---|---|
| 1 | **把"迁移"误建模成"衰减"** | Reddit 710万用户研究（arXiv 1912.09210）证明人的兴趣是 **drift/shift（突发迁移）**，不是平滑衰减；MaiBot/elizaOS/MemoryBank 三个独立项目都收敛到同一套（两库+事件分型+饱和强化+双阈值滞回） | 改 `self.ts` 的衰减：`2^(-Δ/HL)` + 饱和强化 `s←s+α(1-s)` + 冻结态(非删除) + 双阈值 0.1/0.15 |
| 2 | **兴趣权重"只读不写回"** | MemoryBank（arXiv 2305.10250）`R=e^(-t/S)`，**每次召回 S+=1 且 t 重置**。我们的 `topInterests()` 只读，所以兴趣必然全部压平到 0 | 召回即强化（写回） |
| 3 | **硬约束在历史之前，越聊越被冲掉** | CCv3 `post_history_instructions`（SillyTavern 一直这么用）；理论 arXiv 2601.10387「Assistant Axis」：**助手人格是势能最低点，客服腔是引力默认值** | 把 BASE_RULES + 角色卡移到历史之后 |

### 7.2 新增待做模块

| 模块 | 内容 | 优先级 |
|---|---|---|
| **M11 voice.json 口癖系统** | 从"她自己被接住的那句话"学口癖（行业无现成实现，需自研）。正样本 = 她发言后 5 分钟内被回应/复读/引用；四关护栏；未 confirmed 不注入 | **P0** |
| **M12 兴趣两库化** | `kind: durable（永不衰减）/ current（会淡）` + 事件分型（ACCESS +0.05带冷却 / EVIDENCE 直接1.0）+ 双阈值滞回 | **P0** |
| **M13 抗漂移** | ①硬约束放历史之后 ②规则必须带证据且经确认 ③输出层确定性黑名单替换 | **P1** |
| **M14 预算闭环** | 把 M5 的 `chattiness *= 0.3` 换成 MaiBot `dynamic_gate` 的闭环控制器：**只收紧不放宽**，改的是 frequency（目标）而非人格 | **P1** |
| **M15 叙事出口** | `self.json` 加 `history[]`（`{at, kind:'new_like'|'taste_shift'|'gave_up', topic, from, to}`），每月生成 3 行"我最近变了什么"注入 | **P1** |

### 7.3 关键设计细节（从调研抄来的）

**饱和强化**（替代线性 +0.05）：
```
s ← s + α(1-s)    // 越接近 1 涨得越慢，符合人性
ACCESS α=0.05（60min 冷却）  // 她主动用了一次/被召回
EVIDENCE α=0.5（直接置1.0档） // 用户明确说"我喜欢/我讨厌"
```

**双阈值滞回**（防抖）：
```
freeze 0.1 / revive 0.15
权重在 0.1 附近时，一次提及不会反复"删除→重建→再删除"
MaiBot 甚至在 model_post_init 里硬校验 revive > freeze
```

**两库分层**：
| 库 | 何时用 | 衰减 |
|---|---|---|
| `durable`（长期品味） | 喝咖啡、读书 | **永不衰减** |
| `current`（正在追） | 当前在玩什么游戏 | `confidence·e^(-ageDays/14)` |

**闭环预算（替代一次性乘子）**：
```
预计回复数 = Σ概率 + @强制×0.91
目标回复数 = 预计 × frequency(默认0.5)
保留比例 = (目标-强制)/主动 × 反馈因子
**只收紧不放宽** —— 否则一波消息过后收不回来
```

### 7.4 行业空白（需自研，别浪费时间找参考）

1. **从 AI 自己生成中学习口癖** —— MaiBot 明确过滤 `is_bot_self()`，全行业无人做
2. **中文语境的句式级口癖** —— Mirrai 用触发词，中文更多是句式
3. **AstrBot/elizaOS/Letta 对人格演化零帮助** —— 全是静态 CRUD，别再调研


---

## 八、小黑盒实践补充（2026-10-31，详见 heybox-digest.md）

采集到 4 篇核心技术帖，其中有 **3 个发现直接指出我们的缺失**。

### 8.1 L0–L4 五层记忆链（无想仙人《目前全网 QQ 大肥鱼的最优方案》）

| 层 | 内容 | 我们的现状 |
|---|---|---|
| L0 | 原文库（完整对话存档） | ✅ `turns.jsonl` |
| L1 | 会话摘要（滑动窗口，防"跟不上话题"） | ⚠️ 只有 recent 3 条，无摘要 |
| L2 | 长期权重链（艾宾浩斯，按频次加减权） | ✅ M12 刚做完 |
| L3 | 产物索引（只对 owner 生效） | ❌ 缺（有权限分层需求） |
| **L4** | **selfNote：AI 写自己的成长叙述，有上限、旧叙述归档** | ❌ **最缺，是"人格保持"的核心** |

**L4 的关键设计（作者认为是五层里最重要的一层）**：
- 前四层记录"用户"，**L4 是记录它自己**
- AI 不定期对自己写叙述，**有字数上限**
- 新叙述出现 → 旧叙述**归档**（不是删除）
- 目的："不希望它每次醒来都看着臃肿的过去"，"重新开一个新对话也不会觉得陌生"

### 8.2 上下文压缩策略（最实操）

```
对话进行中：阈值 0.95 → 永不压缩
只在"闲置边界"压缩，触发条件三合一：
  - 安静 30 分钟
  - DSH 没在跑
  - 上下文 > 30 万 token
动作顺序：先写记忆（含 selfNote）→ 再 /compact
三条失败路径全部"宁可不压"：
  - 记忆没投出去 → 不压
  - 记忆没写完 → 不压
  - /compact 没识别 → 不压
```

### 8.3 两个反直觉结论（推翻"写得更详细就更好"）

| 结论 | 证据 |
|---|---|
| **人设越长越差** | XRH66 实测：近 3000 字人设精简后效果更好 |
| **堆语言实例 = 养出复读机** | 是拾亦："人格卡越来越臃肿，发言越来越套模板"。根因：**上下文越长，模型越不精读、只做选择性调用** |

→ **需要检查我们角色卡里有没有回复模板，有就去掉。**

### 8.4 新增待办

| 模块 | 内容 | 优先级 |
|---|---|---|
| **M16 selfNote** | L4 层：她自己写成长叙述，有上限+旧叙述归档。**这是"M11 口癖"之外另一个缺失的自我层** | **P0** |
| M17 人格卡查重 | 用提示词核查角色卡里重复/冲突内容 | P1 |

---

## 九、M18 按人计数的活跃窗口（2026-10-31）

### 9.1 问题

原实现：整个群共享一个 `idleStreak`。只要有人提到她，全会话进入活跃期，
之后**任何人的任何无关消息**都累计这个计数。后果：

- A 提了她，B 一直在聊股票 → A 还没说完，她的窗口就被 B 的闲话关掉了
- 多人同时提她时，计数互相污染

### 9.2 现在的模型

```ts
interface SpeakerWindow {
  until: number;       // 这个人的窗口到期
  idleStreak: number;  // 这个人连续多少条"与她无关"
  lastWakeAt: number;
}
// WakeConfig.speakers: Record<userId, SpeakerWindow>
```

规则：

| 情况 | 行为 |
|---|---|
| 谁提到她（@/名字/关键词/兴趣/明确问句） | 只给**这个人**开窗口，`idleDiveThreshold` 默认 5 |
| 他接着说她的事 | `idleStreak` 归零 |
| 他连续 5 条跟她无关 | 关掉**他的**窗口 |
| 别人（没提过她）说话 | `idleStreak` **不动**，不回答（`active-window:bystander`） |
| 他明确在问别人（"老张吃了吗"） | 不抢话，也**不记**他的计数（`active-window:excluded`） |
| 关窗口时还有人窗口活着 | 会话保持 active（`active-window:speaker-closed`） |
| 所有人都关了 | 会话回潜水（`active-window:auto-dive`） |
| 同时开窗口的人超过 4 个 | 挤掉最早到期的那个 |

### 9.3 为什么阈值是 5 而不是 3

3 条时，正常的"提了一句 → 对方聊两句别的事 → 再回头找她"会被误判成话题飘走。
5 条留出了普通人切换话题的余量。配 `idleDiveThreshold` 可调。

### 9.4 问句识别（question-detect.ts）

旧正则 `/[?？]|怎么|为什么/` 对中文口语几乎无效——`吃了吗`/`在干嘛`/`忙不忙`
全部漏判（实测 7 条 0 命中）。新模块用纯规则打分：

- **A不A 正反问**：定位否定词后反向切片比较（不是贪婪 `.*`），
  `忙不忙/来不来` 全中，`差不多/对不起` 天然不中
- **句末省略式**：`吃了没/有空没`，配第一人称守卫（`我没吃` 是回答不是提问）
- **「吧」四种用法**：祈使/弱陈述/揣测/附加问，判别顺序关键
- **「呢」**：`你呢` 是问，`上课呢` 是陈述（无第二人称且短 → 进行体）

指标：自建语料 recall 100%、误报 0；留出集（未参与调参）100%/0；单次 7.4µs。

### 9.5 关键判据：不在句子，在"谁说的"

`吃了吗` 这种句子本身无法判断是不是问她。真正的判据是
**"出自刚刚提到她的那个人"**——所以窗口所有者说的问句默认是问她，
旁观者说的同样问句不接。

---

## 十、M19 引用归属与备用通道（2026-10-31）

### 10.1 事故现场

群里 jmx 说「卡了就别催了 我这边也动不了」，群主引用它并 @小羽。
小羽回：**「刚不是你那边卡了，我这边也遇到了限流，回复没发出去。」**

两个错叠在一起：
1. 把 **jmx 说的话算到了群主头上**
2. 复述了 **系统代她发的运维提示**（`RATE_LIMIT: raccoon`），
   把"我这边的通道被限流"说成了一件发生在对话里的事

### 10.2 根因

`buildQuotePart` 只拼引文正文：

```
[Quoted message begins]
=== 消息 1 ===
[消息内容] ⚠️ 本轮异常结束 / RATE_LIMIT: raccoon ...
=== 消息 2 ===
[消息内容] 卡了就别催了 我这边也动不了     ← 没有任何署名
[Quoted message ends]
[Current message]
[…… (2DA749...) (@you)]              ← 只有这句标了是谁
```

模型看到的是「两条无署名引文 + 一个 @you」，自然把两条都归给"你"。

**更隐蔽的一层**：那条 RATE_LIMIT 是系统代小羽发的，它进了群、又被用户引用回喂给小羽。
于是形成一个闭环：
```
小羽被限流 → 系统代发运维文案 → 用户引用它 → 小羽看到"自己说过这话" → 编造解释
```

### 10.3 修复

| 项 | 做法 |
|---|---|
| 单条引用 | 加「这段引文来自「jmx」…不是你正在对话的那个人」 |
| 合并转发 | **逐条**标注归属（不能整体判一次，否则 jmx 的话会被标成系统提示） |
| 运维提示 | 单条时整块略去；合并转发里逐条剥离（`[消息内容] （系统提示，已略去）`） |
| 群里错误提示 | 只说「这轮没接上，等下再试」，不带错误码与通道名 |
| 私聊错误提示 | 保留完整细节，供 owner 排查 |

修复后模型看到的是：
```
[Quoted message begins]
（这段引文来自「jmx的大蠢鱼」…，不是你正在对话的那个人）
=== 消息 1 ===
[消息内容] （系统提示，已略去）
=== 消息 2 ===
[消息内容] （jmx的大蠢鱼）卡了就别催了 我这边也动不了
```

### 10.4 备用通道（M19）

`persona.fallbackRoutes`，默认空 = 行为不变。

判据比"任何失败都换"更保守：

| 换路 | 不换 |
|---|---|
| RATE_LIMIT、OVERLOADED、SERVER | CONTEXT_TOO_LONG（换通道照样超） |
| MISSING_CREDENTIAL、NO_ADAPTER | INVALID_REQUEST |
| MODEL_UNAVAILABLE | ABORTED / CANCELLED |

三个设计点：
- **粘住**：切走后后续轮次继续用备用通道，不每轮重打主通道
- **冷却 10 分钟**：到期才回头试主通道
- **到底就停**：最后一路也失败时不假装还有后手

现场配置：主 `trae/deepseek-v4.1-flash` → 备 `our-free-model/deepseek-v4.1-flash-free`
→ 再备 `our-free-model/glm-5.3-flash-free`

---

## 十一、M20 GitHub 推送与网络（2026-10-31，基于 Steam++ 调研）

### 11.1 Steam++ 的 GitHub 加速是什么

不是镜像或中转，而是「**本地 TLS 中间人反代 + hosts 劫持 + 规则表按域名换上游**」。
客户端起本地反代，把域名解析到本机、现签该域名证书，再按规则打到上游 IP。
规则表不在仓库，由 `api.steampp.net/accelerator/projectgroups` 下发。

对 push 有设计（规则 `Github 网站 (Git Push)`，上游 `20.207.73.82`，
`HttpTransformer.Empty` 原样透传），但**不能直接用**：
git/ssh 专用监听在 `YarpReverseProxyServiceImpl.cs` 里被注释掉了，
拦截器包在 `#if WINDOWS`，Linux 包只有 x64（本机 aarch64）。

**能复用的只有它的上游 IP 名单。**

### 11.2 采纳并复验的结论

| 结论 | 复验结果 |
|---|---|
| `140.82.113.3`（原 hosts）不可用 | ✅ 连接超时 |
| `20.200.245.247` 最快 | ✅ ls-remote 1242ms，优于 20.27.177.113(1723) |
| `gh-proxy` 对 git 写操作丢 Authorization | ✅ 直连 receive-pack **200**，经代理 **401** |
| HTTP/1.1 优于 HTTP/2（gnutls 的 -110） | ✅ 同 IP 下 17.7s vs 13.7s |

### 11.3 落地做法（不写 hosts）

用 `http.curloptResolve` 让 git 单独走快 IP，比改 `/etc/hosts` 干净
（hosts 文件头有 `# dsh-opt` 注释，疑似自动化脚本维护，会被覆盖）：

```
http.curloptResolve = github.com:443:20.200.245.247
http.version        = HTTP/1.1
http.postBuffer     = 524288000
http.lowSpeedLimit  = 0
http.lowSpeedTime   = 0
```

效果：**push 从"13 秒 + 反复超时重试"变成 2.3 秒一次成功**。

### 11.4 不用 gh-proxy 做 push

gh-proxy 会剥掉 Authorization。想读可以用它（fetch 正常），
写必须直连。兜底方案：`api.github.com` 的 Git Data API（0.35–0.83s 快通道）。

### 12.5 归属索引的两阶段状态（重要，避免误判）

实测时间线（2026-10-31）：

```
13:14  进程启动        ← 加载 ae011a6（独立归属索引，纯内存版）
14:05  改为落盘 6fdae2a ← 进程未重启，新代码未加载
14:13  用户引用小羽的话 → 认出「这是你自己之前说的」
```

**这次能认出，是同一进程生命周期内的内存反查在起作用** ——
因为小羽说那句话和执行引用的时间，都发生在 13:14 启动的这个进程里。

所以判断"某次改动是否生效"必须同时看两个数：
- `lib/` 构建时间
- **进程启动时间**（`stat -c %y /proc/<pid>`）

构建早于启动 → 生效；构建晚于启动 → 没生效。只看"重启过了"会误判。

当前两阶段差异：
| 能力 | 状态 |
|---|---|
| 同进程内反查 | ✅ 已生效（13:14 那版） |
| 跨重启保留 | ⏳ 待 6fdae2a 重启 |

---

## 十二、M21/M22 引用归属的完整演进（2026-10-31 ~ 11-01）

### 12.1 问题链条

用户截图反馈：群主引用 jmx 说的「卡了就别催了」，小羽回
「刚不是你那边卡了」——**把别人的话算到了群主头上**。

根因链（每修一层都暴露出下一层）：

| 层 | 问题 | 症状 |
|---|---|---|
| L1 | 引用块不拼发送者 | 模型看到无署名引文 + `(@you)` → 全归给"你" |
| L2 | 记录位置在 handleInbound（门禁之后） | 没 @她的消息被 ctx.stop() 拦掉，永远不进索引 → **只认得自己的话** |
| L3 | 索引纯内存 | 重启后清空 → 引用重启前的话查不到 |
| L4 | 群历史每轮被 clearGroupHistory 清空 | 用历史反查的方案直接失效 |
| L5 | 措辞是系统腔 | 「（推测：…）」「认不出是谁」→ 她照念，像念报告不像说话 |
| L6 | quoteRef 在门禁之后 | 引文不参与唤醒判定，被引用这件事完全没反应 |

### 12.2 最终架构

```
4.5  attributionRecorder   ← 记录到独立归属索引（门禁之前，不信 @ 与否）
4.6  quoteRef              ← 解析引用（前移！让门禁能看到引文）
5    mentionGate
...
7.5  personaWakeGate       ← 判定时已能读到 ctx.state.quote
```

**独立归属索引**（`src/features/attribution-index.ts`）：
- 与 historyBuffer 完全分离，不受 clearGroupHistory 影响
- 不进模型上下文，只喂给 buildQuotePart 判定归属
- 落盘 `~/.dsh-qqbot/persona/attribution-index.json`（重启后仍可用）
- 每群 100 条 / 全局 200 群 / 每条 200 字 ≈ 4MB 上限

### 12.3 图片归属：用 MD5，不下载不跑模型

**实测结论：QQ 下发的图片文件名就是图片内容的 MD5。**

```
QQ 文件名  4B859167D7BF796EF62EE84377C1224E.gif
实际 md5   4b859167d7bf796ef62ee84377c1224e     ← 逐字节一致
QQ 文件名  E22B7144C21B287A54AAFA68BE50E02F.jpg
实际 md5   e22b7144c21b287a54aafa68be50e02f
```

所以「引用这张图是谁发的」直接用文件名对索引：

- ✅ 零网络开销（**URL 到手就过期**：实测 `{"retcode":-5503007,"retmsg":"download url has expired"}`，只剩 70 字节错误页）
- ✅ 零模型成本（不用调视觉模型）
- ✅ 只存 32 位指纹，不存像素、不存 base64

视觉识别是另一件事（"这张图是什么"），与归属无关，按需再加。

### 12.4 引用内容进入唤醒判定

之前完全没参与，因为 `quoteRef` 在第 11 位、门禁在第 7.5 位——门禁跑的时候 `ctx.state.quote` 还是空的。

前移后：

| 场景 | 判定 |
|---|---|
| 潜水期，引文里出现她的名字 | 直接醒（`my-words-quoted`） |
| 潜水期，引文命中她的兴趣 | 计入匹配（probe = 正文 + 引文） |
| 活跃期，被引用 | 清零无关计数、接话 |

### 12.5 措辞原则（重要）

**这些字符串会被模型直接复述。** 写得太像系统输出就会露馅：

| 旧（系统腔） | 新（人话） |
|---|---|
| （推测：同一转发里其他条目是你说的） | （大概率是你自己） |
| （这段引文来自「X」，不是你正在对话的那个人） | （这是「X」说的） |
| （引文发送者不明，不要假定…） | （看不出这句是谁说的） |
| [附件1] 类型:图片 文件名:E0AF…jpg 尺寸:290x292 URL:https://… | （X发了一张图片）[图片] |

用户原话：*"这个不对，和我们的目标（更有活人感）差太多了"*。

## 十三、Git 推送与 sha 分叉（已彻底查清）

### 13.1 结论：用 API 推送时 sha 必然不同，无法绕过

GitHub 会**规范化提交消息**：

```
本地 git  : message 末尾无多余换行
GitHub API: 自动补一个 '\n'
```

逐字节验证：

```
带尾部换行   → ad50ee6629ce53b1730fb4b7494896d3ad58ea5b   (API 生成)
去掉尾部换行 → d3b5a2541274e609f6762ab26263d0e704d9fcfc   (本地实际)
```

`author`/`committer` 的 name/email/date **都能通过 API 指定**（实测有效），
但 message 的规范化是服务端行为，改不了。所以 sha 必然不同。

### 13.2 处理策略（`qqbot-push-api` 已实现）

1. **推送前校验**：远程必须正好是本地父提交，否则拒绝并打印对齐命令
2. **推送后校验树**：`本地 tree == 远程 tree`（内容正确性的硬证据）
3. **推送后自动对齐**：gh-proxy fetch → `git reset --soft <远程sha>`
   这样下次推送的父提交就是远程那个 sha，链路自然接上

**分叉只存在于单个 commit 的 sha 层面，内容永远逐字节一致。**

### 13.3 两个脚本

```
qqbot-push      直连 github.com（自动挑最快的 4 个候选 IP）
qqbot-push-api  走 api.github.com（github.com 整体不通时用）
```

实测 `github.com` 经常整体不通（4 个 IP 全超时），而 `api.github.com`
稳定 75ms。所以 API 通道不是"兜底"，实际是最常用的那条。

---

## 十四、M30 厌恶系统 + 三处"从上线就死的"链（2026-11-02）

### 14.1 为什么讨厌不能做成负权重

调研结论（preference-systems-research.md §7.4）：
现有强化是饱和式 `s ← s + α(1-s)`，这是**单调递增**函数。
负数喂进去：`s=-0.5` → `-0.5 + 0.05×1.5 = -0.425`，强度**向 0 靠**，
语义是"越提越不讨厌"——完全反了。负权重在这个模型里从数学上就是错的。

所以 `dislikes[]` 是**结构完全同构、符号相反**的另一列：
一样只会往 0~1 涨，只在**消费端**做减法：

```ts
// wake.ts matchInterest()
probability = raw × (1 - 0.6 × aversion) × moodFactor
```

接在概率公式上而不是 prompt 里，是"情绪要接在有返回值的闸门上"的实例：
写进提词句只能让她**照着演**，接在公式上她才是**真的**懒得开口。

### 14.2 三个必须同时修的断链

把 `decayInterests` 接上之后，我模拟了她自己的数据，发现接上就等于**一键清空**：

| # | 断链 | 后果 | 修法 |
|---|---|---|---|
| 1 | `decayInterests()` 从首次提交起 **0 个调用点** | "兴趣会淡掉"只写在文档里 | 挂进 `pruneStale`（6h） |
| 2 | 刷新 `lastAt` 只有"她自觉调工具"和"冲浪"两条路 | 日常聊天提到兴趣**什么都不发生** | `flushTurn` 里硬触发 `touchMentionedInterests` |
| 3 | `addFinding`（冲浪查到东西）不刷新 `lastAt` | **越研究越接近过期** | 写 findings 同时续命 |

第 1 条还有个更狠的发现：**冷启动就会死**。
她 4 条 current 兴趣里唯一活着的那条已 5.7 天没刷新，
按 24h 半衰算是 0.0064，接上衰减的那一刻直接击穿冻结线 0.1。

### 14.3 参数在原值下数学上不可能存活

原值 `HALF_LIFE=24h`、`ALPHA_ACCESS=0.05`（从 fish-memory 的**记忆**衰减搬来）。
稳态公式：

    s_eq = d·α / (1 - d + d·α),   d = 2^(-Δt/HL)

代入"每天聊到一次"(d=0.5)：`s_eq = 0.048`，而冻结线是 **0.1**。
**每天聊到一次，兴趣也活不下来。**

实测吻合：她 2 条兴趣冻结在 0.04375（0.35 走 3 个半衰期 = 72h 正好）。

为什么记忆和兴趣不能共用这套参数：
- 记忆条目几十上百，衰减只是**排序手段**，死掉几条无所谓；
- 兴趣只有 4~6 条，是**长期特征**——"我喜欢咖啡"不该因为两周没聊就变成陌生人的事。

重标定（按"多久不理它才该淡掉"反推）：

| 参数 | 原值 | 新值 |
|---|---|---|
| HALF_LIFE（兴趣） | 24 小时 | **30 天** |
| ALPHA_ACCESS | 0.05 | **0.15** |
| DISLIKE_HALF | 72 小时 | **90 天**（保持"厌恶持久 3 倍"的比例） |

效果：每天聊到 → 0.885；每周 → 0.542；两周 → 0.390；一个月 → 0.261；
从 0.5 起 70 天不理才冻结。

**测试里有一条直接钉死原参数**：`steadyState(1, 1天, 0.05) < 0.1` ——
以后谁想改回 24h，这条会红。

### 14.4 第四个断链：带空格的话题永远匹配不上

`matchesTopic` 对含空格的 topic 走 `raw.includes(t)`，即要求原文出现
"游戏 新作"这五个字符（含空格）。这类 topic 本来是从**搜索框**来的，
人说话不会打出空格。**实测 124 轮真实对话，6 条兴趣命中 0 次。**

修法：多词 topic 拆开，任一部分命中即算。
不要求全部命中——要求对方复述她的搜索关键词，那是搜索框才有的行为。

修后真实语料命中 0 → 3。

### 14.5 口味必须注入（否则行为漂移）

`dislikes` 接在唤醒闸门上之后，她命中讨厌话题时**会明显变沉默**。
但如果她不知道自己讨厌什么，那个沉默在她那里就是"莫名其妙不想说话"——
外面看是"她在闹脾气"，里面是"她不知道为什么"。

所以 `self.renderSection()` 把口味注入提示词，只渲染强度 ≥0.35 的
（列一长串"我讨厌XX"会让人格变成一张清单），
措辞用"没什么兴致"而不是"拒绝回答"——前者是情绪，后者是禁令，
禁令会把模型逼成客服话术。

---

## 十五、M31 情绪：三个数字，四个闸门（2026-11-02）

### 15.1 核心结论

**情绪要"活"，必须接在有返回值的闸门上（概率/延迟/条数/枚举）。
接在提词句上必死。**

对照实验在仓库外：`dsh-feiyu-mood` 有 7 维打分、双半衰、置信度门槛、
日上限、饱和 —— 比这套复杂得多，但 `mood` 只有 `moodLine()`（渲染成提词）
和 HTTP 面板两个消费者，**无任何行为分支**。精心设计的死代码。

所以顺序反过来：**先找闸门，再决定需要几个数字。**

### 15.2 四个闸门

| 闸门 | 原公式 | 接入点 | 情绪怎么进 |
|---|---|---|---|
| ① 兴趣唤醒概率 | chattiness × Σweight × base | `wake.ts matchInterest()` | × speakWillingness（0.6~1.4） |
| ② 打字延迟 | 字数 × 110ms × 深夜1.6 | `humanize.ts typingMsFor()` | × typingSpeedFactor（0.8~1.4） |
| ③ 分几条发 | burstMax = 2 | `humanize.ts split()` | arousal 决定 1 还是 2 |
| ④ 主动开口概率 | rollProbability = 0.7 | `own-life.ts tick()` | × speakWillingness |

四个闸门只需区分两件事：**心情好不好**（→①④）和**还有没有力气**（→②③）。
再加"激动程度"在两极放大反应 = valence / arousal / energy 三个数。
其余维度（信任、亲密、疲惫的原因…）**不建**：没有闸门消费，建了就是 feiyu-mood。

### 15.3 为什么基线是 0 而不是 95 分

feiyu-mood 实测：模型自评系统性偏正（872 条样本 577正/86负 = 6.7:1），
模拟 14 天有 **78% 时间在 95 分以上** —— "永远开心"等于"没有心情"。

用 -1..1、以 0 为基线：好和不好都是**偏离**，回到 0 是常态。
三个量的回归半衰期不同：valence 6h、arousal 2h（气头上就那阵子）、
energy 12h（累了要睡）。

### 15.4 六个零成本写入点（全由代码触发）

`onAddressed` / `onReplied` / `onIgnored` / `onComplained` / `onNightChat` / `onRest`

**`onIgnored` 是最重要的**：主动说了话没人接 → 失落。
没有它情绪只涨不跌，就退化成"永远开心"。

### 15.5 两个刻意的保守设计

1. **每个系数以 1.0 为"没影响"**：情绪系统挂掉、或所有值都在基线时，
   行为与接情绪之前**完全一致**。情绪是调制，不是开关。
2. **clamp 而非硬否决**：心情再差也只把开口意愿压到 0.6 倍，不会变哑巴。
   理由："被嫌吵 ×0.3"再叠"心情差 ×0.4"会到 0.12，人就没了。

### 15.6 实测闸门确实在动

    基线        v=0.00 a=0.30 e=0.70  →  开口×1.000 打字×1.000 发2条
    被接住三次   v=0.42 a=0.54 e=0.70  →  开口×1.168 打字×1.000 发2条
    被冷落五次   v=-0.18 a=0.29 e=0.55 →  开口×0.928 打字×1.075 发1条
    8 小时后    v=-0.07 a=0.30 e=0.61  →  回到基线

### 15.7 顺手修的数据加载 bug（值得单独记）

`load()` 原写法 `Number(x ?? base) || 0`：
- `|| 0` 把 NaN 和 0 混为一谈；
- 更糟：缺省值也被抹掉 —— arousal/energy 基线 0.3/0.7 掉到 0，
  意味着 `burstLimit` **永远返回 1**、`typingSpeedFactor` **永远 1.35**
  （"永远很累、永远只发一条"），且无任何日志。

修的过程还踩了一层：改用 `Number.isFinite(Number(v))` **仍然漏**，因为

    Number(null)=0   Number('')=0   Number([])=0   Number(true)=1

这些全都"有限"、能过检查，照样被当成合法值收下。
最终只接受 `typeof v === 'number'`，**不走任何隐式转换**。

> 可复用的教训：在 TypeScript 里校验 JSON 数值，不要用 `Number()` 强转 +
> `isFinite`，要判 `typeof`。`Number()` 的隐式转换是语义陷阱不是类型检查。

---

## 十六、M33 复核 8a94319：接线通了不等于跑通了（2026-11-02）

### 16.1 触发原因

`DEAD-CODE-AUDIT.md` 声称 A 类 6 条已全部修复。做了一次**只读复核**，
逐条 grep 调用点 + 用线上真实状态文件复跑，结论是：

> **接线 6/6 都真接上了，生效只有 3/6。**

审计用的唯一指标是"非定义行 grep 命中数"，它只能回答"有没有人调"，
**回答不了"调的时候条件成不成立"**。这次三条翻车的（#1/#5/#6）全都落在那个盲区里。
其中 #1 恰恰是审计自己最看重、还专门写了一段"我把它改没了"的那条。

### 16.2 三条翻车的，各自死在哪

| # | 声称 | 实际情况 |
|---|---|---|
| 1 `onIgnored` | 接进 `observePeer`，分支正确 | 分支**恒假**：传进来的是 `lastActivity`，而会话刚被新建过 |
| 5 `recoverIfCalm` | 挂进 `pruneStale` | 链路真，但 `lastComplainedAt=0` 且 `chattiness=1` → 每次立刻 return |
| 6 `recordNameCall` | 新增 `extractVocatives` + `notePossibleName` | 只修了**写端**，候选名没有任何消费者 |

#### #1 的完整死因（最值得记的一条）

```ts
// bootstrap.ts（8a94319 时）
const existing  = manager.peek('c2c', ownerOpenid);
const record    = await manager.ensureForProactive(...);   // ← 新建时会写 lastActivity=now
svc.observePeer(ownerOpenid, record.lastActivity);          // ← 拿"刚刚"去比"4 小时前"
```

`ensureForProactive` → `getOrCreate` → 新建会话写 `lastActivity: Date.now()`（`session-manager.ts:705`）。
而私聊 `sessionIdleTimeout` 默认 **30 分钟**，own-life 间隔 **4 小时** ——
**每次投递时会话必然已被回收**，`lastActivity` 必然等于"现在"。

于是：

    上次主动推送 4 小时前  <  刚写进去的 lastActivity=now
    → wasAnswered 恒 true
    → `if (wasProactive && !wasAnswered)` 永不进
    → onIgnored 永不执行

**连带踩塌（审计没发现）**：`budget.observe()` 的 `markUnanswered` 分支也走同一个
`wasAnswered` 判断 → `unansweredStreak` 永不增长 → `ProactiveBudget` 的
「3 天冷却 / 14 天冷却 / 永久静默」**整套冷退避一起是死的**。

测试为什么绿：`emotion.test.ts` 喂的是 `Date.now() - 60_000`，
生产喂的是刚创建的 `lastActivity` —— **测的是函数内逻辑，不是生产链路**。
这正是审计自己警告过的那个失败模式的反面：

> 它说"删了调用点测试照样绿"；它没意识到**调用点留着、条件恒假，测试也一样绿**。

#### #6 缺的到底是什么

写端（`extractVocatives` → `notePossibleName` → `recordNameCall`）全通，
候选名也确实写进了 `self.json.names`。但读端全缺：

- `activeNames()` 过滤掉 `accepted=false` → 候选被排除
- `buildSections()` 没有任何一段注入 names
- `self.renderSection()` 只渲染 likes/hates
- `qq_decide_name` 的 `name` 参数要模型自己填 —— **模型不知道存在哪些候选**

所以 `wake-gate.ts` 那行
`logger.info('称呼「X」被叫够了，等她表态（qq_decide_name）')`
成了一句**永远等不到回应的日志**。

### 16.3 五处修法

**① `onIgnored`：把观察点移到投递之前**

```ts
const prevActivity = existing?.lastActivity ?? 0;   // ← 在 ensureForProactive 之前
const record = await manager.ensureForProactive(...);
...
svc.observePeer(ownerOpenid, prevActivity);         // ← 传"投递前的活跃时间"
```

语义修正：会话还活着 → 用它真实的 `lastActivity`；
已被回收 → 说明对方至少空闲了 `sessionIdleTimeout`，用 `0` 表示"这轮肯定没理"。

实测（6 轮 own-life 周期）：

    修复前：streak 恒 0，mutedUntil 恒 0，valence 恒 0.0000
    修复后：第1轮 streak=1；第2轮 streak=2 且进入 3 天冷却；
            第5轮 streak=5 → 永久静默。valence 每次 -0.12

**② 口癖管线：加表达性闸门 + 让转正门槛真的存在**

线上 48 条正样本实跑，修复前抽出来并 **100% 转正**的是：

    「的。」「多。」「完了。」「一样。」「行,」
    → 原样注入 prompt：「当"想收尾时"时，可以用"的。"来表达。」

两个结构性缺陷：

1. `consider()` 写死 `count: n`（入口已要求 n>=2）与 `evidence: samples.slice(0,2)`
   （写死 2 条且 turnId 必然不同）→ 转正判据 `count>=2 && distinctEvidence>=2`
   **对任何候选恒成立**。门槛不是"把关"，是"盖章"。
2. 抽取粒度是字符 n-gram，没有词边界，标点尾巴天然高频。

修法三件：

- `isExpressive()`：去掉尾部标点后必须 >=2 字、且以汉字开头
- 中间类 n-gram 从 **2 字提到 3~4 字**（中文里任何 2 字组合都高频）
- `count`/`evidence` 改由**真含该词**的样本推出；`PROMOTE_MIN_COUNT = 3`

修复后同一份 48 条样本：

    抽取 5 条，转正 0 条，注入段为空 —— 宁可不注入，也不污染 prompt

而构造出的真口癖（"说实话"跨 4 个会话出现）仍然正常转正并注入 —— 护栏没把功能拦死。

**③ 称呼读端：`pendingNames()` + `renderNameCandidates()`**

- 新增 `pendingNames()`：`!accepted && weight===0 && rejectedAt===0 && calledCount>=阈值`
- 新增 `renderNameCandidates()`，挂进 `buildSections()` order=67（紧跟口味段）
- `qq_decide_name` 的返回值补 `pendingNames`，她表态完还能看到剩下在等的
- 新增 `SelfName.rejectedAt`：**拒绝过的不再进候选**，否则每次被叫都重新"等她表态"，
  她会反复被问同一个已经回答过的问题

**④ `extractVocatives` 的光杆 `你`**

原交替项 `(?:在吗|你在|你|在不在|干嘛|几点)` 里那个 `你` 把门槛全废了。
用编译产物实测：

    "停一下，你先忙" → ["停一下"]      "好的，你说吧" → ["好的"]
    "是啊，你说得对" → ["是啊"]        "不知道，你问我" → ["不知道"]
    "太吵了，你闭嘴" → ["太吵了"]

而它自己的测试用的是「，就像」「，等一下」，恰好绕开这条分支 ——
**"零误判"是数据选得好，不是规则严。**

修法：只保留真正的呼叫语（`在吗/在不在/你在/你在干嘛/在干嘛/干嘛呢/几点了`），
再加一道 `NOT_A_NAME` 应答词前缀黑名单。修复后上述 7 条全部返回 `[]`，
正例（`小羽，在吗` / `小羽，几点了，你在干嘛` / `小鲸鱼，在不在`）仍然工作，
真实 100 轮语料仍只命中正确的那 1 条。

**⑤ `lastTurnAt` 落盘**

原来纯内存，进程重启归零 → 重启后第二次 `flushTurn` 就 `now-last` 很小 →
"睡了一觉"的时间维度丢失。而 `onRest` 是 energy 的**唯一正向来源**，
压在易失字段上等于「重启越频繁她越累」。改存 `state/last-turn.json`。

### 16.4 仍未解决 / 已知偏差

- **修复未上线**：进程启动 11:08:41，修复提交 11:54~12:13。硬证据：线上
  `voice.json` 有 48 条正样本（≥ 抽取门槛 4）而 `habits` 为 0 ——
  新管线若在跑早该抽过。**"779 passing" 是源码绿，线上仍跑旧代码。**
- **`valence` 仍然贴顶**：实测 130 轮真实语料，中位数 1.000、>0.85 占 95.4%，
  正负写入比 **45.4:1**（feiyu-mood 是 6.7:1）。#1 修好只是让负向**能触发**，
  但 own-life 上限 4 次/天、每次 -0.12，抵不过 onAddressed(130次)+onReplied(100次)。
  → **要真的解决"永远开心"，得调正负幅度比，不是再修一条链。**
- **闸门③动态范围≈0**：`burstLimit` 阈值 `arousal >= 0.3` 恰与 `BASELINE.arousal=0.3`
  重合，正向写入又占绝对多数 → 恒真、恒发 2 条，"激动时连发"区分不出来。
- **`recoverIfCalm` 仍未被验证**：线上 `chattiness=1`、`lastComplainedAt=0`，
  真实 130 轮抱怨命中 0/130。接线对，但至今零次生效。
- **`maybeResetRoute` 回主通道要等会话重建**：`clearOverride` 只清持久化偏好，
  活着的 agent 不重建。

### 16.5 可复用的教训

> **复审死代码，不能只数调用行，要问"那行的条件在真实数据下会不会成立"。**

具体三步（这次就是这么做的，三次都当场抓出问题）：

1. `grep` 剥注释、排测试、排定义行 —— 只能得到"有没有人调"
2. **拿生产真实值去跑那条分支** —— 才能知道"调的时候进不进得去"
3. 用线上状态文件复跑整条管线 —— `voice.json` / `turns.jsonl` 是免费的真语料

另一条与之配套的：

> **测试喂的输入，必须是生产真的会传的那个形状。**
> 喂 `Date.now() - 60_000` 而生产传 `lastActivity=now`，
> 测试就是在给自己发合格证。
