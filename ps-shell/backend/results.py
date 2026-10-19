# -*- coding: utf-8 -*-
"""读取 praatSauce 输出的结果表，并把它翻译成人能看懂的诊断。

praatSauce 用 0 或 --undefined-- 表示"这一帧没测出来"，
所以"检出率"是判断参数范围对不对的第一指标。
"""

import os
import math
import statistics

UNDEFINED = {"", "--undefined--", "undefined", "nan", "NaN", "NA", "--"}

# 静音 / 非语音标注段的标签名（比较时统一小写）。
# 单字录音的 TextGrid 常把整个文件切成「目标字 + sil」两段：sil 段时长往往比字还长，
# 而它本来就不该有基频。若把它计入检出率的分母，正常录音会被误判成「基频检出异常」
# （2026-10-18 用户实测：15 个文件全被点名，实际目标段检出率 87–98%）。
SILENCE_LABELS = {
    "", "sil", "silence", "sp", "pau", "pause", "#", "0",
    "<eps>", "eps", "blank", "noise", "呼吸", "静音",
}


def _is_silence_label(label):
    return (label or "").strip().lower() in SILENCE_LABELS


def _read_text(path):
    """Praat 在 Windows 上写文件默认用 UTF-16（带 BOM），
    这里统一按 BOM 判断，避免中文文件名和数值读成乱码。"""
    with open(path, "rb") as f:
        raw = f.read()
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16", errors="replace")
    if raw[:3] == b"\xef\xbb\xbf":
        return raw.decode("utf-8-sig", errors="replace")
    # 没有 BOM 但有明显的 00 交错，也当作 UTF-16LE
    if b"\x00" in raw[:400]:
        try:
            return raw.decode("utf-16-le", errors="replace")
        except Exception:
            pass
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("gbk", errors="replace")


def _to_float(v):
    if v is None:
        return None
    v = str(v).strip()
    if v in UNDEFINED:
        return None
    try:
        f = float(v)
    except ValueError:
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def read_table(path, max_rows=None, offset=0):
    """读取 tsv 结果表。返回 {ok, columns, rows, total, raw_columns}"""
    out = {"ok": False, "path": path, "columns": [], "rows": [], "total": 0, "error": ""}
    if not path or not os.path.exists(path):
        out["error"] = "结果文件不存在"
        return out
    try:
        text = _read_text(path)
        lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    except Exception as e:
        out["error"] = f"读取失败：{e}"
        return out
    if not lines or not lines[0].strip():
        out["error"] = "结果文件是空的"
        return out

    header = [c.strip().lstrip("﻿") for c in lines[0].split("\t") if c.strip()]
    if not header:
        out["error"] = "结果文件是空的"
        return out
    out["columns"] = header
    body = [l for l in lines[1:] if l.strip()]
    out["total"] = len(body)
    if max_rows:
        body = body[offset: offset + max_rows]
    for ln in body:
        parts = ln.split("\t")
        if len(parts) < len(header):
            parts = parts + [""] * (len(header) - len(parts))
        parts = parts[:len(header)]
        # praatSauce 拼字符串时会在文件名前面留下空格，分组前先清掉
        if parts and header[0] in ("file", "label"):
            parts[0] = parts[0].strip()
        out["rows"].append(parts)
    out["ok"] = True
    return out


def column_stats(path, columns=None, sample=20000, skip_silence=True):
    """逐列统计：有效值比例、均值、中位数、范围。

    skip_silence=True 时，若结果表带 label 列，则跳过 sil / # 之类的静音标注段——
    这些段没有基频（也没有谐波结构），算进分母会让正常录音的检出率凭空减半。
    """
    stats = {}
    if not os.path.exists(path):
        return stats
    all_lines = _read_text(path).replace("\r\n", "\n").split("\n")
    if not all_lines:
        return stats
    header = [c.strip().lstrip("\ufeff") for c in all_lines[0].split("\t")]
    idx = {c: i for i, c in enumerate(header)}
    li = idx.get("label", -1) if skip_silence else -1
    targets = columns or header
    acc = {c: {"n": 0, "valid": 0, "sum": 0.0, "vals": [], "min": None, "max": None}
           for c in targets if c in idx}
    count = 0
    for ln in all_lines[1:]:
        if count >= sample:
            break
        count += 1
        parts = ln.rstrip("\n").split("\t")
        if not parts or not parts[0].strip():
            continue
        if li >= 0 and li < len(parts) and _is_silence_label(parts[li]):
            continue
        for c, a in acc.items():
            i = idx[c]
            if i >= len(parts):
                continue
            a["n"] += 1
            v = _to_float(parts[i])
            # 2026-10-18 起 praatSauce 用 --undefined-- 表示「这一帧没测到」，新表里
            # 0 已是合法测量值（如 H1-A1 = 0）。这里仍跳过 0，是为了兼容旧的汇总表：
            # 旧版 zeroPadding 把对齐缺帧补成 0，若按有效值统计，H1u 这类列会从
            # 26% 检出率虚报成 100%、均值被拉低几十 dB。真 0 极罕见（H1A1u 千分之一），
            # 当缺失处理对诊断无实质影响；导出与统计另走 _to_float，不受此影响。
            if v is None or v == 0:
                continue
            a["valid"] += 1
            a["sum"] += v
            a["vals"].append(v)
            a["min"] = v if a["min"] is None else min(a["min"], v)
            a["max"] = v if a["max"] is None else max(a["max"], v)

    for c, a in acc.items():
        vals = sorted(a["vals"])
        n = len(vals)
        stats[c] = {
            "count": a["n"],
            "valid": a["valid"],
            "ratio": (a["valid"] / a["n"]) if a["n"] else 0,
            "mean": (a["sum"] / n) if n else None,
            "median": vals[n // 2] if n else None,
            "min": a["min"],
            "max": a["max"],
        }
    return stats


def _fmt(v, digits=1):
    return "—" if v is None else f"{v:.{digits}f}"


def diagnose(path, values=None, per_file_limit=8):
    """根据结果表给出诊断与建议。返回 {stats, diagnostics, perFile, files}"""
    values = values or {}
    res = {"ok": False, "stats": {}, "diagnostics": [], "perFile": [], "files": 0, "error": ""}
    read = read_table(path)
    if not read["ok"]:
        res["error"] = read["error"]
        return res
    res["ok"] = True

    header = read["columns"]
    numeric_cols = [c for c in header if c not in ("file", "label")]
    stats = column_stats(path, numeric_cols)
    res["stats"] = stats

    diags = []

    def add(level, title, detail, suggestion=""):
        diags.append({"level": level, "title": title, "detail": detail, "suggestion": suggestion})

    # ---- 基频诊断 ----
    if "f0" in stats:
        s = stats["f0"]
        r = s["ratio"]
        f0min = _to_float(values.get("f0min")) or 50
        f0max = _to_float(values.get("f0max")) or 400
        if r < 0.25:
            add("error", "基频几乎没测出来",
                f"有效语音段里只有 {r*100:.0f}% 的帧测到基频（{s['valid']}/{s['count']}，"
                "已排除 sil 之类的静音标注段）。",
                "先检查基频上下限是否覆盖你的发音人：男声建议 50–250 Hz，女声 100–400 Hz；"
                "若仍不行，检查录音是否有严重噪声或削波。")
        elif r < 0.6:
            add("warn", "基频检出率偏低",
                f"有效语音段里有 {r*100:.0f}% 的帧测到基频（静音标注段已排除）。"
                "清音、气声、以及字与字之间的停顿本来就没有基频；"
                "但如果浊音段也大量缺失，说明范围需要调整。",
                "观察曲线：若整段偏低被截断，调低下限；若曲线贴着上限跑，调高上限。")
        else:
            add("ok", "基频提取正常",
                f"有效语音段里有 {r*100:.0f}% 的帧测到基频，中位数 {_fmt(s['median'], 1)} Hz。")

        if s["median"]:
            if s["median"] >= f0max * 0.92:
                add("warn", "基频可能撞到上限",
                    f"基频中位数 {_fmt(s['median'])} Hz 已经接近上限 {_fmt(f0max, 0)} Hz。",
                    f"把「基频上限」提高到 {int(s['median'] * 1.4)} Hz 左右再试。")
            if s["median"] <= f0min * 1.08:
                add("warn", "基频可能撞到下限",
                    f"基频中位数 {_fmt(s['median'])} Hz 贴近下限 {_fmt(f0min, 0)} Hz。",
                    f"把「基频下限」降到 {max(20, int(s['median'] * 0.6))} Hz 左右再试。")

    # ---- 共振峰诊断 ----
    for col in ("F1", "F2", "F3"):
        if col in stats:
            s = stats[col]
            if s["ratio"] < 0.3:
                add("warn", f"{col} 检出率低",
                    f"{col} 只有 {s['ratio']*100:.0f}% 的帧有值。",
                    "试调「共振峰频率上限」（男声 5000 / 女声 5500 Hz）或把「共振峰个数」调到 5–6。")

    # ---- 嗓音参数 ----
    if "CPP" in stats and stats["CPP"]["mean"] is not None:
        m = stats["CPP"]["mean"]
        if 0 < m < 8:
            add("warn", "CPP 整体偏低",
                f"CPP 平均 {m:.1f} dB，说明谐波结构很弱。",
                "可能是气嗓音（这本身可能是你要的结果），也可能是录音噪声或距离过远。")
    if "HNR05" in stats and stats["HNR05"]["mean"] is not None:
        m = stats["HNR05"]["mean"]
        if 0 < m < 5:
            add("warn", "低频谐噪比偏低",
                f"HNR05 平均 {m:.1f} dB。",
                "检查录音底噪；必要时在 Praat 里先做降噪。")

    # ---- 全零列 ----
    zero_cols = [c for c, s in stats.items() if s["valid"] == 0 and s["count"] > 0]
    if zero_cols:
        add("warn", "有些列全是空值",
            "以下列没有任何有效数据：" + "、".join(zero_cols[:12]) + "。",
            "如果这些参数你并不需要，可以在「要测什么」里取消勾选，结果表会更清爽。")

    # ---- 每个文件的情况（VS 最缺的功能）----
    # 判据（2026-10-18 修正）：既要有绝对下限（<35%），又要明显低于本批其他文件
    # （< 批内中位数 × 0.6）。单字录音的配音比例本来就有高有低，只看绝对值会把
    # "前后静音多但浊音段测得很干净"的正常文件全点名。
    per_file = _per_file(path)
    res["perFile"] = per_file[:per_file_limit]
    res["files"] = len(per_file)
    ratios = [p["f0Ratio"] for p in per_file if p["f0Ratio"] is not None]
    med = statistics.median(ratios) if ratios else None
    bad = [p for p in per_file if p["f0Ratio"] is not None and p["f0Ratio"] < 0.35
           and (med is None or p["f0Ratio"] < med * 0.6)]
    if bad:
        names = "、".join(p["file"] for p in bad[:5])
        add("warn", f"有 {len(bad)} 个文件基频检出异常",
            f"检出率最低的是：{names}{' 等' if len(bad) > 5 else ''}。",
            "这些样本建议单独在 Praat 里检查，或用不同的基频范围重跑（逐个微调）。")
    elif med is not None and med < 0.6 and "f0" in stats:
        add("warn", "整批基频检出率偏低",
            f"本批 {len(ratios)} 个文件的检出率中位数是 {med*100:.0f}%，没有特别离群的文件。",
            "如果录音里有较多停顿/清音，这个比例是正常的；若浊音段也大量缺失，"
            "先检查基频上下限是否覆盖发音人，再考虑降噪。")


    res["diagnostics"] = diags
    return res


def _per_file(path, sample=60000):
    """按文件统计帧数、时长跨度、基频检出率。

    检出率的**分母只算有效语音段**：结果表带 label 列时，sil / # / sp 这类静音段
    整体剔除（2026-10-18 修正）。单字录音的 TextGrid 常把整段切成「字 + sil」，
    静音段本来就没有基频，算进分母会让 90% 检出的正常文件显示成 30%。
    """
    out = []
    if not os.path.exists(path):
        return out
    agg = {}
    lines = _read_text(path).replace("\r\n", "\n").split("\n")
    if not lines:
        return out
    header = [c.strip().lstrip("\ufeff") for c in lines[0].split("\t")]
    try:
        fi = header.index("file")
    except ValueError:
        return out
    has_f0 = "f0" in header
    f0i = header.index("f0") if has_f0 else -1
    has_t = "t" in header
    ti = header.index("t") if has_t else -1
    li = header.index("label") if "label" in header else -1
    count = 0
    for ln in lines[1:]:
        if count >= sample:
            break
        count += 1
        parts = ln.rstrip("\n").split("\t")
        if fi >= len(parts):
            continue
        name = parts[fi].strip()
        if not name:
            continue
        key = (name, parts[li].strip() if 0 <= li < len(parts) else "")
        a = agg.setdefault(key, {"frames": 0, "f0ok": 0, "hasF0": has_f0,
                                 "tmin": None, "tmax": None})
        a["frames"] += 1
        if has_f0 and f0i < len(parts):
            v = _to_float(parts[f0i])
            if v:
                a["f0ok"] += 1
        if ti >= 0 and ti < len(parts):
            t = _to_float(parts[ti])
            if t is not None:
                a["tmin"] = t if a["tmin"] is None else min(a["tmin"], t)
                a["tmax"] = t if a["tmax"] is None else max(a["tmax"], t)

    # 先按文件把各标注段分组，再决定哪些段参与统计
    by_file = {}
    for (name, label), a in agg.items():
        by_file.setdefault(name, []).append((label, a))

    for name, segs in by_file.items():
        # 有非静音段就只用非静音段；整段都是静音标签（纯静音文件）则退回全部，
        # 这样该报"这个文件没测出基频"时仍然会报。
        voiced = [a for lb, a in segs if not _is_silence_label(lb)]
        used = voiced if voiced else [a for _lb, a in segs]
        frames = sum(a["frames"] for a in used)
        f0ok = sum(a["f0ok"] for a in used)
        tmins = [a["tmin"] for a in used if a["tmin"] is not None]
        tmaxs = [a["tmax"] for a in used if a["tmax"] is not None]
        out.append({
            "file": name,
            "frames": frames,
            "f0Ratio": (f0ok / frames) if (has_f0 and frames) else None,
            "tmin": min(tmins) if tmins else None,
            "tmax": max(tmaxs) if tmaxs else None,
            "segments": len(segs),
            "silenceSkipped": bool(voiced),
        })
    out.sort(key=lambda x: (x["f0Ratio"] if x["f0Ratio"] is not None else 1))
    return out


def _rewrite(path, new_lines):
    """按原文件的编码 / BOM 就地重写（praatsauce 在 Windows 默认 UTF-16 带 BOM）。"""
    raw = open(path, "rb").read()
    if raw[:2] == b"\xff\xfe":
        out = "\n".join(new_lines).encode("utf-16")          # 自动带 BOM
    elif raw[:3] == b"\xef\xbb\xbf":
        out = "\n".join(new_lines).encode("utf-8-sig")        # 自动带 BOM
    elif b"\x00" in raw[:400]:
        out = "\n".join(new_lines).encode("utf-16-le")
    else:
        out = "\n".join(new_lines).encode("utf-8")
    with open(path, "wb") as f:
        f.write(out)


def drop_columns(path, skip):
    """把结果表里 skip 中的列去掉，就地重写（保留原文件编码 / BOM）。

    用于前端「要测哪些 / 结果行」逐列剔除：被点掉的列在结果表与导出 CSV 里都真正消失。
    """
    if not skip:
        return
    skip = set(skip)
    text = _read_text(path)
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if not lines or not lines[0].strip():
        return
    header = [c.strip().lstrip("\ufeff") for c in lines[0].split("\t")]
    keep = [i for i, c in enumerate(header) if c and c not in skip]
    if len(keep) == len(header):
        return  # 没有要删的列，原样不动
    new_lines = []
    for ln in lines:
        if not ln.strip():
            continue
        parts = ln.split("\t")
        new_lines.append("\t".join(parts[i] if i < len(parts) else "" for i in keep))
    _rewrite(path, new_lines)


# 结果数值舍入规则（2026-09-26 用户定案；2026-09-28 逐列依据文献惯例重定）。
# 依据：Praat 查询输出保留 2–3 位小数（如 f0 117.864 Hz）；VoiceSauce/文献表格
# 对 dB 类量（CPP 5.48、HNR 16.35、CPPS 12.49）一律 2 位小数；0–1 比值类
# （SHR，原始写入 4 位）为保留 ≥1‰ 分辨率取 3 位。
#   - 时间列 t / time_s 原样保留（对齐/画图要精确时间轴）；
#   - SHR：3 位小数（0–1 比值，2 位只剩 100 个量化级）；
#   - Hz 类（f0、F1–F5、B1–B5）与 dB 类（HNR*、CPP、CPPS、谐振幅 H*/A* 及
#     H1*-A2* 差值、intensity、soe）：2 位小数；
#   - 其余（未来新增的未知数值列）保守取 1 位；
#   - 文件名 / 标签等非数值不动。
ROUND_SKIP = {"file", "label", "intervalID", "t", "time_s"}
ROUND_THREE = {"SHR"}
ROUND_TWO = {
    # Hz：基频与共振峰/带宽
    "f0", "F1", "F2", "F3", "F4", "F5", "B1", "B2", "B3", "B4", "B5",
    # dB：谐波/共振峰幅值（c=校正 u=未校正）
    "H1c", "H2c", "H4c", "A1c", "A2c", "A3c", "H2Ku", "H5Ku",
    "H1u", "H2u", "H4u", "A1u", "A2u", "A3u",
    # dB：幅值差
    "H1H2c", "H2H4c", "H1A1c", "H1A2c", "H1A3c", "H2KH5Ku", "H4-2Ku",
    "H1H2u", "H2H4u", "H1A1u", "H1A2u", "H1A3u",
    # dB：噪声/音质类
    "HNR05", "HNR15", "HNR25", "HNR35", "HNR38", "CPP", "CPPS",
    "intensity", "soe",
}


def round_result(path):
    """按列规则把结果表里的数值统一舍入，就地重写（保留原文件编码 / BOM）。

    - 时间列 t 原样保留（后续对齐 / 画图要精确时间轴）；
    - HNR* 与 CPP 两位小数（量值较小，一位会丢信息）；
    - 其余数值一位小数；文件名 / 标签等非数值不动。
    返回被改写的数值个数（0 表示无需改动）。
    """
    text = _read_text(path)
    lines = [ln for ln in text.replace("\r\n", "\n").replace("\r", "\n").split("\n") if ln.strip()]
    if len(lines) < 2:
        return 0
    header = [c.strip().lstrip("\ufeff") for c in lines[0].split("\t")]
    digits = [None if c in ROUND_SKIP
              else (3 if c in ROUND_THREE else 2 if c in ROUND_TWO else 1)
              for c in header]
    new_lines = [lines[0]]
    changed = 0
    for ln in lines[1:]:
        parts = ln.split("\t")
        out = []
        for i, cell in enumerate(parts):
            d = digits[i] if i < len(digits) else None
            v = cell.strip()
            if d is None or not v:
                out.append(cell)
                continue
            try:
                f = float(v)
            except ValueError:
                out.append(cell)          # 非数值（文件名、标签）原样
                continue
            # 极小值（如 1e-05）按一位小数会被抹成 0.0，原样保留防丢信息
            if f != 0 and abs(f) < 1e-4:
                out.append(cell)
                continue
            rounded = f"{f:.{d}f}"
            if rounded != v:
                changed += 1
            out.append(rounded)
        new_lines.append("\t".join(out))
    if changed:
        _rewrite(path, new_lines)
    return changed
