# -*- coding: utf-8 -*-
"""PS-FT3 三问起步 + 发音人档案库 —— 单元测试（纯标准库，不依赖 Praat）。

不读写真实 %APPDATA%：profiles.PROFILES_PATH 在 setClassUp 时改指向临时目录。
probe 只测纯函数 parse_probe_output / suggest_f0_range / _first_wav，不触发真实 Praat。

运行：
    cd ps-shell
    python -m unittest tests.test_ft3 -v
    python -m unittest discover tests -v
"""

import os
import sys
import json
import tempfile
import unittest

# 让测试在直接 `python -m unittest` 时也能找到 backend 包
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend import server, profiles, probe
from backend import params_schema as schema


class ProfilesCrudTest(unittest.TestCase):
    """W1 发音人档案库 CRUD + 校验 + 钳制 + 损坏回退。"""

    _orig_path = None
    _tmp = None

    @classmethod
    def setUpClass(cls):
        cls._orig_path = profiles.PROFILES_PATH
        cls._tmp = tempfile.TemporaryDirectory()
        profiles.PROFILES_PATH = os.path.join(cls._tmp.name, "profiles.json")

    @classmethod
    def tearDownClass(cls):
        profiles.PROFILES_PATH = cls._orig_path
        cls._tmp.cleanup()

    def setUp(self):
        # 每个用例前清空，避免前一次写入污染（修正 FT2 调试期 update/delete 串味的坑）
        if os.path.exists(profiles.PROFILES_PATH):
            os.remove(profiles.PROFILES_PATH)

    def test_save_new_creates_profile(self):
        r = profiles.save_profile({"name": "张三", "f0min": 80, "f0max": 300})
        self.assertTrue(r["ok"], r)
        self.assertTrue(r["id"])
        lst = profiles.list_profiles()
        self.assertEqual(len(lst["profiles"]), 1)
        self.assertEqual(lst["profiles"][0]["name"], "张三")
        self.assertEqual(lst["profiles"][0]["f0min"], 80)
        self.assertEqual(lst["profiles"][0]["f0max"], 300)

    def test_save_requires_name(self):
        r = profiles.save_profile({"name": "  ", "f0min": 80, "f0max": 300})
        self.assertFalse(r["ok"])
        self.assertIn("error", r)

    def test_save_requires_numeric_f0(self):
        r = profiles.save_profile({"name": "X", "f0min": "abc", "f0max": 300})
        self.assertFalse(r["ok"])
        r2 = profiles.save_profile({"name": "X", "f0min": 80, "f0max": None})
        self.assertFalse(r2["ok"])

    def test_f0min_gte_f0max_rejected(self):
        r = profiles.save_profile({"name": "X", "f0min": 300, "f0max": 100})
        self.assertFalse(r["ok"])
        self.assertIn("基频下限必须小于上限", r["error"])

    def test_clamp_f0_bounds(self):
        # 5 < 20 钳到 20；9999 > 1000 钳到 1000；两条 warning
        # save_profile 只回 {ok, id, warnings}，钳制值落盘，需从 list 读回校验
        r = profiles.save_profile({"name": "X", "f0min": 5, "f0max": 9999})
        self.assertTrue(r["ok"], r)
        saved = profiles.list_profiles()["profiles"][0]
        self.assertEqual(saved["f0min"], 20)
        self.assertEqual(saved["f0max"], 1000)
        warns = [w["field"] for w in r["warnings"]]
        self.assertIn("f0min", warns)
        self.assertIn("f0max", warns)

    def test_clamp_formant(self):
        r = profiles.save_profile({"name": "X", "f0min": 80, "f0max": 300, "maxFormantHz": 99999})
        self.assertTrue(r["ok"], r)
        saved = profiles.list_profiles()["profiles"][0]
        self.assertEqual(saved["maxFormantHz"], 11000)
        self.assertTrue(any(w["field"] == "maxFormantHz" for w in r["warnings"]))

    def test_update_existing(self):
        r = profiles.save_profile({"name": "张三", "f0min": 80, "f0max": 300})
        pid = r["id"]
        r2 = profiles.save_profile({"id": pid, "name": "李四", "f0min": 90, "f0max": 320})
        self.assertTrue(r2["ok"], r2)
        self.assertEqual(r2["id"], pid)
        lst = profiles.list_profiles()
        self.assertEqual(len(lst["profiles"]), 1)
        self.assertEqual(lst["profiles"][0]["name"], "李四")
        self.assertEqual(lst["profiles"][0]["f0min"], 90)

    def test_update_missing_id(self):
        r = profiles.save_profile({"id": "nope", "name": "X", "f0min": 80, "f0max": 300})
        self.assertFalse(r["ok"])
        self.assertIn("找不到要更新的档案", r["error"])

    def test_delete_and_missing(self):
        r = profiles.save_profile({"name": "张三", "f0min": 80, "f0max": 300})
        pid = r["id"]
        d = profiles.delete_profile({"id": pid})
        self.assertTrue(d["ok"])
        self.assertEqual(len(profiles.list_profiles()["profiles"]), 0)
        # 删不存在的
        d2 = profiles.delete_profile({"id": pid})
        self.assertFalse(d2["ok"])
        # 缺 id
        d3 = profiles.delete_profile({})
        self.assertFalse(d3["ok"])

    def test_rename(self):
        r = profiles.save_profile({"name": "张三", "f0min": 80, "f0max": 300})
        pid = r["id"]
        rn = profiles.rename_profile({"id": pid, "name": "王五"})
        self.assertTrue(rn["ok"])
        self.assertEqual(profiles.list_profiles()["profiles"][0]["name"], "王五")
        # 改名不存在
        self.assertFalse(profiles.rename_profile({"id": "x", "name": "Y"})["ok"])
        # 空名
        self.assertFalse(profiles.rename_profile({"id": pid, "name": "  "})["ok"])

    def test_corrupt_json_rollback(self):
        # 写入损坏内容 → list 回退为空，不抛异常
        with open(profiles.PROFILES_PATH, "w", encoding="utf-8") as f:
            f.write("{ this is not valid json ")
        lst = profiles.list_profiles()
        self.assertTrue(lst["ok"])
        self.assertEqual(lst["profiles"], [])
        # 损坏后仍可正常新增（覆盖写回干净文件）
        r = profiles.save_profile({"name": "恢复", "f0min": 80, "f0max": 300})
        self.assertTrue(r["ok"], r)
        self.assertEqual(len(profiles.list_profiles()["profiles"]), 1)

    def test_presets_untouched(self):
        before = json.dumps(schema.SPEAKER_PRESETS, sort_keys=True)
        profiles.save_profile({"name": "张三", "f0min": 80, "f0max": 300})
        after = json.dumps(schema.SPEAKER_PRESETS, sort_keys=True)
        self.assertEqual(before, after, "SPEAKER_PRESETS 不应被档案库改动")


class ProbePureTest(unittest.TestCase):
    """W2 探针纯函数：解析分支 + 建议钳制 + 首文件的选取。"""

    def test_parse_normal_dict_lines(self):
        lines = [
            {"tag": "out", "text": "some log"},
            {"tag": "out", "text": "PSA_F0MIN 106.14"},
            {"tag": "out", "text": "PSA_F0MAX 185.79"},
        ]
        f0min, f0max = probe.parse_probe_output(lines)
        self.assertEqual(f0min, 106.14)
        self.assertEqual(f0max, 185.79)

    def test_parse_missing_markers(self):
        lines = [{"tag": "out", "text": "nothing here"}, "plain string, no markers"]
        f0min, f0max = probe.parse_probe_output(lines)
        self.assertIsNone(f0min)
        self.assertIsNone(f0max)

    def test_parse_garbage_value(self):
        # PSA_F0MIN 后面跟非数字 → 该值抽不到为 None
        lines = [
            {"tag": "out", "text": "PSA_F0MIN abc"},
            {"tag": "out", "text": "PSA_F0MAX 185.79"},
        ]
        f0min, f0max = probe.parse_probe_output(lines)
        self.assertIsNone(f0min)
        self.assertEqual(f0max, 185.79)

    def test_suggest_clamp_low(self):
        # p05=5 → max(20, round(4))=20；p95=100 → round(130)=130（未到上限）
        self.assertEqual(probe.suggest_f0_range(5, 100), (20, 130))

    def test_suggest_clamp_high(self):
        # p05=100 → 80；p95=900 → min(1000, 1170)=1000
        self.assertEqual(probe.suggest_f0_range(100, 900), (80, 1000))

    def test_first_wav(self):
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "b.wav"), "w").close()
            open(os.path.join(d, "a.wav"), "w").close()
            open(os.path.join(d, "readme.txt"), "w").close()
            self.assertEqual(probe._first_wav(d, "wav"), "a.wav")
            self.assertIsNone(probe._first_wav(d, "mp3"))
            self.assertIsNone(probe._first_wav("C:\\__psft3_nodir__", "wav"))


class MergeSpeakersTest(unittest.TestCase):
    """W1 bootstrap 合并：静态预设(kind:preset) + 档案(kind:profile)，互不改动。"""

    _orig_path = None
    _tmp = None

    @classmethod
    def setUpClass(cls):
        cls._orig_path = profiles.PROFILES_PATH
        cls._tmp = tempfile.TemporaryDirectory()
        profiles.PROFILES_PATH = os.path.join(cls._tmp.name, "profiles.json")

    @classmethod
    def tearDownClass(cls):
        profiles.PROFILES_PATH = cls._orig_path
        cls._tmp.cleanup()

    def setUp(self):
        if os.path.exists(profiles.PROFILES_PATH):
            os.remove(profiles.PROFILES_PATH)

    def test_preset_kind_only_when_empty(self):
        merged = profiles.merge_speakers()
        self.assertEqual(len(merged), len(schema.SPEAKER_PRESETS))
        self.assertTrue(all(m["kind"] == "preset" for m in merged))
        # 每条都有 id / name
        self.assertTrue(all("id" in m and "name" in m for m in merged))

    def test_profile_kind_appended(self):
        profiles.save_profile({"name": "张三", "f0min": 80, "f0max": 300})
        merged = profiles.merge_speakers()
        self.assertEqual(len(merged), len(schema.SPEAKER_PRESETS) + 1)
        prof = [m for m in merged if m["kind"] == "profile"]
        self.assertEqual(len(prof), 1)
        self.assertEqual(prof[0]["name"], "张三")
        self.assertEqual(prof[0]["kind"], "profile")
        # 预设数量与 kind 不变
        self.assertEqual(len([m for m in merged if m["kind"] == "preset"]), len(schema.SPEAKER_PRESETS))

    def test_bootstrap_speakers_and_env(self):
        profiles.save_profile({"name": "张三", "f0min": 80, "f0max": 300})
        boot = server.bootstrap()
        self.assertTrue(boot["ok"])
        kinds = {m["kind"] for m in boot["speakers"]}
        self.assertEqual(kinds, {"preset", "profile"})
        self.assertIn("sampleDir", boot["env"])
        self.assertIn("workDir", boot["env"])
        self.assertTrue(os.path.isabs(boot["env"]["workDir"]))


if __name__ == "__main__":
    unittest.main()
