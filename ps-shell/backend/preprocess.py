# -*- coding: utf-8 -*-
"""预处理：整目录音频 → 带通 30–8000 Hz → 重采样 16 kHz → 存进 <输入目录>/Resample/。

设计取舍（都有实测依据，改动前先读）：
1. **一条 Praat 脚本跑完整批**，不是每个文件起一个进程。单文件只要几十毫秒，但起 300 次
   Praat 要几分钟（transcode.py 是逐文件起进程，那里文件少、格式杂，可以接受）。
2. **不靠退出码判断成败**：Praat 没有 try/except，脚本里任何一个文件报错都会整体中断。
   所以跑完后逐文件验产物（文件存在 且 采样率 == TARGET_RATE），谁成功谁失败以此为准。
3. **带通上限故意不夹到 Nyquist**：实测 Praat 7.0.02 对 `to > Nyquist` 不报错、直接放过，
   夹不夹结果一样，少一段逻辑（源 8 kHz 时带上限 8 kHz 也不会炸）。
4. **滤波器在原采样率下先跑、再重采样**：顺序反了会把 8 kHz 以上的能量折回带内（混叠）。
5. 原采样率本就等于目标时 `Resample` 是幂等的（实测帧数不变），无需特判。
"""

import os
import shutil
import time

from . import settings, praat, audio, health


# 产物子目录名。用户拍板：预处理后工作目录默认切到这里。
RESAMPLE_DIR = "Resample"

TARGET_RATE = 16000     # 目标采样率
BAND_LOW = 30           # 带通下限 Hz
BAND_HIGH = 8000        # 带通上限 Hz（= TARGET_RATE / 2，滤波先做，避免混叠）
# Hann 带通边缘的过渡宽度 Hz。**不要用 Praat 默认的 100**，理由见下表。
#
# 实测频响（44100 Hz 纯音，逐频点测量，单位 dB）：
#   频率Hz      10     20     30     40     60     80    100    150   500-7000   8000    9000
#   smooth=100 -9.2   -7.5   -6.0   -4.8   -2.8   -1.4   -0.5   -0.0     -0.0     -6.0   -84.7
#   smooth=30  -23.5  -12.1  -6.1   -2.5   -0.0   -0.0   -0.0   -0.0     -0.0     -6.0   -84.8
#   smooth=10  -69.3  -48.1  -6.1   -0.1   -0.0   -0.0   -0.0   -0.0     -0.0     -6.0   -84.8
#
# → smooth=100 在 60 Hz 就吃掉 2.8 dB，而 60–150 Hz 是男声基频区；本工具的核心产出是
#   H1−H2 一类谐波幅度差，2.8 dB 的低频倾斜会直接变成测量偏倚。smooth=30 从 60 Hz 起
#   衰减 0.0 dB，同时把次声段（10/20 Hz）压掉 23.5/12.1 dB，是这里最稳的取值。
# → 两端名义边缘 30 / 8000 Hz 恰好都是 −6 dB，这是 Hann 窗边缘的定义（半幅度点），不是 bug。
#   8000 Hz 少 6 dB 无影响：共振峰分析上限 5500 Hz，F4/F5 也不到 8 kHz。
BAND_SMOOTH = 30


def _praat_path(p):
    """Praat 脚本里的路径统一用正斜杠：Windows 反斜杠在 Praat 字符串里不转义，
    但正斜杠两种平台都认，少一个变量。"""
    return os.path.abspath(p).replace("\\", "/")


def _build_script(items):
    """items: [(abs_src, abs_dst, name)]。返回可直接 --run 的 Praat 脚本正文。

    每处理完一个文件打一行 `PSA_PRE i/n 文件名` —— 脚本中途崩了能靠它定位到第几个文件。
    """
    total = len(items)
    out = []
    for i, (src, dst, name) in enumerate(items, 1):
        out.append('snd = Read from file: "%s"' % praat.q(_praat_path(src)))
        out.append("selectObject: snd")
        out.append("Filter (pass Hann band): %g, %g, %g" % (BAND_LOW, BAND_HIGH, BAND_SMOOTH))
        out.append("rs = Resample: %g, 50" % TARGET_RATE)
        out.append("selectObject: rs")
        out.append('Save as WAV file: "%s"' % praat.q(_praat_path(dst)))
        # 不逐个删对象的话，几千个文件会把整个音库堆在内存里
        out.append("removeObject: rs")
        out.append("removeObject: snd")
        out.append('appendInfoLine: "PSA_PRE %d/%d %s"' % (i, total, name))
    return "\n".join(out) + "\n"


def run(dir_path, ext="wav"):
    """把 dir_path 下所有 ext 音频预处理进 <dir_path>/Resample/。

    返回：
      {ok, outDir, dir, total, converted:[{source, converted, sampleRate, duration}],
       failed:[{source, error}], srcRates:[int], tgInSource:int, elapsed:float}
    或 {ok:False, error}
    """
    if not dir_path or not os.path.isdir(dir_path):
        return {"ok": False, "error": "目录不存在或不可访问"}

    ext = (ext or "wav").strip().lstrip(".").lower()
    if ext != "wav":
        return {"ok": False, "error": "预处理只支持 wav；当前扩展名是 .%s，"
                                     "请先用「转成 wav」把 mp3 / flac 转过来。" % ext}

    # 预处理后工作目录会切到 Resample。若用户直接在 Resample 里再点一次，会造出
    # Resample/Resample —— 拦掉，让人回上一级。
    base = os.path.basename(os.path.normpath(dir_path))
    if base.lower() == RESAMPLE_DIR.lower():
        return {"ok": False, "error": "当前目录已经是 %s，不能再往里嵌一层；"
                                     "请回到上一级目录再点「预处理」。" % RESAMPLE_DIR}

    cfg = settings.load()
    exe = cfg.get("praatExe") or ""
    if not exe or not os.path.exists(exe):
        return {"ok": False, "error": "没有找到 Praat，无法预处理；请先到「设置」里指定 Praat.exe。"}

    names = sorted(health._list_audio(dir_path, ext))
    if not names:
        return {"ok": False, "error": "这个目录里没有 .%s 文件" % ext}

    out_dir = os.path.join(dir_path, RESAMPLE_DIR)
    os.makedirs(out_dir, exist_ok=True)

    # 记下源采样率分布，供前端显示「44.1k × 15 → 16k × 15」
    src_rates = set()
    items = []
    for n in names:
        src = os.path.join(dir_path, n)
        dur, sr, _ch = audio._wav_info(src)
        if sr:
            src_rates.add(sr)
        items.append((src, os.path.join(out_dir, n), n))

    t0 = time.time()
    script = _build_script(items)
    sp = os.path.join(settings.WORK_DIR, "_preprocess_%d.praat" % int(time.time() * 1000))
    log = []
    try:
        os.makedirs(settings.WORK_DIR, exist_ok=True)
        with open(sp, "w", encoding="utf-8") as f:
            f.write(script)
        rc, lines = praat.run_script(exe, sp, cwd=dir_path, full_trust=True,
                                     timeout=3600,
                                     on_line=lambda line, tag: log.append(line))
    except Exception as e:
        return {"ok": False, "error": "预处理异常：%s" % e}
    finally:
        try:
            os.remove(sp)
        except Exception:
            pass

    converted, failed = [], []
    for src, dst, n in items:
        dur, sr, _ch = audio._wav_info(dst)
        if sr == TARGET_RATE:
            converted.append({"source": n, "converted": n,
                              "sampleRate": sr, "duration": None if dur is None else round(dur, 3)})
        elif sr is None:
            failed.append({"source": n, "error": "没有生成产物（Praat 可能在它之前中断了）"})
        else:
            failed.append({"source": n, "error": "产物采样率是 %s Hz，不是 %d" % (sr, TARGET_RATE)})

    # 预处理后工作目录会切到 Resample，TextGrid 也应跟着过来（2026-09-29 用户定案），
    # 否则批量「用现成 TextGrid」在 Resample 里一个都找不到（九宫格有整树回退查找
    # 所以审查不受影响，批量脚本没有）。只补缺、不覆盖：手工精修过的 TextGrid 在
    # Resample 里，不能被上层旧文件冲掉。
    tg_copied = 0
    try:
        for n in os.listdir(dir_path):
            if not n.lower().endswith(".textgrid"):
                continue
            base = os.path.splitext(n)[0]
            if base not in {os.path.splitext(x)[2] for x in items}:
                continue
            dst_tg = os.path.join(out_dir, n)
            if os.path.exists(dst_tg):
                continue
            try:
                shutil.copy2(os.path.join(dir_path, n), dst_tg)
                tg_copied += 1
            except OSError:
                pass
    except Exception:
        pass

    # 源目录里还剩多少 TextGrid（含没跟过来的），供前端提示
    try:
        tg_in_source = sum(1 for n in os.listdir(dir_path) if n.lower().endswith(".textgrid"))
    except Exception:
        tg_in_source = 0

    return {
        "ok": True,
        "dir": dir_path,
        "outDir": out_dir,
        "total": len(items),
        "converted": converted,
        "failed": failed,
        "srcRates": sorted(src_rates),
        "tgInSource": tg_in_source,
        "tgCopied": tg_copied,
        "praatRc": rc,
        "log": log[-5:],
        "elapsed": round(time.time() - t0, 2),
    }
