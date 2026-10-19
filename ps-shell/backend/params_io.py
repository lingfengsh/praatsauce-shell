# -*- coding: utf-8 -*-
"""params.csv 的生成与解析。

生成的 CSV 与 praatsauce 自带的 src/params.csv 结构完全一致
（variable,input,comment 三列），注释沿用官方英文原文，保证兼容。
"""

import os
import csv
import io

from . import params_schema as schema


def template_comments(script_dir):
    """从官方 params.csv 读取注释，作为生成模板。"""
    comments = {}
    path = os.path.join(script_dir or "", "params.csv")
    if not os.path.exists(path):
        return comments
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            reader = csv.reader(f)
            next(reader, None)
            for row in reader:
                if len(row) >= 3:
                    comments[row[0]] = row[2]
    except Exception:
        pass
    return comments


def build_csv(values, script_dir=None):
    """按 schema 顺序生成 params.csv 文本。"""
    comments = template_comments(script_dir)
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n", quoting=csv.QUOTE_MINIMAL)
    w.writerow(["variable", "input", "comment"])
    for p in schema.PARAMS:
        if p.get("shell_only"):
            continue  # 仅外壳层概念（如 intervalMode），不进 praat 的 params.csv
        name = p["name"]
        val = values.get(name, p.get("default"))
        val = _normalize(p, val)
        comment = comments.get(name, p.get("help", ""))
        w.writerow([name, val, comment])
    return buf.getvalue()


def _normalize(p, val):
    """把界面上的值转换成 CSV 里需要的写法。"""
    t = p["type"]
    if t == "bool":
        try:
            n = int(val)
        except (TypeError, ValueError):
            n = 1 if val in (True, "1", "true", "True") else 0
        return 1 if n else 0
    if val is None or val == "":
        if t in ("dir", "file"):
            # 目录类留空时给官方占位值，read_params 对 tgDir 有特殊处理
            if name_is_tgdir(p["name"]):
                return "path/to/tg"
            if t == "file":
                return "0"
            return p.get("default", "")
        return p.get("default", "")
    if t in ("int",):
        try:
            return int(float(val))
        except (TypeError, ValueError):
            return p.get("default", 0)
    if t == "number":
        try:
            f = float(val)
        except (TypeError, ValueError):
            return p.get("default", 0)
        return _trim(f)
    if t == "choice":
        try:
            return int(val)
        except (TypeError, ValueError):
            return p.get("default", 0)
    return str(val)


def name_is_tgdir(name):
    return name == "tgDir"


def _trim(f):
    """去掉浮点尾巴上的 0，避免 0.005000000000000001 这种写法。"""
    s = f"{f:.10f}".rstrip("0").rstrip(".")
    return s if s not in ("", "-0") else "0"


def _read_text_any(path):
    """按 BOM / 编码依次尝试解码文件，返回 (text, note)。

    note 为空字符串表示无需适配；否则是一句给人看的诊断（如"文件为 UTF-16 编码，已自动识别"）。
    任何解码异常都不抛出，最终回退到 utf-8(errors=replace)。
    """
    note = ""
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except Exception:
        return "", note
    # 1) UTF-16 LE/BE（带 BOM）
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        try:
            return raw.decode("utf-16"), "文件为 UTF-16 编码，已自动识别"
        except Exception:
            pass
    # 2) UTF-8 带 BOM
    if raw[:3] == b"\xef\xbb\xbf":
        try:
            return raw.decode("utf-8-sig"), "文件为带 BOM 的 UTF-8 编码，已自动识别"
        except Exception:
            pass
    # 3) 无 BOM：先试 utf-8，失败再试 gbk（Excel 中文环境常见）
    try:
        return raw.decode("utf-8"), note
    except UnicodeDecodeError:
        pass
    try:
        return raw.decode("gbk"), "文件为 GBK 编码，已自动识别"
    except Exception:
        return raw.decode("utf-8", errors="replace"), note


def _parse_values(text):
    """解析 params 文本为 {name: value}，自动识别逗号/分号分隔、容忍仅 2 列的行。

    返回 (values, delimiter)。表头含 variable 但不含逗号而含分号时按分号解析
    （Excel 中文环境导出常见）。每行只要前 2 列有效即采纳。
    """
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    header = lines[0] if lines else ""
    delim = ","
    if "variable" in header and "," not in header and ";" in header:
        delim = ";"
    values = {}
    try:
        reader = csv.reader(lines, delimiter=delim)
        next(reader, None)
        for row in reader:
            if len(row) >= 2 and row[0].strip():
                values[row[0].strip()] = row[1]
    except Exception:
        pass
    return values, delim


def parse_csv_text(text):
    """解析 params.csv 文本为 {name: value}（自动识别分隔符）。"""
    values, _ = _parse_values(text)
    return values


def parse_csv_text_ex(text):
    """与 parse_csv_file_ex 对称：解析文本，返回 (values, notes)。

    text 来自前端文本域（已是 UTF-8 字符串），无需文件编码探测，
    但仍识别分号分隔以产出与文件分支一致的 notes。

    与文件分支的关键差异：用户粘贴的内容往往没有「variable,...」表头，
    而共享的 _parse_values 会无条件跳过首行。因此这里先探测首行：
    只有首格确实是 variable（表头）时才原样解析；否则补一行占位表头，
    避免吃掉用户的第一个参数（FT2 验收发现的回归：粘贴 f0min,60 时 f0min 丢失）。
    """
    notes = []
    if text is None:
        return {}, notes
    t = text or ""
    lines = t.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    first = next((ln for ln in lines if ln.strip()), "")
    if first:
        first_cell = first.replace("\"", "").split(",")[0].split(";")[0].strip()
        if first_cell != "variable":
            # 无表头：按首行分隔符补占位表头，让 _parse_values 的跳行与分号识别都正确
            data_delim = ";" if (";" in first and "," not in first) else ","
            t = "variable" + data_delim + "input" + data_delim + "comment\n" + t
    values, delim = _parse_values(t)
    if delim != ",":
        notes.append("文件为分号分隔，已自动适配")
    return values, notes


def parse_csv_file_ex(path):
    """健壮解析：返回 (values, notes)。

    notes 为字符串列表，逐条记录所做的适配（编码识别、分隔符适配等）。
    """
    notes = []
    if not os.path.exists(path):
        return {}, notes
    text, note = _read_text_any(path)
    if note:
        notes.append(note)
    values, delim = _parse_values(text)
    if delim != ",":
        notes.append("文件为分号分隔，已自动适配")
    return values, notes


def parse_csv_file(path):
    """旧接口：签名不变，内部改走 ex 并丢弃 notes。"""
    if not os.path.exists(path):
        return {}
    values, _ = parse_csv_file_ex(path)
    return values


def diff_against_schema(values):
    """比对解析结果与参数表，返回 (unknown, missing)。

    unknown = 不在 schema.PARAMS 中的键；missing = schema 有而 CSV 无的键。
    """
    unknown = [k for k in values if k not in schema.BY_NAME]
    missing = [p["name"] for p in schema.PARAMS if p["name"] not in values]
    return unknown, missing


def coerce_from_csv(values):
    """把字符串值转成界面控件需要的类型。"""
    out = {}
    for p in schema.PARAMS:
        name = p["name"]
        raw = values.get(name, p.get("default"))
        t = p["type"]
        if t == "bool":
            try:
                out[name] = 1 if int(raw) else 0
            except (TypeError, ValueError):
                out[name] = 1 if str(raw).strip() in ("1", "true", "True") else 0
        elif t in ("int", "choice"):
            try:
                out[name] = int(float(raw))
            except (TypeError, ValueError):
                out[name] = p.get("default", 0)
        elif t == "number":
            try:
                out[name] = float(raw)
            except (TypeError, ValueError):
                out[name] = p.get("default", 0)
        else:
            out[name] = "" if raw in (None, "0") else str(raw)
    return out
