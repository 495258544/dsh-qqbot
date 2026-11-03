#!/usr/bin/env python3
"""
bili-chapter · 只做一件事：把字幕压成"哪几分钟讲到东西"

## 为什么这个要自建，其余全用官方

官方 MCP（`bili mcp serve`）的 17 个工具已经覆盖 95% 场景，交给上游维护。
但字幕这块两个官方路径都不行：

    video_transcript   纯文本，时间轴被压平 → 回答不了"哪几分钟"
    run_bili subtitle  75513 字符原始 JSON（≈5 万 tokens）→ 塞不进上下文

而用户最初的诉求就是「别整段倒出来，标出哪几分钟讲到东西」。
所以这一件事必须自己做。

## 只暴露 1 个工具

工具越少，schema 越省。官方 17 个已经占 5861 tokens，
这里再堆十几个就本末倒置了。
"""
import json
import subprocess

from mcp.server.mcpserver import MCPServer

mcp = MCPServer("bili-chapter")


def run_bili(args: list[str], timeout: int = 120) -> dict:
    """调 bili，拿它输出的 JSON。

    bili 的契约：stdout 恒为一个 JSON；失败时 {ok:false,error} 且**退出码非零**。
    所以要同时看 stdout 和退出码，不能只看 returncode。
    """
    try:
        p = subprocess.run(
            ["bili"] + args, capture_output=True, text=True,
            timeout=timeout, encoding="utf-8",
        )
    except FileNotFoundError:
        return {"ok": False, "error": {"code": "no_bili", "message": "找不到 bili 命令"}}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": {"code": "timeout", "message": f"bili 超时 {timeout}s"}}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": {"code": "spawn_failed", "message": str(e)}}

    out = (p.stdout or "").strip()
    if not out:
        return {"ok": False, "error": {"code": "empty", "message": (p.stderr or "无输出")[:300]}}
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return {"ok": False, "error": {"code": "bad_json", "message": out[:300]}}


def mmss(sec: float) -> str:
    s = max(0, int(sec))
    return f"{s // 60:02d}:{s % 60:02d}"


@mcp.tool()
def bili_chapters(bvid: str, page: int = 1) -> str:
    """视频字幕按分钟压缩，带 [mm:ss] 时间戳 —— 用来回答"哪几分钟讲到东西"。

    比整段字幕省 7 倍上下文，且覆盖全程（不会只给开头）。
    这是**原料不是结论**：拿到后你要挑出真正有内容的 3-5 段再说给人听。

    单集视频不用带 page；合集先看分 P 目录再指定第几 P。
    """
    r = run_bili(["video", "subtitle", bvid, "-p", str(page)])
    if not r.get("ok"):
        e = r.get("error") or {}
        return f"字幕拿不到：{e.get('code', 'error')} - {e.get('message', '未知错误')}"

    items = (r.get("data") or {}).get("items") or []
    if not items:
        return "这个视频没有字幕。"

    # 按分钟聚桶：每分钟留最长的两句（短句多是"啊""对吧"这类填充）
    buckets: dict[int, list[tuple[float, str]]] = {}
    for it in items:
        text = (it.get("content") or "").strip()
        if not text:
            continue
        at = float(it.get("from") or 0)
        buckets.setdefault(int(at // 60), []).append((at, text))

    lines = []
    for m in sorted(buckets):
        arr = buckets[m]
        top = sorted(arr, key=lambda x: -len(x[1]))[:2]
        top.sort()
        first = min(a for a, _ in arr)
        lines.append(f"[{mmss(first)}] " + " ".join(t for _, t in top))

    body = "\n".join(lines)

    # C 方案：把"看过"上报到 B 站播放历史（**默认关**，靠 BILI_HISTORY_SYNC 开启）。
    #
    # 放在压缩成功之后：只有真的拿到内容了才算"看过"。
    # 失败不报错也不影响返回 —— 上报是附带动作，不是主功能。
    note = ""
    try:
        import history_report
        last_sec = max((float(it.get("to") or 0) for it in items), default=0)
        r = history_report.report(bvid, int(last_sec), page=page)
        if r.get("ok"):
            note = f"\n（已记进 B 站播放历史：到 {mmss(last_sec)}）"
        elif r.get("skipped"):
            note = ""   # 默认关的时候不打扰
    except Exception:  # noqa: BLE001
        note = ""

    return (
        body
        + f"\n\n↑ 共 {len(lines)} 分钟。**别整段转述** —— 挑出真正讲到东西的 3-5 段，"
        + "每段一句话说清讲了什么，带上时间点。铺垫和寒暄跳过。"
        + note
    )


if __name__ == "__main__":
    mcp.run()
