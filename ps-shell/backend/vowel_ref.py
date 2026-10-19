# -*- coding: utf-8 -*-
"""元音音标 → 共振峰参考值（软先验）加载与匹配。

- 数据在同级 ``vowel_ref.json``（跨语言/多方言聚合均值，男女分开）。
- 匹配强调**比例**（F2/F1、F3/F2）而非绝对数：绝对数因声道大小飘，
  比例对声道长度更不敏感。绝对数只做尺度无关的辅助判据。
- 这是软先验，不是真值；只能辅助挑选 + 提前筛掉离谱结果。
"""
import os
import math
import re
import json

from . import settings

if settings.IS_FROZEN:
    # 冻结态：vowel_ref.json 由 PyInstaller 随包（--add-data），落在 exe 同目录
    _DATA_PATH = settings._resource("vowel_ref.json")
else:
    _HERE = os.path.dirname(os.path.abspath(__file__))
    _DATA_PATH = os.path.join(_HERE, "vowel_ref.json")

_CACHE = {}


def gender_of(speaker):
    """把 speaker 字段归一成 "male"/"female"/None。

    接受 "male"/"female"/"男"/"女"/"M"/"F" 等写法；其余（含空）返回 None
    （→ expected 回退到通用均值）。
    """
    if not speaker:
        return None
    s = str(speaker).strip().lower()
    if s in ("male", "m", "男", "men"):
        return "male"
    if s in ("female", "f", "女", "women"):
        return "female"
    if "男" in s:
        return "male"
    if "女" in s:
        return "female"
    return None

# 与 vowel_ref.json 的 vowels 键保持一致（按字符长降序，避免误吞）。
KNOWN_VOWELS = (
    "ɿ", "ʅ", "ɚ", "ɨ", "ʉ", "ɯ", "ɪ", "ʏ", "ʊ", "ø", "œ", "ɶ", "ɒ", "ɑ", "ɔ", "ɐ",
    "ɛ", "ə", "ɜ", "ɵ", "ɞ", "ʌ", "ɤ", "o", "e", "a", "i", "u", "y",
)
_SEG_RE = re.compile("[" + "".join(KNOWN_VOWELS) + "]+")


def load():
    """读 vowel_ref.json（模块级缓存，只读一次）。"""
    if "data" not in _CACHE:
        try:
            with open(_DATA_PATH, "r", encoding="utf-8") as f:
                _CACHE["data"] = json.load(f)
        except Exception:
            _CACHE["data"] = {"meta": {}, "vowels": {}}
    return _CACHE["data"]


def parse_segments(ipa):
    """从音节 IPA 字符串里抽出元音音段序列。

    例：``"ai" → ["a","i"]``，``"iɛ" → ["i","ɛ"]``，``"iau" → ["i","a","u"]``，
    ``"ɿ" → ["ɿ"]``。只保留已知元音字符；空串/无元音 → ``[]``。
    """
    if not ipa:
        return []
    out = []
    for m in _SEG_RE.findall(ipa):
        for ch in m:
            if ch in KNOWN_VOWELS:
                out.append(ch)
    # 去相邻重复（双写防抖，如 "aa"），保留首尾顺序
    dedup = []
    for ch in out:
        if not dedup or dedup[-1] != ch:
            dedup.append(ch)
    return dedup


def expected(ipa, gender=None):
    """返回某元音音标的期望共振峰 ``{"f1":[m,sd], "f2":[m,sd], "f3":[m,sd]|None}`` 或 None。

    ``gender`` 为 ``"male"``/``"female"`` 时优先取对应性别；没有则回退 ``general``。
    """
    data = load()
    rec = (data.get("vowels") or {}).get(ipa)
    if not rec:
        return None
    for key in ((gender,) if gender in ("male", "female") else ()) + ("general",):
        if rec.get(key):
            return rec[key]
    return None


def ref_for_segment(segments, gender, t_frac):
    """双元音按首尾两半取不同元音；单元音全程同一元音。

    ``t_frac`` 是该区间在「整个浊音段」里的归一化位置（0..1）；
    <0.5 取首段元音，否则取尾段元音。单音段直接返回该元音。
    """
    if not segments:
        return None
    if len(segments) == 1:
        return expected(segments[0], gender)
    return expected(segments[0] if t_frac < 0.5 else segments[-1], gender)


def steady_median(points):
    """取共振峰点列的稳态中值（滤掉 None），返回 ``[f1,f2,f3]``（None 表示无值）。"""
    f1, f2, f3 = [], [], []
    for p in points or []:
        for arr, key in ((f1, "F1"), (f2, "F2"), (f3, "F3")):
            val = p.get(key) if isinstance(p, dict) else None
            if val is not None:
                arr.append(val)
    med = []
    for arr in (f1, f2, f3):
        med.append(sorted(arr)[len(arr) // 2] if arr else None)
    return med


def deviation(median, ref):
    """中值共振峰 vs 参考值的「软距离」（越小越接近）。

    主判据 = 比例：``ln(F2/F1)`` 与 ``ln(F3/F2)`` 对参考比例的偏差（仅用存在的阶）。
    辅判据 = 尺度无关的绝对：各阶 ``ln(f)`` 对参考 ``ln(rf)`` 的偏差。
    两者都做尺度无关，所以男女声道大小差不会直接判"离谱"。
    返回 ``None`` 表示无法比较（缺数据）。
    """
    if not median or not ref:
        return None
    f1, f2, f3 = median
    r1 = ref.get("f1"); r2 = ref.get("f2"); r3 = ref.get("f3")
    if not (r1 and r2):
        return None
    r1m = r1[0]; r2m = r2[0]; r3m = r3[0] if r3 else None

    score = 0.0
    n = 0
    # 比例项（权重更高）
    if f1 and f2:
        try:
            score += abs(math.log(f2 / f1) - math.log(r2m / r1m))
            n += 1
        except ValueError:
            pass
    if f2 and f3 and r3m:
        try:
            score += abs(math.log(f3 / f2) - math.log(r3m / r2m))
            n += 1
        except ValueError:
            pass
    # 尺度无关的绝对项
    for fm, rm in ((f1, r1m), (f2, r2m), (f3, r3m)):
        if fm and rm:
            score += abs(math.log(fm) - math.log(rm))
            n += 1
    if n == 0:
        return None
    return score
