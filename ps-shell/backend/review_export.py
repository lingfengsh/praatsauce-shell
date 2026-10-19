# -*- coding: utf-8 -*-
"""审查结果导出：把审查选定的 F0 / 共振峰落成 praatSauce 能直接读取的对象文件。

为什么需要
----------
批量运行时如果重新计算 F0/共振峰，就等于把审查阶段已经算过、人工核对过的东西再算一遍。
praatSauce 原生支持 ``pitchRead`` / ``formantRead``：不重算，直接读
``<音频目录>/measure/<主名>.Pitch`` / ``.Formant``（2026-09-27 方案 A：中间结果
统一进 measure/ 子目录，路径口径见 object_path）。
本模块负责把审查结果（含人工修正的 F0 点）落成这两个文件。

「已审核」怎么判定
------------------
**以文件为准**：某文件的 ``.Pitch`` 与 ``.Formant`` 都在，就算这个文件审核过。
文件即事实——不需要额外维护状态表，也不会因为换机器、换目录而失效。
实际使用中用户只会修有问题的那几个文件，所以判定粒度不能是"改过没有"，
而是"这批数据这个环节收尾了没有"：由九宫格的「审核完成」按钮一次性给**全部**文件落盘。

人工修正为什么在 Python 侧做
-----------------------------
实测 Praat 7 的 Pitch 对象**没有任何逐帧修改命令**：``Set value at time`` /
``To PitchTier`` / ``Shift`` / ``Set value in frame`` 全部报
"not available for current selection"（只有 ``To Matrix`` 可用）。
所以人工修正点不走 Praat，而是由本模块**直接改写 .Pitch 文本**：
把修正点落到最近的帧，覆盖该帧 ``candidates [1]`` 的 frequency。

⚠️ 由此得到的一条通用教训：``nocheck`` 前缀是"命令不可用时**静默跳过**"，
所以**不能用它判断命令是否存在**——必须去掉 ``nocheck`` 跑一次，看是否报
"not available for current selection"。
"""
import os
import re
import time
import uuid
import shutil
import subprocess

from . import settings, praat, praat_objects
from . import working_dir
from .review_grid import _list_wavs

if settings.IS_FROZEN:
    SCRIPT = os.path.join(settings.APP_BASE, "scripts", "review_export.praat")
else:
    SCRIPT = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "praat", "review_export.praat",
    )

PITCH_EXT = ".Pitch"
FORMANT_EXT = ".Formant"

# 九宫格默认参数（与 review_grid 的默认一致）；调用方可用 defaults 覆盖。
# pitchFloor 对应批量运行的 f0min、nFormants 对应 maxNumFormants、
# formantCeiling 对应 maxFormantHz —— 审查用的抽取参数必须与批量用的一致，
# 否则同一批数据「审核过」与「未审核」会得到两套不同的 F0/共振峰。
DEFAULTS = {"pitchCeiling": 500.0, "nFormants": 5, "formantCeiling": 5500.0,
            "pitchFloor": 75.0, "timeStep": 0.005}
F0_FLOOR = 75.0
# 必须与批量运行 params.csv 的 intervalFixed 一致，理由见 praat/review_export.praat 头部。
TIME_STEP = 0.005

# Praat 文本对象里帧标记写作 ``frames [1]:``（复数）
_RE_FRAME = re.compile(r"^\s*frames\s*\[\s*(\d+)\s*\]\s*:\s*$")
_RE_CAND = re.compile(r"^\s*candidates\s*\[\s*(\d+)\s*\]\s*:\s*$")


def _resolve_exe(exe):
    """显式参数 > 用户设置(praatExe) > 常见位置探测。settings.praat_exe 属性不存在，
    配置在 settings.json 的 praatExe 键里（见 review_grid._resolve_exe 的注释）。"""
    if exe:
        return exe
    try:
        configured = settings.load().get("praatExe")
        if configured and os.path.isfile(configured):
            return configured
    except Exception:
        pass
    found = praat.detect_praat()
    return found[0] if found else None


def pitch_path(wav_path):
    return object_path(wav_path, PITCH_EXT)


def formant_path(wav_path):
    return object_path(wav_path, FORMANT_EXT)


# 中间结果子目录（2026-09-27 用户拍板方案 A）：.Pitch/.Formant/.measure.json 等
# 影子文件统一放音频所在目录的 measure/ 子目录里，音频目录根只留 wav（和 TextGrid）。
# TextGrid 常为手工/外部工具制作，保持与音频同级（Praat 生态默认），不进子目录。
MEASURE_SUBDIR = "measure"


def measure_dir(wav_path):
    """某音频的中间结果子目录：<音频所在目录>/measure/。"""
    return os.path.join(os.path.dirname(os.path.abspath(wav_path)), MEASURE_SUBDIR)


def ensure_measure_dir(wav_path):
    """写入中间结果前确保子目录存在（读路径不建目录，避免到处冒空壳）。"""
    d = measure_dir(wav_path)
    os.makedirs(d, exist_ok=True)
    return d


def object_path(wav_path, ext):
    """wav → <所在目录>/measure/<主名><ext>。wav 可带相对子路径（批量递归清单），
    子目录永远相对该 wav 自己所在的目录——多级目录里每层都有自己的 measure/。"""
    return os.path.join(os.path.dirname(wav_path), MEASURE_SUBDIR,
                        os.path.splitext(os.path.basename(wav_path))[0] + ext)


def is_reviewed(wav_path):
    """该文件是否两个对象都在（仅用于「对象是否存在」这类新鲜度判断，与审核口径无关）。"""
    return os.path.isfile(pitch_path(wav_path)) and os.path.isfile(formant_path(wav_path))


def reviewed_state(dir_path, ext="wav"):
    # 重采样后工作目录自动切到 Resample/（见 working_dir），否则会同时拉到
    # 原始目录(samples/1)与 Resample/ 两套同名文件 → 审核状态错乱。
    dir_path = working_dir.resolve_working_dir(dir_path, ext)
    """目录的审核状态（分维度，按 measure.json 的 choice 判定，而非对象文件在不在）。

    为什么不再用「.Pitch/.Formant 在不在」：普通批量运行也会把这两个对象写在 measure/ 子目录，
    于是「文件在」会把「还没审、只是批量跑过」的文件也误判成已审核。真正代表
    「人工审过」的事实，是单文件详情页点过「存盘」（save_choice 写 measure.json 的
    choice.pitch / choice.formant），以及九宫格「审核完成」（export_dir 给每个文件
    都落一份 choice，表示整批过关）。两者都只记 measure.json、不靠记忆。

    - pitch_reviewed / formant_reviewed：各自「已审」的文件数（F0 与共振峰分开算，
      存了基频不代表存了共振峰——两个维度各自独立）。
    - reviewed：两个维度都审过的文件数（=「全部审核」的口径，第三步据此放行）。
    - missing / missing_pitch / missing_formant：相对路径清单。
    """
    from . import review_choice

    wavs = _list_wavs(dir_path, ext)
    pitch_reviewed = 0
    formant_reviewed = 0
    missing_pitch = []
    missing_formant = []
    for rel in wavs:
        full = os.path.join(dir_path, rel.replace("/", os.sep))
        try:
            ch = (review_choice.read_choice(full).get("choice") or {})
        except Exception:
            ch = {}
        if not isinstance(ch, dict):
            ch = {}
        has_pitch = isinstance(ch.get("pitch"), dict)
        has_formant = isinstance(ch.get("formant"), dict)
        if has_pitch:
            pitch_reviewed += 1
        else:
            missing_pitch.append(rel)
        if has_formant:
            formant_reviewed += 1
        else:
            missing_formant.append(rel)
    total = len(wavs)
    missing = sorted(set(missing_pitch) | set(missing_formant))
    reviewed = total - len(missing)
    return {
        "ok": True,
        "dir": dir_path,
        "total": total,
        "pitch_reviewed": pitch_reviewed,
        "formant_reviewed": formant_reviewed,
        "reviewed": reviewed,
        "missing": missing,
        "missing_pitch": missing_pitch,
        "missing_formant": missing_formant,
    }


def params_for(choice, defaults=None):
    """把 measure.json 的 choice 解析成 (pitchCeiling, nFormants, formantCeiling)。

    - pitch 变体 id 就是 F0 上限（如 "500"）
    - formant 变体 id 是 "上限-数量"（如 "5500-5"）；旧记录只存了裸上限（"5500"），
      此时数量退回默认值（历史上只有 ceiling 可调时都是 5 个）。
    缺项/格式不对一律退回 defaults —— 导出是"能用就行"，不该因为一条坏记录就失败。
    """
    d = dict(DEFAULTS)
    d.update(defaults or {})
    pc = float(d["pitchCeiling"])
    n_f = int(d["nFormants"])
    fc = float(d["formantCeiling"])

    if not isinstance(choice, dict):
        return pc, n_f, fc

    pid = str((choice.get("pitch") or {}).get("id") or "").strip()
    if pid:
        try:
            pc = float(pid)
        except ValueError:
            pass

    fid = str((choice.get("formant") or {}).get("id") or "").strip()
    m = re.match(r"^([0-9.]+)(?:-(\d+))?$", fid) if fid else None
    if m:
        try:
            fc = float(m.group(1))
        except ValueError:
            pass
        if m.group(2):
            try:
                n_f = int(m.group(2))
            except ValueError:
                pass
    return pc, n_f, fc


def pitch_params_for(choice):
    """从 measure.json 的 pitch 变体里取「自定义基频参数」（详情页滑块存盘）。

    自定义变体形如 ``{"id":"custom","method":"raw|filtered","params":{...}}``；
    没有自定义参数（用的是普通上限候选）返回 None —— 导出走默认 ``To Pitch``。
    返回 dict 键：method/ceiling/silence/voicing/octave/octaveJump/vuv/attenuation。
    """
    if not isinstance(choice, dict):
        return None
    v = choice.get("pitch")
    if not isinstance(v, dict) or v.get("method") not in ("raw", "filtered"):
        return None
    prm = v.get("params")
    if not isinstance(prm, dict):
        return None
    try:
        return {
            "method": v["method"],
            "ceiling": float(prm["ceiling"]),
            "silence": float(prm["silence"]),
            "voicing": float(prm["voicing"]),
            "octave": float(prm["octave"]),
            "octaveJump": float(prm["octaveJump"]),
            "vuv": float(prm["vuv"]),
            "attenuation": float(prm.get("attenuation") or 0.03),
        }
    except (KeyError, TypeError, ValueError):
        return None


def pitch_floor_for(defaults=None):
    """取 F0 下限（= 批量的 f0min）。F0 下限是全局的，不分文件，所以不走 measure.json。"""
    d = dict(DEFAULTS)
    d.update(defaults or {})
    try:
        return float(d.get("pitchFloor") or F0_FLOOR)
    except (TypeError, ValueError):
        return F0_FLOOR


def time_step_for(defaults=None):
    """取导出对象的时间步（= 批量的 intervalFixed）。

    必须与批量输出网格一致，否则读回时帧数不足会被**补 0**（见 praat 脚本头部）。
    """
    d = dict(DEFAULTS)
    d.update(defaults or {})
    try:
        ts = float(d.get("timeStep") or TIME_STEP)
    except (TypeError, ValueError):
        return TIME_STEP
    return ts if ts > 0 else TIME_STEP


def _fmt_num(v):
    """写进 Praat 文本的数值：整数不带小数点，其余给足精度。"""
    f = float(v)
    if abs(f - round(f)) < 1e-9:
        return str(int(round(f)))
    return repr(f)


def _pchip_derivs(xs, ys):
    """Fritsch-Carlson 保单调三次 Hermite 插值（PCHIP）的各节点导数。

    过所有节点、C1 连续、若数据单调则插值也单调（不会在两点间过冲）。
    与详情页前端 makePCHIP 同一算法，保证显示与写盘一致。
    """
    n = len(xs)
    if n < 2:
        return [0.0] * n
    if n == 2:
        d0 = (ys[1] - ys[0]) / ((xs[1] - xs[0]) or 1e-9)
        return [d0, d0]
    h = [xs[i + 1] - xs[i] for i in range(n - 1)]
    d = [(ys[i + 1] - ys[i]) / (h[i] or 1e-9) for i in range(n - 1)]
    m = [0.0] * n
    for i in range(1, n - 1):
        if d[i - 1] * d[i] <= 0:
            m[i] = 0.0
        else:
            w1 = 2 * h[i] + h[i - 1]
            w2 = h[i] + 2 * h[i - 1]
            m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])
    m[0] = ((2 * h[0] + h[1]) * d[0] - h[0] * d[1]) / (h[0] + h[1])
    m[n - 1] = ((2 * h[n - 2] + h[n - 3]) * d[n - 2] - h[n - 2] * d[n - 3]) / (h[n - 2] + h[n - 3])
    for i in range(n - 1):
        if d[i] == 0:
            m[i] = 0.0
        elif m[i] * d[i] < 0:
            m[i] = 0.0
        else:
            alpha = m[i] / d[i]
            if alpha > 3.0:
                m[i] = 3.0 * d[i]
    if d[n - 2] == 0:
        m[n - 1] = 0.0
    elif m[n - 1] * d[n - 2] < 0:
        m[n - 1] = 0.0
    else:
        alpha = m[n - 1] / d[n - 2]
        if alpha > 3.0:
            m[n - 1] = 3.0 * d[n - 2]
    return m


def _pchip_eval(xs, ys, ms, t):
    """在手工点序列上用 PCHIP 求 t 处的值（区间外返回端点值）。"""
    n = len(xs)
    if t <= xs[0]:
        return ys[0]
    if t >= xs[-1]:
        return ys[-1]
    for i in range(n - 1):
        if xs[i] <= t <= xs[i + 1]:
            h = xs[i + 1] - xs[i] or 1e-9
            u = (t - xs[i]) / h
            u2 = u * u
            u3 = u2 * u
            h00 = 2 * u3 - 3 * u2 + 1
            h10 = u3 - 2 * u2 + u
            h01 = -2 * u3 + 3 * u2
            h11 = u3 - u2
            return h00 * ys[i] + h10 * h * ms[i] + h01 * ys[i + 1] + h11 * h * ms[i + 1]
    return ys[-1]


def apply_manual_pitch(pitch_file, points, deleted=None):
    """把人工编辑写进 .Pitch 文本（覆盖最近帧的 candidates[1].frequency）。

    points: [{"t": 秒, "f0": Hz}] —— 手工点，**只覆盖最近一帧**（2026-09-26 改语义：
    不再做"相邻手工点之间整段替换"——两个点离得远时会把中间没动过的原始数据抹成一条
    插值线，用户实测反馈"直接好像把中间原来的数据给删了"，不对）。
    deleted: [帧时间, ...] —— 被删掉的原始测量帧。删掉 ≠ 无声：该帧的值改成
    **相邻存活帧的 PCHIP 桥接值**（与前端详情页显示同一算法），曲线平滑跨过坏点。
    手工点与删除标记命中同一帧时，手工点优先（改值 = 删了再加）。

    返回实际改动的帧数。
    逐行改写（不重新序列化整个对象），这样 Praat 写出的其余内容（候选、强度、
    缩进、数值精度）原样保留——重排格式是引入未知风险的最快方式。
    """
    if not pitch_file or not os.path.isfile(pitch_file):
        return 0
    if not points and not deleted:
        return 0

    with open(pitch_file, "r", encoding="utf-8", errors="replace") as f:
        lines = f.readlines()

    # 头部：x1（首帧中心时间）、dx（帧间隔）、nx（帧数）
    x1 = dx = None
    nx = 0
    for ln in lines[:40]:
        s = ln.strip()
        if s.startswith("x1 ") and x1 is None:
            x1 = _num_after_eq(s)
        elif s.startswith("dx ") and dx is None:
            dx = _num_after_eq(s)
        elif s.startswith("nx ") and not nx:
            nx = int(_num_after_eq(s) or 0)
    # x1 是合法浮点时间，恰好为 0.0 时不能当「头部无效」——否则该文件的
    # 全部人工修正静默丢失（曾导致 x1 从 0 开始的音频手工点全部不生效）
    if x1 is None or not dx or not nx:
        return 0

    def _frame_of(t):
        idx = int(round((t - x1) / dx)) + 1
        return idx if 1 <= idx <= nx else None

    # 手工点 → 帧号（同一帧被多个点命中时后者覆盖前者）
    targets = {}
    for p in points or []:
        try:
            t = float(p.get("t"))
            v = float(p.get("f0"))
        except (TypeError, ValueError, AttributeError):
            continue
        idx = _frame_of(t)
        if idx:
            targets[idx] = v

    # 删除标记 → 帧号；手工点优先（同一帧既删又改 = 改值）
    del_idx = set()
    for d in deleted or []:
        try:
            t = float(d.get("t")) if isinstance(d, dict) else float(d)
        except (TypeError, ValueError):
            continue
        idx = _frame_of(t)
        if idx:
            del_idx.add(idx)
    del_idx -= set(targets)

    # 先把当前所有帧的 candidates[1] 值读出来（桥接要用原曲线做节点）
    vals = {}
    cur_frame = cur_cand = 0
    for ln in lines:
        mf = _RE_FRAME.match(ln)
        if mf:
            cur_frame = int(mf.group(1))
            cur_cand = 0
            continue
        mc = _RE_CAND.match(ln)
        if mc:
            cur_cand = int(mc.group(1))
            continue
        if cur_cand == 1 and cur_frame not in vals:
            s = ln.strip()
            if s.startswith("frequency ") or s.startswith("frequency="):
                v = _num_after_eq(s)
                if v is not None:
                    vals[cur_frame] = v

    # ---- PCHIP 节点集（与前端 mergedF0Points 同一算法，2026-09-26 定稿）----
    #   存活有声帧（frequency>0、非删帧、非手工覆盖帧）∪ 手工点帧（值=手工值）。
    #   删帧不进节点（它的桥接值只是输出）；无声帧也不进节点（否则插值被拉向 0）。
    knot_i = [i for i in range(1, nx + 1)
              if i not in del_idx and i not in targets and (vals.get(i) or 0) > 0]
    knot_t = [x1 + (i - 1) * dx for i in knot_i]
    knot_v = [vals[i] for i in knot_i]
    for m, v in targets.items():
        if m in del_idx:
            continue            # 手工点优先时删帧标记已被去掉，这里防御
        knot_t.append(x1 + (m - 1) * dx)
        knot_v.append(v)
    order = sorted(range(len(knot_t)), key=lambda k: knot_t[k])
    knot_t = [knot_t[k] for k in order]
    knot_v = [knot_v[k] for k in order]
    ms = _pchip_derivs(knot_t, knot_v) if len(knot_t) >= 2 else None

    # 被删帧的桥接值：PCHIP 过「存活帧（含手工覆盖值）」这一节点序列，
    # 与前端 mergedF0Points 完全同一算法——所见即所得。
    for idx in del_idx:
        tt = x1 + (idx - 1) * dx
        if ms is not None:
            targets[idx] = _pchip_eval(knot_t, knot_v, ms, tt)
        elif knot_t:
            targets[idx] = knot_v[0]   # 只剩一个节点 → 退化为常值
        else:
            continue                   # 全删光了，没有参照 → 不动

    if not targets:
        return 0

    # 手工点跨无声段的桥接（2026-09-26 用户拍板「存盘就应该是普通 pitch 文件，
    # 再次读取跟正常做出来的没差别」）：无声帧落在节点时间范围内 → PCHIP 填桥接值
    # （v>0 才写）。与前端 mergedF0Points 的无声帧补值同一算法——详情页显示的每
    # 一个点，盘上都有；九宫格读回 .Pitch 后曲线连续穿过手工点，不再因「孤立点
    # 连不出线」而在九宫格上看不见。有声原始帧一律不动（手工点只覆盖自己那一帧，
    # 2026-09-26 拍板——原始测量数据绝不被插值线抹掉）；节点范围外的无声帧保持
    # 空白（与前端「范围外不画」一致）。
    if knot_t:
        t1, t2 = knot_t[0], knot_t[-1]
        for i in range(1, nx + 1):
            if i in targets or i in del_idx or (vals.get(i) or 0) > 0:
                continue
            tt = x1 + (i - 1) * dx
            if not (t1 <= tt <= t2) or ms is None:
                continue
            v = _pchip_eval(knot_t, knot_v, ms, tt)
            if v is not None and v > 0:
                targets[i] = v

    changed = 0
    cur_frame = 0
    cur_cand = 0
    for i, ln in enumerate(lines):
        mf = _RE_FRAME.match(ln)
        if mf:
            cur_frame = int(mf.group(1))
            cur_cand = 0
            continue
        mc = _RE_CAND.match(ln)
        if mc:
            cur_cand = int(mc.group(1))
            continue
        if cur_frame in targets and cur_cand == 1:
            s = ln.strip()
            if s.startswith("frequency ") or s.startswith("frequency="):
                newv = targets[cur_frame]
                lines[i] = re.sub(r"(frequency\s*=\s*)(-?[\d.eE+-]+)",
                                  lambda mm: mm.group(1) + _fmt_num(newv), ln, count=1)
                changed += 1
            elif s.startswith("strength "):
                # 原本无声的帧被改成有声时，强度也给个非零值，免得下游把它当无效帧
                lines[i] = re.sub(r"(strength\s*=\s*)(-?[\d.eE+-]+)", r"\g<1>0.5", ln, count=1)

    if changed:
        with open(pitch_file, "w", encoding="utf-8") as f:
            f.writelines(lines)
    return changed


def _num_after_eq(s):
    m = re.search(r"=\s*(-?[\d.eE+-]+)", s)
    if not m:
        return None
    try:
        return float(m.group(1))
    except ValueError:
        return None


def write_smoothed_formant(wav_path, choice, exe=None, formant_ceiling=5500.0,
                           n_formants=5):
    """对 wav 跑 burg+Track（全分辨率，保留带宽），写回 measure/ 子目录的 ``.Formant``。

    与「修周期」保护同源思路：共振峰维记了 formantSmoothed 时，导出的 ``.Formant``
    就该是平滑后的权威结果，不能用普通 burg 覆盖。返回 (ok, error)。
    ``n_formants``（2026-09-26）：与详情页平滑同源——跟随存盘候选的数量，不再写死 5。
    """
    exe = _resolve_exe(exe)
    if not exe:
        return False, "没有找到 Praat 程序"
    if not wav_path or not os.path.isfile(wav_path):
        return False, "音频文件不存在：%s" % wav_path
    try:
        from .review_grid import track_file
    except Exception as e:
        return False, "无法加载轨迹跟踪模块：%s" % e
    res = track_file(wav_path, exe=exe, formant_ceiling=float(formant_ceiling),
                     n_formants=int(n_formants or 5), full_res=True,
                     # 有音标时 Track 参考频率用该元音期望值（与九宫格/详情页同源先验）
                     vowel_ipa=(choice or {}).get("vowel_ipa"),
                     speaker=(choice or {}).get("speaker"))
    if not res.get("ok"):
        return False, res.get("error") or "平滑（Track）失败"
    pts = res.get("points") or []
    if not pts:
        return False, "Track 没有产出共振峰点"
    ensure_measure_dir(wav_path)
    if not praat_objects.write_formant_text(formant_path(wav_path), pts):
        return False, "写入 .Formant 失败"
    return True, None


def write_imported_formant(wav_path, choice, exe=None):
    """「读入的那条共振峰」导出收尾（FormantPath 精修 / 外部导入）。

    2026-09-27 定案「读入即落盘」：原始结果在读回/导入时就已直接写成 measure/ 子目录的
    ``.Formant``，这里没勾平滑就**无事可做**（落盘文件就是权威数据）。勾了平滑
    （``formantSmoothed``）→ 对落盘文件重跑一次 Track 并写回——Track 是确定性
    变换，重跑结果与界面预览一致，不依赖任何暂存。
    """
    from .review_grid import track_imported_formant

    ch = choice if isinstance(choice, dict) else {}
    if not ch.get("formantSmoothed"):
        return True, None   # 原始那份已经在音频目录，无需任何动作
    res = track_imported_formant(wav_path, exe=exe,
                                 tg_path=os.path.splitext(wav_path)[0] + ".TextGrid",
                                 vowel_ipa=ch.get("vowel_ipa"),
                                 speaker=ch.get("speaker"),
                                 write_back=True)
    if not res.get("ok") or not res.get("tracked"):
        return False, (res.get("error") or "平滑（Track）失败")
    return True, None


def _work_dir():
    d = os.path.join(settings.WORK_DIR, "review_export")
    os.makedirs(d, exist_ok=True)
    return d


def _run_batch(pairs, exe, input_dir, f0_floor=F0_FLOOR, time_step=TIME_STEP):
    """pairs: [(wav_full_path, name_in_list, relative_name, pc, nF, fc, custom, dims)]，跑一次 Praat。

    ``custom`` 是 pitch_params_for() 的结果（自定义基频参数）或 None。
    ``dims``（2026-09-25 存盘分维）："pitch"=只导 .Pitch，"formant"=只导 .Formant，
    "both"=两个都导（审核完成的整批落盘）。写进清单第 12 段，Praat 侧据此跳过另一维。
    ``input_dir`` 是清单里相对名的基准目录（Praat 侧算 wav 路径 = inputDir + "/" + 相对名）。
    ⚠️ 必须由调用方显式传入根目录，**不能**用「第一个文件的目录」推——``_list_wavs`` 是
    递归的，文件可能分散在不同子目录里。

    ``f0_floor`` 写进 Praat 脚本的 ``To Pitch``（第 2 参数），即批量的 f0min。
    ``time_step`` 是导出对象的时间步，必须与批量的 intervalFixed 一致（见同名常量注释）。

    worklist 行格式（后 7 字段是 2026-09-25 新增的自定义基频参数，普通候选全空；
    第 12 段 dims 是 2026-09-25 存盘分维，both 时不写）：
        rel|pc|nF|fc|method|silence|voicing|octave|octaveJump|vuv|attenuation[|dims]

    返回 (log_text, error)。成功与否**不看 stdout**（Praat 出错时 stdout 为空），
    由调用方按产物文件判断。
    """
    wd = _work_dir()
    # 清单名带随机后缀：两个导出并发时不再写同一份文件（Praat 读到别人的清单
    # 会结果错配且不报错）。跑完即删。
    wl = os.path.join(wd, "worklist_%s.txt" % uuid.uuid4().hex)
    # Praat 不能建目录：清单里每个文件的对象落盘目录（measure/）先建好
    for _full, *_rest in pairs:
        ensure_measure_dir(_full)
    with open(wl, "w", encoding="utf-8") as f:
        for _full, _name, rel, pc, n_f, fc, custom, dims in pairs:
            if custom:
                ext = "|%s|%s|%s|%s|%s|%s|%s" % (
                    custom["method"], _fmt_num(custom["silence"]),
                    _fmt_num(custom["voicing"]), _fmt_num(custom["octave"]),
                    _fmt_num(custom["octaveJump"]), _fmt_num(custom["vuv"]),
                    _fmt_num(custom["attenuation"]))
            else:
                ext = "|||||||"   # 7 个空字段，补齐 11 段格式（Praat 侧 method 为空走默认）
            if dims in ("pitch", "formant"):
                ext += "|" + dims
            f.write("%s|%s|%d|%s%s\n" % (rel, _fmt_num(pc), int(n_f), _fmt_num(fc), ext))

    try:
        rc, lines = praat.run_script(
            exe, SCRIPT,
            [input_dir.replace("\\", "/"), wl.replace("\\", "/"), ".wav",
             _fmt_num(f0_floor), _fmt_num(time_step)],
            cwd=wd, full_trust=True, timeout=1800,
        )
    except Exception as e:
        _try_remove(wl)
        return "", "调用 Praat 失败：%s" % e
    log = "\n".join(l.get("text", "") for l in lines)
    _try_remove(wl)
    if rc != 0 and "EXPORT_DONE" not in log:
        return log, "Praat 运行失败（退出码 %s）" % rc
    return log, None


def _try_remove(path):
    """尽力删除临时文件（清单/脚本），失败不影响主流程。"""
    try:
        os.remove(path)
    except Exception:
        pass


def export_one(wav_path, choice=None, defaults=None, exe=None, dims=None):
    """导出单个文件的审查对象（九宫格「存盘」后调用，保证该文件不过期）。

    ``dims``（2026-09-25 存盘分维，用户拍板）：看 F0 存盘只落 .Pitch、看共振峰存盘
    只落 .Formant——另一维的已有中间文件原样不动（有中间文件就不重算那一维）。
    None/其他值 = "both"，保持旧行为（「审核完成」整批导出走 export_dir，不受影响）。
    """
    if not wav_path or not os.path.isfile(wav_path):
        return {"ok": False, "error": "音频文件不存在：%s" % wav_path}
    dims = dims if dims in ("pitch", "formant") else "both"
    exe = _resolve_exe(exe)
    if not exe:
        return {"ok": False, "error": "没有找到 Praat 程序"}

    pc, n_f, fc = params_for(choice, defaults)
    # 自定义基频参数（详情页滑块存盘）：整组覆盖默认 To Pitch，pc 即 ceiling/top
    custom = pitch_params_for(choice)
    if custom:
        pc = custom["ceiling"]
    name = os.path.basename(wav_path)
    # 时间基准放到最前：下面「平滑写回 .Formant」和「普通 burg」都在此基准内判定新鲜度。
    started = time.time()
    # 「读入的结果」优先（2026-09-26）：这一维的最终数据是人从 Praat 精修/外部导进
    # 来的那条曲线，重抽等于把它扔掉。marker 的存在与否由详情页决定（勾了平滑就用
    # Track 过的那一份），这里只负责把它原样写成 .Formant。
    imported = bool(isinstance(choice, dict) and choice.get("formantImported"))
    imported_formant_done = False
    if imported and dims in ("both", "formant"):
        ok_i, err_i = write_imported_formant(wav_path, choice, exe=exe)
        if dims == "formant":
            return {
                "ok": bool(ok_i),
                "path": pitch_path(wav_path),
                "formantPath": formant_path(wav_path),
                "manualFrames": 0,
                "params": {"pitchFloor": pitch_floor_for(defaults),
                           "pitchCeiling": pc, "nFormants": n_f,
                           "formantCeiling": fc, "timeStep": time_step_for(defaults)},
                "log": "已把读入的共振峰结果写成 .Formant（未重新抽取）",
                "error": None if ok_i else (err_i or "读入结果写回失败"),
            }
        # dims == "both"：共振峰已写回，F0 仍走普通 burg（只导 pitch），共振峰不被覆盖
        dims = "pitch"
        imported_formant_done = True
    # 共振峰平滑落盘（2026-09-26）：该文件记了 formantSmoothed → 共振峰维不跑普通 burg，
    # 改用 burg+Track 的全分辨率结果写回 .Formant（保留带宽），让导出的对象就是平滑后的。
    # 只导共振峰（详情页共振峰页存盘，dims=formant）时直接返回；整批（both）则 F0 仍走
    # 普通 burg（下面把 dims 改成 pitch 只算 F0），共振峰已写好、不被覆盖。
    smoothed = bool(isinstance(choice, dict) and choice.get("formantSmoothed"))
    smoothed_formant_done = False
    if smoothed and dims in ("both", "formant"):
        ok_w, err_w = write_smoothed_formant(wav_path, choice, exe=exe,
                                            formant_ceiling=fc, n_formants=n_f)
        if dims == "formant":
            return {
                "ok": bool(ok_w),
                "path": pitch_path(wav_path),
                "formantPath": formant_path(wav_path),
                "manualFrames": 0,
                "params": {"pitchFloor": pitch_floor_for(defaults),
                           "pitchCeiling": pc, "nFormants": n_f,
                           "formantCeiling": fc, "timeStep": time_step_for(defaults)},
                "log": "已写入平滑（Track）后的 .Formant",
                "error": None if ok_w else (err_w or "平滑导出失败"),
            }
        # dims == "both"：共振峰已写回，F0 仍走普通 burg（只导 pitch），共振峰不被覆盖
        dims = "pitch"
        smoothed_formant_done = True
    # 「修周期」保护（见 review_grid.read_pp_result）：wav 旁的 .Pitch 是人在 Praat 里
    # 逐周期修出来的最终结果，重算会把它整个覆盖。标记在且本次要导 pitch 时直接
    # 返回现有对象，不跑 Praat；只导 formant 时不受它影响（照常现算 .Formant）。
    if dims in ("both", "pitch") and isinstance(choice, dict) \
            and choice.get("ppfix") and os.path.isfile(pitch_path(wav_path)):
        ok = is_reviewed(wav_path)
        return {"ok": ok, "path": pitch_path(wav_path),
                "formantPath": formant_path(wav_path), "manualFrames": 0,
                "params": {"pitchFloor": pitch_floor_for(defaults), "pitchCeiling": pc,
                           "nFormants": n_f, "formantCeiling": fc,
                           "timeStep": time_step_for(defaults)},
                "log": "该文件已人工修周期（ppfix），跳过重算以保护修正结果",
                "error": None if ok else "已有修周期结果但缺 .Formant 对象"}
    log, err = _run_batch([(wav_path, name, name, pc, n_f, fc, custom, dims)], exe,
                          os.path.dirname(wav_path), f0_floor=pitch_floor_for(defaults),
                          time_step=time_step_for(defaults))
    if err:
        probe = (formant_path if dims == "formant" else pitch_path)(wav_path)
        if not os.path.isfile(probe):
            return {"ok": False, "error": err, "log": log}

    # 人工修正点是 F0 维的事；只导共振峰时不碰 .Pitch。
    # deleted = 被删的原始测量帧（桥接值写回，见 apply_manual_pitch）。
    if dims != "formant":
        manual = [p for p in ((choice or {}).get("manual") or []) if isinstance(p, dict)]
        deleted = (choice or {}).get("deleted") or []
    else:
        manual, deleted = [], []
    n_fixed = apply_manual_pitch(pitch_path(wav_path), manual, deleted) \
        if (manual or deleted) else 0

    # 成功判定按维度来：只看本次导的那一维的产物是否新鲜
    def _fresh(p):
        return os.path.isfile(p) and os.path.getmtime(p) >= started - 1
    p_fresh, f_fresh = _fresh(pitch_path(wav_path)), _fresh(formant_path(wav_path))
    if dims == "both" and (smoothed_formant_done or imported_formant_done):
        ok = p_fresh and f_fresh   # 单独写回的共振峰也要求新鲜（前面已写回）
    else:
        ok = {"pitch": p_fresh, "formant": f_fresh, "both": p_fresh and f_fresh}[dims]
    return {
        "ok": bool(ok),
        "path": pitch_path(wav_path),
        "formantPath": formant_path(wav_path),
        "manualFrames": n_fixed,
        "params": {"pitchFloor": pitch_floor_for(defaults), "pitchCeiling": pc,
                   "nFormants": n_f, "formantCeiling": fc,
                   "timeStep": time_step_for(defaults)},
        "log": log,
        "error": None if ok else (err or "导出后没有找到对象文件"),
    }


def _stamp_audited(wav_path, pc, n_f, fc, ch):
    """审核完成：给文件落 measure.json 的 choice（F0 / 共振峰两维都标成已审）。

    已存过真实参数的文件沿用原值，只补缺失的那一维（save_choice 合并语义）。
    写失败静默忽略——审核完成的主产物是对象文件，measure.json 标记只是让
    reviewed_state（看 choice.pitch/formant）能认出整批过关的文件。
    """
    from . import review_choice

    new_ch = dict(ch) if isinstance(ch, dict) else {}
    if not isinstance(new_ch.get("pitch"), dict):
        new_ch["pitch"] = {"id": str(int(round(pc))), "label": "F0 %s" % int(round(pc))}
    if not isinstance(new_ch.get("formant"), dict):
        new_ch["formant"] = {
            "id": "%d-%d" % (int(round(fc)), int(n_f)),
            "label": "%d Hz · %d 个" % (int(round(fc)), int(n_f)),
        }
    try:
        review_choice.save_choice(wav_path, new_ch)
    except Exception:
        pass


def export_dir(dir_path, defaults=None, exe=None, on_progress=None):
    """把目录下**所有** wav 的 F0/共振峰导出成对象文件（九宫格「审核完成」调用）。

    没改过的文件用它的 measure.json 记录（没有记录就用 defaults）导出——
    这样每个文件都有对象，批量时才能全部读对象、一个都不重算。
    """
    # 重采样后工作目录自动切到 Resample/（见 working_dir）：审计只应处理工作副本，
    # 否则会把原始目录(samples/1)的同名文件也一起导出，与批量 / 第四步互相覆盖。
    dir_path = working_dir.resolve_working_dir(dir_path, "wav")
    from . import review_choice

    wavs = _list_wavs(dir_path, "wav")
    if not wavs:
        return {"ok": False, "error": "该目录没有 wav 文件", "dir": dir_path}
    exe = _resolve_exe(exe)
    if not exe:
        return {"ok": False, "error": "没有找到 Praat 程序", "dir": dir_path}

    pairs = []
    manuals = {}
    ppfixed = []   # 已人工修周期的文件：跳过重算（防止覆盖），直接计入 done
    smoothed_files = []   # 已 Track 平滑的文件：(full, rel, fc) —— burg 只算 F0，共振峰单独写回
    imported_files = []   # 「读入的结果」就是定稿的文件：(full, rel) —— 同上，不重抽
    existing_files = []   # 对象文件都在的文件：(full, rel, pc, n_f, fc, ch) —— 只补标记，不重算
    failed_smoothed = []  # 平滑/读入文件里写回 .Formant 失败的，计入 failed
    done_info = {}    # full -> (pc, n_f, fc, choice)：审核完成要给每个文件落 measure.json 标记
    choices = {}      # full -> choice：第一循环里按文件记下，第二循环按文件取回（否则会拿到上一轮残留变量）
    for rel in wavs:
        full = os.path.join(dir_path, rel.replace("/", os.sep))
        try:
            ch = review_choice.read_choice(full).get("choice") or {}
        except Exception:
            ch = {}
        choices[full] = ch
        if isinstance(ch, dict) and ch.get("ppfix") and os.path.isfile(pitch_path(full)):
            ppfixed.append(rel)
            continue
        pc, n_f, fc = params_for(ch, defaults)
        custom = pitch_params_for(ch)
        if custom:
            pc = custom["ceiling"]
        # 「读入的结果」= 定稿（2026-09-26）：共振峰维完全不碰 Praat 抽取，
        # 只让 F0 进 burg 清单，共振峰在下面的第二循环里原样写回。
        if isinstance(ch, dict) and ch.get("formantImported"):
            pairs.append((full, rel, rel, pc, n_f, fc, custom, "pitch"))
            imported_files.append((full, rel))
        elif isinstance(ch, dict) and ch.get("formantSmoothed"):
            # 平滑文件：共振峰用 Track 写回（下面统一处理），burg 只算 F0（dims=pitch），
            # 防止普通 burg 把平滑后的 .Formant 覆盖回原始曲线。
            pairs.append((full, rel, rel, pc, n_f, fc, custom, "pitch"))
            smoothed_files.append((full, rel, fc, n_f))
        else:
            # 落盘即权威（2026-09-27 用户定案）：九宫格首次进入时系统已自动算好
            # pitch/formant 并存盘。这些文件没进过详情窗、没有审核标记，点「审核完成」
            # 只是**给它们补一个审核结束的标签**——绝不重算覆盖（再跑 burg 只会把
            # 好数据冲掉）。只有对象文件缺失时才补算，且缺哪维补哪维。
            has_p = os.path.isfile(pitch_path(full))
            has_f = os.path.isfile(formant_path(full))
            if has_p and has_f:
                existing_files.append((full, rel, pc, n_f, fc, ch))
                continue
            dims = "formant" if has_p else ("pitch" if has_f else "both")
            pairs.append((full, rel, rel, pc, n_f, fc, custom, dims))
        pts = [p for p in (ch.get("manual") or []) if isinstance(p, dict)]
        dels = ch.get("deleted") or []
        if pts or dels:
            manuals[full] = (pts, dels)

    started = time.time()
    if on_progress:
        on_progress(0, len(pairs))
    log, err = _run_batch(pairs, exe, dir_path, f0_floor=pitch_floor_for(defaults),
                          time_step=time_step_for(defaults))
    # 平滑文件：在 burg（只写了 .Pitch）之后，单独把共振峰维写回为 Track 平滑后的 .Formant。
    for full, rel, fc, n_f in smoothed_files:
        ok_w, _ = write_smoothed_formant(full, review_choice.read_choice(full).get("choice") or {},
                                         exe=exe, formant_ceiling=fc, n_formants=n_f)
        if not ok_w:
            failed_smoothed.append(rel)
    # 读入结果的文件：共振峰维原样写出（Pull 而不是重抽），失败同上计入 failed
    for full, rel in imported_files:
        ok_i, _ = write_imported_formant(
            full, review_choice.read_choice(full).get("choice") or {}, exe=exe)
        if not ok_i:
            failed_smoothed.append(rel)

    imported_set = set(f for f, _r in imported_files)

    done, failed, fixed = list(ppfixed), [], 0
    for full, _n, rel, _pc, _nf, _fc, _cu, _dm in pairs:
        p = pitch_path(full)
        f = formant_path(full)
        # 平滑/读入文件的共振峰是上面单独写回的，这里要把它的新鲜度一并算上
        if any(full == sfull for sfull, *_ in smoothed_files) or full in imported_set:
            fresh = (os.path.isfile(p) and os.path.isfile(f)
                     and os.path.getmtime(p) >= started - 1
                     and os.path.getmtime(f) >= started - 1)
        else:
            fresh = (os.path.isfile(p) and os.path.isfile(f)
                     and os.path.getmtime(p) >= started - 1)
        if fresh:
            done.append(rel)
            # 用本文件自己的参数（来自 pair 元组 _pc/_nf/_fc），而非第一循环残留的 pc/n_f/fc
            done_info[full] = (_pc, _nf, _fc, choices.get(full, {}))
            if full in manuals:
                fixed += apply_manual_pitch(p, manuals[full][0], manuals[full][1])
        else:
            failed.append(rel)

    # 对象文件都在的文件：直接计入 done 并补审核标记（没跑 Praat，不存在新鲜度问题）
    for full, rel, pc, n_f, fc, ch in existing_files:
        done.append(rel)
        done_info[full] = (pc, n_f, fc, ch)

    # 审核完成：把整批文件都标记成「已审核」（F0 / 共振峰两维都标），写进 measure.json。
    # 这样 reviewed_state（看 measure.json 的 choice.pitch/formant）能认出整批过关的文件；
    # 单文件详情页点过存盘的会沿用原值，只补缺失的那一维（save_choice 合并语义）。
    for full, info in done_info.items():
        _stamp_audited(full, info[0], info[1], info[2], info[3])
    for rel in ppfixed:
        full = os.path.join(dir_path, rel.replace("/", os.sep))
        try:
            pch = review_choice.read_choice(full).get("choice") or {}
        except Exception:
            pch = {}
        if not isinstance(pch, dict):
            pch = {}
        _stamp_audited(full, *params_for(pch, defaults), pch)

    return {
        "ok": len(failed) == 0 and len(failed_smoothed) == 0,
        "dir": dir_path,
        "total": len(pairs) + len(ppfixed) + len(existing_files),
        "done": len(done),
        "failed": failed + failed_smoothed,
        "ppfixSkipped": len(ppfixed),
        "existingSkipped": len(existing_files),
        "smoothedWritten": len(smoothed_files),
        "manualFrames": fixed,
        "elapsed": round(time.time() - started, 1),
        "log": log,
        "error": (err or (failed_smoothed and "部分平滑文件写回 .Formant 失败")) if (failed or failed_smoothed) else None,
    }
