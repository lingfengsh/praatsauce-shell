# -*- coding: utf-8 -*-
"""一次性生成器：读 vowel_data/sources.json（带出处的参考库），
写 backend/vowel_ref.json（运行时用的精简记录）。

用法（在 ps-shell 下）：
    python vowel_data/build_vowel_ref.py

- 原始库 sources.json 含每条元音的 "source" 文献标签 —— 那是给人看的，
  运行时不需要，写回时会被剥掉。
- 运行时 vowel_ref.py 只读 backend/vowel_ref.json，绝不访问 vowel_data/。
- 改了元音参考值：直接编辑 sources.json，再跑本脚本即可重算记录。
"""
import os
import json
import datetime

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
_SRC = os.path.join(_HERE, "sources.json")
_OUT = os.path.join(_ROOT, "backend", "vowel_ref.json")

# 运行时 vowel_ref.py 只认这三个性别键；其余（source 等）一律剥掉。
_GENDER_KEYS = ("male", "female", "general")


def main():
    with open(_SRC, "r", encoding="utf-8") as f:
        src = json.load(f)

    meta = src.get("meta", {})
    meta = dict(meta)
    meta["generated_from"] = "vowel_data/sources.json"
    meta["generated_at"] = datetime.date.today().isoformat()
    meta["_note"] = (
        "运行时精简记录：由 vowel_data/build_vowel_ref.py 从带出处的参考库一次性生成。"
        "不要手工改这里——改 sources.json 再重跑生成器。"
    )

    vowels = {}
    for v, body in (src.get("vowels") or {}).items():
        clean = {g: body[g] for g in _GENDER_KEYS if g in body}
        vowels[v] = clean

    out = {"meta": meta, "vowels": vowels}
    with open(_OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print("wrote", _OUT, "vowels:", len(vowels))


if __name__ == "__main__":
    main()
