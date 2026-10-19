# -*- coding: utf-8 -*-
"""全量审查网格：一次 Praat 启动批量抽取一页目录的 F0 / 共振峰。

与 review_build（单文件、多 ceiling 候选、供详情页选最优）不同，网格视图面向
"全量过一遍"：每个文件只做一组默认参数的抽取（单 ceiling），用于九宫格一眼浏览；
具体的候选对比 / 手动画 F0 在单文件详情里做（仍走 review_build）。

设计要点：
- 动态生成一次性 Praat 脚本（把本页要处理的 wav 路径直接写进脚本），避免依赖
  Praat 侧逐行读清单的脆弱语法；只使用已验证可靠的 Read / To Pitch / To Formant /
  Save as text file 命令。每个文件用 if/else 守护，单文件读失败不影响整页。
- 每个文件抽取 Pitch 与 Formant 各一份（默认 ceiling），后端读回 JSON 点序列并
  降采样，便于前端任意切换 F0 / 共振峰模式而不必重新抽 Praat。
"""

import os
import re
import json
import math
import shutil
import tempfile
import subprocess
import datetime

from . import settings, praat, praat_objects, audio, review_choice, formant_path, vowel_ref
from . import working_dir

# 每个文件在网格里最多保留的点数（降采样用），控制单页 JSON 体积
MAX_POINTS = 320


def _resolve_exe(exe):
    """解析 Praat 可执行文件路径：显式参数 > 用户设置(praatExe) > 常见位置探测。

    ⚠️ 用户设置存的是 settings.json 里的 ``praatExe`` 键（camelCase dict），
    不是 settings 模块属性——之前写 ``settings.praat_exe`` 永远取不到值，
    每次都靠 detect_praat 全盘遍历兜底（能找到项目自带 praat.exe，但慢）。
    """
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


def _list_wavs(dir_path, ext="wav"):
    """递归收集 dir_path 下全部 .wav，返回相对 dir_path 的路径（用 / 分隔），按名排序。"""
    ext = (ext or "wav").strip().lstrip(".").lower()
    if not dir_path or not os.path.isdir(dir_path):
        return []
    try:
        found = []
        for root, dirs, files in os.walk(dir_path):
            # 跳过重采样工作副本目录（2026-10-02）：工作目录以用户指定为准，
            # 用「指定在哪就在哪」+ 扫描层排除 Resample/ 来根治双副本，
            # 不再靠后端偷偷切到 Resample/。父目录（含原始 wav）直接选就只处理父目录，
            # 要 16k 副本就直接选 Resample/。
            dirs[:] = [x for x in dirs if x.lower() != "resample"]
            for n in files:
                if n.lower().endswith("." + ext):
                    rel = os.path.relpath(os.path.join(root, n), dir_path)
                    found.append(rel.replace(os.sep, "/"))
        return sorted(found)
    except Exception:
        return []


def _downsample(points, max_points):
    if not points or len(points) <= max_points:
        return points
    stride = math.ceil(len(points) / max_points)
    return points[::stride]


def _find_textgrid(wav, dir_path):
    """定位 wav 对应的 TextGrid。

    优先级：① wav 同目录同名 ``<base>.TextGrid``（常规）；② 退化到整棵目录树下
    同名 ``<base>.TextGrid``（唯一命中才采用）—— 应对用户把 TextGrid 放在子目录、
    或先在别处做好再拷进来的情况。都找不到返回 None。
    """
    if not wav:
        return None
    sibling = os.path.splitext(wav)[0] + ".TextGrid"
    if os.path.isfile(sibling):
        return sibling
    base = os.path.splitext(os.path.basename(wav))[0].lower()
    hits = []
    try:
        for root, _dirs, files in os.walk(dir_path):
            for fn in files:
                if not fn.lower().endswith(".textgrid"):
                    continue
                if os.path.splitext(fn)[0].lower() == base:
                    hits.append(os.path.join(root, fn))
    except Exception:
        pass
    return hits[0] if len(hits) == 1 else None


def _syllable_span(intervals):
    """非静音段的总跨度 [t0, t1]，供前端把视图裁到"有音的部分"。

    TextGrid 通常首尾各有一段静音（samples/1/11.wav：0–0.19 与 0.57–0.75 都是 sil），
    九宫格格子又小，不裁的话有效段只占一半宽度。返回 None 表示没有可用音节段。
    """
    ts = [(iv["t0"], iv["t1"]) for iv in intervals
          if (iv.get("label") or "").strip().lower() not in ("", "sil")]
    if not ts:
        return None
    return [round(min(t[0] for t in ts), 4), round(max(t[1] for t in ts), 4)]


def _read_tg_intervals(tg_path, name, report):
    """读 TextGrid -> [{t0,t1,label}]，并把「缺/坏」如实记进 report（不再静默吞掉）。"""
    if not tg_path:
        report["missing"].append(name)
        return []
    try:
        from . import syllables  # 延迟导入，避免与 syllables 的循环依赖
        _xmax, ivs = syllables.read_textgrid(tg_path)
    except Exception as e:
        report["error"].append("%s：%s" % (name, e))
        return []
    out = [{"t0": t0, "t1": t1, "label": label} for (t0, t1, label) in ivs]
    if out:
        report["loaded"] += 1
        return out
    report["error"].append("%s：TextGrid 里没有解析出任何区间" % name)
    return []


def _ipa_refs(ipa, gender):
    """元音音标 → Track 的参考频率 ``(f1, f2, f3)``（缺阶为 None → 回退自动估计）。

    取该元音期望共振峰的均值（vowel_ref.expected，男 / 女分开、缺性别回退通用均值）。
    双元音取**首段**近似（与 review_build 推荐组同一约定——Track 一次只吃一套参考值，
    全程同一套；双元音首尾段不同的精细区分只在择优打分里做，那里按音节分段）。
    元音不在参考库 / 没填音标 → None（调用方回退 Get mean 自动估计）。
    """
    if isinstance(ipa, str):
        segs = vowel_ref.parse_segments(ipa)
    else:
        segs = [s for s in (ipa or []) if s]
    if not segs:
        return None
    ref = vowel_ref.expected(segs[0], gender)
    if not ref:
        return None

    def _mean(key):
        v = ref.get(key)
        return v[0] if v and v[0] and v[0] > 0 else None

    out = (_mean("f1"), _mean("f2"), _mean("f3"))
    return out if any(out) else None


def _track_snippet(span, marker="", refs=None):
    """Praat 片段：对当前选中的 Formant 跑 Viterbi 轨迹跟踪（``Formant: Track``）。

    ``refs``（可选）= ``(rf1, rf2, rf3)``：来自元音音标期望值的参考频率（见 ``_ipa_refs``）。
    给了哪阶就用字面值（``rf1 = 300``），Track 的频率代价会把候选往参考值附近拉——
    这就是「有音标时按该元音优选轨迹」的落点；没给的阶（或没音标）回退 ``Get mean``
    自动估计（见下）。

    ⚠️ 四个坑（均实测踩过）：
    1. ``Track:`` 只接受 9 个参数（轨迹数, refF1..refF5, freqCost, bwCost, transCost），
       **没有 maximumFormant**；多写一个会报 "requires only 9 arguments"。
    2. Track 要求「每帧中落在它 4950 Hz 范围内的共振峰条数」的最小值 ≥ 轨迹数，否则
       **整条脚本中断**（Praat 7 无 try/catch，实测 ``try`` 报 Unknown variable）。
       而这个最小值**无法廉价预判**：实测共振峰数量取 4 时，同批数据的 11/14/15.wav
       失败、12/13.wav 却成功——数据相关，不能一刀切。
       —— 注意 ``To Formant (burg)`` 对象 **每帧的 numberOfFormants 是动态的**：
       实测 11.wav 的 113 帧里 12 帧只有 3 条、100 帧 4 条、仅 1 帧 5 条。
       ``Get number of formants: i`` 返回的是**该帧实际条数**（可小于 maxNumberOfFormants，
       后者由 ``Get maximum number of formants`` 读）。所以 ``minF >= 3`` 只是对这批
       样本恰好成立、并非恒真；换个样本就可能被它拦住，不能当可靠预判。
       故这里索性不预判，直接用 ``nocheck`` + 事后探测。
       现改为 ``nocheck Track: ...`` + 事后探测：``nocheck`` 让 Track 出错时**只跳过这一条
       命令**而不再中断整条脚本（否则一个文件失败会把整页剩下的文件全部带走）；
       随后用 ``Get maximum number of formants`` 判定——成功时 Track 会把对象压成 3 个
       共振峰，被跳过时仍是 nF 个。跳过了就写 ``TRACK_SKIP <marker>``，由后端收集成告警
       回传前端，**绝不静默**。
    3. Praat 里 ``fi`` 是 ``endif`` 的等价保留字，**不能当变量名**（会报 Symbol misplaced）；
       故循环变量用 ii / kk。
    4. 注意 ``Get value at time`` 在 Praat 7 里多一个第 4 参数 ``Interpolation``
       （``"linear"`` / ``"nearest"``），少写会报 "requires more than the given 3 arguments"。
       本片段不用它，只在此备注，免得以后要逐帧取值时再踩。

    refF1~refF3 用该 Formant 自身的均值自动估计：给了语音跨度时只在跨度内取
    （Praat 的 ``Get mean`` 默认取全段，静音段的垃圾候选会把参考抬高数百 Hz——实测
     14.wav 全段 F1 855 Hz 而语音段只有 315 Hz，轨迹会被带偏）。用户不必手填。
    """
    def _one(i, val):
        if val and val > 0:
            return "  rf%d = %g\n" % (i, val)
        if span and span[1] - span[0] > 0.02:
            return '  rf%d = Get mean: %d, %g, %g, "Hertz"\n' % (i, i, span[0], span[1])
        return '  rf%d = Get mean: %d, 0, 0, "Hertz"\n' % (i, i)

    r = refs if refs and len(refs) == 3 else (None, None, None)
    ref = _one(1, r[0]) + _one(2, r[1]) + _one(3, r[2])
    return (
        ref +
        "  nocheck Track: 3, rf1, rf2, rf3, 3850, 4950, 1, 1, 1\n"
        # ⚠️ 查询命令不能直接写在 if 条件里（Praat 报 Unknown symbol «Get» in formula），
        # 必须先赋给变量再判断。
        "  nfa = Get maximum number of formants\n"
        "  if nfa <> 3\n"
        '    writeInfoLine: "TRACK_SKIP %s"\n'
        "  endif\n"
        % marker
    )


def _track_warnings(log, page_keys, page_names):
    """从 Praat 日志收集 ``TRACK_SKIP`` 标记 → 告警文案（给界面用）。

    Track 用的是 ``nocheck``，出错只会跳过自己、不会中断整页——但必须如实报出来：
    这些文件这一页**没有做平滑**，看到的曲线还是逐帧候选而不是 Viterbi 轨迹。
    """
    if not log:
        return []
    name_of = dict(zip(page_keys, page_names))
    hit = []
    for line in log.splitlines():
        i = line.find("TRACK_SKIP")
        if i < 0:
            continue
        key = line[i + len("TRACK_SKIP"):].strip()
        nm = name_of.get(key, key)
        if nm not in hit:
            hit.append(nm)
    if not hit:
        return []
    shown = "、".join(hit[:6]) + ("…" if len(hit) > 6 else "")
    return ["%d 个文件未做平滑（%s）：其共振峰数量与该文件每帧可用的共振峰条数不兼容"
            "（Track 需要每帧至少 3 条落在 4950 Hz 内），曲线仍是逐帧候选，不是 Viterbi 轨迹"
            % (len(hit), shown)]


def _pitch_call(time_step, floor, ceiling):
    """滤波自相关（filtered autocorrelation）的 Praat 调用串。

    2026-09-25 用户拍板：基频抽取**统一用 filtered AC**，与主批量
    ``get_pitch.praat`` 的 ``pitchMethod=0`` 同款（此前审查侧用的是
    ``To Pitch: ts, floor, ceiling`` 三参形式 = raw AC，与批量不一致）。

    签名 11 参（Praat 7.0.02 实测）：
        timeStep, floor, pitchTop, maxNoCandidates, veryAccurate,
        attenuationAtTop, silence, voicing, octave, octaveJump, vuv
    第 3 参在 filtered 里叫 pitch top（标准 800Hz），这里传用户的 f0 上限，
    与主批量把 ``f0max`` 填在同一位的做法一致。其余取 Praat 标准值。
    """
    return ("To Pitch (filtered autocorrelation): %s, %g, %g, 15, 0, "
            "0.03, 0.09, 0.5, 0.055, 0.35, 0.14" % (time_step, floor, ceiling))


def _build_script(items, out_dir, pitch_ceiling, formant_ceiling, formant_track=False,
                  track_refs=None, pitch_floor=75.0, n_formants=5, track_ipa=None,
                  skip_pitch=None):
    """生成本页一次性 Praat 脚本：逐文件抽取 Pitch + Formant 并存文本（单 ceiling）。

    items: list of (wav_full_path, key)，key 是相对路径 flatten 后的唯一标识
    （如 "1_11"），避免 1/11.wav 与 2/11.wav 在临时目录里撞名。

    formant_track=True 时，对 Formant 追加 Praat 的 Viterbi 轨迹跟踪
    （``Formant: Track``），把逐帧候选连成平滑轨迹，消除 F2/F3 的上下跳。
    ``track_ipa``（可选）= {key: (f1,f2,f3)}：元音音标期望值当 Track 参考频率
    （见 ``_ipa_refs`` / ``_track_snippet``）；没给的文件回退自动估计。

    ``skip_pitch``（可选）= key 集合：这些文件 measure/ 里已有 .Pitch（复用语义），
    跳过 Pitch 抽取——只补缺的那一维，不做无用功（2026-09-26 用户批评重算浪费）。

    ``pitch_floor`` / ``n_formants`` 原先写死成 75 / 5，与批量运行的
    ``f0min`` / ``maxNumFormants`` 对不上——同一批数据「审核过」与「未审核」
    会走两套参数。现在由调用方从用户设置传入，保证审查看到的就是批量要用的。
    """
    skip = set(skip_pitch or ())
    blocks = []
    for wav, base in items:
        pitch_out = praat.q(os.path.join(out_dir, base + ".pitch").replace("\\", "/"))
        formant_out = praat.q(os.path.join(out_dir, base + ".formant").replace("\\", "/"))
        wav_u = praat.q(wav.replace("\\", "/"))
        track = (_track_snippet((track_refs or {}).get(base), base,
                                (track_ipa or {}).get(base))
                 if formant_track else "")
        if base in skip:
            pitch_block = ""
        else:
            pitch_block = ('  %s\n'
                           '  Save as text file: "%s"\n'
                           '  Remove\n'
                           % (_pitch_call("0.0", pitch_floor, pitch_ceiling), pitch_out))
        blocks.append(
            '''Read from file: "%s"
if selected("Sound", 1) = 0
  writeInfoLine: "GRID_SKIP"
else
  snd = selected("Sound", 1)
  selectObject: snd
%s  selectObject: snd
  To Formant (burg): 0.0, %g, %g, 0.025, 50
%s  Save as text file: "%s"
  Remove
  selectObject: snd
  Remove
endif
''' % (wav_u, pitch_block,
       n_formants, formant_ceiling, track, formant_out)
        )
    return "".join(blocks) + "writeInfoLine: \"OK grid done\"\n"


NF_CANDIDATES = (4, 5, 6, 7)  # 「多数量择优」扫描的共振峰数量（整数；Praat 的 maxNumberOfFormants 只能整数）


def _build_nf_script(items, out_dir, pitch_ceiling, formant_ceiling, pitch_floor=75.0,
                     nf_list=None, formant_track=True, track_refs=None, track_ipa=None,
                     skip_pitch=None):
    """「多数量择优」：对同一文件用不同 ``maxNumberOfFormants`` 各跑一套 ``To Formant (burg)``，
    由 Python 逐音节挑最合适的数量再合并成一条轨迹。Pitch 只抽一次（与数量无关）。

    文件名 ``<key>.F<nf>.formant``：Python 侧解析 → 逐音节打分 → 合并；
    不再依赖 FormantPath（它只能变 ceiling，变不了数量）。

    ``formant_track=True``（默认开，与九宫格「两处都默认平滑」同拍板）：每个数量的
    Formant 在存盘前都先过一遍 Viterbi 轨迹跟踪，择优合并用的就是平滑后的候选；
    Track 跳过的文件照旧落裸 burg（nocheck + 事后探测，见 ``_track_snippet``），
    由 ``_track_warnings`` 汇总成告警，绝不静默。

    ``skip_pitch``（可选）= key 集合：measure/ 里已有 .Pitch 的文件跳过 Pitch 抽取
    （复用语义，只补缺的一维；2026-09-26 用户批评重算浪费）。
    """
    nf_list = list(nf_list or NF_CANDIDATES)
    skip = set(skip_pitch or ())
    blocks = []
    for wav, base in items:
        pitch_out = praat.q(os.path.join(out_dir, base + ".pitch").replace("\\", "/"))
        wav_u = praat.q(wav.replace("\\", "/"))
        track = (_track_snippet((track_refs or {}).get(base), base,
                                (track_ipa or {}).get(base))
                 if formant_track else "")
        lines = ['Read from file: "%s"\n' % wav_u,
                 'if selected("Sound", 1) = 0\n',
                 '  writeInfoLine: "GRID_SKIP"\n',
                 'else\n',
                 '  snd = selected("Sound", 1)\n',
                 '  selectObject: snd\n']
        if base not in skip:
            lines += ['  %s\n' % _pitch_call("0.0", pitch_floor, pitch_ceiling),
                      '  Save as text file: "%s"\n' % pitch_out,
                      '  Remove\n']
        for nf in nf_list:
            formant_out = praat.q(os.path.join(out_dir, "%s.F%d.formant" % (base, nf)).replace("\\", "/"))
            lines.append('  selectObject: snd\n')
            lines.append('  To Formant (burg): 0.0, %d, %g, 0.025, 50\n' % (nf, formant_ceiling))
            lines.append(track)
            lines.append('  Save as text file: "%s"\n' % formant_out)
            lines.append('  Remove\n')
        lines.append('  selectObject: snd\n')
        lines.append('  Remove\n')
        lines.append('endif\n')
        blocks.append("".join(lines))
    return "".join(blocks) + 'writeInfoLine: "OK grid done"\n'


def _closest_index(seq, target):
    """离 target 最近的序号（默认数量 = 用户当前 maxNumFormants）。"""
    seq = list(seq)
    if not seq:
        return 0
    return min(range(len(seq)), key=lambda i: abs(seq[i] - target))


def _gender_of(speaker):
    """把 measure.json 里的 speaker 字段归一成 "male"/"female"/None（见 vowel_ref.gender_of）。"""
    return vowel_ref.gender_of(speaker)


def _gv(block, key):
    """从一行/几行里取 ``key = 数值`` 的数值（Praat 文本小工具）。"""
    for ln in block:
        if ln.strip().lower().startswith(key.lower()):
            m = re.search(r"=\s*([0-9eE.+-]+)", ln)
            if m:
                try:
                    return float(m.group(1))
                except ValueError:
                    return None
    return None


def _read_formant_frames(path):
    """解析单个 ``To Formant (burg)`` 文本：返回 ``{"xmin","dx","x1","nx","frames"}``。

    ``frames[i] = {"t": t, "c": [(freq, bw), ...]}``（含全部阶数，按出现顺序）。
    评分只用前三阶，但解析时把每阶的频率与带宽都留下，避免二次读取。
    """
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
    except Exception:
        return None
    start = 0
    for i, ln in enumerate(lines):
        if ln.strip().lower().startswith("xmin"):
            start = i
            break
    xmin = _gv(lines[start:start + 10], "xmin") or 0.0
    nx = int(_gv(lines[start:start + 10], "nx") or 0)
    dx = _gv(lines[start:start + 10], "dx") or 0.01
    x1 = _gv(lines[start:start + 10], "x1") or xmin
    fs = None
    for i in range(start, len(lines)):
        if re.match(r"\s*frames?\s*\[\s*1\s*\]", lines[i], re.I):
            fs = i
            break
    if fs is None:
        return None
    frames = []
    i = fs
    for fi in range(1, nx + 1):
        while i < len(lines) and not re.match(rf"\s*frames?\s*\[\s*{fi}\s*\]", lines[i], re.I):
            i += 1
        if i >= len(lines):
            break
        i += 1
        while i < len(lines):
            ln = lines[i].strip().lower().replace(" ", "")
            if ln.startswith("nformants") or ln.startswith("numberofformants"):
                i += 1
                break
            i += 1
        t = x1 + (fi - 1) * dx
        cands = []
        while i < len(lines):
            if re.match(r"\s*formant\s*\[\s*\]", lines[i], re.I):
                i += 1
                continue
            if not re.match(r"\s*formant\s*\[\s*\d+\s*\]", lines[i], re.I):
                break
            i += 1
            freq = None
            bw = None
            if i < len(lines) and "frequency" in lines[i].lower():
                freq = _gv([lines[i]], "frequency")
                i += 1
            if i < len(lines) and "bandwidth" in lines[i].lower():
                bw = _gv([lines[i]], "bandwidth")
                i += 1
            if freq is not None:
                cands.append((freq, bw))
        frames.append({"t": t, "c": cands})
    return {"xmin": xmin, "dx": dx, "x1": x1, "nx": nx, "frames": frames}


def _run_script(exe, out_dir, script, name):
    """把脚本写进 out_dir 并跑 Praat；成功返回 (None, log)，失败返回 (错误 dict, log)。"""
    sp = os.path.join(out_dir, name)
    with open(sp, "w", encoding="utf-8") as f:
        f.write(script)
    try:
        rc, lines = praat.run_script(exe, sp, [], cwd=out_dir, full_trust=True, timeout=600)
    except Exception as e:  # 连 Praat 都起不来
        return {"ok": False, "error": "调用 Praat 失败：%s" % e}, ""
    log = "\n".join("[%s] %s" % (l.get("tag", "?"), l.get("text", "")) for l in lines)
    # 允许个别文件被 GRID_SKIP，只要整页跑完即可
    if rc != 0 and "OK grid done" not in log:
        return {"ok": False, "error": "Praat 运行失败（详见日志）", "log": log}, log
    return None, log


def _merge_nf(out_dir, page_keys, tgs, nf_list, default_index, ipa_meta=None, page_names=None):
    """读回各数量的 Formant 文本 → 逐音节挑数量 → 合并成一条 F1/F2/F3 轨迹。

    复用 ``formant_path`` 的「带宽体检 + 帧间平滑度」打分（与旧 ceiling 择优同一套判据），
    只是把"候选"从多套 ceiling 换成多套数量；并可选接入「元音音标参考」软先验
    （``ipa_meta``：每文件 ``{"ipa": [...音段], "gender": "male"/"female"/None}``）：
    在打分里并入"稳态中值 vs 期望"的尺度无关 + 比例偏差，且**优先保持相邻区间同一套、
    减少共振峰轨迹断裂**。返回 ``{"forms": {key: 点列}, "switched", "intervals", "failed"}``，
    ``forms`` 与 ``read_formant_text`` 同形状，直接喂前端。

    ⚠️ 各数量共享同一 wav 与同一 timeStep（0.0=自动），帧网格一致，按帧序号对齐即可；
       某帧落在静音段则取默认数量那套（前端会遮掉静音段，不影响判读）。
    """
    nf_list = list(nf_list or NF_CANDIDATES)
    forms = {}
    switched = 0
    intervals = 0
    failed = []
    ipa_meta = ipa_meta or {}
    for key, (_tg, ivs), _name in zip(page_keys, tgs, page_names or [None] * len(page_keys)):
        variants = []   # [(nf, parsed), ...]，跳过解析失败的
        for nf in nf_list:
            p = os.path.join(out_dir, "%s.F%d.formant" % (key, nf))
            parsed = _read_formant_frames(p)
            if parsed and parsed["frames"]:
                variants.append((nf, parsed))
        if not variants:
            failed.append(key)
            forms[key] = []
            continue
        base = variants[0][1]
        nx = base["nx"]
        dx = base["dx"]
        x1 = base["x1"]
        xmin = base["xmin"]
        # 取最后一帧的实际时间为 xmax：Praat 的 x1 常 = xmin + dx/2，若按
        # xmin + (nx-1)*dx 反推会把末帧挡在定义域外，导致 choose 的逐段切片少掉末帧、
        # 退化成默认数量。用真实帧时间铺满定义域最稳。
        base_frames = base["frames"]
        xmax = (max(f["t"] for f in base_frames)
                if base_frames else (xmin + (nx - 1) * dx if nx > 1 else xmin + 1.0))
        cand_frames = [v[1]["frames"] for v in variants]
        ivs_part = formant_path.partition(xmin, xmax, ivs)
        di = max(0, min(int(default_index), len(variants) - 1))
        # 元音音标参考：双元音按首尾两半取不同元音，单元音全程同一元音。
        meta = ipa_meta.get(key) or {}
        segs = meta.get("ipa") or []
        if isinstance(segs, str):
            segs = vowel_ref.parse_segments(segs)
        gender = meta.get("gender")
        ref_list = None
        if segs:
            span = (xmax - xmin) or 1.0
            ref_list = []
            for (t0, t1, _lab) in ivs_part:
                t_frac = ((t0 + t1) / 2.0 - xmin) / span if span else 0.5
                ref_list.append(vowel_ref.ref_for_segment(segs, gender, t_frac))
        choices = formant_path.choose(cand_frames, ivs_part, default=di + 1, ref=ref_list)
        win = {}
        for (t0, t1, ix, _r) in choices:
            win[(round(t0, 6), round(t1, 6))] = ix - 1   # 1-based → 0-based 变体序号
        merged = []
        for fi in range(nx):
            t = x1 + fi * dx
            win_variant = di
            for (a, b, _lab) in ivs_part:
                if a - 1e-9 <= t <= b + 1e-9:
                    win_variant = win.get((round(a, 6), round(b, 6)), di)
                    break
            if win_variant < len(cand_frames) and fi < len(cand_frames[win_variant]):
                fr = cand_frames[win_variant][fi]
            else:
                fr = cand_frames[di][min(fi, len(cand_frames[di]) - 1)]
            cs = fr["c"]
            merged.append({
                "t": t,
                "F1": cs[0][0] if len(cs) > 0 else None,
                "F2": cs[1][0] if len(cs) > 1 else None,
                "F3": cs[2][0] if len(cs) > 2 else None,
            })
        for (t0, t1, ix, reason) in choices:
            if reason.startswith("静音段"):
                continue
            intervals += 1
            if ix != (di + 1):
                switched += 1
        forms[key] = merged
    return {"forms": forms, "switched": switched, "intervals": intervals, "failed": failed}


def build_grid(dir_path, page=0, size=9, pitch_ceiling=500.0, formant_ceiling=5500.0,
               ext="wav", exe=None, formant_track=True, formant_opt=False,
               pitch_floor=75.0, n_formants=5, reuse=True):
    # 重采样后工作目录自动切到 Resample/（见 working_dir）：审核九宫格只应处理工作副本，
    # 否则会同时拉到原始目录(samples/1)与 Resample/ 两套同名文件 → 互相覆盖 / 空白。
    dir_path = working_dir.resolve_working_dir(dir_path, ext)

    """批量抽取一页目录的 F0 / 共振峰，返回网格 JSON。

    - 递归列出 dir_path 下全部 wav（含子目录，按相对路径排序），按 page/size 切片，
      单个 Praat 进程处理本页；
    - 每个文件读回 Pitch/Formant 文本 -> JSON 点序列（降采样到 MAX_POINTS）；
    - 返回 total/pages 供前端分页；name 为相对路径（如 "1/11.wav"）便于区分子目录；
    - 输出键用相对路径 flatten（"1_11"），避免不同子目录下同名文件互覆盖。
    - formant_track=True（**默认开**，2026-09-26 用户拍板「九宫格与详情页两处都默认
      平滑」）：对 Formant 追加 Praat Viterbi 平滑（`Formant: Track`）；普通路径在
      burg 之后 Track 一次，「多数量择优」路径对每个数量的 Formant 都先 Track 再存盘，
      择优合并用的就是平滑后的候选。
    - formant_opt=True：改为「多数量择优」——对同一文件用不同 ``maxNumberOfFormants``
      （4/5/6/7，均为整数；Praat 的 maxNumberOfFormants 只能整数）各跑一套
      ``To Formant (burg)``，再由 `formant_path` 逐音节打分挑一套数量并合并成
      一条 F1/F2/F3 轨迹（见 `_merge_nf`）。默认数量 = 用户当前的 maxNumFormants
      （就近取 4/5/6/7）。不再依赖 FormantPath（它只能变 ceiling，变不了数量）。
    - reuse=True（**默认开**，2026-09-26 用户拍板「优先读存盘的中间文件」）：
      measure/ 里已有 .Pitch / .Formant（详情页存盘、审核完成、或本函数此前生成）就
      直接读它展示，**不再重算**；缺哪维补哪维，且现算的结果**立即复制到 measure/
      存盘**——下一页进来（或批量运行）直接复用，不用一遍遍重复生成。「刷新」
      就是重新走一遍「读盘 → 缺的补算 → 存盘」。

    四个抽取参数（pitch_floor / pitch_ceiling / formant_ceiling / n_formants）由调用方
    从用户当前设置传入（f0min / f0max / maxFormantHz / maxNumFormants），并在返回里回显——
    前端据此把语图纵轴与共振峰线纵轴设成同一个上限（否则轨迹会与语图错位）。
    """
    if not dir_path or not os.path.isdir(dir_path):
        return {"ok": False, "error": "目录不存在：%s" % dir_path}
    exe = _resolve_exe(exe)
    if not exe:
        return {"ok": False, "error": "找不到 Praat 程序（请在设置里指定）"}

    all_wavs = _list_wavs(dir_path, ext)   # 相对路径列表
    total = len(all_wavs)
    if total == 0:
        return {"ok": True, "dir": dir_path, "page": int(page), "size": int(size),
                "total": 0, "pages": 0, "files": [],
                "pitchFloor": float(pitch_floor), "pitchCeiling": float(pitch_ceiling),
                "formantCeiling": float(formant_ceiling), "nFormants": float(n_formants)}

    size = max(1, int(size))
    pages = (total + size - 1) // size
    page = max(0, min(int(page), pages - 1))
    start = page * size
    page_names = all_wavs[start:start + size]
    page_wavs = [os.path.join(dir_path, n) for n in page_names]
    # 唯一输出键：相对路径去扩展名 + 分隔符转下划线
    page_keys = [os.path.splitext(n)[0].replace("/", "_").replace("\\", "_")
                 for n in page_names]

    # TextGrid 只读一次：既要给脚本里 Track 的参考频率限定语音段（见 _build_script），
    # 又要填进下面每个文件的 intervals。缺 / 坏照旧由 _read_tg_intervals 记入 tg_report。
    tg_report = {"loaded": 0, "missing": [], "error": []}
    tgs = []
    for wav, name in zip(page_wavs, page_names):
        tg_path = _find_textgrid(wav, dir_path)
        tgs.append((tg_path, _read_tg_intervals(tg_path, name, tg_report)))
    # Track 参考频率的取样区间 = TextGrid 里的语音跨度。Praat 的 Get mean 默认取全段，
    # 静音段的垃圾候选会把参考抬高数百 Hz（实测 14.wav 全段 F1 855 而语音段 315），
    # 导致自动参考反而把轨迹带偏。没有 TextGrid（或没有非静音段）时不收窄，脚本回退全段。
    track_refs = {}
    if formant_track:
        for (_tg, ivs), key in zip(tgs, page_keys):
            span = _syllable_span(ivs)
            if span:
                track_refs[key] = span

    # 读回每个文件已存盘的元音音标 / 说话人性别（两条抽取路径共用）：
    # ① 择优打分的软先验（_merge_nf；音标参考只在该文件填了 vowel_ipa 时生效，
    #    性别缺失则回退通用均值）；② Track 参考频率（_ipa_refs：有音标时连线
    #    偏向该元音的候选，没音标回退 Get mean 自动估计）。
    ipa_meta = {}
    choices = {}                         # key -> 该文件 wav 旁 measure.json 的 choice（下面复用）
    for wav, key in zip(page_wavs, page_keys):
        ch = review_choice.read_choice(wav).get("choice") or {}
        choices[key] = ch
        ipa_meta[key] = {"ipa": ch.get("vowel_ipa"),
                         "gender": _gender_of(ch.get("speaker"))}
    track_ipa = {}
    if formant_track:
        for key, meta in ipa_meta.items():
            refs = _ipa_refs(meta.get("ipa"), meta.get("gender"))
            if refs:
                track_ipa[key] = refs

    # 「有存盘中间文件优先复用」（2026-09-26 用户拍板）：wav 旁已有 .Pitch / .Formant
    # 就直接读它展示、不重算；缺哪维补哪维（只对缺的文件跑 Praat），现算的结果再
    # 存回 wav 旁——下次进来直接复用。详情页存盘后回到九宫格，读的就是新存的文件，
    # 不再出现「改了参数存了盘、九宫格还是旧曲线」。
    from .review_export import pitch_path as _disk_pitch, formant_path as _disk_formant
    # 中间结果统一进 measure/ 子目录（2026-09-27 方案 A）：凡可能要写盘的文件先建目录，
    # 防止 copy2/write 因目录不存在静默失败（异常都被吞，表现为“算了却没存上”）。
    from .review_export import ensure_measure_dir as _ensure_measure
    for wav, key, name in zip(page_wavs, page_keys, page_names):
        if not (bool(reuse) and os.path.isfile(_disk_pitch(wav))
                and os.path.isfile(_disk_formant(wav))):
            _ensure_measure(wav)
    disk_pitch, disk_formant = {}, {}    # key -> bool（该维是否用 wav 旁存盘文件）
    need_items, need_names = [], []      # 缺文件的（要跑 Praat 的）子集
    for wav, key, name in zip(page_wavs, page_keys, page_names):
        hp = bool(reuse) and os.path.isfile(_disk_pitch(wav))
        hf = bool(reuse) and os.path.isfile(_disk_formant(wav))
        disk_pitch[key] = hp
        disk_formant[key] = hf
        if not (hp and hf):
            need_items.append((wav, key))
            need_names.append(name)
    need_keys = [k for _w, k in need_items]
    keep = set(need_keys)
    # 注意保持 (tg_path, intervals) 元组形状——_merge_nf 内部按 `for key, (_tg, ivs)`
    # 解包（2026-09-26 踩过坑：写成只留 tg 路径字符串，_merge_nf 解包字符串报
    # "too many values to unpack (expected 2)"）。
    need_tgs = [tg for tg, k in zip(tgs, page_keys) if k in keep]

    # 「复用对象平滑升级」（2026-09-26 用户反馈：12.wav 九宫格不平滑、详情页却平滑）：
    # 复用定案之后，wav 旁平滑机制上线前导出的旧裸 burg .Formant 会被九宫格原样展示
    # （不平滑），详情页打开时又默认跑 Track（平滑）→ 两处不一致。
    # 调解（与既有三条拍板相容）：共振峰维**未审定**（choice.formant 为空）的盘上对象
    # 不是人工成果 → 九宫格加载时对它们补跑一次 Track，把平滑对象写回盘上（与「现算
    # 落盘」同一哲学：盘上对象逐步收敛为平滑权威版，下次复用零开销）；已审定的尊重
    # formantSmoothed 标记——true = 盘上已是平滑版不用动；false = 审定明确不要平滑，
    # 九宫格与详情页都不强加（详情页 openDetail 见同日前端补丁）。
    # formant_opt（择优）本来就用合并平滑轨迹、且不落盘；formant_track=False（关平滑）
    # 时用户就是要看裸曲线——两者都跳过升级。
    upgrade_items, upgrade_names = [], []
    if reuse and formant_track and not formant_opt:
        for wav, key, name in zip(page_wavs, page_keys, page_names):
            if not disk_formant.get(key):
                continue
            ch = choices.get(key) or {}
            if ch.get("formant") is not None or ch.get("formantSmoothed") is True:
                continue        # 已审定 / 盘上已是平滑版
            if ch.get("formantSmoothed") is False:
                continue        # 审定明确不平滑 → 尊重
            upgrade_items.append((wav, key))
            upgrade_names.append(name)
    upgrade_keys = [k for _w, k in upgrade_items]

    out = tempfile.mkdtemp(prefix="psgrid_")
    opt_info = None
    warnings = []
    try:
        page_items = need_items
        if page_items and formant_opt:
            # 「多数量择优」：同一份 Pitch，按 4/5/6/7 各跑一套 To Formant (burg)，
            # Python 逐音节打分挑数量 → 合并一条轨迹（见 _merge_nf）。单趟，无需 Extract。
            di = _closest_index(NF_CANDIDATES, float(n_formants))
            err, log = _run_script(exe, out, _build_nf_script(
                page_items, out, float(pitch_ceiling), float(formant_ceiling),
                pitch_floor=float(pitch_floor), nf_list=NF_CANDIDATES,
                formant_track=bool(formant_track), track_refs=track_refs,
                track_ipa=track_ipa,
                skip_pitch={k for k, v in disk_pitch.items() if v}), "grid_nf.praat")
            if err:
                return err
            opt_info = _merge_nf(out, need_keys, need_tgs, NF_CANDIDATES, default_index=di,
                                 ipa_meta=ipa_meta, page_names=need_names)
        elif page_items:
            err, log = _run_script(exe, out, _build_script(
                page_items, out, float(pitch_ceiling), float(formant_ceiling),
                formant_track=bool(formant_track), track_refs=track_refs,
                track_ipa=track_ipa,
                pitch_floor=float(pitch_floor), n_formants=float(n_formants),
                skip_pitch={k for k, v in disk_pitch.items() if v}), "grid.praat")
            if err:
                return err
        # Track 现在用 nocheck 跑：个别文件会让 Track 报错（实测共振峰数量取 4 时，
        # 同批数据里 11/14/15.wav 失败而 12/13.wav 成功，无法预先判定）。出错只跳过
        # 它自己、不再中断整页；但必须如实回传，免得让人以为这些文件已经平滑过了。
        if page_items:
            warnings = _track_warnings(log, need_keys, need_names)

            # 现算结果立即存盘（2026-09-26 用户拍板「生成后也要存盘」）：把临时目录里的
            # 对象复制到 wav 旁，下次进九宫格（或批量运行）直接复用，不再重复生成。
            # 择优模式不落 .Formant——合并轨迹是 Python 算的派生结果，不是 Praat 对象快照，
            # 落盘会冒充「原始测量」；其 .Pitch 照常落盘。reuse=False（强制全量现算）
            # 时**不落盘**——临时结果只用于本次显示，绝不覆盖 wav 旁已有对象（可能含人工修正）。
            for wav, key in need_items:
                if reuse and not disk_pitch[key]:
                    src = os.path.join(out, key + ".pitch")
                    if os.path.isfile(src):
                        try:
                            shutil.copy2(src, _disk_pitch(wav))
                            disk_pitch[key] = True
                        except OSError:
                            pass
                if reuse and not disk_formant[key]:
                    # 2026-09-26 用户定稿：择优+平滑的合并轨迹**直接落盘 .Formant**——
                    # 存盘即永久化，之后九宫格/详情窗/批量全读这份文件，不再重算。
                    # （旧「派生结果不落盘防冒充测量」取舍作废：文件就是权威结果。）
                    form_pts = (opt_info or {}).get("forms", {}).get(key) or []
                    if formant_opt and form_pts:
                        try:
                            if praat_objects.write_formant_text(_disk_formant(wav), form_pts):
                                disk_formant[key] = True
                        except OSError:
                            pass
                    elif not formant_opt:
                        src = os.path.join(out, key + ".formant")
                        if os.path.isfile(src):
                            try:
                                shutil.copy2(src, _disk_formant(wav))
                                disk_formant[key] = True
                            except OSError:
                                pass

        # 复用对象平滑升级（见上面 upgrade_items 的注释）：对旧裸 burg 对象补跑 Track。
        # Track 成功的文件把平滑对象写回 wav 旁（下次复用零开销）；Track 被 nocheck
        # 跳过的（_track_warnings 有记录）盘上保留裸对象、如实展示并计入 warnings。
        # 顺手把升级文件现算出的 .Pitch 也落盘（若它原本没有）——与「现算落盘」一致。
        formant_upgraded = 0
        if upgrade_items:
            up_refs = {k: v for k, v in track_refs.items() if k in set(upgrade_keys)}
            up_ipa = {k: v for k, v in track_ipa.items() if k in set(upgrade_keys)}
            err_u, log_u = _run_script(exe, out, _build_script(
                upgrade_items, out, float(pitch_ceiling), float(formant_ceiling),
                formant_track=True, track_refs=up_refs or None, track_ipa=up_ipa or None,
                pitch_floor=float(pitch_floor), n_formants=float(n_formants),
                skip_pitch={k for k, v in disk_pitch.items() if v}), "grid_upgrade.praat")
            if err_u:
                warnings.append("平滑升级未执行：" + err_u)
            else:
                # _track_warnings 返回的是给界面看的文案；这里要的是 key 集合，
                # 直接从日志解析 TRACK_SKIP 标记（与 _track_warnings 同一来源）。
                warned = set()
                for _line in (log_u or "").splitlines():
                    _i = _line.find("TRACK_SKIP")
                    if _i >= 0:
                        warned.add(_line[_i + len("TRACK_SKIP"):].strip())
                for wav, key in upgrade_items:
                    if key in warned:
                        continue          # Track 没跑成，盘上留裸对象、展示也用它
                    src = os.path.join(out, key + ".formant")
                    if os.path.isfile(src):
                        try:
                            shutil.copy2(src, _disk_formant(wav))
                            formant_upgraded += 1
                        except OSError:
                            pass
                for wav, key in upgrade_items:
                    if disk_pitch.get(key):
                        continue
                    src = os.path.join(out, key + ".pitch")
                    if os.path.isfile(src):
                        try:
                            shutil.copy2(src, _disk_pitch(wav))
                            disk_pitch[key] = True
                        except OSError:
                            pass
                warnings.extend(_track_warnings(log_u, upgrade_keys, upgrade_names))

        files = []
        for wav, name, key, (tg_path, intervals) in zip(page_wavs, page_names,
                                                        page_keys, tgs):
            pitch_path = os.path.join(out, key + ".pitch")
            pitch = []
            if disk_pitch[key]:
                # wav 旁已有 .Pitch（详情窗存盘 / 审核完成 / 上次九宫格生成）→ 直接读它。
                # 2026-09-26 用户定稿：存盘那一刻文件里就是最终结果（手工点已写进
                # candidates[1]），此后九宫格/详情窗/批量全读这份文件，不做任何重算重写。
                try:
                    pitch = praat_objects.read_pitch_text(_disk_pitch(wav))
                except Exception:
                    pitch = []      # 读不动退回现算（若有）
            if not pitch and os.path.exists(pitch_path):
                pitch = praat_objects.read_pitch_text(pitch_path)

            if formant_opt:
                if disk_formant[key]:
                    # 择优+平滑的结果已落盘 .Formant（首次生成时写入），直接读它——
                    # 与 F0 同一逻辑：存盘即永久化，之后只读不算。
                    try:
                        formant = praat_objects.read_formant_text(_disk_formant(wav))
                    except Exception:
                        formant = (opt_info or {}).get("forms", {}).get(key, [])
                else:
                    # 择优已合并好：直接用内存里的合并轨迹（与 read_formant_text 同形状）
                    formant = (opt_info or {}).get("forms", {}).get(key, [])
            else:
                tmp_formant_path = os.path.join(out, key + ".formant")
                formant = []
                if disk_formant[key]:
                    try:
                        formant = praat_objects.read_formant_text(_disk_formant(wav))
                    except Exception:
                        formant = []
                if not formant and os.path.exists(tmp_formant_path):
                    formant = praat_objects.read_formant_text(tmp_formant_path)
            # 展示层复用人工修周期结果（2026-09-25 用户反馈：修完重开九宫格还是旧曲线）。
            # measure.json 里记了 ppfix → wav 旁 .Pitch 是人眼逐周期修出来的权威结果，
            # 直接读它展示，不再用现算值。只对 ppfix 文件这么做：无 ppfix 的对象文件
            # 是审核导出的参数快照，改了抽取参数后是陈旧值，不能拿来冒充现算结果
            # （九宫格本职就是调参数对比；批量侧才有「有文件就复用」的 pitchRead）。
            choice = review_choice.read_choice(wav).get("choice") or {}
            pitch_fixed = False
            if isinstance(choice.get("ppfix"), dict):
                from .review_export import pitch_path as fixed_pitch_path
                fixed = fixed_pitch_path(wav)
                if os.path.isfile(fixed):
                    try:
                        pitch = praat_objects.read_pitch_text(fixed)
                        pitch_fixed = True
                    except Exception:
                        pass  # 修正文件读不动就退回现算曲线
            # 共振峰平滑落盘（2026-09-26）：measure.json 记了 formantSmoothed → wav 旁
            # .Formant 是 Track 平滑后的权威结果，直接读它展示（与 ppfix 读 .Pitch 同源），
            # 不再用现算 burg。只对平滑文件这么做：无标记的对象文件是审核导出的参数快照，
            # 改了抽取参数后是陈旧值，不能拿来冒充现算结果（与 ppfix 同一取舍）。
            formant_smoothed = False
            if isinstance(choice.get("formantSmoothed"), bool) and choice["formantSmoothed"]:
                from .review_export import formant_path as disk_formant_path
                fp = disk_formant_path(wav)
                if os.path.isfile(fp):
                    try:
                        formant = praat_objects.read_formant_text(fp)
                        formant_smoothed = True
                    except Exception:
                        formant_smoothed = False  # 读不动就退回现算曲线
            dur = audio._wav_info(wav)[0] or 0.0
            files.append({
                "name": name,
                "path": wav,
                "duration": round(dur, 3) if dur else 0.0,
                "pitch": _downsample(pitch, MAX_POINTS),
                "formant": _downsample(formant, MAX_POINTS),
                "intervals": intervals,
                # 让界面能说清"用的是哪份 TextGrid、音节段在哪"——以前只有 intervals，
                # 用户无法判断到底载入没有、载入的是哪一个文件。
                "tgPath": tg_path or "",
                "span": _syllable_span(intervals),
                # 该文件上次「存盘」记录下的参数（wav 同目录 *.measure.json）；没有则为 None。
                # 顺手带上，免得详情页为了显示"上次存的是哪组参数"再跑一次请求。
                "choice": choice,
                # True = F0 来自修周期导出的 .Pitch（展示层复用），界面要标明曲线来源
                "pitchFixed": pitch_fixed,
                # True = 共振峰来自 Track 平滑后的 .Formant（展示层复用），界面要标明曲线来源
                "formantSmoothed": formant_smoothed,
                # True = 这一维读的是 wav 旁已存盘的中间文件（非现算），界面标明数据来源
                "pitchSaved": bool(disk_pitch[key]),
                "formantSaved": bool(disk_formant[key]),
            })
    finally:
        shutil.rmtree(out, ignore_errors=True)

    return {
        "ok": True,
        "dir": dir_path,
        "page": page,
        "size": size,
        "total": total,
        "pages": pages,
        "files": files,
        # 让界面能明确区分「没有 TextGrid」还是「TextGrid 坏了」，不再静默显示为空
        "tg": tg_report,
        # 回显本次是否走了 Viterbi 平滑，供界面标明曲线来源
        "formantTrack": bool(formant_track),
        # 回显多数量择优：switched = 非静音段里真正换了数量的区间数
        "formantOpt": bool(formant_opt),
        "optSwitched": (opt_info or {}).get("switched"),
        "optIntervals": (opt_info or {}).get("intervals"),
        # 本页没能按预期完成的事（当前只有「某些文件未做 Track 平滑」），界面必须显示
        "warnings": warnings,
        # 回显本次抽取实际用的四个参数：前端要用 formantCeiling 设语图纵轴
        # （与共振峰线同一常量，防止轨迹与语图错位），另外三个便于界面文案说明。
        "pitchFloor": float(pitch_floor),
        "pitchCeiling": float(pitch_ceiling),
        "formantCeiling": float(formant_ceiling),
        "nFormants": float(n_formants),
        # 复用回显（2026-09-26）：本页各文件 F0 / 共振峰有几个读的存盘文件、
        # 几个是本次现算的（现算的已自动存盘）。界面据此说明数据来源。
        "reuse": bool(reuse),
        "computed": len(need_items),
        "pitchReused": sum(1 for k in page_keys if disk_pitch.get(k)),
        "formantReused": sum(1 for k in page_keys if disk_formant.get(k)),
        # 本页有几个复用的旧裸 burg 对象被补跑 Track 升级成了平滑版（并已写回盘上）。
        # 界面据此说明"这些文件的曲线来源已升级"；0 = 没有需要升级的。
        "formantUpgraded": formant_upgraded,
    }


# ------------------------------------------------------------------ 批量重测（覆盖式单维强抽）
# 用户从九宫格勾选若干文件 → 点「重测」→ 改参数 → 把选中的文件按新模式重新抽取，
# **覆盖**落盘的中间结果（.Pitch / .Formant），并清掉被覆盖维的手工修正标记。
# 与 build_grid 的 reuse（优先读旧文件、缺哪维补哪维、不覆盖）正好相反——这里
# 的语义就是"我要用新参数重做这些文件"。修正保护由前端弹窗 + 本模块 scan 两步把关：
# 先 scan 列出带手工修正的文件，用户逐文件决定覆盖/跳过后，再 execute 真正落盘。

def scan_corrections(dir_path, names, mode):
    # 重采样后工作目录自动切到 Resample/（见 working_dir），与 build_grid 同源口径。
    dir_path = working_dir.resolve_working_dir(dir_path, "wav")

    """扫描选中文档在指定维度上是否带手工修正标记，供前端弹窗逐文件决定覆盖/跳过。

    mode: 'f0' → 查 ppfix / manual / deleted；'formant' → 查 formantImported /
    formantSmoothed（仅 True 算，False 只是"不要平滑"开关，不是成果）。
    返回 [{name, types:[...]}]（只含带修正的文件）。
    """
    mode = (mode or "f0").lower()
    markers = ("ppfix", "manual", "deleted") if mode == "f0" \
        else ("formantImported", "formantSmoothed")
    out = []
    for n in (names or []):
        if not n:
            continue
        full = os.path.join(dir_path, n)
        if not os.path.isfile(full):
            continue
        ch = review_choice.read_choice(full).get("choice") or {}
        types = []
        for m in markers:
            v = ch.get(m)
            if m == "formantSmoothed":
                if v is True:
                    types.append(m)
            elif v not in (None, False, {}, []):
                types.append(m)
        if types:
            out.append({"name": n, "types": types})
    return out


def _build_rerun_script(items, out_dir, pitch_ceiling, formant_ceiling,
                        pitch_floor=75.0, n_formants=5, formant_track=True,
                        track_refs=None, track_ipa=None, dims="f0"):
    """重测专用脚本：只抽 ``dims`` 指定的单一维度（'f0' 或 'formant'），写临时目录。

    另一维完全不动（不抽、不写、不覆盖）——「重测跟模式走·单维」的硬约束，
    防止改 F0 参数时把好不容易人工精修过的共振峰也擦掉。formant 维按 formant_track
    决定是否追加 Viterbi 轨迹跟踪（与九宫格同款 ``_track_snippet``）。
    """
    blocks = []
    for wav, base in items:
        wav_u = praat.q(wav.replace("\\", "/"))
        lines = ['Read from file: "%s"\n' % wav_u,
                 'if selected("Sound", 1) = 0\n',
                 '  writeInfoLine: "GRID_SKIP"\n',
                 'else\n',
                 '  snd = selected("Sound", 1)\n',
                 '  selectObject: snd\n']
        if dims == "f0":
            pitch_out = praat.q(os.path.join(out_dir, base + ".pitch").replace("\\", "/"))
            lines.append('  %s\n' % _pitch_call("0.0", pitch_floor, pitch_ceiling))
            lines.append('  Save as text file: "%s"\n' % pitch_out)
            lines.append('  Remove\n')
        else:  # formant
            formant_out = praat.q(os.path.join(out_dir, base + ".formant").replace("\\", "/"))
            track = (_track_snippet((track_refs or {}).get(base), base,
                                    (track_ipa or {}).get(base)) if formant_track else "")
            lines.append('  To Formant (burg): 0.0, %g, %g, 0.025, 50\n'
                         % (n_formants, formant_ceiling))
            lines.append(track)
            lines.append('  Save as text file: "%s"\n' % formant_out)
            lines.append('  Remove\n')
        lines.append('  selectObject: snd\n')
        lines.append('  Remove\n')
        lines.append('endif\n')
        blocks.append("".join(lines))
    return "".join(blocks) + 'writeInfoLine: "OK grid done"\n'


def _clear_markers(wav, dims, formant_smoothed=None):
    """直接改写 wav 旁 measure/<主名>.measure.json：清掉被重测覆盖那一维的手工修正标记。

    必须**直接写整份 JSON**，不能走 review_choice.save_choice 的合并语义——后者对
    ppfix 等键"请求没带就回退 prev"，无法真正删除（2026-09 已踩）；重测覆盖 F0 维时，
    旧的 ppfix（修周期）/ manual（手工点）/ deleted（删帧）必须一并抹掉，否则落盘的新
    曲线会和 measure 里"已手工修过"的标记对不上（详情页 / 导出仍会读修正文件覆盖现算值）。
    - dims='f0'：删 ppfix / manual / deleted。
    - dims='formant'：删 formantImported；formantSmoothed 置为本次重抽实际是否做了 Track
      （formant_smoothed 由调用方按 formant_track 传入，避免标记与落盘文件真相不符）。
    """
    p = review_choice.choice_path(wav)
    data = {}
    if p and os.path.isfile(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f) or {}
        except Exception:
            data = {}
    if not isinstance(data, dict):
        data = {}
    if dims == "f0":
        for k in ("ppfix", "manual", "deleted"):
            data.pop(k, None)
    else:
        data.pop("formantImported", None)
        if formant_smoothed is not None:
            data["formantSmoothed"] = bool(formant_smoothed)
    try:
        from .review_export import ensure_measure_dir
        ensure_measure_dir(wav)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
    except Exception:
        pass  # 标记写不进只影响"导出跳过重算"判定，不阻塞重测落盘


def rerun_grid(dir_path, names, mode, pitch_ceiling=500.0, formant_ceiling=5500.0,
               pitch_floor=75.0, n_formants=5, formant_track=True, formant_opt=False,
               exe=None, ext="wav"):
    # 重采样后工作目录自动切到 Resample/（见 working_dir），与 build_grid 同源口径。
    dir_path = working_dir.resolve_working_dir(dir_path, ext)

    """批量重测：对选中的文件强制重抽指定维度并覆盖落盘，同时清掉该维手工修正标记。

    与 build_grid 的 reuse（读旧文件、缺补、不覆盖）相反——这里就是"用新参数重做"。
    - mode: 'f0'（只重写 .Pitch、清 F0 维标记）/ 'formant'（只重写 .Formant、清共振峰维标记）。
      单维硬约束：绝不误伤另一维（用户拍板"重测跟模式走·单维"）。
    - formant_opt=True 时共振峰走"多数量择优"（复用 _build_nf_script + _merge_nf），
      合并轨迹直接落盘 .Formant（与 build_grid 同一权威化策略）。
    - 返回 {ok, mode, done:[base...], errors:[base...], warnings:[...]}；
      base 是去扩展名 + 分隔符转下划线的唯一键（与九宫格 name→key 推导一致，便于前端对账）。
    """
    if not dir_path or not os.path.isdir(dir_path):
        return {"ok": False, "error": "目录不存在：%s" % dir_path}
    exe = _resolve_exe(exe)
    if not exe:
        return {"ok": False, "error": "找不到 Praat 程序（请在设置里指定）"}
    mode = (mode or "f0").lower()
    if mode not in ("f0", "formant"):
        return {"ok": False, "error": "mode 必须是 f0 或 formant"}
    items = []
    for n in (names or []):
        if not n:
            continue
        full = os.path.join(dir_path, n)
        if not os.path.isfile(full):
            continue
        base = os.path.splitext(n)[0].replace("/", "_").replace("\\", "_")
        items.append((full, base))
    if not items:
        return {"ok": False, "error": "选中的文件均不存在或没有选中任何文件"}

    from .review_export import (ensure_measure_dir as _ensure_measure,
                                pitch_path as _disk_pitch,
                                formant_path as _disk_formant)
    for full, _b in items:
        _ensure_measure(full)

    # Track 参考频率 / 元音音标先验（仅 formant 维需要，与 build_grid 同源）
    track_refs, track_ipa, ipa_meta = {}, {}, {}
    if mode == "formant":
        for full, base in items:
            tg_path = _find_textgrid(full, dir_path)
            ivs = _read_tg_intervals(tg_path, base,
                                     {"missing": [], "error": [], "loaded": 0})
            span = _syllable_span(ivs)
            if span:
                track_refs[base] = span
            ch = review_choice.read_choice(full).get("choice") or {}
            ipa_meta[base] = {"ipa": ch.get("vowel_ipa"),
                              "gender": _gender_of(ch.get("speaker"))}
        if formant_track:
            for base, meta in ipa_meta.items():
                refs = _ipa_refs(meta.get("ipa"), meta.get("gender"))
                if refs:
                    track_ipa[base] = refs

    out = tempfile.mkdtemp(prefix="psrerun_")
    done, errors, warnings = [], [], []
    try:
        if mode == "f0":
            err, log = _run_script(exe, out, _build_rerun_script(
                items, out, float(pitch_ceiling), float(formant_ceiling),
                pitch_floor=float(pitch_floor), n_formants=float(n_formants),
                dims="f0"), "rerun_f0.praat")
            if err:
                return err
            for full, base in items:
                src = os.path.join(out, base + ".pitch")
                if not os.path.isfile(src):
                    errors.append(base)
                    continue
                try:
                    shutil.copy2(src, _disk_pitch(full))
                    _clear_markers(full, "f0")
                    done.append(base)
                except OSError:
                    errors.append(base)
        else:  # formant
            if formant_opt:
                di = _closest_index(NF_CANDIDATES, float(n_formants))
                err, log = _run_script(exe, out, _build_nf_script(
                    items, out, float(pitch_ceiling), float(formant_ceiling),
                    pitch_floor=float(pitch_floor), nf_list=NF_CANDIDATES,
                    formant_track=bool(formant_track),
                    track_refs=track_refs or None, track_ipa=track_ipa or None),
                    "rerun_nf.praat")
                if err:
                    return err
                tgs_for_merge = []
                names_list, keys = [], []
                for full, base in items:
                    tg_path = _find_textgrid(full, dir_path)
                    ivs = _read_tg_intervals(tg_path, base,
                                             {"missing": [], "error": [], "loaded": 0})
                    tgs_for_merge.append((tg_path, ivs))
                    names_list.append(base)
                    keys.append(base)
                merged = _merge_nf(out, keys, tgs_for_merge, NF_CANDIDATES,
                                   default_index=di, ipa_meta=ipa_meta,
                                   page_names=names_list)
                for full, base in items:
                    pts = merged.get("forms", {}).get(base) or []
                    if not pts:
                        errors.append(base)
                        continue
                    try:
                        if praat_objects.write_formant_text(_disk_formant(full), pts):
                            _clear_markers(full, "formant",
                                           formant_smoothed=bool(formant_track))
                            done.append(base)
                        else:
                            errors.append(base)
                    except OSError:
                        errors.append(base)
            else:
                err, log = _run_script(exe, out, _build_rerun_script(
                    items, out, float(pitch_ceiling), float(formant_ceiling),
                    pitch_floor=float(pitch_floor), n_formants=float(n_formants),
                    formant_track=bool(formant_track),
                    track_refs=track_refs or None, track_ipa=track_ipa or None,
                    dims="formant"), "rerun_formant.praat")
                if err:
                    return err
                for full, base in items:
                    src = os.path.join(out, base + ".formant")
                    if not os.path.isfile(src):
                        errors.append(base)
                        continue
                    try:
                        shutil.copy2(src, _disk_formant(full))
                        _clear_markers(full, "formant",
                                       formant_smoothed=bool(formant_track))
                        done.append(base)
                    except OSError:
                        errors.append(base)
        if mode == "formant":
            warnings = _track_warnings(log, [b for _, b in items],
                                       [n for n, _ in items])
    finally:
        shutil.rmtree(out, ignore_errors=True)
    return {"ok": True, "mode": mode, "done": done, "errors": errors,
            "warnings": warnings}


# ------------------------------------------------------------------ 单格精修闭环
# 用户在九宫格点某格 → 「在 Praat 中打开」载入该 wav → 手动精修 F0/共振峰 →
# 在 Praat 里 Save as text file（F0 也可 Save as PitchTier file）→ 回到界面
# 「导入修正数据」选中导出文件，覆盖该格显示（用户拍板：读回修正数据，而非只重抽）。

def _sniff_kind(text):
    """按文件头猜类型：pitchtier / formantgrid / formant / pitch（默认 pitch）。"""
    head = (text or "")[:600].lower()
    if "pitchtier" in head:
        return "pitchtier"
    if "formantgrid" in head:
        return "formantgrid"
    if "formant" in head:
        return "formant"
    return "pitch"


def open_in_praat(path, exe=None):
    """用本机 Praat 打开 wav（新建 GUI 实例，声音载入对象窗口，供人工精修）。

    用 ``--new-open`` 而非 ``--run``：后者是无界面的脚本运行（headless），
    前者才会在可见的 Praat 窗口里打开数据文件，便于用户手动修正后导出。
    """
    exe = _resolve_exe(exe)
    if not exe:
        return {"ok": False, "error": "找不到 Praat 程序（请在设置里指定 praat.exe）"}
    if not path or not os.path.isfile(path):
        return {"ok": False, "error": "音频文件不存在：%s" % path}
    # 若同目录有同名 TextGrid，用脚本方式载入 wav+TextGrid 进入 View & Edit（可精修并写回）
    tg_path = os.path.splitext(path)[0] + ".TextGrid"
    if os.path.isfile(tg_path):
        from . import syllables
        return syllables.open_in_praat_with_tg(path, tg_path, exe)
    # 否则仅打开 wav
    try:
        subprocess.Popen([exe, "--new-open", path])
    except Exception as e:
        return {"ok": False, "error": "启动 Praat 失败：%s" % e}
    return {"ok": True}


def import_review_object(text, kind, wav_path=""):
    """解析用户从 Praat 导出的修正数据（Pitch / Formant / PitchTier 文本）。

    kind: "auto" | "f0" | "formant"。auto 时按文件头 sniff。
    返回 {ok, kind, points, count}，points 已降采样到 MAX_POINTS。

    ``wav_path``（2026-09-27）：共振峰导入时把**原始文本**直接写成 measure/ 子目录的
    ``.Formant``（读入即落盘，与修周期脚本同一待遇，无临时中转），同时在
    measure.json 记 ``formantImported`` 标记——之后九宫格 / 详情 / 导出都读这份
    落盘文件，不重抽。
    """
    if not text:
        return {"ok": False, "error": "没有收到数据"}
    kind = (kind or "auto").lower()
    if kind == "auto":
        kind = _sniff_kind(text)
    tmp = tempfile.mkdtemp(prefix="psimport_")
    fp = os.path.join(tmp, "obj.txt")
    try:
        with open(fp, "w", encoding="utf-8") as f:
            f.write(text)
        if kind in ("pitch", "pitchtier"):
            if kind == "pitchtier":
                pts = praat_objects.read_pitchtier_text(fp)
            else:
                pts = praat_objects.read_pitch_text(fp)
                if not pts:  # 退化：也许其实是 PitchTier
                    pts = praat_objects.read_pitchtier_text(fp)
            det = "pitch"
        elif kind in ("formant", "formantgrid"):
            if kind == "formantgrid":
                pts = praat_objects.read_formantgrid_text(fp)
            else:
                pts = praat_objects.read_formant_text(fp)
                if not pts:  # 退化：也许其实是 FormantGrid
                    pts = praat_objects.read_formantgrid_text(fp)
            det = "formant"
        else:
            return {"ok": False, "error": "kind 必须是 f0 / formant / auto"}

        if not pts:
            return {"ok": False, "error": "无法从该文件解析出数据。请确认它是 Praat 导出的 "
                                          "Pitch / Formant / PitchTier 文本（菜单 Save as text file "
                                          "或 Save as PitchTier file）。"}
        if det == "formant" and wav_path and os.path.isfile(wav_path):
            # 读入即落盘（2026-09-27 定案）：原始文本直接写 measure/ 子目录里的
            # .Formant，并记 formantImported 标记（同 ppfix 读回记标记的套路）
            from .review_export import formant_path as _rx_formant, ensure_measure_dir
            try:
                ensure_measure_dir(wav_path)
                with open(_rx_formant(wav_path), "w", encoding="utf-8") as g:
                    g.write(text)
                ch = review_choice.read_choice(wav_path).get("choice") or {}
                ch["formantImported"] = {
                    "savedAt": datetime.datetime.now().isoformat(timespec="seconds")}
                review_choice.save_choice(wav_path, ch)
            except OSError:
                pass
        pts = _downsample(pts, MAX_POINTS)
        return {"ok": True, "kind": det, "points": pts, "count": len(pts)}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ------------------------------------------------- 「在 Praat 中修周期」两段式人工修正
# 九宫格小图 / 详情大图的「点图改 F0」只适合零星修点；整条曲线烂掉（如喉化元音、
# 基频超出 ceiling 导致大片丢帧）时，靠人眼在 Praat 里逐周期修脉冲更可靠——
# 这是用户原有工作流（Sound → PointProcess → 改脉冲 → PitchTier → 修曲线）的界面化：
# 两段编辑器 + pause 按钮推进，导出直接落 wav 同目录（= 批量 pitchRead/formantRead、
# 审核导出 review_export 的同一位置），人工修一次，批量测量就永久用这份结果。
# 读回后在 measure.json 记 ppfix 标记，export_one/export_dir 跳过重算防止覆盖人工结果。


def _build_pp_edit_script(wav_path, out_pitch, out_formant,
                          f0min, f0max, time_step, n_formants, formant_ceiling):
    """生成两段式 GUI 修周期脚本（不加 --run，需要可见 GUI）。

    段 1：Sound+PointProcess 开 PointProcessEditor 改脉冲（可跳过）；
    段 2：PitchTier 开编辑器修曲线（不需要改就直接点导出）；
    导出：PitchTier → To Pitch（帧网格 = timeStep，与批量 intervalFixed 对齐）
          存 .Pitch；Formant 用当前参数现算存 .Formant（nocheck，尽力而为），
          让该文件直接达到 review_export 的「已审核」状态（两个对象都在）。
    """
    wav_u = wav_path.replace("\\", "/")
    op_u = out_pitch.replace("\\", "/")
    of_u = out_formant.replace("\\", "/")
    return "".join([
        'Read from file: "%s"\n' % wav_u,
        'snd = selected("Sound", 1)\n',
        'selectObject: snd\n',
        'To PointProcess (periodic, cc): %g, %g\n' % (f0min, f0max),
        'pp = selected("PointProcess", 1)\n',
        'selectObject: snd\n',
        'plusObject: pp\n',
        'View & Edit\n',
        # beginPause 只有标题一个参数；按钮全在 endPause：标签..., 回车默认按钮号，
        # （可选）取消按钮号——写了取消按钮号就没有 Stop 键，关窗 = 点取消。
        'beginPause: "第 1 步：修改周期标记（脉冲）"\n',
        'comment: "在 PointProcessEditor 里检查/增删蓝色脉冲（拖动底部滑块放大看波形周期）。"\n',
        'comment: "点「取消」= 什么都不导出，直接退出。"\n',
        'clicked = endPause: "脉冲改好了", "跳过脉冲", "取消", 1, 3\n',
        'if clicked = 3\n',
        '    removeObject: snd, pp\n',
        '    exitScript()\n',
        'endif\n',
        'selectObject: pp\n',
        'To PitchTier: 0.02\n',
        'pt = selected("PitchTier", 1)\n',
        'selectObject: pt\n',
        'Edit\n',
        'beginPause: "第 2 步：修改声调曲线（不需要改就直接点导出）"\n',
        'comment: "在 PitchTier 编辑器里拖动/增删蓝点修整曲线。"\n',
        'comment: "「导出」把修正结果转成 Pitch 对象存到音频目录的 measure 子目录，回界面点「读回修周期结果」。"\n',
        'clicked = endPause: "曲线改好了，导出", "取消", 1, 2\n',
        'if clicked = 2\n',
        '    removeObject: snd, pp, pt\n',
        '    exitScript()\n',
        'endif\n',
        'selectObject: pt\n',
        'To Pitch: %g, %g, %g\n' % (time_step, f0min, f0max),
        'Save as text file: "%s"\n' % op_u,
        'writeInfoLine: "PPFIX_DONE %s"\n' % os.path.basename(out_pitch),
        'Remove\n',
        'selectObject: snd\n',
        'nocheck To Formant (burg): %g, %d, %g, 0.025, 50\n' % (time_step, n_formants, formant_ceiling),
        'nFm = numberOfSelected("Formant")\n',
        'if nFm >= 1\n',
        '    nocheck Save as text file: "%s"\n' % of_u,
        '    Remove\n',
        'endif\n',
        'selectObject: snd\n',
        'plusObject: pp\n',
        'plusObject: pt\n',
        'Remove\n',
    ])


def open_pointprocess(path, exe=None, pitch_floor=None, pitch_ceiling=None,
                      time_step=None, n_formants=None, formant_ceiling=None):
    """用 GUI Praat 打开两段式修周期流程，导出落 wav 同目录。

    参数缺省时用 review_export.DEFAULTS（与九宫格/批量同一套默认），前端会传
    用户当前设置（reviewParams()），保证修正对象与批量抽取参数一致。
    """
    from .review_export import DEFAULTS as _RXD, pitch_path as _rx_pitch, \
        formant_path as _rx_formant, ensure_measure_dir as _rx_ensure
    exe = _resolve_exe(exe)
    if not exe:
        return {"ok": False, "error": "找不到 Praat 程序（请在设置里指定 praat.exe）"}
    if not path or not os.path.isfile(path):
        return {"ok": False, "error": "音频文件不存在：%s" % path}

    def _num(v, key):
        try:
            x = float(v)
            if x > 0:
                return x
        except (TypeError, ValueError):
            pass
        return float(_RXD[key])

    f0min = _num(pitch_floor, "pitchFloor")
    f0max = _num(pitch_ceiling, "pitchCeiling")
    ts = _num(time_step, "timeStep")
    nf = int(_num(n_formants, "nFormants"))
    fc = _num(formant_ceiling, "formantCeiling")
    out_pitch = _rx_pitch(path)
    out_formant = _rx_formant(path)
    _rx_ensure(path)   # Praat 不能建目录，落盘的 measure/ 先建好
    try:
        tmp = tempfile.mkdtemp(prefix="pspp_")
        sp = os.path.join(tmp, "edit_pp.praat")
        with open(sp, "w", encoding="utf-8") as f:
            f.write(_build_pp_edit_script(path, out_pitch, out_formant,
                                          f0min, f0max, ts, nf, fc))
        # --new-send：起新 GUI 并在 GUI 里自动运行脚本（2026-09-25 实测 Praat 7.0.02）：
        #   --run = 无 GUI 的 batch 模式（View & Edit 报 "Cannot edit a Sound from batch"，
        #           beginPause 直接跳过）；裸脚本参数也瞬间退出；
        #   --new-send 才是「GUI + 自动跑脚本」，且保证新实例、不打扰用户已开的 Praat。
        # CREATE_NEW_PROCESS_GROUP：与启动服务器的进程解耦，关掉/重启外壳不连带杀掉 Praat。
        subprocess.Popen([exe, "--new-send", sp],
                         creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
    except Exception as e:
        return {"ok": False, "error": "启动 Praat 失败：%s" % e}
    return {"ok": True, "out": out_pitch}


def read_pp_result(path):
    """读回「修周期」导出的 .Pitch → 与「导入修正数据」同一条解析路径。

    读回成功时在 measure.json 记 ppfix 标记：export_one/export_dir 见标记即跳过
    重算，防止「存盘 / 审核完成」把人工逐周期修出来的曲线整个覆盖掉。
    """
    from .review_export import pitch_path
    if not path or not os.path.isfile(path):
        return {"ok": False, "error": "音频文件不存在：%s" % path}
    pfile = pitch_path(path)
    if not os.path.isfile(pfile):
        return {"ok": False,
                "error": "还没有导出文件（%s）。请先点「在 Praat 中修周期」，"
                         "完成两步修改并点「曲线改好了，导出」。" % pfile}
    try:
        with open(pfile, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
    except Exception as e:
        return {"ok": False, "error": "读取失败：%s" % e}
    r = import_review_object(text, "pitch")
    if r.get("ok"):
        try:
            ch = review_choice.read_choice(path).get("choice") or {}
            ch["ppfix"] = {"savedAt": datetime.datetime.now().isoformat(timespec="seconds"),
                           "file": os.path.basename(pfile)}
            review_choice.save_choice(path, ch)
        except Exception:
            pass  # 标记写不进去只影响「导出跳过重算」，不阻塞读回显示
    return r


# ------------------------------------------------- FormantPath 人工精修闭环（Route B）
# 单文件手动复核/微调共振峰：FormantPathEditor 把每套 ceiling 的轨迹都画出来，还标了
# stress（越小越好）与带宽，点矩形就能把某段换成那一套。编辑器以默认 FormantPath 为初值
# （无自动择优初值；网格的「多数量择优」走的是另一条 4/5/6/7 数量择优路线），用户只改有
# 问题的段，改完一点就把 Formant 导出到固定路径，前端再读回来覆盖该格——省掉文件选择器。

def _build_fp_edit_script(wav_path, tg_path, out_path, ceiling, prep_path=None):
    """生成 GUI 脚本：读 wav(+TextGrid)(+已有 FormantPath) → 开编辑器 → 导出 Formant。

    ``prep_path`` 给出一份已经按自动择优改好 ``path`` 层的 FormantPath 文本时，编辑器
    会以它为初值；否则现算一个（默认路径 = 中间那套 ceiling）。
    """
    wav_u = wav_path.replace("\\", "/")
    out_u = out_path.replace("\\", "/")
    lines = ['Read from file: "%s"\n' % wav_u,
             'snd = selected("Sound", 1)\n']
    if tg_path and os.path.isfile(tg_path):
        lines += ['Read from file: "%s"\n' % tg_path.replace("\\", "/"),
                  'tg = selected("TextGrid", 1)\n']
    else:
        # FormantPathEditor 要三个对象一起选中；没有 TextGrid 就现造一个空的
        # （name 用 "syllables"，与项目其它地方一致）。
        lines += ['selectObject: snd\n',
                  'To TextGrid: "syllables", ""\n',
                  'tg = selected("TextGrid", 1)\n']
    if prep_path and os.path.isfile(prep_path):
        lines += ['Read from file: "%s"\n' % prep_path.replace("\\", "/"),
                  'fp = selected("FormantPath", 1)\n']
    else:
        lines += ['selectObject: snd\n',
                  'To FormantPath (burg): 0.005, 5.0, %g, 0.025, 50.0, 0.05, 4\n' % ceiling,
                  'fp = selected("FormantPath", 1)\n']
    lines += [
        'selectObject: snd\n',
        'plusObject: tg\n',
        'plusObject: fp\n',
        'View & Edit\n',
        # beginPause 只有标题一个参数（按钮在 endPause；见 _build_pp_edit_script 注释）
        'beginPause: "FormantPath 精修"\n',
        'comment: "右侧网格里每个矩形 = 一套 ceiling 分析，点矩形即把该时段换成那一套。"\n',
        'comment: "矩形上的数字是 stress（越小越好），竖线长度表示带宽。"\n',
        'comment: "改完点「导出并退出」，结果会写成 Formant 文件供界面读回。"\n',
        'clicked = endPause: "导出并退出", "取消", 1, 2\n',
        'if clicked = 2\n',
        '    removeObject: snd, tg, fp\n',
        '    exitScript()\n',
        'endif\n',
        'selectObject: fp\n',
        'Extract Formant\n',
        'fm = selected("Formant", 1)\n',
        'Save as text file: "%s"\n' % out_u,
        'writeInfoLine: "已导出：%s"\n' % out_u.replace('"', ""),
        # 导出成功也要清空对象列表（2026-09-26 用户反馈：只有「取消」清了，
        # 「导出并退出」却留下 Sound/TextGrid/FormantPath/导出的 Formant 四个对象，
        # 反复编辑同一个文件对象列表就越堆越多）。清的对象里必须包含本次 Extract
        # 出来的 fm，否则列表里留着的正是它。
        # writeInfoLine 放在 Remove 之前——Remove 不影响 Info 窗口已写出的内容。
        'removeObject: snd, tg, fp, fm\n',
    ]
    return "".join(lines)


def open_formant_path(path, name="", tg_path=None, exe=None, formant_ceiling=5500.0):
    """用 GUI Praat 打开 FormantPathEditor，供人工复核/微调单个文件的共振峰（ceiling 维度）。

    以默认 FormantPath 为初值（网格的「多数量择优」走的是另一条 4/5/6/7 数量路线，
    不在此编辑器里）；用户点「导出并退出」后，脚本把 Formant **直接存成 wav 旁的
    ``.Formant``**（2026-09-27 定案：读入即落盘，与修周期脚本同一待遇，无临时中转），
    由 ``read_opt_result`` 读回解析显示并记 ``formantImported`` 标记。
    """
    exe = _resolve_exe(exe)
    if not exe:
        return {"ok": False, "error": "找不到 Praat 程序（请在设置里指定 praat.exe）"}
    if not path or not os.path.isfile(path):
        return {"ok": False, "error": "音频文件不存在：%s" % path}
    if not tg_path:
        cand = os.path.splitext(path)[0] + ".TextGrid"
        tg_path = cand if os.path.isfile(cand) else None
    from .review_export import formant_path as _rx_formant, ensure_measure_dir
    out_path = _rx_formant(path)
    ensure_measure_dir(path)   # Praat 不能建目录，落盘的 measure/ 先建好
    try:
        tmp = tempfile.mkdtemp(prefix="psfpe_")
        sp = os.path.join(tmp, "edit_fp.praat")
        with open(sp, "w", encoding="utf-8") as f:
            f.write(_build_fp_edit_script(path, tg_path, out_path,
                                          float(formant_ceiling)))
        # --new-send：同 open_pointprocess，GUI + 自动跑脚本（实测见彼处注释）。
        # CREATE_NEW_PROCESS_GROUP：与启动服务器的进程解耦，关掉/重启外壳不连带杀掉 Praat。
        subprocess.Popen([exe, "--new-send", sp],
                         creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
    except Exception as e:
        return {"ok": False, "error": "启动 Praat 失败：%s" % e}
    return {"ok": True, "out": out_path}


def track_file(wav_path, exe=None, tg_path=None, name="", formant_ceiling=5500.0,
                full_res=False, vowel_ipa=None, speaker=None, n_formants=5):
    """对单个 wav 跑一遍 Praat：裸 burg → Viterbi 轨迹跟踪，返回平滑后的点。

    与九宫格曾经的「平滑」同源（共用 ``_track_snippet``）：
    - 参考频率：有元音音标（``vowel_ipa`` + ``speaker``）时用该元音期望的 F1/F2/F3
      （见 ``_ipa_refs``，双元音取首段近似），Track 连线整体偏向该元音的候选；
      没音标回退语音段均值自动估计。
    - ``n_formants``（2026-09-26）：平滑作用对象跟随界面勾选的候选（详情页平滑与
      候选耦合拍板）——勾了哪条候选就用它的「上限 + 数量」重跑 burg 再 Track，
      不再写死 5；调用方不传则保持旧默认。存盘导出（write_smoothed_formant）
      也传同一值，保证导出的平滑对象与屏幕所见一致。
    - ``nocheck`` 保证 Track 与该文件不兼容时不中断，事后用 ``Get maximum number of
      formants`` 确认是否真的平滑过（成功会把对象压成 3 条）。全程只在 Praat 已算出的
      候选里选，不插值、不造值。

    ⚠️ 实测提醒（本批样本）：Track 只是「在两条都连续的轨迹里挑一条」，当某帧漏检真实
    F1 时它可能挑到偏高的那条，导致整段上移数十至数百 Hz。故返回 ``tracked`` 只表示
    「Praat 确实跑成功了」，**不代表结果一定更准**——界面上要与原始曲线叠加对比后再用。
    """
    exe = _resolve_exe(exe)
    if not exe:
        return {"ok": False, "error": "找不到 Praat 程序（请在设置里指定 praat.exe）"}
    if not wav_path or not os.path.isfile(wav_path):
        return {"ok": False, "error": "音频文件不存在：%s" % wav_path}
    if not tg_path:
        cand = os.path.splitext(wav_path)[0] + ".TextGrid"
        tg_path = cand if os.path.isfile(cand) else None
    key = "one"
    out = tempfile.mkdtemp(prefix="pstrack_")
    try:
        span = None
        if tg_path and os.path.isfile(tg_path):
            ivs = _read_tg_intervals(tg_path, name or key,
                                     {"missing": [], "error": [], "loaded": 0})
            span = _syllable_span(ivs)
        ipa_refs = _ipa_refs(vowel_ipa, vowel_ref.gender_of(speaker))
        err, log = _run_script(exe, out, _build_script(
            [(wav_path, key)], out, 500.0, float(formant_ceiling),
            formant_track=True, track_refs={key: span} if span else None,
            track_ipa={key: ipa_refs} if ipa_refs else None,
            n_formants=int(n_formants or 5)), "track.praat")
        if err:
            return {"ok": False, "error": err}
        fp = os.path.join(out, key + ".formant")
        if not os.path.isfile(fp):
            return {"ok": False, "error": "Praat 没有产出共振峰对象（该文件可能不是有效音频）"}
        pts = praat_objects.read_formant_text(fp)
        if not pts:
            return {"ok": False, "error": "共振峰对象解析为空"}
        skipped = bool(_track_warnings(log, [key], [name or key]))
        # full_res = True 时返回全分辨率点（不降采样），供写回 .Formant 用——
        # 降采样会丢掉帧、改 dx，导出的对象与原始 burg 网格对不上；
        # 全分辨率 + read_formant_text 已带回的带宽，能写出 fidelity 与原生一致的 .Formant。
        points = pts if full_res else _downsample(pts, MAX_POINTS)
        return {"ok": True, "points": points,
                "tracked": not skipped, "count": len(pts)}
    finally:
        shutil.rmtree(out, ignore_errors=True)


def read_opt_result(path):
    """读回 FormantPath 精修导出的 Formant（wav 旁 ``.Formant``，脚本已直接落盘）。

    解析显示 + 在 measure.json 记 ``formantImported`` 标记（同 ppfix 套路）。
    """
    from .review_export import formant_path as _rx_formant
    if not path or not os.path.isfile(path):
        return {"ok": False, "error": "音频文件不存在：%s" % path}
    ffile = _rx_formant(path)
    if not os.path.isfile(ffile):
        return {"ok": False,
                "error": "还没有导出文件（%s）。请先点「FormantPath 编辑器」，"
                         "在 Praat 里点「导出并退出」。" % ffile}
    try:
        with open(ffile, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
    except Exception as e:
        return {"ok": False, "error": "读取失败：%s" % e}
    return import_review_object(text, "formant", wav_path=path)


def track_imported_formant(wav_path, exe=None, tg_path=None, vowel_ipa=None,
                           speaker=None, write_back=False):
    """对「读入的那条共振峰」（wav 旁 ``.Formant``）跑一遍 Viterbi 轨迹跟踪（Track）。

    与 ``track_file`` 的唯一区别：**不重新抽取**。作用对象是用户在 Praat 里精修/
    从外部导入的那条曲线，而不是按某个 ceiling 重新跑 burg——换了的曲线拿到不同
    对象上去平滑，"所见 = 所存" 就成了空话（2026-09-26 用户定案：读入的结果就是
    权威数据，后面一切都基于它）。

    ``write_back=False``（界面预览）：只返回平滑后的点，落盘文件不动——
    平滑只是预览，用户满意了点「存盘」才覆盖。
    ``write_back=True``（存盘时）：把 Track 结果（Praat 原生文本）写回 wav 旁的
    ``.Formant``。Track 是确定性变换，重跑结果与预览一致，不依赖任何暂存。
    """
    exe = _resolve_exe(exe)
    if not exe:
        return {"ok": False, "error": "找不到 Praat 程序（请在设置里指定 praat.exe）"}
    if not wav_path or not os.path.isfile(wav_path):
        return {"ok": False, "error": "音频文件不存在：%s" % wav_path}
    from .review_export import formant_path as _rx_formant
    raw = _rx_formant(wav_path)
    if not os.path.isfile(raw):
        return {"ok": False,
                "error": "还没有可读回的共振峰结果，请先点「读回 FormantPath 结果」"}
    name = os.path.basename(wav_path)
    out = tempfile.mkdtemp(prefix="pstrackimp_")
    try:
        span = None
        if tg_path and os.path.isfile(tg_path):
            ivs = _read_tg_intervals(tg_path, name,
                                     {"missing": [], "error": [], "loaded": 0})
            span = _syllable_span(ivs)
        ipa_refs = _ipa_refs(vowel_ipa, vowel_ref.gender_of(speaker))
        save_to = os.path.join(out, "tracked.Formant")
        script = ('Read from file: "%s"\n' % raw.replace("\\", "/") +
                  _track_snippet(span, "imported", ipa_refs) +
                  'Save as text file: "%s"\n' % save_to.replace("\\", "/") +
                  'writeInfoLine: "OK track imported done"\n')
        err, log = _run_script(exe, out, script, "track_imported.praat")
        if err:
            return {"ok": False, "error": (err.get("error") or "Praat 运行失败"),
                    "log": log}
        if not os.path.isfile(save_to):
            return {"ok": False, "error": "Praat 没有产出平滑结果"}
        pts = praat_objects.read_formant_text(save_to)
        if not pts:
            return {"ok": False, "error": "平滑结果解析为空"}
        if write_back:
            # Praat 原生文本整份覆盖 .Formant：帧网格 / dx / 带宽零失真
            try:
                shutil.copy2(save_to, raw)
            except OSError as e:
                return {"ok": False, "error": "写回 .Formant 失败：%s" % e}
        skipped = bool(_track_warnings(log, ["imported"], [name]))
        return {"ok": True, "points": _downsample(pts, MAX_POINTS),
                "tracked": not skipped, "count": len(pts)}
    finally:
        shutil.rmtree(out, ignore_errors=True)
