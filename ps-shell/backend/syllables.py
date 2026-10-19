# -*- coding: utf-8 -*-
"""音节自动切分：纯 Python 静音检测生成 TextGrid，并支持在 Praat 里精修保存。

设计要点：
- 不依赖 numpy：用标准库 wave + struct/array 读 wav，逐帧算 RMS（10ms 非重叠帧），
  按相对峰值能量阈值（dB）判定静音/音节，再合并「短静音」与剔除「短音节」。
  完全自控，不踩 Praat 命令签名坑，也不新增第三方依赖。
- 静音段统一标 ``sil``；音节段默认用**文件名（去扩展名）**标注（用户要求）。
- 生成的 TextGrid 写在 wav 同目录、同名 ``.TextGrid``，方便 Praat 一起打开、也方便
  主流程的 "useTextGrid" 直接复用（tgDir 留空即指向声音目录）。
- 精修闭环：``open_in_praat_with_tg`` 用 GUI Praat 载入 wav + TextGrid → View & Edit
  → 带「保存并退出」按钮的 beginPause（用户编辑边界/标签）→ 脚本写回 TextGrid。
"""

import os
import math
import array
import wave
import shutil
import subprocess
import tempfile

from .review_grid import _list_wavs, _resolve_exe
from . import working_dir


# ----------------------------- 读 wav -> float 单声道 -----------------------------
def _read_wav(path):
    """返回 (samples, sr, duration)。samples 为 [-1,1] 浮点单声道列表。

    支持 8/16/24/32 bit PCM；多声道取第一声道。
    """
    with wave.open(path, "rb") as w:
        nch = w.getnchannels()
        sr = w.getframerate()
        n = w.getnframes()
        depth = w.getsampwidth()
        raw = w.readframes(n)
    if depth == 1:
        a = array.array("B")
        a.frombytes(raw)
        vals = [v - 128 for v in a]
        scale = 128.0
    elif depth == 2:
        a = array.array("h")
        a.frombytes(raw)
        vals = list(a)
        scale = float(1 << 15)
    elif depth == 4:
        a = array.array("i")
        a.frombytes(raw)
        vals = list(a)
        scale = float(1 << 31)
    elif depth == 3:
        vals = []
        for i in range(0, len(raw) - 2, 3):
            b0, b1, b2 = raw[i], raw[i + 1], raw[i + 2]
            v = b0 | (b1 << 8) | (b2 << 16)
            if v >= 0x800000:
                v -= 0x1000000
            vals.append(v)
        scale = float(1 << 23)
    else:
        raise ValueError("不支持的采样位深：%d" % depth)
    if nch > 1:
        vals = vals[::nch]
    samples = [v / scale for v in vals]
    duration = (n / sr) if sr else 0.0
    return samples, sr, duration


def _duration(path):
    """仅读 wav 头拿时长（不解码样本），用于 TextGrid 的 xmax / 展示。"""
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        n = w.getnframes()
    return (n / sr) if sr else 0.0


# ----------------------------- 读已有 TextGrid（保留手工精修） -----------------------------
def read_textgrid(path):
    """解析 Praat 长文本格式 TextGrid，返回 (xmax, [(t0, t1, label), ...])。

    只取 IntervalTier（优先名为 ``syllables`` 的层，否则第一层）。写回时由本模块
    生成的文件结构稳定，这里做轻量健壮解析即可。
    """
    xmax = 0.0
    intervals = []
    # 用 results._read_text 按 BOM 探测编码（Praat 在 Windows 可能写 UTF-16）。
    # 之前硬按 utf-8 读，UTF-16 文件抛 UnicodeDecodeError 又被吞掉，
    # 表现为「标注莫名其妙全没了」；现在解码失败直接抛，调用方能看到原因。
    from . import results as _results
    lines = [ln.strip() for ln in _results._read_text(path).splitlines()]
    n = len(lines)
    for ln in lines:
        if ln.startswith("xmax = "):
            try:
                xmax = float(ln.split("=", 1)[1])
                break
            except Exception:
                pass
    capture = False
    i = 0
    while i < n:
        ln = lines[i]
        if ln.startswith('class = "IntervalTier"'):
            capture = True
            i += 1
            continue
        if capture:
            if ln.startswith('class = "') or ln.startswith("item ["):
                capture = False
            elif ln.startswith("intervals ["):
                x0 = x1 = 0.0
                txt = ""
                for k in range(i + 1, min(i + 4, n)):
                    lk = lines[k]
                    if lk.startswith("xmin = "):
                        try:
                            x0 = float(lk.split("=", 1)[1])
                        except Exception:
                            pass
                    elif lk.startswith("xmax = "):
                        try:
                            x1 = float(lk.split("=", 1)[1])
                        except Exception:
                            pass
                    elif lk.startswith("text = "):
                        # text = "..."（标签内不含引号时安全）
                        if '"' in lk:
                            txt = lk.split('"', 2)[1]
                intervals.append((x0, x1, txt))
        i += 1
    return xmax, intervals


def save_textgrid(wav_path, intervals):
    """把浏览器内手工编辑后的区间写回 wav 同目录同名 .TextGrid。

    intervals: [{t0,t1,label}] 或 [(t0,t1,label)]。会自动排序并补齐拼接缝隙
    （缝隙填 sil），保证 TextGrid 区间连续。
    """
    if not wav_path:
        return {"ok": False, "error": "缺少 wav 路径"}
    tg_path = os.path.splitext(wav_path)[0] + ".TextGrid"
    try:
        seq = []
        for iv in intervals:
            if isinstance(iv, dict):
                t0 = float(iv.get("t0", 0))
                t1 = float(iv.get("t1", 0))
                lab = str(iv.get("label", "sil"))
            else:
                t0, t1, lab = float(iv[0]), float(iv[1]), str(iv[2])
            if t1 > t0:
                seq.append((t0, t1, lab))
        seq.sort(key=lambda x: x[0])
        norm = []
        cur = 0.0
        for t0, t1, lab in seq:
            if t0 > cur + 1e-6:
                norm.append((cur, t0, "sil"))   # 补齐缝隙
            # 区间重叠（手工拖拽）时把 t1 也夹住，否则写出 t1 < t0 的损坏 TextGrid
            t1c = max(t1, cur)
            if t1c > cur:
                norm.append((max(t0, cur), t1c, lab))
            cur = t1c
        xmax = cur
        if xmax <= 0 and seq:
            xmax = seq[-1][1]
        _write_textgrid(tg_path, xmax, norm)
    except Exception as e:
        return {"ok": False, "error": "保存失败：%s" % e}
    return {"ok": True, "path": tg_path}


# ----------------------------- 静音/音节切分 -----------------------------
def segment_silences(samples, sr, min_silence=0.1, min_syllable=0.1, threshold_db=-25.0):
    """基于帧 RMS 的静音检测，返回区间列表 [(t0, t1, label)]，label 为 'sil' / 'sounding'。

    - 帧长 / 步长 = 10ms（非重叠）；
    - 阈值 = 峰值 RMS × 10^(threshold_db/20)；低于阈值判为静音；
    - 合并：短于 min_silence 的静音段并入相邻音节；短于 min_syllable 的音节段降级为静音。
    """
    if not samples or sr <= 0:
        return []
    n = len(samples)
    frame = max(1, int(0.01 * sr))
    n_frames = max(1, int(math.ceil(n / frame)))

    rms = []
    for i in range(n_frames):
        s = i * frame
        e = min(n, s + frame)
        acc = 0.0
        for j in range(s, e):
            acc += samples[j] * samples[j]
        rms.append(math.sqrt(acc / frame) if (e - s) > 0 else 0.0)

    peak = max(rms)
    if peak <= 0:
        # 全静音：整段当作一个 sil
        return [(0.0, n / sr, "sil")]
    thresh = peak * (10.0 ** (threshold_db / 20.0))
    voiced = [r >= thresh for r in rms]

    # 时间轴：帧 i 覆盖 [i*frame/sr, (i+1)*frame/sr]
    def frame_t(i):
        return i * frame / sr

    def flip_short(runs, min_dur, target):
        # 把时长 < min_dur 的区间翻成 target
        for t0_f, t1_f, lab in runs:
            if lab != target and (t1_f - t0_f) < min_dur:
                for f in range(t0_f, t1_f):
                    voiced[f] = (target == "sounding")

    # 先收集原始 run，再合并短静音、再剔除短音节
    def collect_runs():
        runs = []
        i = 0
        while i < n_frames:
            j = i
            cur = voiced[i]
            while j < n_frames and voiced[j] == cur:
                j += 1
            lab = "sounding" if cur else "sil"
            runs.append([i, j, lab])
            i = j
        return runs

    flip_short(collect_runs(), min_silence, "sounding")   # 短静音 -> 音节
    flip_short(collect_runs(), min_syllable, "sil")        # 短音节 -> 静音

    runs = collect_runs()
    intervals = []
    for t0_f, t1_f, lab in runs:
        t0 = frame_t(t0_f)
        t1 = frame_t(t1_f) if t1_f < n_frames else (n / sr)
        intervals.append((t0, t1, lab))
    if intervals:
        intervals[-1] = (intervals[-1][0], n / sr, intervals[-1][2])
    return intervals


# ----------------------------- 写 TextGrid（Praat 长文本格式） -----------------------------
def _fmt(x):
    return "%.6f" % x


def _write_textgrid(path, xmax, intervals):
    lines = [
        'File type = "ooTextFile"',
        'Object class = "TextGrid"',
        "",
        "xmin = 0",
        "xmax = %s" % _fmt(xmax),
        "tiers? <exists>",
        "size = 1",
        "item []:",
        "    item [1]:",
        '        class = "IntervalTier"',
        '        name = "syllables"',
        "        xmin = 0",
        "        xmax = %s" % _fmt(xmax),
        "        intervals: size = %d" % len(intervals),
    ]
    for i, (t0, t1, label) in enumerate(intervals, 1):
        safe = label.replace('"', '\\"')
        lines.append("        intervals [%d]:" % i)
        lines.append("            xmin = %s" % _fmt(t0))
        lines.append("            xmax = %s" % _fmt(t1))
        lines.append('            text = "%s"' % safe)
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


# ----------------------------- 批量切分一页目录 -----------------------------
def segment_directory(dir_path, page=0, size=9, min_silence=0.1, min_syllable=0.1,
                      threshold_db=-25.0, ext="wav", exe=None, force=False, readonly=False,
                      scope="page"):
    """对 dir_path 下 wav 批量切分，返回九宫格 JSON（与 review_grid.build_grid 同构）。

    files[].intervals = [{t0,t1,label}]；files[].tgPath 为 TextGrid 路径；
    音节段 label 用文件名（去扩展名）标注。

    ``scope``（2026-09-28）：
      - ``"page"``（默认）：**只处理当前页**的 size 个文件 —— 翻页、单文件重切用它。
      - ``"all"``：**遍历整个目录**（含子目录）全部音频，逐个保证有 TextGrid；
        ``files`` 仍只回当前页（供九宫格显示），另用 ``scanned``/``written``/``errors``
        报告整目录结果。「自动制作 TextGrid」按钮走这条 —— 用户要的是"这一批全做"，
        不是"当前这 9 个"。

    幂等策略：wav 同目录已有同名 ``.TextGrid`` 且 ``force=False`` 时，**读取**该文件
    （保留用户在浏览器内或 Praat 里手工精修的结果）而**不覆盖**；仅当文件不存在或
    ``force=True`` 时才自动切分并写出。这样「浏览/翻页」不会抹掉已编辑的标注。

    ``readonly=True``：**只读取**已有 TextGrid，缺文件的返回空 intervals 且**绝不写盘**。
    给「审查九宫格只想刷新分段」这类只读场景用 —— 那里「没有 TextGrid」是合法状态，
    不能顺手替用户生成文件。
    """
    if not dir_path or not os.path.isdir(dir_path):
        return {"ok": False, "error": "目录不存在：%s" % dir_path}
    # 重采样后工作目录自动切到 Resample/（见 working_dir）：与审核/批量/第四步同一口径，
    # 否则会同时拉到原始目录(samples/1)与 Resample/ 两套同名文件 → 互相覆盖 / 切分错位。
    dir_path = working_dir.resolve_working_dir(dir_path, ext)
    all_wavs = _list_wavs(dir_path, ext)   # 相对路径（含子目录，按名排序）
    total = len(all_wavs)
    if total == 0:
        return {"ok": True, "dir": dir_path, "page": int(page), "size": int(size),
                "total": 0, "pages": 0, "files": [], "scanned": 0, "written": 0, "errors": 0}

    size = max(1, int(size))
    pages = (total + size - 1) // size
    page = max(0, min(int(page), pages - 1))
    start = page * size
    page_names = all_wavs[start:start + size]
    # scope=all → 整个目录；否则只当前页
    target_names = all_wavs if str(scope) == "all" else page_names
    page_set = set(page_names)

    files = []
    scanned = written = errors = 0
    for name in target_names:
        wav = os.path.join(dir_path, name)
        rec = {"name": name, "path": wav, "duration": 0.0,
               "intervals": [], "tgPath": "", "count": 0}
        try:
            scanned += 1
            dur = _duration(wav)
            rec["duration"] = round(dur, 3)
            base = os.path.splitext(os.path.basename(wav))[0]
            tg_path = os.path.join(dir_path, os.path.splitext(name)[0] + ".TextGrid")
            if os.path.isfile(tg_path) and not force:
                # 已有 TextGrid：读取并复用（不覆盖手工精修）；读不了就跳过该文件
                try:
                    _, existing = read_textgrid(tg_path)
                except Exception:
                    existing = []
                if existing:
                    rec["intervals"] = [{"t0": t0, "t1": t1, "label": lab}
                                        for t0, t1, lab in existing]
                    rec["tgPath"] = tg_path
                    rec["count"] = len(existing)
                    if name in page_set:
                        files.append(rec)
                    continue
            if readonly:
                # 只读模式：没有 TextGrid 就返回空区间，绝不为了"刷新"而替用户生成文件
                if name in page_set:
                    files.append(rec)
                continue
            # 否则自动切分并写出
            samples, sr, _ = _read_wav(wav)
            intervals = segment_silences(samples, sr, float(min_silence),
                                         float(min_syllable), float(threshold_db))
            relabeled = [(t0, t1, (base if lab == "sounding" else lab))
                         for t0, t1, lab in intervals]
            _write_textgrid(tg_path, dur, relabeled)
            written += 1
            rec["intervals"] = [{"t0": t0, "t1": t1, "label": lab}
                                for t0, t1, lab in relabeled]
            rec["tgPath"] = tg_path
            rec["count"] = len(relabeled)
        except Exception as e:
            errors += 1
            rec["error"] = "切分失败：%s" % e
        if name in page_set:
            files.append(rec)

    # 返回顺序按当前页顺序（整目录遍历时追加顺序 == all_wavs 顺序，切片已一致）
    order = {n: i for i, n in enumerate(page_names)}
    files.sort(key=lambda r: order.get(r["name"], 1 << 30))

    return {
        "ok": True, "dir": dir_path, "page": page, "size": size,
        "total": total, "pages": pages, "files": files,
        "scanned": scanned, "written": written, "errors": errors,
    }


# ----------------------------- 批量重切分（覆盖式） -----------------------------
def resegment_files(dir_path, names, min_silence=0.1, min_syllable=0.1,
                    threshold_db=-25.0, ext="wav"):
    """批量重新制作 TextGrid：对选中的 wav（相对 dir_path 的路径）强制用新参数重切分，
    覆盖写盘同名 ``.TextGrid``（无论旧文件是否存在、是否手工精修过——"重测"语义就是重做）。

    与 segment_directory 的「有文件就复用、不覆盖手工精修」相反：九宫格「重测」按钮就是
    要"用新参数重做这些文件"，所以这里直接 overwrite，不读旧文件、不保留旧标注。
    不调用 Praat（纯 Python RMS 切分），参数即页面"进阶 TextGrid 参数"那一组
    （minSilence / minSyllable / thresholdDb）。
    返回 {ok, done:[name...], errors:[{name, error}...]}。
    """
    if not dir_path or not os.path.isdir(dir_path):
        return {"ok": False, "error": "目录不存在：%s" % dir_path}
    done, errors = [], []
    for n in (names or []):
        if not n:
            continue
        wav = os.path.join(dir_path, n)
        if not os.path.isfile(wav):
            errors.append({"name": n, "error": "文件不存在"})
            continue
        try:
            dur = _duration(wav)
            base = os.path.splitext(os.path.basename(wav))[0]
            tg_path = os.path.splitext(wav)[0] + ".TextGrid"
            samples, sr, _ = _read_wav(wav)
            intervals = segment_silences(samples, sr, float(min_silence),
                                         float(min_syllable), float(threshold_db))
            relabeled = [(t0, t1, (base if lab == "sounding" else lab))
                         for t0, t1, lab in intervals]
            _write_textgrid(tg_path, dur, relabeled)
            done.append(n)
        except Exception as e:
            errors.append({"name": n, "error": "切分失败：%s" % e})
    return {"ok": True, "done": done, "errors": errors}


# ----------------------------- 在 Praat 里精修并保存 -----------------------------
def _build_edit_script(wav_path, tg_path):
    wav_u = wav_path.replace("\\", "/")
    tg_u = tg_path.replace("\\", "/")
    return (
        'Read from file: "%s"\n'
        'snd = selected("Sound", 1)\n'
        'Read from file: "%s"\n'
        'tg = selected("TextGrid", 1)\n'
        'selectObject: snd\n'
        'plusObject: tg\n'
        'View & Edit\n'
        # beginPause 只有标题一个参数；按钮在 endPause（末尾数字=回车默认/取消按钮，
        # 写取消按钮号就没有 Stop 键，关窗 = 点取消；详见 review_grid._build_pp_edit_script 注释）
        'beginPause: "编辑 TextGrid"\n'
        'comment: "在编辑器里拖动边界、双击改标签；完成后点「保存并退出」写回 TextGrid。"\n'
        'clicked = endPause: "保存并退出", "取消", 1, 2\n'
        'if clicked = 2\n'
        '    removeObject: snd, tg\n'
        '    exitScript()\n'
        'endif\n'
        'selectObject: tg\n'
        'Save as text file: "%s"\n'
        'writeInfoLine: "OK saved"\n'
    ) % (wav_u, tg_u, tg_u)


def open_in_praat_with_tg(wav_path, tg_path=None, exe=None):
    """用 GUI Praat 载入 wav + 同名 TextGrid，进入 View & Edit 供精修；点「保存并退出」写回。

    tg_path 缺省时按 wav 同目录同名 .TextGrid 推导。
    """
    exe = _resolve_exe(exe)
    if not exe:
        return {"ok": False, "error": "找不到 Praat 程序（请在设置里指定 praat.exe）"}
    if not wav_path or not os.path.isfile(wav_path):
        return {"ok": False, "error": "音频文件不存在：%s" % wav_path}
    if not tg_path:
        tg_path = os.path.splitext(wav_path)[0] + ".TextGrid"
    if not os.path.isfile(tg_path):
        return {"ok": False, "error": "TextGrid 不存在（请先自动制作）: %s" % tg_path}
    try:
        tmp = tempfile.mkdtemp(prefix="psseg_")
        sp = os.path.join(tmp, "edit.praat")
        with open(sp, "w", encoding="utf-8") as f:
            f.write(_build_edit_script(wav_path, tg_path))
        # --new-send：起新 GUI 并在 GUI 里自动运行脚本（2026-09-25 实测 Praat 7.0.02，
        # --run 是无 GUI 的 batch 模式、裸脚本参数瞬间退出；详见 review_grid.open_pointprocess 注释）
        # CREATE_NEW_PROCESS_GROUP：与启动服务器解耦，关掉/重启外壳不会连带杀掉 Praat
        subprocess.Popen([exe, "--new-send", sp],
                         creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
    except Exception as e:
        return {"ok": False, "error": "启动 Praat 失败：%s" % e}
    return {"ok": True}
