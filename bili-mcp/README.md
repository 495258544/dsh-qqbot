# bili-mcp · B 站薄壳 MCP server

给 DSH 用的 B 站接入。**14 个工具，只读 12 个 + 写 2 个（关注/取关）。**

## 为什么自己写，不用 `bili mcp serve`

官方那个看着只有 17 个工具，但里面有个 `run_bili`：

> 运行任意 bili 子命令（不含开头的 bili）

**等于把 116 个命令全开放** —— 包括 `upload` 投稿、`me` 改昵称、`user block` 拉黑。
所以"17 个工具"是假象，权限面是全部。

另外官方 schema 实测 **8373 字符 ≈ 5861 tokens**，每次请求都进上下文。

这个薄壳的取舍：

| | 官方 | 这个 |
|---|---|---|
| 工具数 | 17 | 14 |
| schema | 5861 tokens | **3934 tokens** |
| 任意命令后门 | 有（`run_bili`） | **没有** |
| 写操作 | 6 个 | **2 个**（关注/取关） |

## 工具清单

**只读（12）**
- `bili_status` 账号状态
- `bili_following` 关注列表
- `bili_inbox` 消息
- `bili_video` 视频信息 + 分 P 目录
- `bili_transcript` 字幕（**按分钟压缩、带时间戳**）
- `bili_summary` AI 总结 + 分章提纲
- `bili_danmaku` 弹幕高能时刻
- `bili_search` 搜索
- `bili_trending` 热门/每周必看/排行
- `bili_up_videos` 某 UP 的投稿
- `bili_up_timeline` 关注动态
- `bili_comments` 评论

**写（2）**
- `bili_follow` 关注（幂等，已关注返回"没重复操作"）
- `bili_unfollow` 取关

## 白名单

```bash
BILI_MCP_TOOLS=bili_video,bili_transcript,bili_status  # 只启用这几个
```

留空 = 全部启用。部署时可以临时收窄（比如只想给只读）。

## 依赖

- `bili` CLI（bili-agent 1.2.1，已登录）
- Python 3.10+ / `mcp>=2.3` / `pytest`（测试用）

## 跑测试

```bash
cd ~/.dsh-qqbot/bili-mcp && python3 -m pytest test_server.py -q
```

16 条，覆盖：`mmss` 进位、白名单收窄、`run_bili` 的 5 种失败路径、
字幕压缩**覆盖全程**（防"只给开头几分钟"）。

## DSH 配置

```yaml
- id: mcp-bili
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: bili
    transport: stdio
    command: python3
    args: ['/root/.dsh-qqbot/bili-mcp/server.py']
```

工具会以 `mcp__bili__bili_video` 这样的名字出现。

## 升级 bili 之后要做什么

工程侧已经做了自检（`src/persona/bili-health.ts`），但那个检查的是**旧封装**的字段。
换成 MCP 之后，字段解析在 `server.py` 里，所以要看这里。

升级后跑一遍：

```bash
python3 -c "import sys; sys.path.insert(0,'/root/.dsh-qqbot/bili-mcp'); import server; print(server.run_bili(['video','info','BV1ednc6jE3j'])['ok'])"
```

返回 False 就说明字段或命令变了，改 `server.py` 对应那个函数。
