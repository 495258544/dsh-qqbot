"""
bili-mcp server 的测试
─────────────────────────────────────────────────────────────
重点测的是**从 ts 搬过来的那些逻辑**（按分钟压缩字幕），
以及白名单/命令封装这几个容易出错的地方。

跑法：python3 -m pytest test_server.py -q
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import pytest

import server


def mmss(sec):
    return server.mmss(sec)


class TestMmss:
    def test_basic(self):
        assert mmss(0) == "00:00"
        assert mmss(61) == "01:01"
        assert mmss(185) == "03:05"

    def test_beyond_hour(self):
        # 40 集的合集动的就是这种量级，不能退化成 0
        assert mmss(3725) == "62:05"

    def test_negative_clamped(self):
        assert mmss(-5) == "00:00"


class TestAllowlist:
    """白名单是这套东西的安全边界，必须真的能收窄。"""

    def test_empty_means_all(self):
        server._ALLOWED.clear()
        assert server.allowed("bili_video") is True
        assert server.allowed("随便什么") is True

    def test_explicit_list_only_allows_listed(self):
        server._ALLOWED.clear()
        server._ALLOWED.update({"bili_video", "bili_status"})
        assert server.allowed("bili_video") is True
        assert server.allowed("bili_follow") is False

    def test_teardown(self):
        server._ALLOWED.clear()


class TestRunBili:
    """run_bili 的错误处理：bili 失败时退出码非零但 stdout 有 JSON。"""

    def test_no_bili_command(self, monkeypatch):
        def boom(*a, **k):
            raise FileNotFoundError()
        monkeypatch.setattr(server.subprocess, "run", boom)
        r = server.run_bili(["auth", "status"])
        assert r["ok"] is False
        assert r["error"]["code"] == "no_bili"

    def test_timeout(self, monkeypatch):
        def boom(*a, **k):
            raise server.subprocess.TimeoutExpired(cmd="bili", timeout=1)
        monkeypatch.setattr(server.subprocess, "run", boom)
        r = server.run_bili(["video", "info", "x"])
        assert r["ok"] is False
        assert r["error"]["code"] == "timeout"

    def test_nonzero_exit_still_parses_stdout(self, monkeypatch):
        # bili 的契约：失败时 {ok:false,error} + 非零退出码。
        # 若只按 returncode 判断，就会丢掉 bili 自己写的错误信息。
        class Fake:
            returncode = 1
            stdout = '{"ok": false, "error": {"code": "not_found", "message": "该视频没有字幕"}}'
            stderr = ""
        monkeypatch.setattr(server.subprocess, "run", lambda *a, **k: Fake())
        r = server.run_bili(["video", "subtitle", "BV1"])
        assert r["ok"] is False
        assert "没有字幕" in r["error"]["message"]

    def test_empty_stdout(self, monkeypatch):
        class Fake:
            returncode = 0
            stdout = ""
            stderr = "some error"
        monkeypatch.setattr(server.subprocess, "run", lambda *a, **k: Fake())
        r = server.run_bili(["x"])
        assert r["ok"] is False
        assert r["error"]["code"] == "empty"

    def test_bad_json(self, monkeypatch):
        class Fake:
            returncode = 0
            stdout = "not json at all"
            stderr = ""
        monkeypatch.setattr(server.subprocess, "run", lambda *a, **k: Fake())
        r = server.run_bili(["x"])
        assert r["ok"] is False
        assert r["error"]["code"] == "bad_json"


class TestTranscriptCondensing:
    """按分钟压缩 —— 从 tools.ts 搬过来的逻辑，行为必须一致。

    这条最关键：用户抱怨"整段倒出来"，压缩后必须**覆盖全程**，
    不能只给开头几分钟（那样等于没修）。
    """

    def _compress(self, items):
        """复刻 server.bili_transcript 里的压缩逻辑（不含 IO）"""
        buckets = {}
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
        return lines

    def test_covers_whole_video_not_just_opening(self):
        # 27 分钟的视频，每分钟 20 句 —— 老实现只取前 40 句（≈前 90 秒）
        items = [
            {"from": i * 2.2, "to": i * 2.2 + 2, "content": f"第{i}句讲解内容"}
            for i in range(755)
        ]
        lines = self._compress(items)
        assert len(lines) >= 26, "必须覆盖约 27 分钟"
        assert int(lines[-1][1:3]) >= 26, "最后一条要是结尾，不是开场"

    def test_picks_longest_per_minute(self):
        items = [
            {"from": 1, "content": "啊"},
            {"from": 3, "content": "对吧"},
            {"from": 5, "content": "这里是这一分钟最重要的一句话讲了完整配置步骤"},
        ]
        lines = self._compress(items)
        assert len(lines) == 1
        assert "最重要" in lines[0]
        assert "啊" not in lines[0].replace("最重要", "")

    def test_empty_content_ignored(self):
        items = [{"from": 1, "content": ""}, {"from": 2, "content": "  "}, {"from": 70, "content": "有内容"}]
        lines = self._compress(items)
        assert len(lines) == 1
        assert lines[0].startswith("[01:10]")

    def test_no_timestamp_treated_as_zero(self):
        lines = self._compress([{"content": "没有 from 的一句"}])
        assert len(lines) == 1
        assert lines[0].startswith("[00:00]")

    def test_compression_ratio(self):
        items = [
            {"from": i * 2.25, "content": "这是一句大约十二个字的口语讲解内容"} for i in range(1600)
        ]
        lines = self._compress(items)
        full = sum(len(x["content"]) for x in items)
        packed = sum(len(x) for x in lines)
        assert packed < full / 4, f"压缩不够：{full} → {packed}"


class TestNewTools:
    """新增的 4 个工具（stats / relation / dm_list / dm_read）。

    这几个的工具函数直接调 run_bili，所以用 monkeypatch 喂假数据测字段解析。
    重点是**字段名**——实测发现 dm 的字段是 messages/last_message.text 而不是
    items/content，写错就静默返回"没有记录"。
    """

    def test_stats_parses_numbers(self, monkeypatch):
        monkeypatch.setattr(server, "run_bili", lambda *a, **k: {
            "ok": True, "data": {"stat": {"view": 558027, "like": 12346, "coin": 3969}}
        })
        out = server.bili_stats("BV1")
        assert "558,027" in out and "12,346" in out

    def test_relation_all_untouched(self, monkeypatch):
        monkeypatch.setattr(server, "run_bili", lambda *a, **k: {
            "ok": True, "data": {"liked": False, "coin": 0, "favorited": False, "followed": False}
        })
        out = server.bili_relation("BV1")
        assert "还没动过" in out

    def test_relation_reports_actions(self, monkeypatch):
        monkeypatch.setattr(server, "run_bili", lambda *a, **k: {
            "ok": True, "data": {"liked": True, "coin": 2, "favorited": True, "followed": True}
        })
        out = server.bili_relation("BV1")
        assert "赞过了" in out and "2 个币" in out and "收藏了" in out

    def test_dm_list_uses_last_message_text(self, monkeypatch):
        # 实测字段：{uid, name, unread, last_message:{text, auto_reply}}
        monkeypatch.setattr(server, "run_bili", lambda *a, **k: {
            "ok": True, "data": {"items": [
                {"name": "影视飓风", "unread": 1,
                 "last_message": {"text": "感谢关注", "auto_reply": True}},
            ]}
        })
        out = server.bili_dm_list()
        assert "影视飓风" in out
        assert "感谢关注" in out
        # 自动回复必须标出来，否则她会以为对方在等她回话
        assert "自动回复" in out

    def test_dm_read_uses_messages(self, monkeypatch):
        # 实测字段是 messages（不是 items），每条有 from/text
        monkeypatch.setattr(server, "run_bili", lambda *a, **k: {
            "ok": True, "data": {"messages": [
                {"from": "them", "text": "你好呀"},
                {"from": "me", "text": "在的"},
            ]}
        })
        out = server.bili_dm_read("946974")
        assert "对方" in out and "我" in out
        assert "你好呀" in out

    def test_dm_empty_is_not_error(self, monkeypatch):
        monkeypatch.setattr(server, "run_bili", lambda *a, **k: {"ok": True, "data": {"messages": []}})
        out = server.bili_dm_read("x")
        assert "没有" in out
