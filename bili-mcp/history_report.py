#!/usr/bin/env python3
"""
把"看过"上报到 B 站播放历史（C 方案）

## 默认关闭

这个动作会**写进 B 站账号的公开播放历史**。虽然这个账号是给小羽专用的，
但仍然要有开关 —— 部署到别人的机器上时不能默默改人家的账号数据。

开关：环境变量 `BILI_HISTORY_SYNC=1` 才启用。

## 为什么用 bilibili_api 而不是自己打接口

bili CLI 用的是 bilibili_api 17.4.2，它已经把 wbi 签名、csrf、分P cid
全部封装好了：

    await video.report_watch_history(progress=秒, page_index=P序号)

自己打接口要重做签名，没必要。

## 注意 report_start_watching 的 200 播放限制

bilibili_api 的文档原话：「该接口使用似乎存在 200 播放限制, 请勿滥用!」
所以我们**只调 report_watch_history（带上进度）**，不调 report_start_watching。
前者是"我看到了这里"，后者是"我开始看了"且会计播放量。
"""
import asyncio
import json
import os
from pathlib import Path

CRED_PATH = Path.home() / ".config" / "bili-cli" / "credential.json"


def enabled() -> bool:
    """是否启用上报。默认关。"""
    return os.environ.get("BILI_HISTORY_SYNC", "").strip() in ("1", "true", "yes")


def load_credential():
    """读 bili CLI 存的凭证，转成 bilibili_api 的 Credential。

    字段名两边不一样（bili 存的是小写，bilibili_api 要关键字参数），
    这里做一次映射。读不到就返回 None，调用方跳过。
    """
    try:
        raw = json.loads(CRED_PATH.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(raw, dict) or not raw.get("sessdata"):
        return None
    try:
        from bilibili_api import Credential
    except ImportError:
        return None
    return Credential(
        sessdata=raw.get("sessdata"),
        bili_jct=raw.get("bili_jct"),
        buvid3=raw.get("buvid3"),
        buvid4=raw.get("buvid4"),
        dedeuserid=raw.get("dedeuserid"),
        ac_time_value=raw.get("ac_time_value"),
    )


async def report_async(bvid: str, progress: int, page: int = 1) -> dict:
    """真正上报。progress 是秒数（看到哪儿了）。"""
    cred = load_credential()
    if cred is None:
        return {"ok": False, "error": "没有可用凭证（先 bili auth login）"}
    try:
        from bilibili_api import video
    except ImportError:
        return {"ok": False, "error": "bilibili_api 不可用"}
    try:
        v = video.Video(bvid=bvid, credential=cred)
        # **page_index 是 0 起**，不是 1 起。
        #
        # 踩到的坑：传 page=1 报 `ArgsException: 不存在该分 p`。
        # 因为 bilibili_api 内部走 get_cid(page_index)，而 pages 数组是 0 索引的。
        # 对外仍然用"第几 P"（1 起，人话），这里转成 0 起。
        await v.report_watch_history(progress=max(0, int(progress)), page_index=max(0, page - 1))
        return {"ok": True, "bvid": bvid, "page": page, "progress": int(progress)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def report(bvid: str, progress: int, page: int = 1) -> dict:
    """同步入口。未启用时直接返回 skipped，不打网络。"""
    if not enabled():
        return {"ok": False, "skipped": True, "reason": "BILI_HISTORY_SYNC 未开启（默认关）"}
    return asyncio.run(report_async(bvid, progress, page))
