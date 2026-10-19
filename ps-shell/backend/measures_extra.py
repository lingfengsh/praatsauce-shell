# -*- coding: utf-8 -*-
"""Python 外接补算：SHR（次谐谐波比）。

SHR 基于 opensauce-python 对 VoiceSauce v1.25 的复现，仅依赖 numpy。
CPPS 已改由 Praat 标准算法直出（ps_get_CPPS.praat：先平滑倒谱再取峰，
Maryn & Weenink 2015 协议），不再走 Python 补算。
"""
import math
import os
import wave
import re

UNDEFINED = {"", "--undefined--", "undefined", "nan", "NaN", "NA", "--", "0"}

# ---- numpy 懒加载，缺失时优雅降级 ----
_HAVE_NUMPY = None

def _numpy():
    global _HAVE_NUMPY
    if _HAVE_NUMPY is None:
        try:
            import numpy as np
            _HAVE_NUMPY = np
        except Exception:
            _HAVE_NUMPY = False
    return _HAVE_NUMPY


def numpy_ok():
    return bool(_numpy())


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


def _read_wav_mono(path):
    """用标准库 wave 读单声道 float 数组；失败返回 (None, None)。"""
    np = _numpy()
    if not np:
        return None, None
    try:
        with wave.open(path, "rb") as w:
            nch = w.getnchannels()
            sw = w.getsampwidth()
            fs = w.getframerate()
            nframes = w.getnframes()
            raw = w.readframes(nframes)
    except Exception as e:
        return None, None

    if sw == 1:
        arr = np.frombuffer(raw, dtype=np.uint8).astype(np.float64)
        arr = (arr - 128.0) / 128.0
    elif sw == 2:
        arr = np.frombuffer(raw, dtype=np.int16).astype(np.float64)
        arr = arr / 32768.0
    elif sw == 3:
        # 24-bit：补齐到 32-bit 有符号
        a = np.frombuffer(raw, dtype=np.uint8)
        a = a.reshape(-1, 3)
        b = np.zeros((a.shape[0], 4), dtype=np.uint8)
        b[:, 1:] = a
        signed = b.view(np.int32).reshape(-1)
        arr = signed.astype(np.float64) / 8388608.0
    elif sw == 4:
        arr = np.frombuffer(raw, dtype=np.int32).astype(np.float64)
        arr = arr / 2147483648.0
    else:
        return None, None

    if nch > 1:
        arr = arr.reshape(-1, nch).mean(axis=1)
    return arr, fs


def _round_half_away_from_zero(x):
    """numpy.round 默认 half to even；VoiceSauce 用 half away from zero。"""
    np = _numpy()
    if np is False:
        return x
    fx = np.floor(np.abs(x) + 0.5)
    return np.sign(x) * fx


# =====================================================================
# SHR 算法（基于 opensauce-python / VoiceSauce v1.25 / Sun 2002）
# =====================================================================

def _window(width, window_type="hamm"):
    np = _numpy()
    n = np.arange(width)
    t = 2 * np.pi * n / (width - 1)
    if window_type.startswith("hamm"):
        return 0.54 - 0.46 * np.cos(t)
    if window_type.startswith("hann"):
        return 0.5 * (1 - np.cos(t))
    return np.ones(width)


def _to_frames(samples, curpos, segmentlen, window_type="hamm"):
    np = _numpy()
    last_index = len(samples) - 1
    num_frames = len(curpos)
    start = curpos - segmentlen // 2
    start = np.where(start < 0, 0, start)
    endpos = start + segmentlen - 1
    over = np.where(endpos > last_index)[0]
    endpos = np.where(endpos > last_index, last_index, endpos)
    start = np.where(endpos > last_index, last_index + 1 - segmentlen, start)
    idx = start[:, None] + np.arange(segmentlen)[None, :]
    frames = samples[idx]
    win = _window(segmentlen, window_type)
    return frames * win[None, :]


def _get_log_spectrum(segment, fftlen, limit, logf, interp_logf):
    np = _numpy()
    spectra = np.fft.fft(segment, fftlen)
    amplitude = np.abs(spectra[:fftlen // 2 + 1])
    amplitude = amplitude[1:limit + 2]
    interp_amplitude = np.interp(interp_logf, logf, amplitude)
    interp_amplitude = interp_amplitude - np.min(interp_amplitude)
    return interp_amplitude


def _two_max(x, lowerbound, upperbound, unit_len):
    np = _numpy()
    max_index = min(upperbound, len(x) - 1)
    mag = np.array([np.max(x[lowerbound:upperbound + 1])])
    index = np.where(x == mag)[0]
    if mag[0] < 0:
        return mag, index
    harmonics = 2.0
    limit = 0.0625  # 1/8 倍频程
    startpos = index[0] + int(round((np.log2(harmonics - limit)) / unit_len))
    if startpos <= max_index:
        endpos = index[0] + int(round((np.log2(harmonics + limit)) / unit_len))
        endpos = min(max_index, endpos)
        mag2 = np.max(x[startpos:endpos + 1])
        index2 = np.where(x[startpos:] == mag2)[0][0] + startpos
        if mag2 > 0:
            mag = np.append(mag, mag2)
            index = np.append(index, index2)
    return mag, index


def _compute_shr(log_spectrum, min_bin, startpos, endpos, lowerbound, upperbound,
                 n, shift_units, shr_threshold):
    np = _numpy()
    len_spectrum = len(log_spectrum)
    total_len = shift_units + len_spectrum
    shshift = np.zeros((n, total_len))
    shshift[0, total_len - len_spectrum:total_len] = log_spectrum
    for i in range(1, n):
        shshift[i, startpos[i - 1]:endpos[i - 1] + 1] = (
            log_spectrum[:endpos[i - 1] - startpos[i - 1] + 1])
    shshift = shshift[:, shift_units:total_len]
    shseven = np.sum(shshift[0:n:2, :], axis=0)
    shsodd = np.sum(shshift[1:n - 1:2, :], axis=0)
    difference = shsodd - shseven
    mag, index = _two_max(difference, lowerbound, upperbound, min_bin)
    if len(mag) == 1:
        if mag[0] <= 0:
            return -1, 0.0, shshift, index
        return int(index[0]), 0.0, shshift, index
    shr = (mag[0] - mag[1]) / (mag[0] + mag[1])
    if shr <= shr_threshold:
        return int(index[1]), float(shr), shshift, index
    return int(index[0]), float(shr), shshift, index


def _shrp(Y, Fs, F0MinMax=(50, 500), frame_length=40, timestep=10,
          SHR_Threshold=0.4, ceiling=1250):
    np = _numpy()
    minf0, maxf0 = F0MinMax
    Y = Y - np.mean(Y)
    mx = np.max(np.abs(Y))
    if mx > 0:
        Y = Y / mx
    total_len = len(Y)
    interpolation_depth = 0.5
    maxlogf = np.log2(maxf0 / 2)
    minlogf = np.log2(minf0 / 2)
    N = int(np.floor(ceiling / minf0))
    N = N - (N % 2)
    N = N * 4
    segmentlen = int(np.around(frame_length * Fs / 1000.0))
    inc = int(np.around(timestep * Fs / 1000.0))
    nf = int(np.fix((total_len - segmentlen + inc) / inc))
    if nf <= 0:
        return np.array([]), np.array([]), np.array([]), np.array([]).reshape(0, 2)
    n = np.arange(nf)
    f0_time = np.transpose(n * timestep + frame_length / 2.0)
    fftlen = 1
    while fftlen < segmentlen * (1 + interpolation_depth):
        fftlen *= 2
    frequency = Fs * np.arange(1, fftlen // 2 + 1) / fftlen
    limit = int(np.where(frequency >= ceiling)[0][0])
    frequency = frequency[:limit + 1]
    logf = np.log2(frequency)
    del frequency
    min_bin = logf[-1] - logf[-2]
    shift = np.log2(N)
    shift_units = int(np.around(shift / min_bin))
    i = np.arange(2, N + 1)
    startpos = shift_units + 1 - np.around(np.log2(i) / min_bin).astype(int)
    startpos = np.where(startpos < 1, 1, startpos) - 1
    interp_logf = np.arange(logf[0], logf[-1], min_bin)
    interp_len = len(interp_logf)
    totallen = shift_units + interp_len
    endpos = startpos + interp_len - 1
    endpos = np.where(endpos >= totallen, totallen - 1, endpos)
    newfre = np.power(2, interp_logf)
    upperbound = int(np.where(interp_logf >= maxlogf)[0][0])
    lowerbound = int(np.where(interp_logf >= minlogf)[0][0])
    curpos = np.around(f0_time / 1000.0 * Fs).astype(int) - 1
    frames = _to_frames(Y, curpos, segmentlen)
    f0_value = np.zeros(nf)
    SHR = np.zeros(nf)
    f0_time = f0_time[:nf + 1]
    f0_candidates = np.zeros((nf, 2))
    curf0, cur_SHR, cur_cand1, cur_cand2 = 0, 0, 0, 0
    for n in range(nf):
        segment = frames[n, :]
        log_spectrum = _get_log_spectrum(segment, fftlen, limit, logf, interp_logf)
        peak_index, cur_SHR, shshift, all_peak_indices = _compute_shr(
            log_spectrum, min_bin, startpos, endpos, lowerbound, upperbound,
            N, shift_units, SHR_Threshold)
        if peak_index == -1:
            curf0 = 0
            cur_cand1, cur_cand2 = 0, 0
        else:
            curf0 = newfre[peak_index] * 2
            if curf0 > maxf0:
                curf0 = curf0 / 2
            if len(all_peak_indices) == 1:
                cur_cand1 = 0
                cur_cand2 = newfre[all_peak_indices[0]] * 2
            else:
                cur_cand1 = newfre[all_peak_indices[0]] * 2
                cur_cand2 = newfre[all_peak_indices[1]] * 2
            if cur_cand1 > maxf0:
                cur_cand1 = cur_cand1 / 2
            if cur_cand2 > maxf0:
                cur_cand2 = cur_cand2 / 2
        f0_value[n] = curf0
        SHR[n] = cur_SHR
        f0_candidates[n, 0] = cur_cand1
        f0_candidates[n, 1] = cur_cand2
    return f0_time, f0_value, SHR, f0_candidates


def _shr_pitch(wav_data, fs, time_step_ms=5.0, f0min=50, f0max=500,
               shr_threshold=0.4, datalen=0):
    np = _numpy()
    # opensauce 原实现 datalen += 1；这里保持兼容
    f0_time, f0_value, shr_value, _ = _shrp(
        wav_data, fs, F0MinMax=(f0min, f0max), frame_length=40,
        timestep=time_step_ms, SHR_Threshold=shr_threshold)
    if datalen <= 0 or len(f0_time) == 0:
        return f0_time, shr_value
    F0 = np.full(datalen, np.nan)
    SHR = np.full(datalen, np.nan)
    t = _round_half_away_from_zero(f0_time)
    for k in range(datalen):
        target = k * time_step_ms
        dabs = np.abs(t - target)
        inx = int(dabs.argmin())
        if dabs[inx] > time_step_ms:
            continue
        if 0 <= k < datalen:
            F0[k] = f0_value[inx]
            SHR[k] = shr_value[inx]
    return F0, SHR


# =====================================================================
# 主入口
# =====================================================================

def augment_result(path, values, log_fn=None):
    """读取 praatSauce 生成的 TSV，按需补算 SHR 列并写回。

    values 是运行时的参数字典；log_fn(msg, tag='out') 用于记录进度。
    返回 (ok, message)。
    """
    if not path or not os.path.exists(path):
        return False, "结果文件不存在"

    want_shr = bool(int(values.get("shr", 0) or 0))
    if not want_shr:
        return True, "无需补算"

    if log_fn is None:
        log_fn = lambda *a, **k: None

    # 用 results 模块的健壮读取复用逻辑
    from . import results
    res = results.read_table(path)
    if not res["ok"]:
        return False, f"读取结果表失败：{res.get('error', '')}"

    header = res["columns"]
    rows = res["rows"]
    if not rows:
        return True, "结果表为空，无需补算"

    has_file = "file" in header
    has_t = "t" in header
    has_f0 = "f0" in header

    idx = {h: i for i, h in enumerate(header)}
    file_idx = idx.get("file")
    t_idx = idx.get("t")
    f0_idx = idx.get("f0")

    input_dir = (values.get("inputDir") or "").strip()
    sound_ext = (values.get("soundExt") or "wav").strip().lstrip(".")
    f0min = float(values.get("f0min") or 50)
    f0max = float(values.get("f0max") or 500)
    # 分析步长（秒）→ SHR 帧移（毫秒）
    interval_fixed = float(values.get("intervalFixed") or 0.005)
    time_step_ms = interval_fixed * 1000.0

    # 收集 CPP / f0 / time / file 序列
    groups = {}
    for r in rows:
        file_key = r[file_idx].strip() if file_idx is not None and len(r) > file_idx else ""
        groups.setdefault(file_key, []).append(r)

    # 按 t 排序并记录位置
    file_keys = list(groups.keys())
    file_frames = {}
    for fk in file_keys:
        lst = groups[fk]
        if has_t and t_idx is not None:
            lst.sort(key=lambda r: _to_float(r[t_idx]) or 0)
        file_frames[fk] = lst

    new_cols = []
    shr_col_idx = None

    if want_shr:
        if "SHR" not in header:
            header.append("SHR")
            new_cols.append("SHR")
        shr_col_idx = header.index("SHR")

    if not new_cols:
        return True, "目标列已存在"

    # 为每一行补齐新列空位
    for r in rows:
        need = len(header) - len(r)
        if need > 0:
            r.extend(["--undefined--"] * need)

    if want_shr:
        np = _numpy()
        if np is False:
            log_fn("SHR 需要 numpy，当前环境未安装；SHR 列将留空。", "err")
            for r in rows:
                if shr_col_idx is not None and len(r) > shr_col_idx:
                    r[shr_col_idx] = "--undefined--"
        else:
            log_fn("SHR：逐文件用 Sun (2002) 算法补算…", "out")
            for fk in file_keys:
                if not fk:
                    continue
                lst = file_frames[fk]
                wav_name = os.path.splitext(fk)[0] + "." + sound_ext
                wav_path = os.path.join(input_dir, wav_name)
                if not os.path.exists(wav_path):
                    # 兼容 result 中 file 列只存 basename 或带前缀空格的情况
                    wav_path = os.path.join(input_dir, fk)
                if not os.path.exists(wav_path):
                    log_fn(f"SHR 找不到音频：{wav_name}", "err")
                    for r in lst:
                        if shr_col_idx is not None and len(r) > shr_col_idx:
                            r[shr_col_idx] = "--undefined--"
                    continue

                wav_data, fs = _read_wav_mono(wav_path)
                if wav_data is None:
                    log_fn(f"SHR 读音频失败：{wav_name}", "err")
                    for r in lst:
                        if shr_col_idx is not None and len(r) > shr_col_idx:
                            r[shr_col_idx] = "--undefined--"
                    continue

                n_frames = len(lst)
                # 让 SHR 按与结果表相同的帧数对齐
                _, shr_vec = _shr_pitch(
                    wav_data, fs, time_step_ms=time_step_ms,
                    f0min=f0min, f0max=f0max, shr_threshold=0.4,
                    datalen=n_frames)
                for i, r in enumerate(lst):
                    if shr_col_idx is not None and len(r) > shr_col_idx:
                        v = shr_vec[i]
                        if np.isnan(v):
                            r[shr_col_idx] = "--undefined--"
                        else:
                            r[shr_col_idx] = f"{v:.4f}"

    # 写回 TSV：走 results._rewrite 按原文件编码/BOM 重写（Praat 默认 UTF-16）。
    # 之前硬写 UTF-8 导致「勾 SHR」与「不勾 SHR」产出的结果表编码不一致。
    try:
        lines = ["\t".join(header)] + ["\t".join(r[:len(header)]) for r in rows]
        results._rewrite(path, lines)
    except Exception as e:
        return False, f"写回结果表失败：{e}"

    return True, f"已补算并追加列：{', '.join(new_cols)}"
