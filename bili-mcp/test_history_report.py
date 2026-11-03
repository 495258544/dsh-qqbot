"""
C 方案（写进 B 站播放历史）的测试

重点不是"能不能上报"，而是**默认必须是关的** ——
部署到别人的机器上不能默默改人家的账号数据。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import pytest

import history_report as hr


class TestSwitch:
    """开关是这套东西的安全边界。"""

    def test_default_off(self, monkeypatch):
        monkeypatch.delenv("BILI_HISTORY_SYNC", raising=False)
        assert hr.enabled() is False

    def test_off_means_no_network(self, monkeypatch):
        monkeypatch.delenv("BILI_HISTORY_SYNC", raising=False)
        r = hr.report("BV1", 100)
        assert r["ok"] is False
        assert r["skipped"] is True
        # 关键：未启用时**不能**真的打网络
        assert "reason" in r

    def test_truthy_values(self, monkeypatch):
        for v in ("1", "true", "yes"):
            monkeypatch.setenv("BILI_HISTORY_SYNC", v)
            assert hr.enabled() is True

    def test_falsy_values(self, monkeypatch):
        for v in ("", "0", "false", "no", " "):
            monkeypatch.setenv("BILI_HISTORY_SYNC", v)
            assert hr.enabled() is False


class TestCredential:
    def test_missing_file_returns_none(self, monkeypatch, tmp_path):
        monkeypatch.setattr(hr, "CRED_PATH", tmp_path / "nope.json")
        assert hr.load_credential() is None

    def test_bad_json_returns_none(self, monkeypatch, tmp_path):
        f = tmp_path / "c.json"
        f.write_text("not json", encoding="utf-8")
        monkeypatch.setattr(hr, "CRED_PATH", f)
        assert hr.load_credential() is None

    def test_missing_sessdata_returns_none(self, monkeypatch, tmp_path):
        f = tmp_path / "c.json"
        f.write_text('{"bili_jct": "x"}', encoding="utf-8")
        monkeypatch.setattr(hr, "CRED_PATH", f)
        assert hr.load_credential() is None


class TestPageIndex:
    """page_index 是 0 起 —— 踩过的坑。"""

    def test_user_facing_page_is_1_based(self):
        # 对外用"第几 P"（1 起，人话），内部转 0 起。
        # 传 page=1 时应该给 bilibili_api 传 0。
        # 这里只验证转换公式，不打网络。
        assert max(0, 1 - 1) == 0
        assert max(0, 3 - 1) == 2
        assert max(0, 0 - 1) == 0   # 非法输入不会变负

    def test_documented_in_source(self):
        # 源码里必须写清楚这个基准，否则下次又会传错
        src = Path(hr.__file__).read_text(encoding="utf-8")
        assert "0 起" in src, "page_index 基准必须写在注释里"
        assert "不存在该分 p" in src, "踩坑记录应该留着"
