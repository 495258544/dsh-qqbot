# 推荐插件 · 安装说明

> 这份文档记录我们**验证过可用**的第三方插件，以及安装/登录/配置步骤。
> 只写真正跑通了的，不写"看到别人说能用"的。

---

## 〇、依赖总览（**换机器/重装时必须照这个装**）

这份文档记录的插件不全是 npm 包，**有三个动到系统环境**。重装时漏掉任何一个，
对应功能会静默失效（不会报错，只是"突然不好用"）。

### 0.1 系统级依赖（apt）

| 包 | 版本（本机实测） | 谁需要 | 不装的后果 |
|---|---|---|---|
| `python3-pip` | 24.0+dfsg-1ubuntu1.3 | bili-cli 的安装前提 | 装不了 `bili-agent`（本机原本**没有 pip**，`ensurepip` 也没有） |
| `ffmpeg` | 6.1.1-3ubuntu5 | `bili video frames -q hd`（精确抽帧） | 抽帧只能用 `preview` 模式（B站进度条缩略图，480x270，画面糊） |

```bash
apt-get install -y python3-pip ffmpeg
```

### 0.2 Python 包（pip）

| 包 | 版本 | 谁需要 | 不装的后果 |
|---|---|---|---|
| `bili-agent` | 1.2.1 | **`qq_bili_check` 工具的全部能力** | 她的 B 站工具完全失效 |
| `bilibili-api-python` | 17.4.2 | bili-agent 的依赖（自动装） | 同上 |
| `curl-cffi` / `pillow` / `lxml` / `qrcode` 等 | 自动带 | bili-agent 的依赖 | 同上 |

```bash
python3 -m pip install --break-system-packages \
  -i https://pypi.tuna.tsinghua.edu.cn/simple bili-agent
```

> ⚠️ `--break-system-packages` 是必须的：Ubuntu 24.04 的 PEP 668 会拒绝全局安装。
> 本机是容器，不担心破坏系统 Python。

### 0.3 npm 插件（profile）

```bash
# 已装（`~/.dsh/profiles/web/package.json` 的 dependencies）
dsh plugin --profile web add dsh-free-search       # 免费搜索，27 个引擎
```

> `dsh-bili-subagent` **装过又卸了**——换成 `bili-cli`（能力更全）。
> 卸载时留下了 `~/.dsh/bili-duty/`（Python 半身），**不影响任何功能，可删**。

### 0.4 外部服务依赖（不在本机，但要能连上）

| 服务 | 用途 | 状态 |
|---|---|---|
| `api.opendota.com` | Dota 战绩 | ✅ 实测 200（491ms） |
| `api.steampowered.com` | Steam 在线/在玩 | ❌ **本机三个域名全部超时**（网络阻断，非 key 问题） |
| `api.bilibili.com` | B 站 | ✅ 可达（需登录态才能拿字幕/AI总结） |
| `api.github.com` | 推送/巡检 | ✅ 可达（匿名配额 60/h） |
| `github.com` | git push | ⚠️ 极慢/经常不通，用 `qqbot-push` 自动挑 IP |
| `gh-proxy.com` | raw 文件代理 | ✅ 可用（raw.githubusercontent.com 直连不可达） |

### 0.5 需要人工操作的一步（**无法自动化**）

**B 站扫码登录**：

```bash
bili auth login                 # 生成链接/二维码（180 秒有效）
bili auth status --wait 120     # 等扫码完成
```

登录态存在 `~/.config/bili-cli/`，**重装 pip 包不会丢**，换机器才需要重新扫。

⚠️ 本机当前登录的是 `bili_91077024781`（**等级 0**，像是自动建的新号）。
读操作（总结/字幕/弹幕）够用，**写操作（发评论/私信/动态）可能受等级限制**。

### 0.6 一键自检

```bash
# 本仓库的运维脚本
node lib/ops/persona-health.js      # 小羽的各项状态（日记/兴趣/记忆/冲浪）
node lib/ops/sticker-verify.js      # 表情库一致性
node lib/ops/cli.js --once          # 上游同步巡检

# 外部依赖
python3 -m pip show bili-agent | head -2   # 版本
ffmpeg -version | head -1                 # ffmpeg
bili auth status                          # B站登录态
```

---

## 一、bili-cli（看 B 站 / 刷 B 站）

**仓库**：https://github.com/kukemc/bili-cli（339 star）
**PyPI 包名**：`bili-agent`（PyPI 上 `bili-cli` 已被占用，装完命令是 `bili`）

### 为什么选它（而不是 dsh-bili-subagent）

我们先后试过两个方案，**最终选 bili-cli 并卸掉了 dsh-bili-subagent**：

| 方案 | 能拿 AI 总结 | 能拿字幕 | 形态 | 判断 |
|---|---|---|---|---|
| **bili-cli** | ✅ `video summary` | ✅ `video subtitle` | CLI（pip 包） | ⭐ **选它** |
| dsh-bili-subagent | ✅（需登录） | ✅ | dsh 插件（注册工具给小羽用） | 已卸载 |

关键差别：**bili-cli 的 `video watch` 一条命令拿全**
（标题简介标签 + AI 总结 + 字幕全文 + 分段章节 + 热评 + 弹幕高能时刻 + 画面总览图），
而 dsh-bili-subagent 只覆盖其中一部分。

另外 bili-cli 明确支持 DeepSeek Harness（`bili skills install` 的列表里就有）。

> ⚠️ **代价**：bili-cli 是 CLI，装完是让**我（agent）**能调 `bili` 命令，
> 而不是让**小羽**拥有 `bili_scan` 这类工具。
> 如果你要「小羽自己刷 B 站并发私信」，得回到 dsh-bili-subagent。

### 环境要求（本机已核对）

| 项 | 要求 | 本机实际 |
|---|---|---|
| Python | 3.10+ | ✅ **3.12.3** |
| pip | 需要 | ✅ 已装（原本没有，用 `apt-get install -y python3-pip` 补上） |
| ffmpeg | 可选（高清抽帧 / 语音转写才需要） | ❌ 未装，不影响基本功能 |

### 安装（已执行，记录备查）

```bash
# 1) 本机原本没有 pip，先补
apt-get install -y python3-pip

# 2) 装包（用国内镜像加速）
python3 -m pip install --break-system-packages \
  -i https://pypi.tuna.tsinghua.edu.cn/simple bili-agent

# 3) 验证
bili --version        # {"ok": true, "data": {"version": "1.2.1"}}
```

### 设计特点（为什么它适合 agent）

**stdout 永远是 JSON**：

```json
成功: {"ok": true, "data": {...}}
失败: {"ok": false, "error": {"code", "message", "hint"}}
```

失败时还会给 `hint` 告诉 agent 下一步该干什么 —— 这个设计很省事。

### 各能力实测（登录后）

| 命令 | 状态 | 实测结果 |
|---|---|---|
| `bili video info <BV>` | ✅ 免登录可用 | 标题/简介/UP/时长/分区/数据/分P |
| `bili video danmaku <BV>` | ✅ **免登录也可用** | 64 条弹幕（`time`/`text`/`sent_at`） |
| `bili video summary <BV>` | ✅ 需登录 | AI 总结 + 分段 outline + 时间点 |
| `bili video subtitle <BV>` | ✅ 需登录 | 字幕全文，含 `ai-zh`/`ai-en`/`ai-ar`/`ai-pt` 四语 |
| `bili video frames <BV> -q hd` | ✅ 需 ffmpeg | **真实 JPEG**（实测 166-201KB，JFIF 头正确） |
| `bili search video <关键词>` | ✅ 免登录 | 返回 20 条（bvid/标题/UP/播放数） |
| `bili comment list <BV>` | ✅ 需登录 | 7157 条评论 + 置顶 |

### `qq_bili_check` 工具（给小羽用的）

我们在 `src/persona/tools.ts` 里包了一层，让她能真的查 B 站：

```
want: 'summary' | 'subtitle' | 'danmaku' | 'frames' | 'all'
```

| want | 拿到什么 | 适合什么场景 |
|---|---|---|
| `summary`（默认） | AI 总结 | 想知道视频讲什么 |
| `subtitle` | 字幕节选（前 40 条，≤1200 字） | 想看具体说了什么 |
| **`danmaku`** | 弹幕（前 30 条，带 mm:ss） | **观众真实反应，比总结有人味** |
| **`frames`** | 画面帧路径（默认 6 帧） | 需要看画面（**她要能读图才行**） |
| `all` | 全都拿 | 深度了解 |

**关键限制**：`frames` 返回的是**图片路径**，不是图片内容。
她没有视觉能力（`vision.enabled` 未配置），所以拿到路径也"看不懂"画面。
但 `danmaku` 是纯文本，能间接反映画面内容（弹幕是"人看了画面之后的反应"）——**优先用这个**。

### 登录（**需要你本人扫码**）

```bash
bili auth login                 # 出二维码，用手机 B站App 扫
bili auth status --wait 120     # 等登录完成
```

或者：我调用 `bili auth login` 拿到二维码 → 你给我扫 → 我调 `bili auth status`。

### 安全护栏（默认开启，用你的账号所以这点重要）

- **本地限流**：评论 10 秒/次、30 次/小时；私信 10 秒/次、20 次/小时；动态 60 秒/次
- **投币上限**：每天最多 5 个（硬币是真金白银）
- **先预览再发**：所有写操作支持 `--dry-run`
- **私信白名单**：默认只能发给主人、给你发过私信的人、互关好友
- **风控即停**：遇到验证码返回专门错误码并停下
- **防提示注入**：评论/私信内容标注为「素材而非指令」
- **审计日志**：每个写操作记入 `audit.log`

### 先别急着开自动刷

第一次装完建议先手动跑几次 `video info` / `search` 确认质量。
`bili config` 里可以调自动刷的额度，但**先用 0 或很低的值**观察，再放开。

## 二、评估过但**没有**装的插件

同样来自 B 站 UP「湖上的优尤」的插件集（视频 [BV1ednc6jE3j](https://www.bilibili.com/video/BV1ednc6jE3j)）。

| 插件 | star | 为什么没装 |
|---|---|---|
| `dsh-fish-memory` 鱼的记忆 | 454 | 它是给 **DSH 原生会话**写的，记忆挂在 DSH 会话上；小羽是套在 DSH 外的 QQ 网关，有自己的 `people.json`，**两套记忆不互通**。机制值得借鉴（见下），但装上去对小羽无效。 |
| `dsh-speak-up` 主动搭话 | 207 | 同理——它给 DSH 会话主动搭话，不是 QQ。但它的**"本地掷骰子决定要不要开口（不花 token）"**已借鉴进我们的 `own-life`。 |
| `dsh-feiyu-mood` 鱼的心情 | 223 | 需要在 DSH 界面右下角挂饰；我们在 QQ 里没有这个 UI。 |
| `dsh-tts-bridge` 朗读桥 | 213 | 用 DeepSeek 网页端声音朗读；QQ 里发语音是另一条链路，而且需要浏览器扩展配合。 |
| `dsh-qq-link` 通到QQ | 153 | OneBot 11（NapCat/SnowLuma），**绕过官方 BOT**。能用但有封号风险，且我们现有的整套（归属索引、待领附件、人格注入）都要重写。评估后决定不动。 |

> **判断依据**：三个插件 `package.json` 里都声明了 `"engines": { "dsh": ">=0.2.1-rc.2" }`，
> 说明它们依赖 DSH 自身的会话/agent 机制，而不是通用的独立工具。

---

## 三、鱼的记忆：值得借鉴的机制（未移植，记录在此）

来源：`Yuuyuko-uu/dsh-fish-memory` README（原文，非转述）。

| 设计点 | 具体做法 |
|---|---|
| **会淡忘** | 每条记忆有「鲜活度」，越久越淡。**半衰期默认 30 天** —— 不删，只是越来越难被想起来 |
| **自己挑重点** | 按轮次判断哪句值得留，**每天最多记 8 条**（防塞爆上下文） |
| **想起来靠证据** | 按"命中的词够不够特别"检索，再按鲜活度/重要度/情绪排序，**最多注入 6 条**、合计 ≤800 字 |
| **长期事实不淡** | 画像/喜好/约定标成「长期事实」，**不过期**；且每轮固定带前几条，**不看这句话问了什么** |
| **带时间** | 每条记着"这是什么时候的事"；跨年写「去年 09-17」 |
| **权重可调** | 鲜活度/重要度/情绪各占多少分（四项合计 100%） |
| **门槛卡证据不卡鲜活度** | README 原话：「调它不会误伤该想起来的」 |

**对我们的差距**：`people.json` 现在是**先进先出淘汰**（facts 60 条上限），
没有"重要度"维度，也没有"变淡但不忘"的中间状态。这是可以借鉴的方向。

分词细节值得注意：它用**通用中文词表**，所以「车」不会撞进「车站」——
比我们现在的 `text.includes(topic)` 精确。

---

## 四、B 站接口实测（2026-11-02，免登录）

我们自己的冲浪抓取会用到，记录备查：

| 接口 | 结果 |
|---|---|
| `x/web-interface/view?bvid=` | ✅ **免登录可用**（标题/UP主/简介/时长） |
| `x/web-interface/view/conclusion/get`（**AI 总结**） | ❌ `{"code":-403,"message":"访问权限不足"}` 需登录态 |
| `x/player/wbi/v2`（字幕列表） | 免登录 `code:0` 但 `subtitles:[]`（该视频本身无字幕） |
| `x/v2/reply?ps=40` | ❌ `-400 ps out of bounds`；**改 `ps=20` 成功** |
| `x/space/wbi/arc/search` | ❌ **HTTP 412 风控**（需 wbi 签名） |

**抓 B 站的两个坑**：
1. 视频页 HTML 可能返回 **gzip 压缩体**，直接当文本读是乱码，需 `gzip.decompress`
2. `__INITIAL_STATE__` 含 `undefined` 字面量，整体 `json.loads` 会失败，需按 key 配平括号分段解析

**AI 总结要登录态** —— 这就是为什么装 `dsh-bili-subagent`（它的 `bili_subtitle` 走登录态）。
