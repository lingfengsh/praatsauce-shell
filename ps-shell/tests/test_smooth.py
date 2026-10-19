# -*- coding: utf-8 -*-
"""平滑落盘链路单元测试（纯标准库，不依赖 Praat、不改真实目录）。

运行：
    cd ps-shell
    python -m unittest tests.test_smooth -v

覆盖：
- praat_objects.write_formant_text ↔ read_formant_text 往返（含带宽、帧网格公式一致）
- review_choice.save_choice 的 formantSmoothed 合并语义（F0 页不抹掉共振峰维标记）
- review_export.write_smoothed_formant 在无 Praat 时优雅报错（不崩）
"""
import os
import tempfile
import unittest

from backend import praat_objects, review_choice


class FormantWriteReadTest(unittest.TestCase):
    def _sample(self, n=20):
        pts = []
        for i in range(n):
            t = round(0.026 + i * 0.005, 6)
            pts.append({"t": t, "F1": 500 + i, "F2": 1500 + i,
                        "F3": 2500 + i, "B1": 80.0, "B2": 120.0, "B3": 200.0})
        return pts

    def test_write_then_read_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "x.Formant")
            pts = self._sample()
            self.assertTrue(praat_objects.write_formant_text(p, pts))
            self.assertTrue(os.path.isfile(p))
            back = praat_objects.read_formant_text(p)
            self.assertEqual(len(back), len(pts))
            # 频率往返一致
            self.assertAlmostEqual(back[0]["F1"], pts[0]["F1"], places=2)
            self.assertAlmostEqual(back[-1]["F3"], pts[-1]["F3"], places=2)
            # 带宽被读回
            self.assertAlmostEqual(back[0]["B1"], 80.0, places=2)
            self.assertAlmostEqual(back[5]["B2"], 120.0, places=2)

    def test_frame_grid_matches_formula(self):
        # 读回的 t 必须满足 t = x1 + (fi-1)*dx，否则导出对象会错位
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "y.Formant")
            pts = self._sample(15)
            praat_objects.write_formant_text(p, pts)
            back = praat_objects.read_formant_text(p)
            dx = back[1]["t"] - back[0]["t"]
            for fi, r in enumerate(back, start=1):
                self.assertAlmostEqual(r["t"], back[0]["t"] + (fi - 1) * dx, places=6)

    def test_empty_points_returns_false(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "z.Formant")
            self.assertFalse(praat_objects.write_formant_text(p, []))
            self.assertFalse(os.path.isfile(p))

    def test_read_bandwidth_absent_yields_default(self):
        # 没带带宽时，write 给 50Hz 默认；读回 B 应为 50
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "w.Formant")
            pts = [{"t": 0.026 + i * 0.005, "F1": 400 + i, "F2": 1400 + i, "F3": 2400 + i}
                   for i in range(10)]
            praat_objects.write_formant_text(p, pts)
            back = praat_objects.read_formant_text(p)
            self.assertAlmostEqual(back[0]["B1"], 50.0, places=2)


class SaveChoiceSmoothedTest(unittest.TestCase):
    def _wav(self, d):
        p = os.path.join(d, "a.wav")
        with open(p, "wb") as f:
            f.write(b"RIFF....WAVE")
        return p

    def test_smoothed_stored_and_preserved_on_f0_save(self):
        with tempfile.TemporaryDirectory() as d:
            wav = self._wav(d)
            # 共振峰页存盘：带 formantSmoothed=true
            r1 = review_choice.save_choice(wav, {
                "formant": {"id": "5500", "label": "共振峰上限5500Hz"},
                "formantSmoothed": True,
            })
            self.assertTrue(r1["ok"])
            self.assertTrue(r1["choice"]["formantSmoothed"])
            # F0 页存盘：只带 pitch/manual，不应抹掉 formantSmoothed
            r2 = review_choice.save_choice(wav, {
                "pitch": {"id": "500", "label": "F0上限500Hz"},
                "manual": [{"t": 0.1, "f0": 210.0}],
            })
            self.assertTrue(r2["ok"])
            self.assertTrue(r2["choice"]["formantSmoothed"],
                            "F0 页存盘不能抹掉共振峰维的平滑标记")
            self.assertEqual(r2["choice"]["formant"]["id"], "5500")

    def test_smoothed_off_clears_flag(self):
        with tempfile.TemporaryDirectory() as d:
            wav = self._wav(d)
            review_choice.save_choice(wav, {
                "formant": {"id": "5500", "label": "x"}, "formantSmoothed": True})
            # 共振峰页存盘时取消平滑
            r = review_choice.save_choice(wav, {
                "formant": {"id": "5500", "label": "x"}, "formantSmoothed": False})
            self.assertFalse(r["choice"]["formantSmoothed"])


class WriteSmoothedNoPraatTest(unittest.TestCase):
    def test_no_exe_returns_error(self):
        # 无 Praat 时不应抛异常，而是返回 (ok=False, error)
        from backend import review_export
        with tempfile.TemporaryDirectory() as d:
            wav = os.path.join(d, "a.wav")
            with open(wav, "wb") as f:
                f.write(b"RIFF....WAVE")
            ok, err = review_export.write_smoothed_formant(
                wav, {}, exe="__no_such_praat__.exe")
            self.assertFalse(ok)
            self.assertIsNotNone(err)


if __name__ == "__main__":
    unittest.main()
