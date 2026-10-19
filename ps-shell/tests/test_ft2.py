# -*- coding: utf-8 -*-
"""PS-FT2 体检卡 + 输入转码 + TextGrid 模糊配对 —— 单元测试（纯标准库，不依赖 Praat）。

运行：
    cd ps-shell
    python -m unittest tests.test_ft2 -v
    python -m unittest discover tests -v
"""

import os
import sys
import wave
import struct
import math
import unittest
import tempfile

# 让测试在直接 `python -m unittest` 时也能找到 backend 包
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend import server, health, tgmatch, transcode
from backend import params_schema as schema


def _make_wav(path, channels=1, seconds=1.0, rate=16000):
    """写一个最小合法 wav（静音正弦），供健康扫描/转码测试用。"""
    n = int(rate * seconds)
    with wave.open(path, "w") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        frames = b"".join(
            struct.pack("<h", int(2000 * math.sin(2 * math.pi * 220 * i / rate)))
            for i in range(n)
        )
        w.writeframes(frames)


def _make_tg(path):
    """写一个最小合法 TextGrid（长格式），供配对测试用。"""
    with open(path, "w", encoding="utf-8") as f:
        f.write(
            'File type = "ooTextFile"\n'
            'Object class = "TextGrid"\n\n'
            'xmin = 0\nxmax = 1\n\n'
            'tiers? <exists>\nsize = 1\n'
            'item []:\n'
            '    item [1]:\n'
            '        class = "IntervalTier"\n'
            '        name = "utterance"\n'
            '        xmin = 0\nxmax = 1\n'
            '        intervals: size = 1\n'
            '        intervals [1]:\n'
            '            xmin = 0\nxmax = 1\n'
            '            text = "a"\n'
        )


class W1TextImportTest(unittest.TestCase):
    def test_valid_csv_text(self):
        text = "variable,input,comment\nf0min,75,低\nf0max,300,高\n"
        r = server.import_params({"text": text})
        self.assertTrue(r["ok"])
        self.assertEqual(r["values"].get("f0min"), 75)
        self.assertEqual(r["values"].get("f0max"), 300)

    def test_semicolon_csv_text(self):
        # 用真实 schema 参数（import_params 返回的 coerced 只含 schema 内字段）
        text = "variable;input;comment\nf0min;75;低\nf0max;300;高"
        r = server.import_params({"text": text})
        self.assertTrue(r["ok"])
        self.assertIn("分号", (r["notes"] or [""])[0])
        self.assertEqual(r["values"].get("f0min"), 75)
        self.assertEqual(r["values"].get("f0max"), 300)

    def test_unknown_key_warning(self):
        text = "variable,input,comment\nf0min,75,低\nbogus,9,?\n"
        r = server.import_params({"text": text})
        self.assertTrue(r["ok"])
        self.assertIn("bogus", r["unknown"])
        self.assertTrue(any("已忽略" in w["msg"] for w in r["warnings"]))

    def test_missing_key_warning(self):
        # 只给 f0min，缺 f0max（schema 里必须存在）
        text = "variable,input,comment\nf0min,75,低\n"
        r = server.import_params({"text": text})
        self.assertTrue(r["ok"])
        self.assertIn("f0max", r["missing"])
        self.assertTrue(any("默认值" in w["msg"] for w in r["warnings"]))

    def test_headerless_first_line_kept(self):
        # 回归（FT2 验收发现）：无表头粘贴时首行曾被当表头吃掉，f0min 丢失回退默认 50
        text = "f0min,60\nf0max,400\nbogusKey,1\n"
        r = server.import_params({"text": text})
        self.assertTrue(r["ok"])
        self.assertEqual(r["values"].get("f0min"), 60)
        self.assertEqual(r["values"].get("f0max"), 400)
        self.assertNotIn("f0min", r["missing"])
        self.assertIn("bogusKey", r["unknown"])

    def test_headerless_semicolon_first_line_kept(self):
        # 无表头 + 分号分隔：首行同样不能丢，且分号识别的 notes 要在
        text = "f0min;60;低\nf0max;400;高\n"
        r = server.import_params({"text": text})
        self.assertTrue(r["ok"])
        self.assertEqual(r["values"].get("f0min"), 60)
        self.assertEqual(r["values"].get("f0max"), 400)
        self.assertNotIn("f0min", r["missing"])
        self.assertTrue(any("分号" in n for n in (r["notes"] or [])))

    def test_neither_path_nor_text(self):
        r = server.import_params({})
        self.assertFalse(r["ok"])
        self.assertIn("error", r)


class W2NormalizeTest(unittest.TestCase):
    def test_whitespace_and_case(self):
        self.assertEqual(health.normalize_name("A b C.wav"), "abcwav")

    def test_fullwidth(self):
        # NFKC 把全角转半角
        self.assertEqual(health.normalize_name("ＡＢ"), "ab")

    def test_underscore_dash_dot(self):
        self.assertEqual(health.normalize_name("a_b-c.d"), "abcd")

    def test_empty(self):
        self.assertEqual(health.normalize_name(""), "")
        self.assertEqual(health.normalize_name(None), "")


class W2HealthCheckTest(unittest.TestCase):
    def _dir(self, d, make):
        make(d)
        return d

    def test_all_green(self):
        with tempfile.TemporaryDirectory() as d:
            _make_wav(os.path.join(d, "a.wav"), seconds=1.0)
            _make_wav(os.path.join(d, "b.wav"), seconds=1.0)
            r = health.health_check(d, "wav")
            self.assertTrue(r["ok"])
            codes = [i["code"] for i in r["items"]]
            self.assertEqual(codes, ["ALL_GREEN"])
            self.assertEqual(r["summary"]["audio"], 2)

    def test_can_transcode(self):
        with tempfile.TemporaryDirectory() as d:
            _make_wav(os.path.join(d, "a.wav"), seconds=1.0)
            with open(os.path.join(d, "b.mp3"), "wb") as f:
                f.write(b"fake")
            r = health.health_check(d, "wav")
            self.assertTrue(any(i["code"] == "CAN_TRANSCODE" and i["action"] == "transcode"
                                 for i in r["items"]))
            self.assertEqual(r["summary"]["transcodable"], 1)

    def test_stereo_warn(self):
        with tempfile.TemporaryDirectory() as d:
            _make_wav(os.path.join(d, "a.wav"), channels=2, seconds=1.0)
            r = health.health_check(d, "wav")
            self.assertTrue(any(i["code"] == "STEREO" and i["action"] == "transcode"
                                 for i in r["items"]))

    def test_tg_count_mismatch(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as tg:
            _make_wav(os.path.join(d, "a.wav"), seconds=1.0)
            _make_wav(os.path.join(d, "b.wav"), seconds=1.0)
            _make_tg(os.path.join(tg, "a.TextGrid"))
            r = health.health_check(d, "wav", tg, use_textgrid=True)
            self.assertTrue(any(i["code"] == "TG_COUNT" and i["action"] == "tgmatch"
                                 for i in r["items"]))

    def test_tg_name_diff(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as tg:
            _make_wav(os.path.join(d, "a.wav"), seconds=1.0)
            _make_wav(os.path.join(d, "b.wav"), seconds=1.0)
            _make_tg(os.path.join(tg, "a.TextGrid"))
            _make_tg(os.path.join(tg, "c.TextGrid"))
            r = health.health_check(d, "wav", tg, use_textgrid=True)
            self.assertTrue(any(i["code"] == "TG_NAME" and i["action"] == "tgmatch"
                                 for i in r["items"]))

    def test_dir_bad(self):
        r = health.health_check("C:\\__not_exist__psft2__", "wav")
        self.assertFalse(r["ok"])
        self.assertEqual(r["items"][0]["code"], "DIR_BAD")

    def test_no_files(self):
        with tempfile.TemporaryDirectory() as d:
            r = health.health_check(d, "wav")
            self.assertFalse(r["ok"])
            self.assertEqual(r["items"][0]["code"], "NO_FILES")


class W4ProposalTest(unittest.TestCase):
    def test_exact_and_normalized(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as tg:
            _make_wav(os.path.join(d, "a.wav"), seconds=1.0)
            _make_wav(os.path.join(d, "b.wav"), seconds=1.0)
            _make_wav(os.path.join(d, "c_1.wav"), seconds=1.0)  # 规范化后 = c1
            _make_tg(os.path.join(tg, "a.TextGrid"))
            _make_tg(os.path.join(tg, "b.TextGrid"))
            _make_tg(os.path.join(tg, "c-1.TextGrid"))  # 规范化后 = c1，模糊命中
            r = tgmatch.proposal(d, "wav", tg)
            self.assertEqual(len(r["exact"]), 2)
            self.assertEqual(len(r["fuzzy"]), 1)
            self.assertEqual(r["fuzzy"][0][0], "c_1.wav")
            self.assertEqual(r["unmatchedWav"], [])
            self.assertEqual(r["unmatchedTg"], [])

    def test_unmatched(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as tg:
            _make_wav(os.path.join(d, "a.wav"), seconds=1.0)
            _make_wav(os.path.join(d, "b.wav"), seconds=1.0)
            _make_tg(os.path.join(tg, "a.TextGrid"))
            _make_tg(os.path.join(tg, "x.TextGrid"))  # 谁都对不上
            r = tgmatch.proposal(d, "wav", tg)
            self.assertEqual(len(r["exact"]), 1)
            self.assertIn("b.wav", r["unmatchedWav"])
            self.assertIn("x.TextGrid", r["unmatchedTg"])

    def test_ambiguous(self):
        # wav "z-x.wav" 规范化成 zx；两个 tg 规范化后也都是 zx → 一个 wav 对应多个 tg，歧义
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as tg:
            _make_wav(os.path.join(d, "z-x.wav"), seconds=1.0)
            _make_tg(os.path.join(tg, "z.x.TextGrid"))   # 基名 z.x，规范化 zx
            _make_tg(os.path.join(tg, "z_x.TextGrid"))   # 基名 z_x，规范化 zx
            r = tgmatch.proposal(d, "wav", tg)
            self.assertEqual(len(r["ambiguous"]), 1)
            self.assertEqual(r["ambiguous"][0]["wav"], "z-x.wav")
            self.assertEqual(len(r["ambiguous"][0]["candidates"]), 2)


class W4ApplyTest(unittest.TestCase):
    def test_apply_staging_and_original_untouched(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as tg:
            _make_wav(os.path.join(d, "a.wav"), seconds=1.0)
            _make_wav(os.path.join(d, "b.wav"), seconds=1.0)
            _make_tg(os.path.join(tg, "a.TextGrid"))
            _make_tg(os.path.join(tg, "b.TextGrid"))
            a_mtime0 = os.path.getmtime(os.path.join(tg, "a.TextGrid"))
            r = tgmatch.apply(d, "wav", tg, [["a.wav", "a.TextGrid"], ["b.wav", "b.TextGrid"]])
            self.assertTrue(r["ok"])
            self.assertEqual(r["pairs"], 2)
            # staging 里 TG 被重命名为与 wav 同基名
            self.assertTrue(os.path.exists(os.path.join(r["tgDir"], "a.TextGrid")))
            self.assertTrue(os.path.exists(os.path.join(r["tgDir"], "b.TextGrid")))
            # filelist 每行一条完整路径、无 BOM
            with open(r["filelist"], "rb") as f:
                raw = f.read()
            self.assertFalse(raw.startswith(b"\xef\xbb\xbf"), "filelist 不应带 BOM")
            text = raw.decode("utf-8")
            self.assertIn(os.path.join(d, "a.wav"), text)
            self.assertIn(os.path.join(d, "b.wav"), text)
            self.assertTrue(text.endswith("\n"))
            # 原始 TG 未被改动（mtime 不变、内容不变）
            self.assertEqual(os.path.getmtime(os.path.join(tg, "a.TextGrid")), a_mtime0)
            with open(os.path.join(tg, "a.TextGrid"), "r", encoding="utf-8") as f:
                self.assertIn("TextGrid", f.read())

    def test_apply_skips_missing(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as tg:
            _make_wav(os.path.join(d, "a.wav"), seconds=1.0)
            _make_tg(os.path.join(tg, "a.TextGrid"))
            r = tgmatch.apply(d, "wav", tg, [["a.wav", "a.TextGrid"], ["ghost.wav", "ghost.TextGrid"]])
            self.assertTrue(r["ok"])
            self.assertEqual(r["pairs"], 1)
            self.assertEqual(len(r["skipped"]), 1)


class W3TranscodeStubTest(unittest.TestCase):
    """W3 不做真实转码：打桩 _transcode_one，只验证请求校验与 manifest 格式。"""

    def setUp(self):
        self._orig = transcode._transcode_one
        # 桩：直接写一个最小合法 wav，模拟 Praat 转码成功
        def fake(exe, src, dst, mono):
            _make_wav(dst, channels=1, seconds=1.0)
            return None
        transcode._transcode_one = fake
        # 让 settings.load 返回一个存在的 praatExe（直接用本测试文件本身）
        self._orig_load = transcode.settings.load
        transcode.settings.load = lambda: {"praatExe": os.path.abspath(__file__)}

    def tearDown(self):
        transcode._transcode_one = self._orig
        transcode.settings.load = self._orig_load

    def test_request_validation(self):
        with tempfile.TemporaryDirectory() as d:
            # 目录不存在：用不存在的盘符路径，避免被 os.makedirs 误建造成误判
            r = transcode.transcode("Q:\\__psft2_nope__\\x", ["a.mp3"])
            self.assertFalse(r["ok"])
            # 无文件
            r = transcode.transcode(d, [])
            self.assertFalse(r["ok"])

    def test_manifest_format(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "a.mp3"), "wb") as f:
                f.write(b"fake")
            with open(os.path.join(d, "b.flac"), "wb") as f:
                f.write(b"fake")
            r = transcode.transcode(d, ["a.mp3", "b.flac"], mono=True)
            self.assertTrue(r["ok"])
            self.assertEqual(r["failed"], [])
            self.assertEqual(len(r["converted"]), 2)
            self.assertTrue(os.path.isfile(r["manifest"]))
            with open(r["manifest"], "r", encoding="utf-8") as f:
                lines = f.read().split("\n")
            header = lines[0].split("\t")
            self.assertEqual(header, ["source", "converted", "duration", "sampleRate", "channels"])
            # 每个成功项都有一行数据
            self.assertEqual(len([l for l in lines if l]), 3)  # header + 2 行
            # outDir 在 converted_wav 子目录
            self.assertTrue(r["outDir"].endswith(transcode.CONVERTED_DIR))


class W4ExecutionChainTest(unittest.TestCase):
    """回归：W4 写入的 filelist 必须在批量路径透传到 params.csv，否则 1:1 校验失败。"""

    def test_filelist_kept_when_valid(self):
        with tempfile.TemporaryDirectory() as d:
            fl = os.path.join(d, "filelist.txt")
            with open(fl, "w", encoding="utf-8") as f:
                f.write(os.path.join(d, "a.wav") + "\n")
            values = dict(schema.default_values())
            values["filelist"] = fl
            _, _, _, _, v = server._prepare(values, None, None)
            self.assertEqual(v.get("filelist"), fl)

    def test_filelist_popped_when_absent(self):
        values = dict(schema.default_values())
        values["filelist"] = "C:\\__nope_fl__\\x.txt"
        _, _, _, _, v = server._prepare(values, None, None)
        self.assertNotIn("filelist", v)


if __name__ == "__main__":
    unittest.main()
