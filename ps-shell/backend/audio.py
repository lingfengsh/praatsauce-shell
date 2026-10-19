# -*- coding: utf-8 -*-
"""扫描声音文件目录与 TextGrid 配套情况。"""

import os
import wave
import re
import struct


def _wav_info(path):
    """返回 (duration, sample_rate, channels)；非 wav 或读取失败返回 (None, None, None)。"""
    try:
        with wave.open(path, "rb") as w:
            frames = w.getnframes()
            rate = w.getframerate()
            ch = w.getnchannels()
            if rate:
                return (frames / float(rate), rate, ch)
            return (None, rate, ch)
    except Exception:
        return (None, None, None)


def scan_directory(dirpath, ext="wav", limit=5000):
    """列出目录里指定扩展名的声音文件，附带时长/采样率/声道信息。"""
    result = {"ok": False, "dir": dirpath, "files": [], "count": 0,
              "totalDuration": 0.0, "sampleRates": [], "error": ""}
    if not dirpath or not os.path.isdir(dirpath):
        result["error"] = "目录不存在或不可访问"
        return result
    ext = (ext or "wav").strip().lstrip(".").lower()
    try:
        names = sorted(os.listdir(dirpath))
    except Exception as e:
        result["error"] = f"无法读取目录：{e}"
        return result

    rates = {}
    total = 0.0
    for n in names:
        if not n.lower().endswith("." + ext):
            continue
        full = os.path.join(dirpath, n)
        if not os.path.isfile(full):
            continue
        size = os.path.getsize(full)
        dur, sr, ch = _wav_info(full)
        if sr:
            rates[sr] = rates.get(sr, 0) + 1
        if dur:
            total += dur
        result["files"].append({
            "name": n, "size": size, "duration": dur,
            "sampleRate": sr, "channels": ch,
        })
        if len(result["files"]) >= limit:
            break

    result["ok"] = True
    result["count"] = len(result["files"])
    result["totalDuration"] = round(total, 3)
    result["sampleRates"] = [{"rate": k, "count": v} for k, v in
                             sorted(rates.items(), key=lambda kv: -kv[1])]
    return result


def _tg_tiers(path):
    """粗略读出 TextGrid 的层数。"""
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            head = f.read(200000)
        m = re.findall(r"item\s*\[\d+\]\s*:", head)
        if m:
            return len(m)
        m2 = re.search(r"size\s*=\s*(\d+)", head)
        if m2:
            return int(m2.group(1))
    except Exception:
        pass
    return None


def textgrid_report(wav_files, tg_dir):
    """检查 TextGrid 与声音文件是否一一对应。

    praatSauce 要求数量严格相等，否则直接报错退出，所以必须在开跑前预检。
    """
    rep = {"ok": False, "tgDir": tg_dir, "count": 0, "matched": 0,
           "missing": [], "extra": [], "paired": [], "tiers": None, "error": ""}
    if not tg_dir or not os.path.isdir(tg_dir):
        rep["error"] = "TextGrid 目录不存在"
        return rep
    try:
        tg_names = [n for n in os.listdir(tg_dir) if n.lower().endswith(".textgrid")]
    except Exception as e:
        rep["error"] = f"无法读取 TextGrid 目录：{e}"
        return rep

    tg_base = {os.path.splitext(n)[0] for n in tg_names}
    wav_base = {os.path.splitext(n)[0] for n in wav_files}

    rep["count"] = len(tg_names)
    rep["matched"] = len(tg_base & wav_base)
    rep["paired"] = sorted(tg_base & wav_base)
    rep["missing"] = sorted(wav_base - tg_base)[:50]
    rep["extra"] = sorted(tg_base - wav_base)[:50]
    rep["ok"] = True
    if tg_names:
        rep["tiers"] = _tg_tiers(os.path.join(tg_dir, tg_names[0]))
    return rep


def human_size(n):
    if n is None:
        return ""
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024.0


def human_duration(sec):
    if sec is None:
        return "—"
    if sec < 60:
        return f"{sec:.2f} 秒"
    m, s = divmod(sec, 60)
    return f"{int(m)} 分 {s:05.2f} 秒"
