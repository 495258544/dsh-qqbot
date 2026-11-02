# 更正：为什么我说"不建议用 MCP"是错的（2026-11-03）

## 我上一条说的原话

> `mcp` / `skills` — 是给别的客户端用的，我们直接 exec 更简单

**这句话对 `mcp` 部分成立，对 `skills` 部分完全错了。**
我当时没读过这两个命令的 help，凭名字猜的。

## 实测事实

### 1. `skills` 明确支持 DeepSeek Harness，而且已经检测到了

```
$ bili skills status
agents             detected=True installed=False path=/root/.agents/skills/bili-cli
deepseek-harness   detected=True installed=False path=/root/.dsh/skills/bili-cli
```

它认识我们的宿主（`/root/.dsh/skills/`），只是还没装。

### 2. 技能正文里有大量我们没实现的用法

`bili skills show` 输出的 SKILL.md 不只是命令手册，它是一份
**"怎么用这个工具做事"的操作知识**，包括：

| 技能里的写法 | 我们现在的状态 |
|---|---|
| `video watch`（信息+AI总结+全文+热评+弹幕高能+画面总览，一次拿全） | ❌ 没用（我们拆成 5 个命令各调一次） |
| `hot popular --unseen` / `feed recommend --unseen` | ❌ 没用 |
| `video subtitle --text` / `--max-chars 3000` | ❌ 没用（我们手写 slice 截断） |
| `video frames --peaks 5` / `--at 1:30.5` | ❌ 没用 |
| `comment emotes -k 笑` | ❌ 没用 |
| `dm watch --backlog`（先吐积压再逐条） | ❌ 没用 |
| 弹幕时间差 2 秒的对齐解释 | ⚠️ 我们不知道 |
| `risk_control` / `captcha_required` / `rate_limited` 的错误码处理 | ⚠️ 我们只做了 try/catch |

**其中 `--unseen` 最值钱**：它证明 `bili` 自己记录"她看过哪些"：

```
$ cat ~/.config/bili-cli/seen.json
{"BV1ednc6j6E3j": 1793640152.41}
```

这正好补上小羽"每次从零决策"的老毛病 —— 她不用自己维护"看过什么"，
`bili` 已经替她记了。

### 3. `mcp` 这部分我原来的判断是对的，但理由要更正

不是"给别的客户端用"这种含糊说法，而是两条硬的：

**① 依赖根本没装**

```
$ echo '{...initialize...}' | bili mcp serve
{"ok": false, "error": {"code":"invalid_argument",
  "message": "MCP 模式需要额外安装 mcp 依赖。",
  "hint": "重新安装：uv tool install --force \"bili-agent[mcp]\""}}
```

**② 即使装上也不该用 —— 多一层协议没有收益**

我们现在是 `execFileSync('bili', [...])` → 拿 JSON。这是**最短路**：
一次进程调用，一次 JSON 解析。

走 MCP 就变成：起 stdio 子进程 → JSON-RPC 握手 → tools/list → tools/call → 解析结果。
同样的命令，多两层序列化、多一个常驻进程、多一处可能卡住的地方（`dm watch` 这种长任务尤其）。

MCP 解决的是**"客户端不能执行命令"**的问题（Claude Desktop、Cherry Studio）。
DSH 能 exec，所以这个问题在我们这儿不存在。

**③ 还有权限面问题**
MCP 会把 bili 的**全部**能力（包括发评论、私信、投稿、改资料）一次性暴露成工具。
我们现在是白名单式地接 6 个读命令 —— 写操作一个都没有。
走 MCP 等于把写权限也一起给了，而那个账号是 level 0 的新号。

## 结论（修正版）

| 东西 | 该不该用 | 理由 |
|---|---|---|
| `bili skills install --yes` | ✅ **该装** | 它认识 DSH，装完我（以及小羽）能直接读到"怎么正确用 bili"的操作知识 |
| `bili mcp serve` | ❌ 不该用 | 依赖没装 + 多一层协议无收益 + 一次性暴露写权限 |
| `hot popular --unseen` | ✅ 该接 | 补上"看过什么"的记忆 |
| `video watch` | ✅ 该接 | 一次调用拿全，比我们拆 5 次省 |

## 一句话

**"给别的客户端用的"这个理由对 MCP 成立（针对不能 exec 的客户端），
但对 skills 不成立 —— skills 是给 agent 的知识，DSH 正是目标之一。**

我当时把两个命令混为一谈了。
