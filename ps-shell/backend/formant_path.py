# -*- coding: utf-8 -*-
"""Praat FormantPath 的解析、逐区间打分与 path 层改写。

## 为什么用它
`To Formant (burg)` 只用**一个** ceiling 就把整段音频算死；而同一个 Sound 在不同 ceiling 下
算出的共振峰差别很大，哪种 ceiling 最合适往往逐段不同。Praat 的 `FormantPath` 正是为此设计：
一次性算出多套分析（ceiling 上下各若干步），并记录"某时段采用哪一套"。

## 实测确认的接口（2026-09-22，本机 Praat 7.0.02）
- 创建：``To FormantPath (burg): timeStep, maxNumberOfFormants, ceiling, windowLength,
  preEmphasisFrom, ceilingStep, numberOfSteps``
  —— ``ceilingStep`` 是**相对比例**（0.05 = 5%），``numberOfSteps`` 是上下各多少步。
  实测 ``0.005, 5.0, 5500.0, 0.025, 50.0, 0.05, 4`` → 9 套，ceiling =
  4503.0 / 4733.9 / 4976.6 / 5231.8 / 5500 / 5782.0 / 6078.4 / 6390.1 / 6717.7。
- 对象命令**只有两个**：``Extract Formant``（无参，按当前 path 导出 Formant）与
  ``Save as text file``。``Get ceiling`` / ``Get stress`` / ``Down to Table`` 之类**都不存在**。
- 文本尾部：``ceilings [1..N] = …`` → ``path? <exists>`` → 内嵌 TextGrid，其中 ``path`` 是
  一个 IntervalTier，**每段的 text 就是 ceiling 序号**（默认全段 "5"）。
  **手改这段文本，Praat 会照办**（已实测：同文件前段改成 1 号后，该段 F1 从 1067 → 445 Hz，
  后段逐值不变）。所以"逐段挑哪套分析"可以纯后端完成、不必进 GUI 点矩形。

## 打分判据（每条都写清依据，避免拍脑袋）
1. **带宽过窄 = 谐波伪极点**（硬证据）：samples/1 语音段内 63 个带宽 < 30 Hz 的候选，
   **100% 落在 F0 的整数倍上**（距最近谐波中位偏差 0.029·F0）。文献同向：真共振峰带宽是
   百赫兹量级（J Voice 2015 男性持续元音 BW1 均值 53–137 Hz；合成惯用 B1≈90 / B2≈110 /
   B3≈170，随频率递增）。
2. **带宽过宽 = 被噪声/阻尼污染的伪极点**：本样本见过 5202 / 8775 Hz 的极点，远超真共振峰量级。
3. **帧间平滑度**：沿用本项目量 Track 效果时的同一指标（逐帧 |ΔF| 均值），
   只作为"在体检合格的分析之间"的选择目标——所以它**不会**把明显病态的一套选上来。
"""

import re

from . import vowel_ref

# 判据常量（依据见模块 docstring）
NARROW_HZ = 30.0        # 带宽小于它 → 谐波伪极点
WIDE_HZ = 1500.0        # 带宽大于它 → 被污染的伪极点
BAD_RATIO = 0.20        # 坏帧占比超过它 → 该套分析在这个区间被淘汰

_CAND_RE = re.compile(r"^\s*formantCandidates\s*\[\s*(\d+)\s*\]", re.I)
_FRAME_RE = re.compile(r"^\s*frames?\s*\[\s*(\d+)\s*\]", re.I)
_INTERVALS_RE = re.compile(r"^\s*intervals\s*:\s*size\s*=", re.I)
_INTERVAL_RE = re.compile(r"^\s*intervals\s*\[\s*\d+\s*\]")
_F_EMPTY_RE = re.compile(r"^\s*formant\s*\[\s*\]", re.I)
_F_RE = re.compile(r"^\s*formant\s*\[\s*\d+\s*\]", re.I)


def _val(line):
    m = re.search(r"=\s*([0-9eE.+-]+)", line)
    if not m:
        return None
    try:
        return float(m.group(1))
    except ValueError:
        return None


def _parse_frames(lines, i, x1, dx):
    """从 lines[i]（首个 ``frames [k]:`` 行）开始解析帧；返回 (frames, 下一个位置)。"""
    frames = []
    while i < len(lines):
        m = _FRAME_RE.match(lines[i])
        if not m:
            break
        fi = int(m.group(1))
        i += 1
        intensity = 0.0
        while i < len(lines):
            s = lines[i].strip().lower().replace(" ", "")
            if s.startswith("intensity"):
                intensity = _val(lines[i]) or 0.0
                i += 1
                continue
            if s.startswith("nformants") or s.startswith("numberofformants"):
                i += 1
                break
            i += 1
        # 逐块读 formant [k]；先跳过 "formant []:" 声明行（否则会白占一次迭代）。
        cands = []
        while i < len(lines):
            if _F_EMPTY_RE.match(lines[i]):
                i += 1
                continue
            if not _F_RE.match(lines[i]):
                break
            i += 1
            freq = bw = None
            if i < len(lines) and "frequency" in lines[i].lower():
                freq = _val(lines[i])
                i += 1
            if i < len(lines) and "bandwidth" in lines[i].lower():
                bw = _val(lines[i])
                i += 1
            if freq is not None:
                cands.append((freq, bw))
        frames.append({"t": x1 + (fi - 1) * dx, "intensity": intensity, "c": cands})
    return frames, i


def _parse_formant_block(lines, i):
    """从 lines[i]（``formantCandidates [k]:`` 行）开始解析一套 Formant 分析。"""
    i += 1
    x1, dx = 0.0, 0.01
    while i < len(lines):
        if _FRAME_RE.match(lines[i]) or _CAND_RE.match(lines[i]):
            break
        s = lines[i].strip().lower()
        if s.startswith("x1"):
            x1 = _val(lines[i]) or x1
        elif s.startswith("dx"):
            dx = _val(lines[i]) or dx
        i += 1
    return _parse_frames(lines, i, x1, dx)


def parse_text(text):
    """解析 FormantPath 文本。

    返回 ``{"ceilings": [...], "candidates": [[frame, ...], ...], "path": [(t0,t1,label)],
    "xmin": …, "xmax": …, "nx": n}``。
    ``candidates[k]`` 与 ``ceilings[k]`` 一一对应（1-based 序号即数组下标 +1）。

    ⚠️ ``xmin``/``xmax`` 是对象自身的定义域，**不等于首/末帧时间**（帧从 ``x1`` 起、
    末帧之后还留了一截）。改写 path 层时必须用它铺满，否则 Praat 在 `Extract Formant`
    时会访问到区间外而**直接崩溃**（实测 rc=0xC0000005 访问越界，且不打印任何错误）。
    """
    lines = (text or "").splitlines()
    ceilings = []
    for ln in lines:
        m = re.match(r"\s*ceilings\s*\[\s*\d+\s*\]\s*=\s*([0-9eE.+-]+)", ln)
        if m:
            try:
                ceilings.append(float(m.group(1)))
            except ValueError:
                pass

    # 顶层头部（到 formantCandidates 之前）里的 xmin / xmax
    xmin = xmax = None
    for ln in lines[:30]:
        s = ln.strip().lower()
        if s.startswith("formantcandidates"):
            break
        if s.startswith("xmin"):
            xmin = _val(ln)
        elif s.startswith("xmax"):
            xmax = _val(ln)

    candidates = []
    i = 0
    while i < len(lines):
        if _CAND_RE.match(lines[i]):
            frames, i = _parse_formant_block(lines, i)
            candidates.append(frames)
            continue
        i += 1

    nx = max((len(c) for c in candidates), default=0)
    return {"ceilings": ceilings, "candidates": candidates, "path": parse_path(lines),
            "xmin": xmin, "xmax": xmax, "nx": nx}


def partition(xmin, xmax, intervals, skip=("", "sil")):
    """把 [xmin, xmax] 切成**连续无缝**的区间，标签取所含 TextGrid 区间的标签。

    path 层必须严丝合缝铺满定义域（不能有缺口、不能重叠），否则 Praat 会在
    ``Extract Formant`` 时访问越界崩溃（实测）。所以这里用"先收集所有边界点、
    再相邻两两成段"的办法构造，而不是直接用 TextGrid 的区间（它的首尾常常
    与对象定义域不一致）。
    """
    marks = {float(xmin), float(xmax)}
    eps = 1e-4   # 0.1 ms：比这更近的边界视为同一处，否则会切出长度为 0 的退化区间
    labelled = []
    for iv in intervals or []:
        t0 = max(float(xmin), float(iv["t0"]))
        t1 = min(float(xmax), float(iv["t1"]))
        if t1 > t0 + 1e-9:
            labelled.append((t0, t1, (iv.get("label") or "")))
            marks.add(t0)
            marks.add(t1)
    ms = []
    for v in sorted(marks):
        if v - float(xmin) <= eps:
            v = float(xmin)
        elif float(xmax) - v <= eps:
            v = float(xmax)
        if not ms or v - ms[-1] > eps:
            ms.append(v)
    out = []
    for k in range(len(ms) - 1):
        a, b = ms[k], ms[k + 1]
        if b - a <= 1e-9:
            continue
        lab = "sil"
        for (t0, t1, l) in labelled:
            if t0 - 1e-9 <= a and b <= t1 + 1e-9:
                lab = l
                break
        out.append((a, b, lab))
    return out


def parse_path(lines):
    """解析尾部 path 层（IntervalTier）→ ``[(t0, t1, label)]``。

    定位办法：取**最后一个** ``intervals: size =``（path 层固定在文件末尾）。
    """
    idx = None
    for i, ln in enumerate(lines):
        if _INTERVALS_RE.match(ln):
            idx = i
    if idx is None:
        return []
    out = []
    i = idx + 1
    while i < len(lines) and _INTERVAL_RE.match(lines[i]):
        i += 1
        t0 = t1 = None
        label = ""
        while i < len(lines) and not _INTERVAL_RE.match(lines[i]):
            s = lines[i].strip().lower()
            if s.startswith("xmin"):
                t0 = _val(lines[i])
            elif s.startswith("xmax"):
                t1 = _val(lines[i])
            elif s.startswith("text"):
                m = re.search(r'"(.*)"', lines[i])
                label = m.group(1) if m else ""
            i += 1
        if t0 is not None and t1 is not None:
            out.append((t0, t1, label))
    return out


def default_index(ceilings, ceiling):
    """离给定 ceiling 最近的那一套的 1-based 序号（默认 = 正中间那套）。"""
    if not ceilings:
        return 1
    best = min(range(len(ceilings)), key=lambda k: abs(ceilings[k] - float(ceiling)))
    return best + 1


def _frame_bad(frame):
    """该帧前三阶里是否出现"窄到像谐波"或"宽到像噪声"的带宽。"""
    if len(frame["c"]) < 3:
        return None
    for k in range(3):
        b = frame["c"][k][1]
        if b is None or b < NARROW_HZ or b > WIDE_HZ:
            return True
    return False


def _bandwidth_ok(frames):
    """体检：坏帧占比是否在容许范围内。"""
    checked = [c for c in (_frame_bad(f) for f in frames) if c is not None]
    if not checked:
        return False
    return (sum(1 for c in checked if c) / len(checked)) <= BAD_RATIO


def _jump(frames):
    """逐帧 |ΔF1|+|ΔF2|+|ΔF3| 均值（只在帧间对齐的相邻帧上算）。"""
    prev = None
    acc, n = 0.0, 0
    for f in frames:
        if len(f["c"]) < 3:
            prev = None
            continue
        if prev is not None:
            acc += sum(abs(f["c"][k][0] - prev[k][0]) for k in range(3))
            n += 1
        prev = f["c"]
    return (acc / n) if n else None


def _slice(frames, t0, t1):
    return [f for f in frames if t0 <= f["t"] <= t1]


def choose(candidates, intervals, ceiling=None, default=None, skip=("", "sil"),
            ref=None, cont_penalty=35.0, ref_weight=80.0):
    """逐区间挑分析（ceiling 或数量），返回 ``[(t0, t1, index, reason), ...]``。

    - 对每个非静音区间：先按带宽体检淘汰不合格的分析，再在合格的里取
      「帧间跳变 + 音标参考偏差 + 切换惩罚」综合最小的；全被淘汰则退回 ``default``。
    - 静音区间（label 在 ``skip`` 里）不做选择，直接用 ``default``——反正前端会遮掉。
    - ``ref``：与 ``intervals`` 等长的列表，每项是该区间的期望共振峰
      （``vowel_ref.expected`` 的返回，或 None）。给出后，稳态中值与期望的
      「尺度无关 + 比例」软距离会被并入打分——绝对数因声道大小飘，所以比例权重更高。
    - ``cont_penalty``：与上一段所选分析不同则加的惩罚（Hz/帧当量），
      用于**减少相邻区间之间的共振峰轨迹断裂**（优先保持同一条连续轨迹）。

    返回值里 index 是 **1-based** 序号，直接写进 path 层文本。
    """
    n = len(candidates) or 1
    if default is None:
        default = (n // 2) + 1
    out = []
    prev_index = None
    for ii, (t0, t1, label) in enumerate(intervals):
        lab = (label or "").strip().lower()
        if lab in skip:
            out.append((t0, t1, default, "静音段（默认）"))
            prev_index = default
            continue
        ref_entry = None
        if ref is not None and ii < len(ref):
            ref_entry = ref[ii]
        best, best_score, best_ceil = None, None, None
        for k, frames in enumerate(candidates, 1):
            seg = _slice(frames, t0, t1)
            if len(seg) < 3 or not _bandwidth_ok(seg):
                continue
            j = _jump(seg)
            if j is None:
                continue
            score = j
            if ref_entry:
                med = vowel_ref.steady_median(seg)
                dev = vowel_ref.deviation(med, ref_entry)
                if dev is not None:
                    score += ref_weight * dev
            if prev_index is not None and k != prev_index:
                score += cont_penalty
            if best_score is None or score < best_score:
                best, best_score, best_ceil = k, score, (k == default)
        if best is None:
            out.append((t0, t1, default, "无合格分析（默认）"))
            prev_index = default
        else:
            note = "保持默认" if best_ceil else "改选（跳变 %.0f Hz/帧）" % best_score
            out.append((t0, t1, best, note))
            prev_index = best
    return out


def rewrite_path(text, choices):
    """把 path 层替换成 ``choices``（[(t0, t1, index), ...]），其余部分原样保留。

    path 层固定在文件末尾，所以做法是：截断到最后一个 ``intervals: size =`` 之前，再补写新的层。
    """
    lines = (text or "").splitlines()
    idx = None
    for i, ln in enumerate(lines):
        if _INTERVALS_RE.match(ln):
            idx = i
    if idx is None:
        return None
    head = lines[:idx]
    tail = ["        intervals: size = %d" % len(choices)]
    for k, (t0, t1, ix) in enumerate(choices, 1):
        tail.append("        intervals [%d]:" % k)
        tail.append("            xmin = %.10g" % float(t0))
        tail.append("            xmax = %.10g" % float(t1))
        tail.append('            text = "%d"' % int(ix))
    return "\n".join(head + tail) + "\n"
