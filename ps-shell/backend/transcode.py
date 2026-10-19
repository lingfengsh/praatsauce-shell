# -*- coding: utf-8 -*-
"""mp3 / flac / m4a → wav 转码（用本机 Praat 脚本，只在 shell 里调用，不改原文件）。

要点：
- 调用 Praat 走 praat.run_script（--FULL-TRUST 才能 Save as WAV），不另起 Popen；
- 输出统一进 <输入目录>/converted_wav/，该子目录在 health 扫描时被排除，避免二次扫描；
- 转码成功后不自动改用户的 inputDir —— 由前端弹确认；
- 单个文件失败不影响其他文件，失败清单照常返回。
"""

import os
import csv
import time

from . import settings, praat, audio


# 转码产物所在子目录名（与 health.CONVERTED_DIR 保持一致，便于排除扫描）
CONVERTED_DIR = "converted_wav"

# Praat 转码脚本模板：读源 →（立体声时取第 1 声道）→ 存 wav。
# 经本机 Praat 7.0.02 实测：Extract one channel 对单声道文件也安全（返回第 1 声道本身）。
_TRANSCODE_TMPL = (
    'Read from file: "{src}"\n'
    'Extract one channel: 1\n'
    'Save as WAV file: "{dst}"\n'
)


def _transcode_one(exe, src, dst, mono):
    """用 Praat 把单个源文件转成 wav。成功返回 None，失败返回错误字符串。"""
    body = 'Read from file: "%s"\n' % praat.q(src)
    if mono:
        body += 'Extract one channel: 1\n'
    body += 'Save as WAV file: "%s"\n' % praat.q(dst)

    # 临时脚本写到 WORK_DIR（与 praatSauce 同级临时区），用完即删
    sdir = settings.WORK_DIR
    os.makedirs(sdir, exist_ok=True)
    sp = os.path.join(sdir, "_transcode_%d.praat" % int(time.time() * 1000 * 1000))
    try:
        with open(sp, "w", encoding="utf-8") as f:
            f.write(body)
        rc, _lines = praat.run_script(exe, sp, cwd=os.path.dirname(src),
                                      full_trust=True, timeout=600)
    except Exception as e:  # 转码整体异常：记录但不中断整批
        return "转码异常：%s" % e
    finally:
        try:
            os.remove(sp)
        except Exception:
            pass

    if rc != 0 or not os.path.exists(dst):
        return "Praat 转码失败（退出码 %s）" % rc
    return None


def _write_manifest(path, out_dir, converted):
    """写 manifest.tsv：source / converted / duration / sampleRate / channels（UTF-8）。"""
    try:
        with open(path, "w", encoding="utf-8", newline="") as f:
            w = csv.writer(f, delimiter="\t", lineterminator="\n")
            w.writerow(["source", "converted", "duration", "sampleRate", "channels"])
            for c in converted:
                if c.get("error"):
                    w.writerow([c.get("source", ""), c.get("converted", ""), "", "", ""])
                    continue
                dst = os.path.join(out_dir, c["converted"])
                dur, sr, ch = audio._wav_info(dst)
                w.writerow([
                    c["source"],
                    c["converted"],
                    "" if dur is None else round(dur, 3),
                    "" if sr is None else sr,
                    "" if ch is None else ch,
                ])
    except Exception:
        # manifest 写失败不影响已转出的 wav，仅记下
        pass


def transcode(dir_path, files, mono=True):
    """批量转码。

    dir_path: 输入目录（源文件所在）；输出进 <dir_path>/converted_wav/。
    files: 相对文件名列表（如 ["a.mp3"]）。
    返回 {ok, outDir, manifest, converted:[{source, converted, error?}], failed:[...]}。
    """
    if not dir_path or not os.path.isdir(dir_path):
        return {"ok": False, "error": "目录不存在或不可访问"}
    if not files:
        return {"ok": False, "error": "没有要转码的文件"}
    cfg = settings.load()
    exe = cfg.get("praatExe") or ""
    if not exe or not os.path.exists(exe):
        return {"ok": False, "error": "没有找到 Praat，无法转码；请先到「设置」里指定 Praat.exe。"}
    out_dir = os.path.join(dir_path, CONVERTED_DIR)
    os.makedirs(out_dir, exist_ok=True)

    converted = []
    failed = []
    for name in files:
        src = os.path.join(dir_path, name)
        if not os.path.isfile(src):
            failed.append(name)
            continue
        base = os.path.splitext(name)[0]
        dst_name = base + ".wav"
        dst = os.path.join(out_dir, dst_name)
        err = _transcode_one(exe, src, dst, mono)
        if err:
            failed.append(name)
            converted.append({"source": name, "converted": dst_name, "error": err})
        else:
            converted.append({"source": name, "converted": dst_name})

    manifest = os.path.join(out_dir, "manifest.tsv")
    _write_manifest(manifest, out_dir, converted)

    return {
        "ok": True,
        "outDir": out_dir,
        "manifest": manifest,
        "converted": converted,
        "failed": failed,
    }
