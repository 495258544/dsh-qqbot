# 小羽实际拥有的工具（实测，2026-11-03）

## 方法

会话存档是**多帧 zstd**（751 帧）。系统里没有 `zstd` 命令、没有 python `zstandard`，
但 **Node 24 内置 `zlib.zstdDecompressSync`** —— 按 magic number `28 b5 2f fd`
切帧逐段解压，拿到 18MB / 1816 行真实会话记录。

数据源：`/root/.dsh/sessions/--root-.dsh-qqbot-workspace--/session-b19fc5fb-.../session.v4.jsonl.zstd`

## 结论：她有完整工具集，不是只有 qq_* 工具

23 个会话**全部**是 `agentPreset: "standard"`（不是受限 preset）。

127 次 `tool/call` 实测统计：

| 工具 | ok | fail |
|---|---|---|
| **bash** | **67** | **0** |
| qq_bili_check | 12 | 0 |
| read_image | 6 | 0 |
| qq_write_diary | 5 | 0 |
| list_agents | 4 | 0 |
| subagent | 3 | 0 |
| ego_navigate | 3 | 0 |
| ...（共 26 个不同工具） | | |

完整工具名（她**实际调用过**的 26 个）：
```
bash, ego_navigate, ego_snapshot, ego_space_open, ego_status, job_output,
list_agents, mnemon_runtime_memory, platform_search, qq_bili_check,
qq_mark_interest, qq_memory_append, qq_note_activity, qq_pick_sticker,
qq_raise_wish, qq_read_diary, qq_read_self_note, qq_write_diary,
qq_write_self_note, qqbot_send_file, read, read_image, send_message,
subagent, wait_agent, web_fetch
```

**`bash` 67 次调用 0 次失败。**

所以那句「（这个操作没成功：bash）」不是"她没有 bash"，
而是**那一次的具体命令失败了**（我当时的注释理解错了，现在更正）。

## 对"skill 有没有用"的意义

她的 system prompt 与我**是同一套**（DSHA 能力说明一字不差），
且她能用 bash 自由读取文件 —— 所以：

**她能读 `/root/.dsh/skills/bili-cli/SKILL.md`。**

但有两个现实约束：

1. **她从未调用过 `skill` 工具**（26 个工具里没有它）。
   这不代表没有，只代表没触发过。她更可能直接用 `bash cat` 去读。
2. **现有会话都在技能安装之前创建**（最新 17:07 UTC，技能 17:44 装）。
   新会话才会在 system prompt 里带 `available_skills`。

## 修正我之前两个判断

| 我说过 | 实际 |
|---|---|
| 「她可能没有 bash」 | ❌ 错。67 次调用 0 失败 |
| 「『这个操作没成功：bash』说明她没这个工具」 | ❌ 错。是那次命令失败，不是工具不存在 |
| 「skill 对她是'有说明书没手'」 | ❌ 错。她的手很全（bash/read/subagent/浏览器都有） |

## 那么回到原问题：该不该改成 skill + MCP？

**skill：她完全用得上。** 她能用 bash 读到 SKILL.md，
而且她的工具集里有 `subagent`、`ego_*`（浏览器）、`platform_search` ——
这些正好是 SKILL.md 里描述的工作流需要的。

**MCP：仍然不该用。** 理由不变且更硬了 ——
她既然能 bash，`execFileSync('bili', ...)` 就是最短路径；
MCP 要多一层 JSON-RPC + 常驻进程，且一次性暴露全部写权限。

## 但真正的问题不是 skill 有没有用

而是：**小羽回答用户时，只有一次工具调用机会。**

她可以 bash，但"四十集挑哪几分钟"这种任务，
让她现场写脚本分析字幕，比我们预先把工具做好要慢得多、也更容易出错。

所以正确的分工是：
- **skill** → 让她在**自由时间**（own-life、闲聊探索）能自己玩 B 站
- **封装工具**（`qq_bili_check`） → 让她在**回答用户**时一次调用拿到结果

两者不冲突，是不同场景。
