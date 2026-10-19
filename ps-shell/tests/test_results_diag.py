# -*- coding: utf-8 -*-
"""结果诊断的回归测试（2026-10-18 静音段误报事故）。

背景：用户把 F0/共振峰全部测量并审核完，批量再跑时却被提示「有 15 个文件基频检出
异常」。实际原因是 TextGrid 把每个文件切成「目标字 + sil」两段，sil 段本来就没有
基频，却被算进了检出率的分母——目标段 87–98% 的录音被算成 26–35%。

这些用例锁三件事：
1. 带 label 的结果表，sil / # 之类的静音段一律不进分母；
2. 真的离群的文件仍然要点名（不能为了不误报而整体失聪）；
3. 没有 label 列的旧结果表维持原行为。
"""

import os
import tempfile
import unittest

from backend import results


HEADER = "file\tlabel\tintervalID\tt\tf0\tF1\n"


def _row(name, label, i, t, f0, f1="500"):
    return f"{name}\t{label}\t{i}\t{t:.3f}\t{f0}\t{f1}\n"


class SilenceSegmentTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "out.tsv")

    def tearDown(self):
        self.tmp.cleanup()

    def _write(self, rows):
        with open(self.path, "w", encoding="utf-8") as f:
            f.write(HEADER)
            f.writelines(rows)

    def test_silence_segments_do_not_dilute_f0_ratio(self):
        """sil 段占一半时长也不该把正常文件的检出率压到 35% 以下。"""
        rows = []
        # a.wav：sil 段 100 帧全空 + 目标段 50 帧全有 → 文件级应为 100%，而不是 33%
        for i in range(100):
            rows.append(_row("a.wav", "sil", i, i * 0.005, "--undefined--"))
        for i in range(50):
            rows.append(_row("a.wav", "a", 100 + i, 0.6 + i * 0.005, 180))
        # b.wav：同样结构
        for i in range(100):
            rows.append(_row("b.wav", "sil", i, i * 0.005, "0"))
        for i in range(50):
            rows.append(_row("b.wav", "b", 100 + i, 0.6 + i * 0.005, 200))
        self._write(rows)

        res = results.diagnose(self.path, {})
        self.assertEqual(res["files"], 2)
        for p in res["perFile"]:
            self.assertAlmostEqual(p["f0Ratio"], 1.0, places=6)
            self.assertTrue(p["silenceSkipped"])
        # 文件级不该再点名；全局检出率也该是 100%
        titles = [d["title"] for d in res["diagnostics"]]
        self.assertNotIn("有 2 个文件基频检出异常", titles)
        self.assertAlmostEqual(res["stats"]["f0"]["ratio"], 1.0, places=6)

    def test_real_outlier_still_reported(self):
        """目标段本身几乎测不出基频的文件，必须继续点名。"""
        rows = []
        for i in range(10):
            rows.append(_row("good.wav", "sil", i, i * 0.005, "--undefined--"))
        for i in range(90):
            rows.append(_row("good.wav", "good", 100 + i, 0.1 + i * 0.005, 180))
        for i in range(10):
            rows.append(_row("bad.wav", "sil", i, i * 0.005, "--undefined--"))
        for i in range(90):
            # 90 帧里只有 3 帧有基频 → 3.3%
            rows.append(_row("bad.wav", "bad", 100 + i, 0.1 + i * 0.005,
                             180 if i < 3 else "--undefined--"))
        self._write(rows)

        res = results.diagnose(self.path, {})
        detail = " ".join(d["detail"] for d in res["diagnostics"])
        self.assertIn("有 1 个文件基频检出异常", [d["title"] for d in res["diagnostics"]])
        self.assertIn("bad.wav", detail)
        self.assertNotIn("good.wav", detail)

    def test_without_label_column_keeps_old_behaviour(self):
        """没有 label 列的整段测量结果表：分母仍是全部帧。"""
        rows = []
        for i in range(100):
            rows.append(_row("c.wav", "", i, i * 0.005, 180 if i < 20 else "--undefined--"))
        self._write(rows)
        res = results.diagnose(self.path, {})
        self.assertAlmostEqual(res["perFile"][0]["f0Ratio"], 0.2, places=6)
        self.assertFalse(res["perFile"][0]["silenceSkipped"])

    def test_pure_silence_file_is_not_hidden(self):
        """整批只有一个 sil 段的文件（纯静音录音）仍要参与统计，不能被过滤成 0 帧。"""
        rows = [_row("silent.wav", "sil", i, i * 0.005, "--undefined--") for i in range(40)]
        self._write(rows)
        res = results.diagnose(self.path, {})
        self.assertEqual(res["files"], 1)
        self.assertEqual(res["perFile"][0]["frames"], 40)
        self.assertFalse(res["perFile"][0]["silenceSkipped"])
        self.assertEqual(res["stats"]["f0"]["ratio"], 0)


if __name__ == "__main__":
    unittest.main()
