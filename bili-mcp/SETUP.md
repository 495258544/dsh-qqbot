# 接入 DSH 的完整步骤（含踩过的坑）

## 关键：`cordis.patch.yml` 不能直接加条目

第一版我是这么写的：

```yaml
- id: mcp-bili
  name: '@deepseek-ai/dsh-mcp-client'
  config: {...}
```

**没用。** 启动日志里完全没有 `mcp-bili`，而 `dsh --dump-config` 报：

    dsh: [cordis.patch.yml] patch: entry "mcp-bili" not found

### 原因

`cordis.patch.yml` 里不带 `insert` 的条目都是**补丁**：
按 `id` 去默认树里找**已存在的条目**，改写它。找不到就 warn 然后**跳过**。

源码（`dsh-app-boot/lib/index.js:76-95`）：

```js
for (const patch of patches) {
  const { id, insert, name, ...overrides } = patch;
  if (insert) {
    if (id) { /* 插到某个 group 里 */ }
    else data.push(...insert);        // ← 不带 id 就是新增到根列表
    continue;
  }
  if (!id) { warn("patch: id is required for non-insert patches"); continue; }
  const target = entryMap.get(id);
  if (!target) { warn("patch: entry %C not found", id); continue; }   // ← 我们的情况
```

### 正确写法

```yaml
- insert:
    - id: mcp-bili
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: bili
        transport: stdio
        command: /usr/bin/python3
        args: ['<repo>/bili-mcp/server.py']
```

验证：`dsh --profile web --dump-config | grep mcp-bili` 要能看到。

## 第二坑：包要能被 profile 解析

`@deepseek-ai/dsh-mcp-client` 在 DSH 自带包里，但**不在 profile 的 node_modules**。
`npm install` 会失败（profile 的 package.json 有 `link:` 依赖，npm 不认）。

解法：软链

```bash
ln -sfn /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-mcp-client \
        /root/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-mcp-client
```

验证：`cd /root/.dsh/profiles/web && node -e "require.resolve('@deepseek-ai/dsh-mcp-client')"`

## 第三坑：python3 用绝对路径

`command: python3` 依赖 PATH。DSH 由 Android app 的 proot 拉起，
PATH 未必和交互 shell 一致。用 `/usr/bin/python3`。

## 完整检查清单

```bash
# 1. server 自己能跑
python3 <repo>/bili-mcp/server.py < /dev/null   # 退出码 0 即可

# 2. MCP 协议正常（应打印 18 个工具名）
{
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"p","version":"1"}}}'
  echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  sleep 2
} | python3 <repo>/bili-mcp/server.py

# 3. 配置进 compose 树
dsh --profile web --dump-config | grep -A3 mcp-bili

# 4. 包可解析
cd /root/.dsh/profiles/web && node -e "require.resolve('@deepseek-ai/dsh-mcp-client')"
```

四条全过，重启就会生效。工具名形如 `mcp__bili__bili_video`。

## 新增条目的通用规则（不止 MCP）

以后往这个 profile 加**任何**新插件，都得用 `insert:` 语法。
直接写条目 = 静默跳过，只在 `--dump-config` 时看到一行 warn。
