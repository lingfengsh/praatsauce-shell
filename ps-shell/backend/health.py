# -*- coding: utf-8 -*-
"""输入目录健康检查：不真实调 Praat，仅基于 os.listdir + wave 判断。

检查项对应任务卡 PS-FT2 第 3 节 W2：
  DIR_BAD / NO_FILES / CAN_TRANSCODE / EXT_CASE / STEREO /
  RATE_MIXED / TOO_SHORT / TG_COUNT / TG_NAME / TG_DIR_BAD / ALL_GREEN
"""

import os
import unicodedata

from . import audio


TRANSCODABLE_EXTS = (".mp3", ".flac", ".m4a")
# 转码产物所在子目录名（输入目录内），health 扫描时排除，避免二次扫描
CONVERTED_DIR = "converted_wav"


def normalize_name(s):
    """规范化文件名，供 TextGrid 模糊配对使用。

    顺序：NFKC（含全角→半角）→ 转小写 → 去全部空白 → `_`/`-`/`.` 统一删除。
    返回空串表示输入为空。
    """
    if s is None:
        return ""
    t = unicodedata.normalize("NFKC", str(s))
    t = t.lower()
    t = "".join(ch for ch in t if not ch.isspace())
    t = t.replace("_", "").replace("-", "").replace(".", "")
    return t


def _list_audio(input_dir, ext):
    """返回目录下目标扩展名的文件名列表（不含 converted_wav 子目录项）。"""
    ext = (ext or "wav").strip().lstrip(".").lower()
    try:
        names = os.listdir(input_dir)
    except Exception:
        return []
    return [n for n in names if n != CONVERTED_DIR and n.lower().endswith("." + ext)]


def health_check(input_dir, ext="wav", tg_dir=None, use_textgrid=False):
    """扫描输入目录，返回 {ok, items[], summary{}}。

    items 中每条：{level: error|warn|ok, code, msg, action: transcode|tgmatch|none, data}
    全部基于 os.listdir + wave，不真实调 Praat。
    """
    items = []
    summary = {"audio": 0, "transcodable": 0, "tg": 0, "matched": 0}

    if not input_dir or not os.path.isdir(input_dir):
        items.append({
            "level": "error", "code": "DIR_BAD",
            "msg": "音频目录不存在或无法读取，请重新选择。",
            "action": "none", "data": {},
        })
        return {"ok": False, "items": items, "summary": summary}

    ext = (ext or "wav").strip().lstrip(".").lower()
    wavs = _list_audio(input_dir, ext)
    others = [n for n in os.listdir(input_dir)
              if n != CONVERTED_DIR and n.lower().endswith(TRANSCODABLE_EXTS)]
    summary["audio"] = len(wavs)
    summary["transcodable"] = len(others)

    if not wavs and not others:
        items.append({
            "level": "error", "code": "NO_FILES",
            "msg": "这个文件夹里没有找到任何声音文件（支持 wav / mp3 / flac / m4a）。"
                   "换个目录，或先把录音放进来。",
            "action": "none", "data": {},
        })
        return {"ok": False, "items": items, "summary": summary}

    if others:
        items.append({
            "level": "warn", "code": "CAN_TRANSCODE",
            "msg": f"有 {len(others)} 个 mp3 / flac 等格式文件，Praat 读不了，可一键转成 wav。",
            "action": "transcode", "data": {"files": others},
        })

    # 扩展名大小写变体（如 .WAV）：系统会一并扫到，仅提醒
    case_variants = [n for n in wavs if not n.endswith("." + ext)]
    if case_variants:
        items.append({
            "level": "warn", "code": "EXT_CASE",
            "msg": f"有 {len(case_variants)} 个文件扩展名是大写（如 .WAV），系统会自动一并扫到，仅提醒。",
            "action": "none", "data": {},
        })

    # 立体声 / 采样率混合 / 过短：用 wave 读（复用 audio._wav_info）
    rates = set()
    stereo = 0
    short = 0
    for n in wavs:
        full = os.path.join(input_dir, n)
        dur, sr, ch = audio._wav_info(full)
        if sr:
            rates.add(sr)
        if ch and ch >= 2:
            stereo += 1
        if dur is not None and dur < 0.5:
            short += 1
    if stereo:
        items.append({
            "level": "warn", "code": "STEREO",
            "msg": f"有 {stereo} 个立体声 wav，转码时可顺带转成单声道（Praat 更稳）。",
            "action": "transcode", "data": {},
        })
    if len(rates) > 1:
        items.append({
            "level": "warn", "code": "RATE_MIXED",
            "msg": f"采样率不统一（{', '.join(str(r) for r in sorted(rates))} Hz），建议统一到同一个采样率。",
            "action": "none", "data": {"rates": sorted(rates)},
        })
    if short:
        items.append({
            "level": "warn", "code": "TOO_SHORT",
            "msg": f"有 {short} 个 wav 时长不到 0.5 秒，可能太短测不准，建议检查。",
            "action": "none", "data": {},
        })

    # TextGrid 配对情况
    if use_textgrid:
        if not tg_dir or not os.path.isdir(tg_dir):
            items.append({
                "level": "error", "code": "TG_DIR_BAD",
                "msg": "勾选了 TextGrid 但标注目录不存在，请先指定标注目录。",
                "action": "none", "data": {},
            })
        else:
            tg_names = [n for n in os.listdir(tg_dir) if n.lower().endswith(".textgrid")]
            wav_base = {os.path.splitext(n)[0] for n in wavs}
            tg_base = {os.path.splitext(n)[0] for n in tg_names}
            summary["tg"] = len(tg_names)
            summary["matched"] = len(wav_base & tg_base)
            if len(wav_base) != len(tg_base):
                items.append({
                    "level": "warn", "code": "TG_COUNT",
                    "msg": f"声音 {len(wav_base)} 个、TextGrid {len(tg_base)} 个，数量不一致；"
                           f"可用「自动配对标注」按文件名匹配。",
                    "action": "tgmatch", "data": {},
                })
            elif normalize_name_set(wav_base) != normalize_name_set(tg_base):
                diff = sorted(wav_base ^ tg_base)
                items.append({
                    "level": "warn", "code": "TG_NAME",
                    "msg": "有文件名对不上（可能大小写 / 符号差异）："
                           + "、".join(diff[:5]) + (" …" if len(diff) > 5 else ""),
                    "action": "tgmatch", "data": {},
                })

    if not items:
        items.append({
            "level": "ok", "code": "ALL_GREEN",
            "msg": "目录检查通过，没有发现需要处理的隐患。",
            "action": "none", "data": {},
        })

    return {"ok": True, "items": items, "summary": summary}


def normalize_name_set(names):
    """把一组基名规范化成集合，供数量相等时比较差异。"""
    return {normalize_name(n) for n in names}
