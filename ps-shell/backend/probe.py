# -*- coding: utf-8 -*-
"""探针两段式（W2）：取目录内首个可读 wav，用 Praat 粗探 f0 范围，给出发音人基频建议。

实测（Praat 7.0.02）要点：
- 分位数命令是 `Get quantile:`（卡上写的 `Get quantile of f0` 在本机不存在），
  完整签名为 4 参数 `Get quantile: fractionOfFrames, fromTime, toTime, unit`，
  unit 传 "Hertz"，fromTime/toTime 传 0 表示全程。
- 只读音频、不改文件，因此 run_script 不加 full_trust，超时 30s。
"""

import os
import re
import uuid

from . import settings, praat

PROBE_SCRIPT = "probe_f0.praat"   # 兼容旧引用；实际生成时用带随机后缀的唯一名


def _build_script(wav_path):
    w = praat.q(wav_path.replace("\\", "/"))
    return (
        'Read from file: "%s"\n' % w +
        'To Pitch: 0, 50, 500\n'
        'q05 = Get quantile: 0.05, 0, 0, "Hertz"\n'
        'q95 = Get quantile: 0.95, 0, 0, "Hertz"\n'
        'writeInfoLine: "PSA_F0MIN ", q05\n'
        'writeInfoLine: "PSA_F0MAX ", q95\n'
        'removeObject: 1\n'
    )


def _first_wav(dir_path, ext="wav"):
    """返回 dir 内按文件名排序的第一个 wav（不含路径）。无则返回 None。"""
    ext = (ext or "wav").strip().lstrip(".")
    try:
        names = [n for n in os.listdir(dir_path) if n.lower().endswith("." + ext.lower())]
    except Exception:
        return None
    names.sort()
    return names[0] if names else None


def parse_probe_output(lines):
    """从 Praat 输出行里解析 PSA_F0MIN / PSA_F0MAX。

    lines 元素是 {"tag","text"} 字典（run_script 的返回格式）或纯字符串。
    返回 (f0min, f0max)；任一个抽不到返回 None。独立成函数以便单测。
    """
    f0min = f0max = None
    for ln in lines:
        text = ln.get("text", "") if isinstance(ln, dict) else str(ln)
        m = re.search(r"PSA_F0MIN\s+([0-9]+(?:\.[0-9]+)?)", text)
        if m:
            try:
                f0min = float(m.group(1))
            except ValueError:
                f0min = None
        m = re.search(r"PSA_F0MAX\s+([0-9]+(?:\.[0-9]+)?)", text)
        if m:
            try:
                f0max = float(m.group(1))
            except ValueError:
                f0max = None
    return f0min, f0max


def suggest_f0_range(p05, p95):
    """把 5%/95% 分位数换算成建议的 f0min/f0max（带边界钳制）。独立成函数以便单测。"""
    f0min = max(20, round(p05 * 0.8))
    f0max = min(1000, round(p95 * 1.3))
    return f0min, f0max


def probe_f0(dir_path, ext="wav"):
    """探测 dir 内首个 wav 的 f0 范围并返回建议值。

    失败返回 {"ok": False, "error": ..., "detail": ...}（detail 放 Praat stderr 摘要）。
    """
    if not dir_path or not os.path.isdir(dir_path):
        return {"ok": False, "error": "目录不存在或不可访问"}
    name = _first_wav(dir_path, ext)
    if not name:
        return {"ok": False, "error": "目录里没有音频文件"}

    wav_path = os.path.join(dir_path, name)
    os.makedirs(settings.WORK_DIR, exist_ok=True)
    # 固定名在并发请求下会互相覆盖（Praat 读到别人的脚本）；用唯一名 + 用完即删
    script_path = os.path.join(settings.WORK_DIR, "probe_f0_%s.praat" % uuid.uuid4().hex)
    with open(script_path, "w", encoding="utf-8") as f:
        f.write(_build_script(wav_path))

    cfg = settings.load()
    exe = cfg.get("praatExe") or ""
    if not exe or not os.path.exists(exe):
        return {"ok": False, "error": "没有找到 Praat 程序，无法探测基频"}

    # 只读音频，不加 full_trust；极端情况下 30s 足够
    try:
        rc, lines = praat.run_script(exe, script_path, timeout=30)
    finally:
        try:
            os.remove(script_path)
        except Exception:
            pass

    f0min, f0max = parse_probe_output(lines)
    if f0min is None or f0max is None:
        err_text = "\n".join(l.get("text", "") for l in lines if isinstance(l, dict) and l.get("tag") == "err")
        return {"ok": False, "error": "无法从音频解析出基频", "detail": err_text[:500]}

    sug_min, sug_max = suggest_f0_range(f0min, f0max)
    return {"ok": True, "f0min": sug_min, "f0max": sug_max, "file": name}
