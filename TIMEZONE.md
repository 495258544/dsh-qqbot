# 容器时区说明（2026-11-03）

## 现状

```
$ date
Mon Nov  2 19:25:04 UTC 2026    ← 容器是 UTC
$ TZ=Asia/Shanghai date
Tue Nov  3 03:25:04 CST 2026    ← 带 TZ 就正确
$ echo $TZ
（未设置）
```

`/etc/timezone` 是 `Etc/UTC`，**但 `/usr/share/zoneinfo` 完整存在**（2.0M，含 Asia/Shanghai 561 字节）。

> 也就是说：**不是"没有 tzdata"，是"没设 TZ"。**
> 早期代码注释写的"容器没有 /usr/share/zoneinfo"是错的，已全仓更正（19 处）。

## 代码层面：不需要改

`dsh-qqbot` 的所有时间计算都走 `src/persona/clock.ts` 的显式 IANA 时区：

```ts
hourInTz(now, 'Asia/Shanghai')   // 不依赖容器时区
```

全仓 grep 结果：**0 处实际调用 `getHours()` / `getDate()`**（命中的全是注释）。
所以 **TZ 设不设，小羽的行为完全一致**。

## 为什么还是想设

给人看。`date`、`ls -l`、日志时间戳都显示北京时间，不用每次心里 +8。

## 怎么设（以及为什么容器内做不到完整）

DSH 的实际启动命令（从 `/proc/27406/cmdline` 读到，**由 Android app 硬编码**）：

```bash
/bin/bash -c 'export PATH=... && export DSH_HOME=/root/.dsh \
  && export NODE_OPTIONS="--import=/root/.dsh/startup-observer.cjs" \
  && ... && exec node .../bin.js web --no-open --host 127.0.0.1 --port 41245'
```

**这条命令在容器内改不了。** 所以：

| 场景 | TZ 生效吗 |
|---|---|
| 从 app 界面重启 | ❌ 不生效（走 app 硬编码的命令） |
| 用 `/usr/local/bin/dsh-restart.sh` 手动重启 | ✅ 生效 |
| agent 的 bash 工具（`bash -c`） | ✅ 通过 `BASH_ENV` 生效 |

### 唯一能在 app 重启时也生效的办法

改 `/root/.dsh/startup-observer.cjs`（app 配在 `NODE_OPTIONS` 里的加载点），
在里面加一行 `process.env.TZ = 'Asia/Shanghai'`。

**但这是 DSH 官方文件**，改它影响宿主本体 —— 需要明确同意才做。

## 关于 `bash -c` 的坑

`.bashrc` 第 8 行是 `[ -z "$PS1" ] && return` —— **非交互式 shell 直接返回**。
而 agent 的所有 bash 工具都是 `bash -c`（非交互），所以写 `.bashrc` 完全无效（实测 `AAA` 为空）。

非交互式 bash 只读 `$BASH_ENV` 指向的文件。所以用 `/root/.dsh-timezone.sh`。

## 相关文件

- `/root/.dsh-timezone.sh` —— `export TZ=Asia/Shanghai`（给非交互 bash 读）
- `/usr/local/bin/dsh-restart.sh` —— 带 TZ 的手动重启入口
