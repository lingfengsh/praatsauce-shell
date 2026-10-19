# -*- coding: utf-8 -*-
"""基频/共振峰审查：生成多候选 + 读回 + 波形包络。

- build_review：调用 ps-shell/praat/review_build.praat 生成多组 Pitch/Formant 候选，
  再用 praat_objects 把 Praat 文本对象读回成 JSON；并用标准库读 wav 算降采样包络。
- demo_review：合成候选数据，无需真实 wav/Praat 即可预览界面与编辑交互。
"""
import os
import glob
import math
import wave
import array
import shutil
import tempfile

from . import settings, praat, praat_objects, audio, vowel_ref, review_choice

if settings.IS_FROZEN:
    # 冻结态：脚本统一分发在 exe 同目录的 scripts/ 下（扁平）
    SCRIPT = os.path.join(settings.APP_BASE, "scripts", "review_build.praat")
else:
    SCRIPT = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "praat", "review_build.praat",
    )


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


def _wav_envelope(path, n_points=500):
    """读 wav 算 RMS 包络（归一化 0..1），供前端画波形底图。"""
    try:
        with wave.open(path, "rb") as w:
            fr = w.getframerate()
            nf = w.getnframes()
            ch = w.getnchannels()
            sw = w.getsampwidth()
            raw = w.readframes(nf)
        if sw == 2:
            samples = array.array("h")
            samples.frombytes(raw)
        elif sw == 1:
            b = array.array("B")
            b.frombytes(raw)
            samples = array.array("h", (x - 128 for x in b))
        else:
            return None
        if ch > 1:
            samples = samples[::ch]
        N = len(samples)
        if N == 0:
            return None
        win = max(1, N // n_points)
        t, env = [], []
        for i in range(n_points):
            s = i * win
            e = s + win
            seg = samples[s:e] if e <= N else samples[s:]
            rms = math.sqrt(sum(x * x for x in seg) / len(seg)) if seg else 0.0
            t.append(round((s + win / 2) / fr, 4))
            env.append(rms)
        mx = max(env) or 1.0
        env = [round(v / mx, 4) for v in env]
        return {"t": t, "env": env}
    except Exception:
        return None


def _read_candidates(out_dir, ext, reader, prefix, unit):
    files = sorted(glob.glob(os.path.join(out_dir, "*" + ext)))
    cands = []
    for fp in files:
        base = os.path.splitext(os.path.basename(fp))[0]
        num = base.split("_")[-1]
        pts = reader(fp)
        cands.append({"id": num, "label": f"{prefix}{num}{unit}", "points": pts})
    cands.sort(key=lambda c: int(c["id"]) if str(c["id"]).isdigit() else 1 << 30)
    return cands


def _read_formant_candidates(out_dir):
    """读 ``formant_<上限>_<数量>.formant`` → 共振峰候选列表。

    Praat 手册（Sound: To Formant (burg)...）把「Formant ceiling」和
    「Maximum number of formants」写成**一对**参数：只有两者配套，F1/F2 才保持
    "舌位高低 / 舌位前后"的可解释性（LPC 阶数 = 2 × 数量）。所以这里做成二维扫描：
    5 个上限 × 4 个数量（4/5/6/7）= 20 组。

    ``id`` 用 ``"上限-数量"``（如 ``"5500-5"``）：**存盘记录 ``measure.json`` 也用它**，
    这样日后才还得出当时用的是哪组参数。``ceiling`` / ``nFormants`` 另外平铺出来，
    前端按上限分组时不必再拆字符串。
    """
    cands = []
    for fp in glob.glob(os.path.join(out_dir, "formant_*.formant")):
        base = os.path.splitext(os.path.basename(fp))[0]
        parts = base.split("_")           # formant / 5500 / 5
        if len(parts) != 3:
            continue
        try:
            ceiling, n_formants = int(parts[1]), int(parts[2])
        except ValueError:
            continue
        cands.append({
            "id": "%d-%d" % (ceiling, n_formants),
            "label": "共振峰上限%dHz·%d个" % (ceiling, n_formants),
            "ceiling": ceiling,
            "nFormants": n_formants,
            "points": praat_objects.read_formant_text(fp),
        })
    cands.sort(key=lambda c: (c["ceiling"], c["nFormants"]))
    return cands


def build_review(wav_path, exe=None):
    """真实生成候选：需 Praat 与真实 wav。"""
    if not wav_path or not os.path.isfile(wav_path):
        return {"ok": False, "error": "音频文件不存在"}
    exe = _resolve_exe(exe)
    if not exe:
        return {"ok": False, "error": "找不到 Praat 程序（请在设置里指定）"}
    out = tempfile.mkdtemp(prefix="psreview_")
    try:
        rc, lines = praat.run_script(
            exe, SCRIPT, [wav_path, out], cwd=out,
            full_trust=True, timeout=300,
        )
        if rc != 0:
            log = "\n".join(f"[{l.get('tag', '?')}] {l.get('text', '')}" for l in lines)
            return {"ok": False, "error": "Praat 运行失败（详见日志）", "log": log}

        pitch = _read_candidates(out, ".pitch", praat_objects.read_pitch_text, "F0上限", "Hz")
        formant = _read_formant_candidates(out)
        env = _wav_envelope(wav_path) or {"t": [], "env": []}
        dur = audio._wav_info(wav_path)[0] or (env["t"][-1] if env["t"] else 0.0)
        # 元音音标软先验：本文件若填了 vowel_ipa，就在共振峰候选里挑一组
        # 「既贴合该元音参考值、轨迹又顺滑」的作为推荐（人类仍可在界面上改选）。
        recommend = _recommend_formant(formant, wav_path)
        return {
            "ok": True,
            "duration": round(dur, 3) if dur else 0.0,
            "wave": env,
            "pitch": {"candidates": pitch},
            "formant": {"candidates": formant, "recommend": recommend},
        }
    except Exception as e:  # 无法启动 Praat
        return {"ok": False, "error": f"调用 Praat 失败：{e}"}
    finally:
        # 成功/失败/异常三条路径都要清掉临时目录（含全套候选对象，不小）
        shutil.rmtree(out, ignore_errors=True)


def _traj_jump(points):
    """共振峰点列的逐帧 |ΔF1|+|ΔF2|+|ΔF3| 均值（顺滑度，越小越连续）。"""
    prev = None
    acc, n = 0.0, 0
    for p in points or []:
        if not isinstance(p, dict):
            continue
        cur = [p.get("F1"), p.get("F2"), p.get("F3")]
        if any(v is None for v in cur):
            prev = None
            continue
        if prev is not None:
            acc += sum(abs(cur[k] - prev[k]) for k in range(3))
            n += 1
        prev = cur
    return (acc / n) if n else None


def _recommend_formant(formant, wav_path):
    """用已存盘的 vowel_ipa / speaker 给共振峰候选挑一组推荐（参考 + 顺滑）。"""
    try:
        ch = (review_choice.read_choice(wav_path).get("choice") or {})
        segs = ch.get("vowel_ipa")
        if isinstance(segs, str):
            segs = vowel_ref.parse_segments(segs)
        if not segs:
            return None
        gender = vowel_ref.gender_of(ch.get("speaker"))
        ref = vowel_ref.expected(segs[0], gender)   # 主元音期望（双元音取首段近似）
        if not ref:
            return None
        best_id, best_score = None, None
        for c in formant:
            pts = c.get("points") or []
            med = vowel_ref.steady_median(pts)
            dev = vowel_ref.deviation(med, ref)
            j = _traj_jump(pts)
            score = 0.0
            if dev is not None:
                score += 80.0 * dev          # 参考偏差（比例为主，尺度无关）
            if j is not None:
                score += 0.5 * j             # 顺滑度（减少断裂）
            if best_score is None or score < best_score:
                best_score, best_id = score, c["id"]
        return best_id
    except Exception:
        return None


def pitch_preview(wav_path, params=None):
    """单文件 F0 快速预览（详情页滑块实时调参，2026-09-25）。

    params 键：method("raw"/"filtered")、pitchFloor、ceiling、silence、voicing、
    octave、octaveJump、vuv、attenuation、timeStep。缺项用该方法的标准值兜底。
    - raw      = To Pitch (raw autocorrelation)，与批量 get_pitch.praat 的
                 ``To Pitch: ts, floor, ceiling``（三参形式）同一算法、同一默认值；
    - filtered = To Pitch (filtered autocorrelation)，Praat 2023 起推荐的
                 带限自相关：先高斯低通再自相关，"ceiling" 在该命令里叫
                 pitch top（标准 800 Hz，比 raw 的 ceiling 高一档），多一个
                 attenuation at top（标准 0.03，手册明说基本不用动）。
    两个命令的完整签名均在本机 Praat 7.0.02 实测（raw 10 参 / filtered 11 参，
    第 5 参 very accurate 用 0/1——batch 模式下不认 yes/no 字面量）。
    实测单文件全程约 0.25 s（含进程启动），滑块防抖 350ms 下体感实时。
    """
    if not wav_path or not os.path.isfile(wav_path):
        return {"ok": False, "error": "音频文件不存在"}
    p = params if isinstance(params, dict) else {}
    # 2026-09-25 用户拍板：默认（也是推荐）用 filtered AC，与主批量一致。
    method = p.get("method") if p.get("method") in ("raw", "filtered") else "filtered"
    filt = method == "filtered"

    def num(key, default):
        try:
            v = float(p.get(key))
        except (TypeError, ValueError):
            v = float(default)
        return default if (v != v or v in (float("inf"), float("-inf"))) else v

    floor = num("pitchFloor", 75.0)
    ceiling = num("ceiling", 800.0 if filt else 600.0)
    silence = num("silence", 0.09 if filt else 0.03)
    voicing = num("voicing", 0.50 if filt else 0.45)
    octave = num("octave", 0.055 if filt else 0.01)
    octave_jump = num("octaveJump", 0.35)
    vuv = num("vuv", 0.14)
    attenuation = num("attenuation", 0.03)
    time_step = num("timeStep", 0.005) or 0.005

    exe = _resolve_exe(None)
    if not exe:
        return {"ok": False, "error": "找不到 Praat 程序（请在设置里指定）"}

    out = tempfile.mkdtemp(prefix="psprev_")
    try:
        out_pitch = os.path.join(out, "preview.pitch")
        # 参数直接烘进脚本文本（全部过 float() 消毒，无注入面）。不走 form+args：
        # 带 form 的脚本在 --run 下必须显式传全参数（实测缺一个就 "Found 0 arguments"）。
        if filt:
            call = ("To Pitch (filtered autocorrelation): %.6g, %.6g, %.6g, 15, 0, "
                    "%.6g, %.6g, %.6g, %.6g, %.6g, %.6g"
                    % (time_step, floor, ceiling, attenuation, silence, voicing,
                       octave, octave_jump, vuv))
        else:
            call = ("To Pitch (raw autocorrelation): %.6g, %.6g, %.6g, 15, 0, "
                    "%.6g, %.6g, %.6g, %.6g, %.6g"
                    % (time_step, floor, ceiling, silence, voicing, octave,
                       octave_jump, vuv))
        script = ('Read from file: "%s"\n%s\nSave as text file: "%s"\n'
                  % (praat.q(wav_path.replace("\\", "/")), call, praat.q(out_pitch.replace("\\", "/"))))
        sp = os.path.join(out, "preview.praat")
        with open(sp, "w", encoding="utf-8") as f:
            f.write(script)
        try:
            rc, _lines = praat.run_script(exe, sp, [], cwd=out,
                                          full_trust=True, timeout=120)
        except Exception as e:
            return {"ok": False, "error": "调用 Praat 失败：%s" % e}
        points = praat_objects.read_pitch_text(out_pitch) if os.path.isfile(out_pitch) else []
        if rc != 0 or not points:
            return {"ok": False, "error": "Praat 分析失败（请检查参数取值）"}
        return {"ok": True, "method": method, "points": points, "count": len(points),
                "params": {"method": method, "pitchFloor": floor, "ceiling": ceiling,
                           "silence": silence, "voicing": voicing, "octave": octave,
                           "octaveJump": octave_jump, "vuv": vuv,
                           "attenuation": attenuation, "timeStep": time_step}}
    finally:
        shutil.rmtree(out, ignore_errors=True)


def formant_preview(wav_path, params=None):
    """单文件共振峰快速预览（Manual/详情页共振峰页滑块实时调参，2026-09-27）。

    与 pitch_preview 同一思路：临时跑一次 ``To Formant (burg)``，读回 F1–F5/B1–B5
    供前端实时绘制；**不落盘、不污染** measure/ 里的 .Formant（保存时再走 choice-save
    + export 真正写回）。
    params 键：nFormants(4/5/6/7)、formantCeiling(Hz)、timeStep、windowLength、preEmphasis。
    缺项用标准值兜底（nFormants=5, ceiling=5500, window=0.025, preEmphasis=50）。
    ``To Formant (burg)`` 第 3 位 ceiling 兼作重采样目标，必须与 nFormants 配套
    （手册明说只有两者配套 F1/F2 才可解释），故这里不做任何「自动」改写。
    """
    if not wav_path or not os.path.isfile(wav_path):
        return {"ok": False, "error": "音频文件不存在"}
    p = params if isinstance(params, dict) else {}
    try:
        n_formants = int(p.get("nFormants", 5))
    except (TypeError, ValueError):
        n_formants = 5
    if n_formants not in (4, 5, 6, 7):
        n_formants = 5
    try:
        ceiling = float(p.get("formantCeiling", 5500))
    except (TypeError, ValueError):
        ceiling = 5500.0
    time_step = float(p.get("timeStep", 0.0) or 0.0)   # 0 = 自动
    window = float(p.get("windowLength", 0.025) or 0.025)
    pre_emph = float(p.get("preEmphasis", 50) or 50)
    exe = _resolve_exe(None)
    if not exe:
        return {"ok": False, "error": "找不到 Praat 程序（请在设置里指定）"}
    out = tempfile.mkdtemp(prefix="psfprev_")
    try:
        out_formant = os.path.join(out, "preview.formant")
        # 参数全部过 int()/float() 消毒，无注入面；直接烘进脚本文本（与 pitch_preview 同策略，
        # 不走 form+args——batch 下缺参即 "Found 0 arguments"）。
        call = ("To Formant (burg): %.6g, %d, %.6g, %.6g, %.6g"
                % (time_step, n_formants, ceiling, window, pre_emph))
        script = ('Read from file: "%s"\n%s\nSave as text file: "%s"\n'
                  % (wav_path.replace("\\", "/"), call, out_formant.replace("\\", "/")))
        sp = os.path.join(out, "preview.praat")
        with open(sp, "w", encoding="utf-8") as f:
            f.write(script)
        try:
            rc, _lines = praat.run_script(exe, sp, [], cwd=out,
                                          full_trust=True, timeout=120)
        except Exception as e:
            return {"ok": False, "error": "调用 Praat 失败：%s" % e}
        rows = praat_objects.read_formant_text(out_formant) if os.path.isfile(out_formant) else []
        if rc != 0 or not rows:
            return {"ok": False, "error": "Praat 共振峰分析失败（请检查 ceiling/数量取值）"}
        return {"ok": True, "nFormants": n_formants, "ceiling": ceiling,
                "rows": rows, "count": len(rows)}
    finally:
        shutil.rmtree(out, ignore_errors=True)


def demo_review():
    """合成候选，免真实数据即可预览 UI 与编辑交互。"""
    dur, dt = 2.0, 0.01
    t = [round(i * dt, 3) for i in range(int(dur / dt))]
    base = [200 + 30 * math.sin(2 * math.pi * 1.2 * tt) + 10 * math.sin(2 * math.pi * 3 * tt)
            for tt in t]

    pitch = []
    for ceil in (400, 500, 600):
        pts = [{"t": tt, "f0": round(min(b, ceil - 5), 1)} for tt, b in zip(t, base)]
        pitch.append({"id": str(ceil), "label": f"F0上限{ceil}Hz", "points": pts})

    formant = []
    # 上限五档与 review_build.praat 保持一致：FormantPath 标准阶梯（5500·e^(±0.05k)）
    # 的 -2..+2 档，取整 4977/5232/5500/5782/6078（偏差 <0.5 Hz）。更外侧档走 FormantPath 编辑器。
    for ceil in (4977, 5232, 5500, 5782, 6078):
        for nf in (4, 5, 6, 7):
            pts = []
            for tt in t:
                # 数量越少、LPC 阶数越低 → 谱包络越糊 → F1/F2 被抬高。
                # 方向与实测一致（nF=4 时 F1 会虚高到 1100 Hz 以上）。
                lift = (5 - nf) * 90
                f1 = 500 + lift + 20 * math.sin(2 * math.pi * 2 * tt)
                f2 = 1500 + lift + (ceil - 5000) / 100 + 80 * math.sin(2 * math.pi * 1.5 * tt)
                f3 = 2500 + lift + (ceil - 5000) / 200
                pts.append({"t": tt, "F1": round(f1, 1), "F2": round(f2, 1), "F3": round(f3, 1)})
            formant.append({
                "id": "%d-%d" % (ceil, nf),
                "label": "共振峰上限%dHz·%d个" % (ceil, nf),
                "ceiling": ceil,
                "nFormants": nf,
                "points": pts,
            })

    env = []
    for tt in t:
        v = 0.3 + 0.7 * abs(math.sin(2 * math.pi * 4 * tt)) * (0.5 + 0.5 * math.sin(2 * math.pi * 0.7 * tt))
        env.append(round(min(1.0, v), 3))

    return {
        "ok": True,
        "duration": dur,
        "demo": True,
        "wave": {"t": t, "env": env},
        "pitch": {"candidates": pitch},
        "formant": {"candidates": formant},
    }
