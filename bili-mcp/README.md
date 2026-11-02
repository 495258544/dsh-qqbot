# bili-chapter · 只做一件事的 MCP server

**B 站接入 = 官方 `bili mcp serve`（17 个工具）+ 这里 1 个自建工具。**

## 为什么要分两半

官方那 17 个工具覆盖了 95% 场景：`watch_video` 一次拿全、`inbox`、`trending`、
`feed`、`comments`、私信…**交给上游维护，bili 升级不用我们改代码。**

但字幕这块，两个官方路径都不行：

| 官方路径 | 问题 |
|---|---|
| `video_transcript` | 纯文本，**时间轴被压平** |
| `run_bili` 调 `video subtitle` | 返回 75513 字符原始 JSON ≈ **5 万 tokens** |

而用户最初的需求就是「别整段倒出来，标出哪几分钟讲到东西」。
所以这一件事必须自己做。

## 这个工具干什么

```python
bili_chapters(bvid, page=1) -> str
```

把逐句字幕按分钟聚桶，每分钟留最长的两句，带 `[mm:ss]`：

```
[00:00] 好我们下面为大家去演示一下DHCP的配置 PC1和PC2啊分别属于微量十和微量20
[01:02] 我们这时候可以输入一条命令叫undo information center 他后面就不会弹这种消息来阻断你
[02:01] display危难summary就是微量的一个汇总 v interface vl10IPADDRE是192.168.1
...
↑ 共 32 分钟。**别整段转述** —— 挑出真正讲到东西的 3-5 段，
每段一句话说清讲了什么，带上时间点。铺垫和寒暄跳过。
```

实测（BV1Xx9bBiEqx 第 3 P，31 分钟视频）：
- 原始 771 句 / 8992 字 ≈ 6300 tokens
- 压缩 32 条 / **1277 tokens**
- **压缩 4.9 倍，覆盖全程**

## 成本

| | schema |
|---|---|
| 官方 17 个工具 | 5861 tokens |
| 这里的 1 个工具 | **408 tokens** |
| 合计 | ≈ 6269 tokens |

对比之前自建的 18 个工具（4924 tokens）多 1345 tokens，
但**换来的是上游维护**——这笔账是划算的：我们只需要维护一个函数。

## 跑测试

```bash
cd ~/.dsh-qqbot/bili-mcp && python3 -m pytest test_chapter_server.py -q
```

11 条，重点钉「压缩必须覆盖全程」（防退化成只给开头几分钟）。

## 升级 bili 之后

只有一件事可能坏：`video subtitle` 的输出字段（`items[].from` / `items[].content`）。
验证：

```bash
python3 -c "import sys; sys.path.insert(0,'.'); import chapter_server as c; \
  print(c.run_bili(['video','subtitle','BV1ednc6jE3j'])['ok'])"
```

返回 False 就改 `run_bili` 或压缩逻辑里对应字段。
其余 17 个工具由官方维护，不归我们管。
