# -*- coding: utf-8 -*-
"""TextGrid 模糊配对（由 praatSauce.praat 的 1:1 硬校验反推的设计）。

脚本端约束（只读事实，不修改 praatSauce-master/）：
  - useTextGrid 时 TG 侧永远从 tgDir 全目录扫描 *.TextGrid；
  - 声音数 <> TG 数 → exitScript("one-to-one correspondence")。
所以要让脚本通过，必须让 tgDir 里「只有配对成功的 TG 且数量恰等于声音数」。
本模块据此提供：proposal（提配对方案）+ apply（把勾选的 TG 复制到 staging 目录并重命名，
与 wav 同基名，再写 filelist.txt 供脚本用完整路径点名声音）。

所有操作只读原文件、只产副本，绝不移动/改写原始音频与 TextGrid。
"""

import os
import time
import shutil
import difflib

from . import settings, health


def _list_by_base(dir_path, ext):
    """返回 {基名: 文件名} 列表。ext 不带点（用于音频）；TextGrid 固定 .textgrid。"""
    if not dir_path or not os.path.isdir(dir_path):
        return {}
    out = {}
    for n in os.listdir(dir_path):
        low = n.lower()
        if ext == ".textgrid":
            ok = low.endswith(".textgrid")
        else:
            ok = low.endswith("." + ext.lstrip(".").lower())
        if ok:
            out[os.path.splitext(n)[0]] = n
    return out


def proposal(input_dir, ext, tg_dir):
    """给 wav × TG 提配对方案。

    返回 {ok, exact:[[wav,tg]...], fuzzy:[[wav,tg]...],
           ambiguous:[{wav, candidates:[...], nearest}], unmatchedWav:[...], unmatchedTg:[...]}。
    - exact：基名严格相等；
    - fuzzy：剩余项按 health.normalize_name 相等匹配（一对一）；
    - ambiguous：一个 wav 规范化后对应多个 tg（需人工确认，预选编辑距离最近者）；
    - unmatched：无论如何都对不上的。
    """
    wav_map = _list_by_base(input_dir, ext)
    tg_map = _list_by_base(tg_dir, ".textgrid")

    exact = []
    rem_wav = {}
    rem_tg = {}
    for b, fn in wav_map.items():
        if b in tg_map:
            exact.append([fn, tg_map[b]])
        else:
            rem_wav[b] = fn
    for b, fn in tg_map.items():
        if b not in wav_map:
            rem_tg[b] = fn

    fuzzy = []
    ambiguous = []
    unmatched_wav = []
    used_tg = set()

    for b, fn in rem_wav.items():
        nb = health.normalize_name(b)
        cands = [tb for tb, tfn in rem_tg.items()
                 if tb not in used_tg and health.normalize_name(tb) == nb]
        if not cands:
            unmatched_wav.append(fn)
            continue
        if len(cands) == 1:
            tb = cands[0]
            used_tg.add(tb)
            fuzzy.append([fn, rem_tg[tb]])
        else:
            # 歧义：一个 wav 对应多个 tg，预选编辑距离最近者，全部标记已占用（仅人工确认）
            nearest = max(cands, key=lambda tb: difflib.SequenceMatcher(None, b, tb).ratio())
            ambiguous.append({
                "wav": fn,
                "candidates": [rem_tg[tb] for tb in cands],
                "nearest": rem_tg[nearest],
            })
            used_tg.update(cands)

    unmatched_tg = [rem_tg[tb] for tb in rem_tg if tb not in used_tg]

    return {
        "ok": True,
        "exact": exact,
        "fuzzy": fuzzy,
        "ambiguous": ambiguous,
        "unmatchedWav": unmatched_wav,
        "unmatchedTg": unmatched_tg,
    }


def apply(input_dir, ext, tg_dir, pairs):
    """把用户确认后的 pairs 应用到 staging 目录。

    pairs: [[wavFile, tgFile], ...]（原始文件名，非完整路径）。
    在 WORK_DIR/tg_staging/<时间戳>/ 下：
      - 复制 pairs 里的 TG 进 staging，重命名为与 wav 同基名 + .TextGrid；
      - 写 filelist.txt（每行一条 wav 完整路径，UTF-8 无 BOM，\\n 行尾）。
    返回 {ok, tgDir, filelist, pairs, skipped:[...]}。不改原始文件、不移动任何文件。
    """
    if not pairs:
        return {"ok": False, "error": "没有要应用的配对"}

    stamp = time.strftime("%Y%m%d-%H%M%S")
    staging = os.path.join(settings.WORK_DIR, "tg_staging", stamp)
    os.makedirs(staging, exist_ok=True)

    skipped = []
    wav_paths = []
    for pair in pairs:
        if not isinstance(pair, (list, tuple)) or len(pair) < 2:
            skipped.append(pair)
            continue
        wav_file, tg_file = pair[0], pair[1]
        if not wav_file or not tg_file:
            skipped.append(pair)
            continue
        wav_full = os.path.join(input_dir, wav_file)
        tg_full = os.path.join(tg_dir, tg_file)
        if not os.path.isfile(wav_full) or not os.path.isfile(tg_full):
            skipped.append(pair)
            continue
        wav_base = os.path.splitext(wav_file)[0]
        dst = os.path.join(staging, wav_base + ".TextGrid")
        try:
            shutil.copy2(tg_full, dst)
        except Exception:
            skipped.append(pair)
            continue
        wav_paths.append(wav_full)

    filelist = os.path.join(staging, "filelist.txt")
    with open(filelist, "w", encoding="utf-8", newline="") as f:
        f.write("\n".join(wav_paths))
        if wav_paths:
            f.write("\n")

    return {
        "ok": True,
        "tgDir": staging,
        "filelist": filelist,
        "pairs": len(wav_paths),
        "skipped": skipped,
    }
