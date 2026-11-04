# 小黑盒接入（只读）

> 2026-11-05 实测。模块目录 `src/xhh/`，工具 `qq_xhh_search` / `qq_xhh_feed` / `qq_xhh_read` / `qq_xhh_save_sticker`。

## 一句话

小羽能搜小黑盒、刷首页、读帖子和评论，觉得合适的图收进表情库。
**全程不需要登录、不需要 Cookie、不碰她的账号。**

## 为什么不用现成的仓库

调研了两个候选（详见对话记录）：

| 仓库 | 为什么不直接用 |
|---|---|
| `fbbDirge/dsh-xiaoheihe` | 它是「刷小黑盒」插件：定时浏览 + 自动评论 + 自动回复 + 定时发帖。这些功能**全都要发到平台**，而我们要的是「只读」。不过它的签名算法（MIT，64 行）是本次直接复用的部分。 |
| `ylty1516/xiaoheihe-agent` | Python + WebUI 的创作工作台，115 个 py 文件。它的只读命令也要先 `xhh login`，对"只想搜一下"来说太重。 |

结论：**只要那两个接口 + 一段签名**，不需要引入任何运行时。

## 实测事实（都是跑出来的，不是查文档得来的）

### 能用、且不需要登录的接口

| 接口 | 用途 | 吃限流? |
|---|---|---|
| `/bbs/app/api/general/search/v1` | 搜索帖子 | **吃** |
| `/bbs/app/link/tree` | 读正文 + 评论 + 楼中楼 | **吃** |
| `/bbs/app/feeds` | 首页推荐流 | **不吃** |
| `/bbs/app/api/search/welcome_page/v2` | 热搜榜/热门游戏/黑盒热议 | **不吃** |

实测样本：

```
feeds      → 11 条（首条「这是我最后的波纹！影之刃零 300 条技巧与冷知识合集」）
热搜       → 15 条（影之刃零 / 侠盗猎车手6 / 黑神话悟空 …）
热门游戏   → 15 条（影之刃零 / 侠盗猎车手6 / 黑神话悟空 / 原神 …）
search     → 10 条帖子（limit=30 时）
```

### 坑 1：`link_id` 必须传**分享哈希**，不能传数字 ID

```
/bbs/app/link/tree?link_id=194674321      → {"status":"show_captcha"}
/bbs/app/link/tree?link_id=ba9b72b0316e   → ok，正文正常返回
```

哈希在搜索/流里每条记录的 `share_url` 末尾（`?link_id=<hash>`）。
数字 ID 在 `info.linkid`，是给别的用途的。

`normalizePostRef()` 会拦住误传数字 ID 的情况并明确指路 —— 否则一次误用就换来
20 分钟静默，还会连累整个模块。

### 坑 2：限流是**请求总量**，不是"搜索单独限流"

实测连跑后 search 与 link/tree **同时**开始返回 `show_captcha`，
而 feeds/热搜全程正常。所以：

- 节流必须放在 `call()` 里（所有入口共享一个滑动窗口），不能只守 search
- 默认 10 分钟窗口内最多 6 次
- 撞上后模块整体静默 20 分钟（实测冷却时长）

### 坑 3：搜索的 `limit` 是**条目总数**，不是帖子数

实测 `limit=10` → 只回 3 条 link（其余是 filter_tag / space / game 等噪声），
`limit=30` → 10 条。link 约占 1/3。

所以客户端按 `3N` 去要（封顶 30），再本地切到 N 条 —— 不透传 limit。

### 坑 4：正文里的图有两种

1. 正常 CDN 地址 `https://imgheybox1.max-c.com/...`
2. **发帖人手机本地路径** `/storage/emulated/0/DCIM/Camera/IMG_xxx.jpg` ← 拿不到，直接丢

`parseRichText()` 只保留 https 的，第二种丢掉，避免交给上层去下载一个必然失败的地址。

### 坑 5：图片后缀和真实格式不一致

`.../thumb.jpeg?imageMogr2/.../format/webp` 这种，后缀 `.jpeg` 但字节是 WebP/JPEG。
入库一律按 **magic bytes** 判定（复用 `transport/attachment.ts` 的 `imageExtension`）。
实测一张 `thumb.png` 实际是 JPEG，被正确存成 `.jpg`。

## 安全边界

- **域名白名单**：只收 `*.max-c.com` / `*.xiaoheihe.cn` 的 https 图。
  正文里的 img url 是**发帖人可控**的，不设白名单等于让任何人使唤她做任意 URL 下载。
- **大小上限** 4MB，先看 content-length 省一次下载。
- **内容嗅探**：不信 content-type、不信 URL 后缀。
- **无账号**：整个模块没有 Cookie 字段，也没有任何写平台的代码路径。
  发帖/评论/点赞/私信不是"默认关"，是根本没有。

## 图片去哪了

复用现有表情库那一套，不另起一套：

- 落盘：`media/sticker-tool.ts` 的 `adoptIntoLibrary`（MD5 去重）
- 索引：同一个 `_index.json`（`upsertIndex`）
- 目录：`<库根>/_小黑盒/`（与 `_群聊收集` 分开，便于分辨来源）
- 检索：`qq_pick_sticker` 直接能搜到（`scene="_小黑盒"`）
- 发送：仍只走 `qqbot_send_file`

文件名形如 `597ca7ad93a3_xhh.jpg`：前 12 位是内容 MD5（去重靠它），后面是固定的
`xhh`。**不能**把 URL 主干或时间戳放进文件名 —— 那样同一张图换个 URL 就成了新文件，
去重形同虚设（测试抓到过这个真 bug）。

## 配置

```yaml
xhh:
  enabled: true
  timeoutMs: 10000
  throttleWindowMs: 600000   # 10 分钟
  throttleMaxCalls: 6        # 窗口内最多 6 次（搜索与读帖共用）
  defaultLimit: 8
  maxLimit: 20
  commentLimit: 12
```

## 来源与许可

签名算法改写自 `fbbDirge/dsh-xiaoheihe`（MIT）。
交叉校验：与 `AaronZ345/xiaoheihe-cli` 的 Python 实现同输入同输出（`7X3XY98`），
该值已写成单测硬断言。
