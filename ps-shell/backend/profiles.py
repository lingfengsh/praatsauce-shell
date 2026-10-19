# -*- coding: utf-8 -*-
"""发音人档案库（与 settings.json 分离，独立存于 APP_DIR/profiles.json）。

设计要点：
- 路径做成模块级变量 PROFILES_PATH，测试时可指向 tempdir（卡 §5 要求不读写真实 %APPDATA%）。
- 文件损坏 / 不存在一律回退为空列表，绝不抛异常。
- 仅做 CRUD + 与静态 SPEAKER_PRESETS 的合并，不做任何 Praat 调用。
"""

import os
import json
import uuid
import time

from . import settings, params_schema

# 模块级变量：测试可临时改指向 tempdir
PROFILES_PATH = os.path.join(settings.APP_DIR, "profiles.json")

F0_MIN_LIMIT = 20
F0_MAX_LIMIT = 1000
FORMANT_MIN_LIMIT = 2000
FORMANT_MAX_LIMIT = 11000


def _clamp(value, lo, hi, warnings, field):
    """把数值钳制到 [lo, hi]；越界则记入 warnings 并返回边界值；非数字返回 None。"""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if v < lo:
        warnings.append({"field": field, "msg": "%s 低于下限 %d，已钳制为 %d" % (field, lo, lo)})
        return lo
    if v > hi:
        warnings.append({"field": field, "msg": "%s 高于上限 %d，已钳制为 %d" % (field, hi, hi)})
        return hi
    return v


def _load():
    """读 profiles.json；任何异常或损坏都当作空列表。"""
    try:
        with open(PROFILES_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return data
    except Exception:
        pass
    return []


def _save(profiles):
    try:
        os.makedirs(os.path.dirname(PROFILES_PATH), exist_ok=True)
        with open(PROFILES_PATH, "w", encoding="utf-8") as f:
            json.dump(profiles, f, ensure_ascii=False, indent=2)
        return True
    except Exception:
        return False


def list_profiles():
    return {"ok": True, "profiles": _load()}


def save_profile(body):
    """新增（无 id）或更新（有 id）一条发音人档案。

    校验：name 空 / f0min >= f0max 拒绝；f0min/f0max 限 20–1000、
    maxFormantHz 限 2000–11000，越界钳制并在 warnings 说明。
    """
    body = body or {}
    name = (body.get("name") or "").strip()
    if not name:
        return {"ok": False, "error": "请填写发音人名称"}

    warnings = []
    try:
        f0min = float(body.get("f0min"))
        f0max = float(body.get("f0max"))
    except (TypeError, ValueError):
        return {"ok": False, "error": "f0min / f0max 必须是数字"}

    if f0min >= f0max:
        return {"ok": False, "error": "基频下限必须小于上限（f0min < f0max）"}

    f0min = _clamp(f0min, F0_MIN_LIMIT, F0_MAX_LIMIT, warnings, "f0min")
    f0max = _clamp(f0max, F0_MIN_LIMIT, F0_MAX_LIMIT, warnings, "f0max")
    if f0min >= f0max:
        return {"ok": False, "error": "钳制后基频下限仍不小于上限，请检查输入"}

    fmax = body.get("maxFormantHz")
    if fmax not in (None, ""):
        fmax = _clamp(fmax, FORMANT_MIN_LIMIT, FORMANT_MAX_LIMIT, warnings, "maxFormantHz")
    else:
        fmax = None

    pid = (body.get("id") or "").strip()
    note = (body.get("note") or "").strip()
    profiles = _load()

    if pid:
        found = False
        for p in profiles:
            if p.get("id") == pid:
                p["name"] = name
                p["f0min"] = f0min
                p["f0max"] = f0max
                if fmax is not None:
                    p["maxFormantHz"] = fmax
                if note:
                    p["note"] = note
                found = True
                break
        if not found:
            return {"ok": False, "error": "找不到要更新的档案（id 不存在）"}
    else:
        pid = uuid.uuid4().hex[:8]
        rec = {"id": pid, "name": name, "f0min": f0min, "f0max": f0max,
               "createdAt": int(time.time())}
        if fmax is not None:
            rec["maxFormantHz"] = fmax
        if note:
            rec["note"] = note
        profiles.append(rec)

    if not _save(profiles):
        return {"ok": False, "error": "档案保存失败（写入文件出错）"}
    return {"ok": True, "id": pid, "warnings": warnings}


def delete_profile(body):
    pid = (body.get("id") or "").strip()
    if not pid:
        return {"ok": False, "error": "缺少 id"}
    profiles = _load()
    kept = [p for p in profiles if p.get("id") != pid]
    if len(kept) == len(profiles):
        return {"ok": False, "error": "找不到要删除的档案"}
    _save(kept)
    return {"ok": True}


def rename_profile(body):
    """可选实现（卡 §W1 标注为可选；此处实现以满足完整管理需求）。"""
    pid = (body.get("id") or "").strip()
    name = (body.get("name") or "").strip()
    if not pid:
        return {"ok": False, "error": "缺少 id"}
    if not name:
        return {"ok": False, "error": "请提供新名称"}
    profiles = _load()
    for p in profiles:
        if p.get("id") == pid:
            p["name"] = name
            _save(profiles)
            return {"ok": True}
    return {"ok": False, "error": "找不到要改名的档案"}


def merge_speakers():
    """bootstrap 用：静态预设（kind:preset）+ 档案（kind:profile）合并返回。

    不修改 SPEAKER_PRESETS 本身；每条都带 kind 标记，前端 renderSpeakers 无需区分即可渲染。
    """
    out = []
    for s in params_schema.SPEAKER_PRESETS:
        item = dict(s)
        item["kind"] = "preset"
        out.append(item)
    for p in _load():
        item = dict(p)
        item["kind"] = "profile"
        out.append(item)
    return out
