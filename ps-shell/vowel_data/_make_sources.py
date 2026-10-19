# -*- coding: utf-8 -*-
"""一次性：从现有 backend/vowel_ref.json 的"录制结果"还原出带文献出处的
「原始参考库」vowel_data/sources.json。

为什么需要它：vowel_ref.json 是给运行时用的精简记录（只有数值），没有出处。
sources.json 才是"下载/汇集来的元音数据库"本体——带每条元音的主要文献依据，
单独放在 vowel_data/，不进程序运行时。

本脚本只跑一次（用来生成 sources.json）；之后 sources.json 是权威源，
由 build_vowel_ref.py 反过来生成运行时用的 vowel_ref.json。
"""
import os
import json

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
_SRC = os.path.join(_ROOT, "backend", "vowel_ref.json")
_OUT = os.path.join(_HERE, "sources.json")

# 每条元音的主要文献依据（近似归属，详见 sources.json 顶层 sources 列表）。
# 这些标签只是"主要参考来源"提示，不是精确的单篇出处声明。
_SOURCE_TAGS = {
    "i":  "Hillenbrand 1995 (AE) · cardinal 1",
    "y":  "cardinal 9 · Chung 2012",
    "ɨ":  "cardinal 10 (close central unrounded)",
    "ʉ":  "cardinal 11 (close central rounded)",
    "ɯ":  "cardinal 8 (close back unrounded)",
    "u":  "Hillenbrand 1995 (AE) · cardinal 8",
    "ɪ":  "Hillenbrand 1995 (AE) · cardinal 14",
    "ʏ":  "cardinal 16 (near-close near-front rounded)",
    "ʊ":  "Hillenbrand 1995 (AE) · cardinal 24",
    "e":  "cardinal 2 · 普通话实测",
    "ø":  "cardinal 10 · Chung 2012",
    "ɤ":  "普通话/粤语 · cardinal 13",
    "o":  "cardinal 7 · Chung 2012",
    "ə":  "schwa · 普通话实测",
    "ɛ":  "Hillenbrand 1995 (AE) · cardinal 3",
    "œ":  "cardinal 11 · Chung 2012",
    "ɜ":  "open-mid central · cardinal 13",
    "ʌ":  "Hillenbrand 1995 (AE) · cardinal 6",
    "ɔ":  "cardinal 5 · Chung 2012",
    "æ":  "Hillenbrand 1995 (AE) · cardinal 4",
    "a":  "Hillenbrand 1995 (AE) · cardinal 4/5",
    "ɐ":  "near-open central · 普通话",
    "ɑ":  "cardinal 5 (open back unrounded)",
    "ɒ":  "cardinal 6 (open back rounded)",
    "ɶ":  "open front rounded · cardinal 12",
    "ɿ":  "普通话舌尖元音 i (apical)",
    "ʅ":  "普通话舌尖元音 u (apical)",
    "ɚ":  "普通话 er (retroflex / r-colored)",
}


def main():
    with open(_SRC, "r", encoding="utf-8") as f:
        rec = json.load(f)

    meta = rec.get("meta", {})
    meta["_note"] = (
        "本文件是「元音共振峰参考库」的权威源（带文献出处），单独存放在 vowel_data/，"
        "不进入程序运行时。build_vowel_ref.py 用它一次性生成 backend/vowel_ref.json"
        "（运行时只读那个精简记录，不再访问本文件）。"
    )
    meta["sources"] = [
        "Hillenbrand, Getty, Clark & Wheeler (1995). Acoustic characteristics of American English vowels. JASA.",
        "Chung, Kong, Edwards, Weismer & Fourakis (2012). Cross-language vowel space (Cantonese/English/Greek/Japanese/Korean).",
        "普通话 / 粤语 / 越南语 / 韩语 实测报道（聚合均值）",
        "eudic《Formants and phonetics》cardinal 锚点；IPA cardinal vowel 体系 (1-22)",
    ]

    vowels = {}
    for v, body in (rec.get("vowels") or {}).items():
        entry = dict(body)  # 保留 male/female/general 数值
        entry["source"] = _SOURCE_TAGS.get(v, "cardinal / 多方言聚合")
        vowels[v] = entry

    out = {"meta": meta, "vowels": vowels}
    with open(_OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print("wrote", _OUT, "vowels:", len(vowels))


if __name__ == "__main__":
    main()
