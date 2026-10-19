# -*- coding: utf-8 -*-
"""解析 Praat .Pitch / .Formant 文本对象，供数据调整曲线叠加使用。"""
import os
import re


def _read_lines(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read().splitlines()
    except Exception:
        return []


def _peek_header(lines):
    """Praat 对象文本文件可能是 UTF-16 编码且带 BOM。这里按行探测并解码。"""
    out = []
    for ln in lines:
        if ln.startswith("\ufeff"):
            ln = ln[1:]
        out.append(ln)
    return out


def _find_value(lines, key):
    for ln in lines:
        if ln.strip().lower().startswith(key.lower()):
            m = re.search(r"=\s*([0-9eE.+-]+)", ln)
            if m:
                return float(m.group(1))
            m = re.search(r"=\s*(\S+)", ln)
            if m:
                try:
                    return float(m.group(1))
                except Exception:
                    pass
    return None


def read_pitch_text(path):
    """返回 [{t, f0}, ...]，取每帧第一个候选（Praat 的当前路径）。

    兼容 Praat 7 文本格式：帧标记写作 ``frames [1]:``（复数）。
    """
    if not path or not os.path.exists(path):
        return []
    lines = _peek_header(_read_lines(path))
    if not lines:
        return []

    # 跳过对象名与类型声明
    start = 0
    for i, ln in enumerate(lines):
        if ln.strip().lower().startswith("xmin"):
            start = i
            break

    xmin = _find_value(lines[start:start + 10], "xmin") or 0
    nx = int(_find_value(lines[start:start + 10], "nx") or 0)
    dx = _find_value(lines[start:start + 10], "dx") or 0.01
    x1 = _find_value(lines[start:start + 10], "x1") or xmin

    # 定位帧数据起点：找到第一个 frame [ 或 frames[1] 行
    frame_start = None
    for i in range(start, len(lines)):
        if re.match(r"\s*frames?\s*\[\s*1\s*\]", lines[i], re.I):
            frame_start = i
            break
    if frame_start is None:
        return []

    out = []
    i = frame_start
    for fi in range(1, nx + 1):
        # 找到 frames[fi]
        while i < len(lines) and not re.match(rf"\s*frames?\s*\[\s*{fi}\s*\]", lines[i], re.I):
            i += 1
        if i >= len(lines):
            break
        i += 1
        # 读 intensity / nCandidates
        intensity = None
        n_candidates = 0
        while i < len(lines):
            ln = lines[i].strip().lower()
            if ln.startswith("intensity"):
                intensity = _find_value([lines[i]], "intensity") or 0
            elif ln.startswith("ncandidates"):
                n_candidates = int(_find_value([lines[i]], "ncandidates") or 0)
                i += 1
                break
            i += 1
        t = x1 + (fi - 1) * dx
        # Praat 约定：每帧 candidates[1] 即当前基频路径（voiced 时 >0，unvoiced 时 =0）。
        # 严禁扫描 candidates[2..n]——那只是备选假设，取"首个非零"会捡到谐波/杂散候选。
        freq = None
        while i < len(lines):
            ln = lines[i].strip()
            m = re.match(r"\s*candidates?\s*\[\s*(\d+)\s*\]", ln, re.I)
            if m and m.group(1) == "1":
                i += 1
                if i < len(lines) and "frequency" in lines[i].lower():
                    freq = _find_value([lines[i]], "frequency")
                break
            if re.match(r"\s*frames?\s*\[", ln, re.I):   # 越过本帧
                break
            i += 1
        f0 = freq if (freq is not None and freq > 0) else None
        out.append({"t": t, "f0": f0})
    return out


def read_formant_text(path):
    """返回 [{t, F1..F5, B1..B5}, ...]，逐帧取各阶共振峰与带宽。

    兼容 Praat 7 文本格式：帧标记写作 ``frames [1]:``（复数），
    共振峰数量字段为 ``numberOfFormants``（旧版为 ``nFormants``）。
    对象里只有 3 阶时 F4/F5/B4/B5 为 None（2026-09-26 第四步导出扩展）。
    """
    if not path or not os.path.exists(path):
        return []
    lines = _peek_header(_read_lines(path))
    if not lines:
        return []

    start = 0
    for i, ln in enumerate(lines):
        if ln.strip().lower().startswith("xmin"):
            start = i
            break

    nx = int(_find_value(lines[start:start + 10], "nx") or 0)
    dx = _find_value(lines[start:start + 10], "dx") or 0.01
    x1 = _find_value(lines[start:start + 10], "x1") or 0

    frame_start = None
    for i in range(start, len(lines)):
        if re.match(r"\s*frames?\s*\[\s*1\s*\]", lines[i], re.I):
            frame_start = i
            break
    if frame_start is None:
        return []

    out = []
    i = frame_start
    for fi in range(1, nx + 1):
        while i < len(lines) and not re.match(rf"\s*frames?\s*\[\s*{fi}\s*\]", lines[i], re.I):
            i += 1
        if i >= len(lines):
            break
        i += 1
        intensity = None
        n_formants = 0
        while i < len(lines):
            ln = lines[i].strip().lower().replace(" ", "")
            if ln.startswith("intensity"):
                intensity = _find_value([lines[i]], "intensity") or 0
            elif ln.startswith("nformants") or ln.startswith("numberofformants"):
                n_formants = int(_find_value([lines[i]], ln.split("=")[0].strip()) or 0)
                i += 1
                break
            i += 1
        t = x1 + (fi - 1) * dx
        formants = []
        # 逐块读取 formant [k]。必须先跳过 "formant []:" 这类数组声明行：
        # 它会白占一次循环，导致 numberOfFormants = 3 时正好丢掉 F3（off-by-one）。
        # 同时把带宽（bandwidth）一起读出来——写回 .Formant 时要用，否则只能填假带宽。
        while i < len(lines):
            if re.match(r"\s*formant\s*\[\s*\]", lines[i], re.I):
                i += 1
                continue
            if not re.match(r"\s*formant\s*\[\s*\d+\s*\]", lines[i], re.I):
                break
            freq = None
            bw = None
            i += 1
            if i < len(lines) and "frequency" in lines[i].lower():
                freq = _find_value([lines[i]], "frequency")
                i += 1
            if i < len(lines) and "bandwidth" in lines[i].lower():
                bw = _find_value([lines[i]], "bandwidth")
                i += 1
            formants.append((freq, bw))
        out.append({
            "t": t,
            "F1": formants[0][0] if len(formants) > 0 and formants[0][0] is not None else None,
            "F2": formants[1][0] if len(formants) > 1 and formants[1][0] is not None else None,
            "F3": formants[2][0] if len(formants) > 2 and formants[2][0] is not None else None,
            # 第 4/5 阶（2026-09-26 第四步导出扩展）：To Formant (burg) 设 5 个数时
            # 对象里就有 5 阶，逐帧导出（第四步）列全 F1–F5/B1–B5。
            "F4": formants[3][0] if len(formants) > 3 and formants[3][0] is not None else None,
            "F5": formants[4][0] if len(formants) > 4 and formants[4][0] is not None else None,
            "B1": formants[0][1] if len(formants) > 0 else None,
            "B2": formants[1][1] if len(formants) > 1 else None,
            "B3": formants[2][1] if len(formants) > 2 else None,
            "B4": formants[3][1] if len(formants) > 3 else None,
            "B5": formants[4][1] if len(formants) > 4 else None,
        })
    return out


def write_formant_text(path, points, xmin=0.0, maxn=5):
    """把轨迹点写成 Praat ``Formant 2`` 文本对象（写回 measure/ 子目录的 ``.Formant``）。

    与 :func:`read_formant_text` 同一格式，便于批量端直接读回展示。
    ``points``：``[{t, F1..F5, B1..B5?}]``，``t`` 为绝对时间（秒），
    2026-09-26 起最多保留五个共振峰（F1–F5 与带宽 B1–B5）；只有 F1–F3 时
    行为与旧版一致（只写 3 阶，不多写 0 值尾巴）。

    帧网格按点的时间重建：``x1 = points[0].t``，``dx`` 取相邻间隔中位数，
    ``nx = 点数``，``xmax = x1 + (nx-1)*dx``——这正是 Praat 帧式对象的写法
    （与读回时的 ``t = x1 + (fi-1)*dx`` 完全一致，不会错位）。缺失的频率写成 0
    （Praat 接受）；没带带宽就给 50 Hz 的保守默认值，保证导出对象在 Praat 里
    看起来正常（带宽只是显示用，本工具展示只取频率）。
    """
    if not points:
        return False
    n = len(points)
    try:
        t0 = float(points[0]["t"])
    except (TypeError, ValueError, KeyError):
        return False

    gaps = []
    for i in range(1, n):
        try:
            gaps.append(float(points[i]["t"]) - float(points[i - 1]["t"]))
        except (TypeError, ValueError, KeyError):
            pass
    dx = sorted(gaps)[len(gaps) // 2] if gaps else 0.005
    if not dx or dx <= 0:
        dx = 0.005
    nx = n
    x1 = t0
    xmax = x1 + (nx - 1) * dx
    if xmax <= xmin:
        xmax = xmin + (nx - 1) * dx + 1e-6

    def fnum(v):
        f = float(v)
        if abs(f - round(f)) < 1e-9:
            return str(int(round(f)))
        return repr(f)

    def get(p, key):
        v = p.get(key)
        if v is None:
            return None
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    lines = ['File type = "ooTextFile"',
             'Object class = "Formant 2"',
             "",
             "xmin = %s " % fnum(xmin),
             "xmax = %s " % fnum(xmax),
             "nx = %d " % nx,
             "dx = %s " % fnum(dx),
             "x1 = %s " % fnum(x1),
             "maxnFormants = %d " % int(maxn),
             "frames []:"]
    for idx, p in enumerate(points, start=1):
        # 2026-09-26 第四步导出扩展：写满 F1–F5/B1–B5（原来写死 3 阶，
        # 平滑存盘会把对象里的 F4/F5 抹掉，第四步就导不出这两列了）。
        # 只写到「最高一个非空频率」为止：F4/F5 本来就没有时不多写 0 帧尾巴，
        # 读回来仍是 None → 导出 CSV 里是空而不是误导性的 0.00。
        fs = [get(p, "F%d" % k) for k in range(1, 6)]
        bs = [get(p, "B%d" % k) for k in range(1, 6)]
        nf = 0
        for j in range(5):
            if fs[j] is not None:
                nf = j + 1
        if nf == 0:
            nf = 1
        lines.append("    frames [%d]:" % idx)
        lines.append("        intensity = 1.0 ")
        lines.append("        numberOfFormants = %d " % nf)
        lines.append("        formant []:")
        for j in range(nf):
            fv = fs[j] if fs[j] is not None else 0.0
            bv = bs[j] if bs[j] is not None else 50.0
            lines.append("            formant [%d]:" % (j + 1))
            lines.append("                frequency = %s " % fnum(fv))
            lines.append("                bandwidth = %s " % fnum(bv))
    text = "\n".join(lines) + "\n"
    try:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
    except Exception:
        return False
    return True


def read_pitchtier_text(path):
    """返回 [{t, f0}, ...]，解析 Praat PitchTier 文本对象。

    常用于用户在 Praat 里手动修正 F0 后导出的数据（对象菜单
    ``Save as PitchTier file``）。文件格式为 time/value 点对。
    """
    if not path or not os.path.exists(path):
        return []
    lines = _peek_header(_read_lines(path))
    if not lines:
        return []
    out = []
    i = 0
    n = len(lines)
    # 先定位到 points 段，避免把文件头的 xmin/xmax 误当数据点
    started = False
    for li in range(n):
        if lines[li].strip().lower().startswith("points"):
            started = True
            i = li
            break
    if not started:
        i = 0
    while i < n:
        ln = lines[i].strip().lower()
        if ln.startswith("time"):
            t = _find_value([lines[i]], "time")
            v = None
            if i + 1 < n and lines[i + 1].strip().lower().startswith("value"):
                v = _find_value([lines[i + 1]], "value")
            if t is not None:
                out.append({"t": t, "f0": v if (v is not None and v > 0) else None})
            i += 2
        else:
            i += 1
    return out


def read_formantgrid_text(path):
    """返回 [{t, F1, F2, F3}, ...]，解析 Praat FormantGrid 文本对象。

    FormantGrid 每个 formant 是一层点（time, freq），层内线性插值，可任意增删点，
    常用于人工精修共振峰后导出（比逐帧 Formant 更适合脚本化修改）。
    各层时间点通常不严格对齐，这里按时间并集对齐，缺失层记 None。
    """
    if not path or not os.path.exists(path):
        return []
    lines = _peek_header(_read_lines(path))
    if not lines:
        return []
    tier_points = {}  # k -> [(t, freq)]
    cur_tier = None
    i = 0
    n = len(lines)
    while i < n:
        m = re.match(r"\s*formants?\s*\[\s*(\d+)\s*\]", lines[i], re.I)
        if m:
            cur_tier = int(m.group(1))
            tier_points.setdefault(cur_tier, [])
            i += 1
            continue
        if cur_tier is not None:
            s = lines[i].strip().lower()
            if s.startswith("time"):
                t = _find_value([lines[i]], "time")
                v = None
                if i + 1 < n and lines[i + 1].strip().lower().startswith("value"):
                    v = _find_value([lines[i + 1]], "value")
                if t is not None:
                    tier_points[cur_tier].append((t, v if (v is not None and v > 0) else None))
                i += 2
                continue
        i += 1
    if not tier_points:
        return []
    times, seen = [], set()
    for k in sorted(tier_points):
        for (t, _) in tier_points[k]:
            if t not in seen:
                seen.add(t)
                times.append(t)
    times.sort()
    tmap = {k: {t: v for (t, v) in tier_points[k]} for k in tier_points}
    return [{
        "t": t,
        "F1": tmap.get(1, {}).get(t),
        "F2": tmap.get(2, {}).get(t),
        "F3": tmap.get(3, {}).get(t),
    } for t in times]
