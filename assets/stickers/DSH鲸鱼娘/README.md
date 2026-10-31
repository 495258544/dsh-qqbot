# DSH鲸鱼娘 · 默认表情包

DeepSeek「鲸鱼娘」表情包，作为机器人的**内置默认表情**随仓库分发。

## 为什么要内置

新设备装上 dsh-qqbot 后，`/sdcard/表情包/` 是空的。内置这一套后：

- **开箱即用**：无需手动收图就能发鲸鱼娘表情
- **默认优先**：没有特别情绪时，优先用这里的表情（`priority: 10` + `use: ["D1"]`）
- **可被覆盖**：设备上自己攒的表情库优先；只有设备库为空时才回退到这里

## 内容

| 项 | 数量 |
|---|---|
| 表情图 | **45 张** |
| 索引 | `index.json`（含每张的使用时机/情绪/文字） |
| 体积 | 约 2.7 MB |

**格式**：PNG / JPG / WebP（无 GIF，避免动图体积和兼容问题）

## 来源与版权

| 来源 | 说明 |
|---|---|
| `yyh-001/dsh-meme` | 手绘风，24 张 |
| `FeWOO/DeepSeek-meme` | 精致贴纸风（带中文台词），17 张 |
| 社区二创 | 群聊收集，4 张 |

均为公开网络流传的 DeepSeek 拟人二创素材，仅作个人使用。如原作者要求下架请联系。

## 索引结构

`index.json` 里每条：

```jsonc
{
  "file": "assets/stickers/DSH鲸鱼娘/DSH鲸鱼娘_谢谢你.webp",  // 相对仓库
  "use": ["B5", "A1", "D1"],   // 使用时机
  "emo": ["感谢", "开心"],      // 情绪词
  "desc": "鲸鱼娘双手合十闭眼笑，配字「谢谢你～」",
  "text": "谢谢你～",            // 图上的字
  "priority": 10               // 10 = 默认优先
}
```

**使用时机代码**（详见 `_使用说明_v2.md`）：

| 代号 | 含义 |
|---|---|
| A1–A6 | 喜/怒/哀/惊/羞/得意 |
| B1–B6 | 夸人/吐槽/安慰/疑问/感谢/道歉 |
| C1–C4 | 搞笑/卖萌/日常/节日 |
| **D1** | **鲸鱼娘默认位** |

## 代码怎么用

`src/media/sticker-tool.ts` 里的 `loadBundledStickers()`：

```ts
// 设备库有内容 → 用设备库
let idx = loadIndex('/sdcard/表情包');
// 设备库为空 → 回退到内置包
if (!idx || idx.stickers.length === 0) {
  idx = { version: 2, stickers: loadBundledStickers() };
}
```

路径解析：编译后 `lib/media/sticker-tool.js` 向上两级即仓库根，再拼 `assets/stickers/DSH鲸鱼娘/`。

## 加新图

1. 把图放进 `assets/stickers/DSH鲸鱼娘/`，文件名带 `DSH鲸鱼娘_` 前缀
2. 在 `index.json` 的 `faces[]` 里加一条（`file` 写相对路径）
3. 记得 `use` 里带上 `D1`、`priority` 设为 `10`

## 校验

```bash
node lib/ops/sticker-verify.js    # 检查索引与文件一致性
```
