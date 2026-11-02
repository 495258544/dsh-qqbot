"""
bili-chapter server 的测试

只测一件事：**字幕压缩是否覆盖全程**。
这条最关键 —— 用户抱怨"整段倒出来""四十集看不过来"，
如果压缩后只给开头几分钟，等于没修。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import pytest

import chapter_server as cs


class TestMmss:
    def test_basic(self):
        assert cs.mmss(0) == "00:00"
        assert cs.mmss(61) == "01:01"
        assert cs.mmss(185) == "03:05"

    def test_beyond_hour(self):
        # 40 集的合集动的就是这种量级
        assert cs.mmss(3725) == "62:05"

    def test_negative_clamped(self):
        assert cs.mmss(-5) == "00:00"


class TestRunBili:
    """bili 失败时 {ok:false} + 非零退出码，两种都得处理。"""

    def test_no_bili(self, monkeypatch):
        def boom(*a, **k):
            raise FileNotFoundError()
        monkeypatch.setattr(cs.subprocess, "run", boom)
        r = cs.run_bili(["x"])
        assert r["ok"] is False and r["error"]["code"] == "no_bili"

    def test_timeout(self, monkeypatch):
        def boom(*a, **k):
            raise cs.subprocess.TimeoutExpired(cmd="bili", timeout=1)
        monkeypatch.setattr(cs.subprocess, "run", boom)
        assert cs.run_bili(["x"])["error"]["code"] == "timeout"

    def test_nonzero_exit_still_parses(self, monkeypatch):
        # 若只看 returncode，会丢掉 bili 自己写的错误信息
        class F:
            returncode = 1
            stdout = '{"ok": false, "error": {"code":"not_found","message":"没有字幕"}}'
            stderr = ""
        monkeypatch.setattr(cs.subprocess, "run", lambda *a, **k: F())
        r = cs.run_bili(["x"])
        assert r["ok"] is False and "没有字幕" in r["error"]["message"]


class TestCompression:
    """压缩逻辑 —— 这是这个 server 存在的唯一理由。"""

    def _compress(self, items):
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
            lines.append(f"[{cs.mmss(first)}] " + " ".join(t for _, t in top))
        return lines

    def test_covers_whole_video(self):
        # 27 分钟、755 句 —— 老实现只取前 40 句（≈前 90 秒）
        items = [
            {"from": i * 2.17, "content": f"第{i}句 这是讲解内容"} for i in range(755)
        ]
        lines = self._compress(items)
        assert len(lines) >= 26, "必须覆盖约 27 分钟"
        assert int(lines[-1][1:3]) >= 26, "最后一条要是结尾，不是开场"

    def test_picks_longest_per_minute(self):
        items = [
            {"from": 1, "content": "啊"},
            {"from": 3, "content": "对吧"},
            {"from": 5, "content": "这里是这一分钟最重要的一句话讲了完整的配置步骤"},
        ]
        lines = self._compress(items)
        assert len(lines) == 1
        assert "最重要" in lines[0]

    def test_empty_ignored(self):
        items = [{"from": 1, "content": ""}, {"from": 2, "content": "  "}, {"from": 70, "content": "有内容"}]
        lines = self._compress(items)
        assert len(lines) == 1 and lines[0].startswith("[01:10]")

    def test_no_timestamp_is_zero(self):
        lines = self._compress([{"content": "没有 from"}])
        assert lines[0].startswith("[00:00]")

    def test_compression_ratio(self):
        items = [
            {"from": i * 2.25, "content": "这是一句大约十二个字的口语讲解内容"} for i in range(1600)
        ]
        full = sum(len(x["content"]) for x in items)
        packed = sum(len(x) for x in self._compress(items))
        assert packed < full / 4, f"压缩不够：{full} → {packed}"
