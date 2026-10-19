# -*- coding: utf-8 -*-
"""全量审查：记录「这个文件最终采用哪组参数测量的」（音频旁 measure/ 子目录里的 sidecar）。

存放位置：音频所在目录 ``measure/`` 子目录、同主名的 ``<主名>.measure.json``（2026-09-27
用户拍板方案 A：所有中间结果归子目录）。例如 ``D:\\data\\1\\11.wav`` →
``D:\\data\\1\\measure\\11.measure.json``。

内容形如::

    {
      "pitch":   {"id": "500",  "label": "F0上限500Hz"},
      "formant": {"id": "5500", "label": "共振峰上限5500Hz"},
      "manual":  [{"t": 0.12, "f0": 210.5}],
      "speaker": "female",
      "savedAt": "2026-09-22T09:10:00"
    }

用 sidecar 而不是把信息写进 wav：wav 保持原样不动（别的工具读它不受影响），
记录可以单独删除、单独备份，也不会因为 wav 被外部程序重写而丢失。
"""
import os
import json
import datetime

SUFFIX = ".measure.json"


def choice_path(wav_path):
    """wav 路径 → 记录文件路径（只做字符串推导，不检查存在性）。

    落在 measure/ 子目录里（与 .Pitch/.Formant 同一处）。
    """
    if not wav_path:
        return ""
    from .review_export import object_path
    return object_path(wav_path, SUFFIX)


def read_choice(wav_path):
    """读该文件的参数记录；没有记录返回 choice=None（不算错误）。"""
    p = choice_path(wav_path)
    if not p or not os.path.isfile(p):
        return {"ok": True, "choice": None, "path": p}
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        return {"ok": False, "error": "参数记录读取失败：%s" % e, "path": p}
    if not isinstance(data, dict):
        return {"ok": False, "error": "参数记录格式不对（应为 JSON 对象）", "path": p}
    return {"ok": True, "choice": data, "path": p}


def save_choice(wav_path, choice):
    """写该文件的参数记录（**合并语义**：请求里没带的键沿用已有记录，不抹掉）。

    前端按标签页分维度存盘（F0 页只带 pitch/manual/ppfix，共振峰页只带 formant），
    所以必须与已有记录合并——否则存 F0 会把已存的共振峰选择抹掉。
    要清空某个维度只能删掉 measure.json 文件本身。
    """
    if not wav_path or not os.path.isfile(wav_path):
        return {"ok": False, "error": "音频文件不存在：%s" % wav_path}
    if not isinstance(choice, dict):
        return {"ok": False, "error": "参数记录内容格式不对"}

    prev = None
    p = choice_path(wav_path)
    if os.path.isfile(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                d = json.load(f)
            if isinstance(d, dict):
                prev = d
        except Exception:
            prev = None  # 旧记录坏了就当没有，按纯覆盖处理

    def pick_variant(kind):
        v = choice.get(kind)
        if not isinstance(v, dict):
            return None  # 未带/未选 → 沿用旧记录
        out = {"id": str(v.get("id", "")), "label": str(v.get("label", ""))}
        # 「自定义基频参数」（详情页滑块预览存盘，2026-09-25）：method/params 必须
        # 原样保留，否则导出时 review_export 拿不到参数、只能退回默认 To Pitch。
        if v.get("method") in ("raw", "filtered") and isinstance(v.get("params"), dict):
            out["method"] = v["method"]
            out["params"] = v["params"]
        return out

    def prev_variant(kind):
        v = (prev or {}).get(kind)
        return v if isinstance(v, dict) else None

    # pitch/formant：新值优先，没带就沿用旧值
    pitch = pick_variant("pitch") or prev_variant("pitch")
    formant = pick_variant("formant") or prev_variant("formant")
    # manual：请求里带了就用新的（F0 页存盘总带全量手工点），
    # 没带（共振峰页存盘）就沿用旧值——共振峰页不该动 F0 手工点。
    if "manual" in choice and isinstance(choice.get("manual"), list):
        manual = [pt for pt in choice["manual"]
                  if isinstance(pt, dict) and pt.get("t") is not None and pt.get("f0") is not None]
    else:
        manual = prev.get("manual") if isinstance(prev, dict) else None
        manual = manual if isinstance(manual, list) else []
    # deleted：被删掉的原始测量帧（帧时间列表，见 review_export.apply_manual_pitch）。
    # 合并语义同 manual——请求带了就用新的，没带就沿用旧值。
    if "deleted" in choice and isinstance(choice.get("deleted"), list):
        deleted = []
        for x in choice["deleted"]:
            try:
                deleted.append(float(x))
            except (TypeError, ValueError):
                continue
    else:
        prevd = prev.get("deleted") if isinstance(prev, dict) else None
        deleted = []
        if isinstance(prevd, list):
            for x in prevd:
                try:
                    deleted.append(float(x))
                except (TypeError, ValueError):
                    continue
    speaker = (str(choice["speaker"]) if isinstance(choice.get("speaker"), str)
               else str((prev or {}).get("speaker") or ""))
    # vowel_ipa：元音音标（音段列表，如 ["a"] / ["a","i"]）。请求里带了就用新的，
    # 没带（如共振峰页存盘）就沿用旧值——它属于整文件的元信息，不该被另一页存盘抹掉。
    if "vowel_ipa" in choice:
        vip = choice["vowel_ipa"]
        if isinstance(vip, list):
            vip = [str(x) for x in vip if x]
        elif isinstance(vip, str):
            vip = [x for x in vip.strip().split() if x]
        else:
            vip = None
        if vip is not None:
            data_vowel = vip
        else:
            data_vowel = (prev or {}).get("vowel_ipa")
    else:
        data_vowel = (prev or {}).get("vowel_ipa")
    data = {
        "pitch": pitch,
        "formant": formant,
        "manual": manual,
        "deleted": deleted,
        "speaker": speaker,
        "vowel_ipa": data_vowel,
        "savedAt": datetime.datetime.now().isoformat(timespec="seconds"),
    }
    # ppfix = 「在 Praat 中修周期」的标记（见 review_grid.read_pp_result）：
    # 原样透传，export_one/export_dir 见到它就跳过重算，防止覆盖人工修正的曲线。
    ppfix = choice.get("ppfix")
    if isinstance(ppfix, dict):
        data["ppfix"] = ppfix
    elif isinstance((prev or {}).get("ppfix"), dict):
        data["ppfix"] = prev["ppfix"]  # 请求没带（如共振峰页存盘）→ 沿用
    # formantSmoothed = 共振峰是否已用 Viterbi 轨迹跟踪（Track）平滑并存盘。
    # 请求里带了就用新值（共振峰页存盘总带这个值），没带（F0 页存盘）就沿用旧值——
    # 它属于共振峰维，不该被另一页存盘抹掉（与 formant 变体同一处理原则）。
    if "formantSmoothed" in choice and isinstance(choice.get("formantSmoothed"), bool):
        data["formantSmoothed"] = choice["formantSmoothed"]
    else:
        data["formantSmoothed"] = bool((prev or {}).get("formantSmoothed"))
    # formantImported = 共振峰这一维的最终结果是「读入的那条」（FormantPath 精修 /
    # 外部导入），不是按参数抽出来的。带了这个标记，export_one/export_dir 会跳过
    # 重新抽取、直接把读入的那份写成 .Formant（见 review_export.write_imported_formant）。
    # 与原样透传的 ppfix 不同：这里允许**显式清除**（发 = null）——用户改回按参数候选
    # 存盘时，旧的「已读入」标记必须失效，否则共振峰维永远不会被重抽。
    if "formantImported" in choice:
        fi = choice.get("formantImported")
        if isinstance(fi, dict):
            data["formantImported"] = fi
    elif isinstance((prev or {}).get("formantImported"), dict):
        data["formantImported"] = prev["formantImported"]
    try:
        from .review_export import ensure_measure_dir
        ensure_measure_dir(wav_path)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
    except Exception as e:
        return {"ok": False, "error": "参数记录写入失败：%s" % e}
    return {"ok": True, "path": p, "choice": data}
