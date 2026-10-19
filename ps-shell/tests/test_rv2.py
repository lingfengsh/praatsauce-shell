# -*- coding: utf-8 -*-
"""PS-RV2 第四步「查看测量结果」（内嵌结果网格）—— 单元测试。

覆盖 series_export.grid_page() 的五件事：
1. F0 来自 wav 旁的 .Pitch、F1–F5/B1–B5 来自 .Formant（与导出/批量同一位置）；
2. 汇总表类参数（HNR/CPP/谐波差…）来自第三步的 out.tsv，按主名宽松匹配；
3. 缺哪一类不报错——给空序列 + warnings，另一类照常出；
4. 分页与九宫格同序，每文件带全局序号 index（前端用它 size=1 开详情窗）；
5. 纯读文件：**不调 Praat**（本文件所有夹具都是手写/用项目自己的 writer 生成）。

不读写真实用户目录：全部在 tempfile 里。

运行：
    cd ps-shell
    python -m unittest tests.test_rv2 -v
"""

import os
import sys
import wave
import shutil
import struct
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend import series_export, praat_objects  # noqa: E402

def _mp(d, name):
    """measure/ 子目录里的夹具路径（2026-09-27 方案 A 布局：对象文件归子目录）。"""
    md = os.path.join(d, "measure")
    os.makedirs(md, exist_ok=True)
    return os.path.join(md, name)




def _write_wav(path, seconds=0.1, rate=16000):
    """写一段静音 wav（只要能被 wave 模块读出时长即可，内容不影响曲线）。"""
    n = int(seconds * rate)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(struct.pack("<%dh" % n, *([0] * n)))


# Praat「Pitch 1」文本对象的最简可解析形态（字段与 praat_objects.read_pitch_text
# 的读取顺序一一对应：xmin/xmax/nx/dx/x1 → frames[n] → intensity/nCandidates →
# candidates[1].frequency）。frequency=0 的帧 = 清音，读回必须是 None（断线用）。
_PITCH_TPL = """File type = "ooTextFile"
Object class = "Pitch 1"

xmin = 0
xmax = {xmax}
nx = {n}
dx = 0.005
x1 = 0.005
{frames}
"""


def _write_pitch(path, freqs):
    frames = []
    for i, f in enumerate(freqs, start=1):
        frames.append(
            "frames [%d]:\n    intensity = 0\n    nCandidates = 1\n"
            "    candidates [1]:\n        frequency = %g\n        strength = 0.9" % (i, f))
    txt = _PITCH_TPL.format(xmax=0.005 * len(freqs), n=len(freqs), frames="\n".join(frames))
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(txt)


def _write_formant(path, pts):
    """用项目自己的 writer 落 .Formant（与 read_formant_text 同一格式）。"""
    praat_objects.write_formant_text(path, pts)


class GridPageTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ps_rv2_")
        self.addCleanup(shutil.rmtree, self.dir, True)
        # 三个 wav（a/b/c），文件名排序 → 分页顺序确定
        for nm in ("a", "b", "c"):
            _write_wav(os.path.join(self.dir, nm + ".wav"))
        _write_pitch(_mp(self.dir, "a.Pitch"), [120, 0, 130])
        _write_pitch(_mp(self.dir, "b.Pitch"), [200, 210, 0])
        # c 故意不给 .Pitch / .Formant：测"缺对象文件"的分支
        _write_formant(_mp(self.dir, "a.Formant"), [
            {"t": 0.005, "F1": 500, "F2": 1500, "F3": 2500, "B1": 60, "B2": 90, "B3": 120},
            {"t": 0.010, "F1": 520, "F2": 1520, "F3": 2520, "B1": 62, "B2": 92, "B3": 122},
            {"t": 0.015, "F1": 510, "F2": 1510, "F3": 2510, "B1": 61, "B2": 91, "B3": 121},
        ])
        self.values = {"inputDir": self.dir, "outputDir": self.dir, "outputFile": ""}

    # ---------------------------------------------------------------- 对象文件
    def test_f0_from_pitch_object(self):
        r = series_export.grid_page(self.dir, 0, 16, ["F0"], values=self.values)
        self.assertTrue(r["ok"], r)
        a = r["files"][0]
        self.assertEqual(a["name"], "a.wav")
        self.assertEqual(a["index"], 0)
        # 中间那帧 frequency=0 → None（前端据此断线，不把静音缝连成直线）
        self.assertEqual(a["series"]["F0"], [[0.005, 120.0], [0.010, None], [0.015, 130.0]])

    def test_formant_from_formant_object(self):
        r = series_export.grid_page(self.dir, 0, 16, ["F1", "B2"], values=self.values)
        self.assertTrue(r["ok"], r)
        s = r["files"][0]["series"]
        self.assertEqual(s["F1"][0], [0.005, 500.0])
        self.assertEqual(s["B2"][0], [0.005, 90.0])
        # c 没有 .Formant → 空序列，且不牵连其它文件
        self.assertEqual(r["files"][2]["series"]["F1"], [])

    def test_missing_object_is_empty_not_error(self):
        r = series_export.grid_page(self.dir, 0, 16, ["F0"], values=self.values)
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["files"][2]["series"]["F0"], [])
        self.assertEqual(r["skipped"], 1)     # c 这一页里只有它一个参数都没数据
        self.assertFalse(r["warnings"])       # 缺对象文件不算异常（对象本来就可能没落盘）

    # ---------------------------------------------------------------- 汇总表
    def _write_tsv(self):
        p = os.path.join(self.dir, "out.tsv")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write("file\tt\tf0\tHNR05\tintensity\n")
            for i in range(3):
                fh.write("a.wav\t%g\t%g\t%g\t%g\n" % (0.005 * (i + 1), 120 + i, 20 + i, 70 + i))
                fh.write("b.wav\t%g\t%g\t%g\t%g\n" % (0.005 * (i + 1), 200 + i, 30 + i, 65 + i))
        return p

    def test_tsv_columns(self):
        self._write_tsv()
        r = series_export.grid_page(self.dir, 0, 16, ["HNR05"], values=self.values)
        self.assertTrue(r["ok"], r)
        self.assertTrue(r["tsvPath"].endswith("out.tsv"), r["tsvPath"])
        self.assertEqual(r["files"][0]["series"]["HNR05"][0], [0.005, 20.0])
        self.assertEqual(r["files"][1]["series"]["HNR05"][2], [0.015, 32.0])

    def test_missing_tsv_warns_and_still_serves_objects(self):
        """没跑过批量 / 输出目录不对：tsv 列为空 + 明确告警，对象列照常出图。"""
        r = series_export.grid_page(self.dir, 0, 16, ["F0", "HNR05"], values=self.values)
        self.assertTrue(r["ok"], r)
        self.assertTrue(len(r["warnings"]) == 1, r["warnings"])
        self.assertIn("out.tsv", r["warnings"][0])
        self.assertEqual(r["files"][0]["series"]["HNR05"], [])
        self.assertEqual(len(r["files"][0]["series"]["F0"]), 3)

    # ---------------------------------------------------------------- 分页 / 序号
    def test_paging_and_global_index(self):
        r = series_export.grid_page(self.dir, 0, 2, ["F0"], values=self.values)
        self.assertTrue(r["ok"], r)
        self.assertEqual((r["total"], r["pages"]), (3, 2))
        self.assertEqual([f["index"] for f in r["files"]], [0, 1])
        r2 = series_export.grid_page(self.dir, 1, 2, ["F0"], values=self.values)
        self.assertEqual([f["index"] for f in r2["files"]], [2])
        self.assertEqual([f["name"] for f in r2["files"]], ["c.wav"])
        # 越界页号夹到最后一页，不返回空
        r3 = series_export.grid_page(self.dir, 9, 2, ["F0"], values=self.values)
        self.assertEqual(r3["page"], 1)

    def test_duration_and_intervals_present(self):
        """前端画格子要用 duration 当时间窗、intervals 叠音节底色。"""
        r = series_export.grid_page(self.dir, 0, 16, ["F0"], values=self.values)
        self.assertAlmostEqual(r["files"][0]["duration"], 0.1, places=2)
        self.assertIn("intervals", r["files"][0])
        self.assertEqual(r["files"][0]["tgPath"], "")   # 没有 TextGrid 时不是错误

    # ---------------------------------------------------------------- 入参容错
    def test_unknown_param_dropped(self):
        r = series_export.grid_page(self.dir, 0, 16, ["NOPE", "F0", "F0"], values=self.values)
        self.assertEqual(r["params"], ["F0"])           # 未知列丢弃 + 去重保序

    def test_no_params_is_empty_page(self):
        r = series_export.grid_page(self.dir, 0, 16, [], values=self.values)
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["params"], [])
        self.assertEqual(r["files"][0]["series"], {})

    def test_bad_dir(self):
        r = series_export.grid_page("", 0, 16, ["F0"])
        self.assertFalse(r["ok"])
        self.assertIn("目录不存在", r["error"])


if __name__ == "__main__":
    unittest.main()
