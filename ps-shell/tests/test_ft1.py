# -*- coding: utf-8 -*-
"""PS-FT1 容错引擎第一批 —— 单元测试（纯标准库，不依赖 Praat、不改真实目录）。

运行：
    cd ps-shell
    python -m unittest tests.test_ft1 -v
"""

import os
import tempfile
import unittest

from backend import params_validate, params_io, safety, errors_i18n
from backend import params_schema as schema


def _msg_set(items):
    return {(i.get("field"), i.get("msg")) for i in items}


class ValidateParamsTest(unittest.TestCase):
    def test_f0min_gt_f0max_error(self):
        r = params_validate.validate_params({"f0min": 350, "f0max": 200})
        self.assertTrue(any(i["field"] == "f0min" and "还大" in i["msg"] for i in r["errors"]))

    def test_f0min_ge_f0max_error(self):
        r = params_validate.validate_params({"f0min": 300, "f0max": 300})
        self.assertTrue(any(i["field"] == "f0min" for i in r["errors"]))

    def test_f0_non_positive_error(self):
        r = params_validate.validate_params({"f0min": 0, "f0max": 300})
        self.assertTrue(any(i["field"] == "f0min" and "大于 0" in i["msg"] for i in r["errors"]))

    def test_interval_both_positive_error(self):
        r = params_validate.validate_params({"intervalEquidistant": 5, "intervalFixed": 0.01})
        self.assertTrue(any(i["field"] == "intervalFixed" for i in r["errors"]))

    def test_interval_both_zero_error(self):
        r = params_validate.validate_params({"intervalEquidistant": 0, "intervalFixed": 0})
        self.assertTrue(any(i["field"] == "intervalFixed" for i in r["errors"]))

    def test_interval_mode_fixed_ignores_equidistant(self):
        # mode=0（固定步长）：等分点数残留非 0 不再报错（运行时被归零）
        r = params_validate.validate_params(
            {"intervalMode": 0, "intervalFixed": 0.01, "intervalEquidistant": 5})
        self.assertEqual([e for e in r["errors"] if "interval" in e["field"]], [])

    def test_interval_mode_equidistant_requires_n(self):
        # mode=1（等分点数）：点数为 0 报错，且不要求 intervalFixed
        r = params_validate.validate_params(
            {"intervalMode": 1, "intervalFixed": 0, "intervalEquidistant": 0})
        self.assertTrue(any(i["field"] == "intervalEquidistant" for i in r["errors"]))

    def test_interval_mode_equidistant_ok_with_stale_fixed(self):
        # mode=1：固定步长残留非 0 不报错
        r = params_validate.validate_params(
            {"intervalMode": 1, "intervalFixed": 0.01, "intervalEquidistant": 10})
        self.assertEqual([e for e in r["errors"] if "interval" in e["field"]], [])

    def test_maxnum_formants_2_error(self):
        r = params_validate.validate_params({"maxNumFormants": 2})
        self.assertTrue(any(i["field"] == "maxNumFormants" for i in r["errors"]))

    def test_illegal_regex_error(self):
        r = params_validate.validate_params({"includeTheseLabels": "("})
        self.assertTrue(any(i["field"] == "includeTheseLabels" for i in r["errors"]))

    def test_defaults_all_green(self):
        r = params_validate.validate_params(schema.default_values())
        self.assertEqual(r["errors"], [])
        self.assertEqual(r["warnings"], [])

    def test_f0min_low_warning(self):
        # 卡中测试示例 "f0min=30 -> warning" 与规则表 "f0min<20 才 warning" 不一致；
        # 按规则表实现，这里用 15（<20）触发 warning 以对齐规则表。
        r = params_validate.validate_params({"f0min": 15, "f0max": 300})
        self.assertTrue(any(i["field"] == "f0min" and "说话范围" in i["msg"] for i in r["warnings"]))

    def test_f0max_high_warning(self):
        r = params_validate.validate_params({"f0min": 100, "f0max": 2500})
        self.assertTrue(any(i["field"] == "f0max" and "说话范围" in i["msg"] for i in r["warnings"]))

    def test_f0_ratio_warning(self):
        r = params_validate.validate_params({"f0min": 20, "f0max": 300})
        self.assertTrue(any(i["field"] == "f0max" and "过宽" in i["msg"] for i in r["warnings"]))

    def test_choice_out_of_range_fixed(self):
        r = params_validate.validate_params({"pitchMethod": 9})
        errs = [i for i in r["errors"] if i["field"] == "pitchMethod"]
        self.assertTrue(errs)
        self.assertEqual(r["fixed"].get("pitchMethod"), schema.BY_NAME["pitchMethod"]["default"])

    def test_window_length_error_and_warn(self):
        self.assertTrue(any(i["field"] == "windowLength"
                            for i in params_validate.validate_params({"windowLength": 0.5})["errors"]))
        self.assertTrue(any(i["field"] == "windowLength"
                            for i in params_validate.validate_params({"windowLength": 0.1})["warnings"]))


class CsvIoTest(unittest.TestCase):
    def test_semicolon_delimited(self):
        text = "variable;input;comment\na;1;x\nb;2;y"
        self.assertEqual(params_io.parse_csv_text(text), {"a": "1", "b": "2"})
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "params.csv")
            with open(p, "w", encoding="utf-8") as f:
                f.write(text)
            values, notes = params_io.parse_csv_file_ex(p)
            self.assertEqual(values, {"a": "1", "b": "2"})
            self.assertTrue(any("分号" in n for n in notes))

    def test_gbk_bytes(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "params.csv")
            with open(p, "wb") as f:
                f.write("variable,input,comment\nf0min,50,共振峰上限\n".encode("gbk"))
            values, notes = params_io.parse_csv_file_ex(p)
            self.assertEqual(values.get("f0min"), "50")
            self.assertTrue(any("GBK" in n for n in notes))

    def test_utf16_bom(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "params.csv")
            with open(p, "wb") as f:
                f.write("variable,input,comment\nf0min,50,x\n".encode("utf-16"))
            values, notes = params_io.parse_csv_file_ex(p)
            self.assertEqual(values.get("f0min"), "50")
            self.assertTrue(any("UTF-16" in n for n in notes))

    def test_two_columns(self):
        text = "variable,input\na,1\nb,2"
        self.assertEqual(params_io.parse_csv_text(text), {"a": "1", "b": "2"})
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "params.csv")
            with open(p, "w", encoding="utf-8") as f:
                f.write(text)
            values, _ = params_io.parse_csv_file_ex(p)
            self.assertEqual(values, {"a": "1", "b": "2"})


class DiffSchemaTest(unittest.TestCase):
    def test_extra_unknown_key(self):
        vals = dict(schema.default_values())
        vals["bogusKey"] = "1"
        unknown, missing = params_io.diff_against_schema(vals)
        self.assertEqual(unknown, ["bogusKey"])
        self.assertEqual(missing, [])

    def test_missing_key(self):
        vals = dict(schema.default_values())
        del vals["f0min"]
        unknown, missing = params_io.diff_against_schema(vals)
        self.assertEqual(unknown, [])
        self.assertIn("f0min", missing)


class ArchiveTest(unittest.TestCase):
    def test_archive_copies_and_keeps_original(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "out.tsv")
            with open(p, "w", encoding="utf-8") as f:
                f.write("file\tf0\na\t120\n")
            archived = safety.archive_previous_result(p)
            self.assertIsNotNone(archived)
            self.assertTrue(os.path.exists(archived))
            # 原文件仍在，内容不变
            with open(p, "r", encoding="utf-8") as f:
                self.assertEqual(f.read(), "file\tf0\na\t120\n")

    def test_archive_missing_returns_none(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(safety.archive_previous_result(os.path.join(d, "nope.tsv")))

    def test_archive_trim_keeps_newest(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "out.tsv")
            with open(p, "w", encoding="utf-8") as f:
                f.write("x\n")
            hist = os.path.join(d, "历史结果")
            os.makedirs(hist)
            # 预置 12 份同名归档（时间戳递增）
            for i in range(12):
                with open(os.path.join(hist, f"out.20260101-{i:06d}.tsv"), "w", encoding="utf-8") as f:
                    f.write("old\n")
            archived = safety.archive_previous_result(p)
            self.assertIsNotNone(archived)
            remaining = sorted(n for n in os.listdir(hist) if n.startswith("out."))
            self.assertEqual(len(remaining), 10)
            # 最旧的 3 份应被删
            for i in (0, 1, 2):
                self.assertNotIn(f"out.20260101-{i:06d}.tsv", remaining)


class TranslateLogTest(unittest.TestCase):
    def test_translate_hit(self):
        lines = ["Processing a.wav", "There is not a one-to-one correspondence between sounds and grids"]
        out = errors_i18n.translate_log_tail(lines)
        self.assertIsNotNone(out)
        self.assertIn("声音文件与 TextGrid", out)
        self.assertIn("建议", out)

    def test_translate_hit_dict_lines(self):
        lines = [{"tag": "err", "text": "Cannot open file: foo.TextGrid"}]
        out = errors_i18n.translate_log_tail(lines)
        self.assertIsNotNone(out)
        self.assertIn("找不到文件", out)

    def test_translate_miss(self):
        lines = ["All done", "Processing a.wav", "writeInfo: ok"]
        self.assertIsNone(errors_i18n.translate_log_tail(lines))


if __name__ == "__main__":
    unittest.main()
