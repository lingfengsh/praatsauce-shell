# -*- coding: utf-8 -*-
"""审查档案存储：全局默认 + 按发音人覆盖。

结构（review_profiles.json，存于 settings.WORK_DIR）：
{
  "global":   { "pitch": {...}, "formant": {...}, "params": {...}, "updatedAt": "..." },
  "speakers": { "<speakerId>": { 同上 } }
}
- pitch:  {"variant": "<候选id>", "points": [{"t":, "f0":}, ...]}  手动 F0 点（PitchTier 式）
- formant: {"variant": "<候选id>"}                                v1 仅选最优变体
"""
import os
import json
import time

from . import settings

PATH = os.path.join(settings.WORK_DIR, "review_profiles.json")


def _load():
    try:
        if os.path.exists(PATH):
            with open(PATH, encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return {"global": {}, "speakers": {}}


def _save(data):
    os.makedirs(settings.WORK_DIR, exist_ok=True)
    with open(PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def get_profile(speaker=None):
    data = _load()
    if speaker:
        return data.get("speakers", {}).get(speaker) or data.get("global", {})
    return data.get("global", {})


def save_profile(payload):
    data = _load()
    speaker = payload.get("speaker") or None
    rec = {
        "pitch": payload.get("pitch", {}),
        "formant": payload.get("formant", {}),
        "params": payload.get("params", {}),
        "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    if speaker:
        data.setdefault("speakers", {})[speaker] = rec
    else:
        data["global"] = rec
    _save(data)
    return {"ok": True}
