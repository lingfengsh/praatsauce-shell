# -*- coding: utf-8 -*-
"""启动自检：核对关键路径与依赖是否齐备，结果写日志并交给界面显示。

开发版与分发版的"程序根"不同，所有路径都由 settings 按程序实际所在位置推导。
这里把最容易静默失败、且报错最难懂的几件事一次说清楚：

1. Praat 到底是"找不到"还是"找到了但跑不动"（后者常见于 Mark-of-the-Web
   拦截 / 缺运行库 / 权限不足，表现就是 WinError 5）。
2. Praat 脚本是"目录不对"还是"文件不全"——praatSauce.praat 用 include 引入
   一整批子脚本，Praat 靠工作目录定位它们，缺一个就整批失败。
3. 脚本版本对不对——脚本 form 声明的参数个数必须与后端 --run 传参一致，
   否则会报 "Found N arguments but expected only M"。
"""

import os
import re
import time

from . import settings

_CACHE = [None]

# 后端调用 praatSauce.praat 时传入的参数个数（见 server.py 的 run_script 调用）
_EXPECTED_ARGS = 2


def _item(name, ok, detail):
    return {"name": name, "ok": bool(ok), "detail": detail}


def _ui_dir():
    """界面目录：冻结态随包/外部复制的 ui，开发态 ps-shell/ui。"""
    if settings.IS_FROZEN:
        return settings._resource("ui")
    return os.path.join(settings.APP_BASE, "ps-shell", "ui")


def _vowel_ref_path():
    """元音参考数据：冻结态在程序根下（随包或外部复制），开发态在 backend/ 下。

    注意不能无差别用 settings._resource()：它以 sys.executable 为锚点，
    开发态会解析到 Python 环境目录里去。
    """
    if settings.IS_FROZEN:
        return settings._resource("vowel_ref.json")
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "vowel_ref.json")


def _script_checks(script_dir):
    """返回 (主脚本检查结果, 子脚本检查结果)。"""
    main = os.path.join(script_dir, "praatSauce.praat")
    if not os.path.exists(main):
        return _item("脚本主文件", False, "找不到 praatSauce.praat：" + str(script_dir)), None

    try:
        with open(main, "r", encoding="utf-8", errors="ignore") as f:
            txt = f.read()
    except Exception as e:
        return _item("脚本主文件", False, "读取失败：%s" % e), None

    incs = re.findall(r"^\s*include\s+(\S+\.praat)", txt, re.M)
    missing = [i for i in incs if not os.path.exists(os.path.join(script_dir, i))]
    ok = not missing
    detail = ("%s（主脚本 + %d 个子脚本齐备）" % (script_dir, len(incs)) if ok
              else "缺少 %d 个子脚本：%s" % (len(missing), "、".join(missing[:6])))

    # 参数个数：form 里声明的 word/sentence 行数应与后端传参一致
    nargs = len(re.findall(r"^\s*(?:word|sentence)\s+\S+", txt, re.M))
    args_ok = (nargs == _EXPECTED_ARGS)
    args_detail = ("form 声明 %d 个参数，后端传 %d 个 —— 一致" % (nargs, _EXPECTED_ARGS)
                   if args_ok else
                   "❗ 版本不匹配：脚本声明 %d 个参数，后端传 %d 个（典型报错 "
                   "Found %d arguments but expected only %d）" % (
                       nargs, _EXPECTED_ARGS, _EXPECTED_ARGS, nargs))
    return _item("脚本主文件", True, main), [
        _item("子脚本完整性", ok, detail),
        _item("脚本版本匹配", args_ok, args_detail),
    ]


def run():
    """执行自检。返回 {"ok","items","appBase","frozen","logPath","scriptDir","praatExe"}。"""
    cfg = settings.load()
    exe = settings.resolve_praat_exe(cfg)
    sdir = settings.resolve_script_dir(cfg)
    items = []

    # 1 程序根
    items.append(_item("程序根目录", os.path.isdir(settings.APP_BASE), settings.APP_BASE))

    # 2 Praat：先找得到，再真的跑一次（区分"没找到"与"跑不动"）
    if not exe or not os.path.exists(exe):
        items.append(_item("Praat 程序", False, "未找到：%s" % (exe or "(未设置)")))
    else:
        from . import praat  # 延迟导入，避免与 server 形成循环
        ver = praat.probe_praat(exe)
        items.append(_item(
            "Praat 程序", bool(ver),
            "%s（版本 %s）" % (exe, ver) if ver
            else "找到了但无法执行：%s —— 常见于被系统/杀软拦截（WinError 5）"
                 "或缺少运行库，可右键文件「属性→解除锁定」" % exe))

    # 3 脚本：主文件 / 子脚本完整性 / 版本匹配
    main_item, sub_items = _script_checks(sdir)
    items.append(main_item)
    if sub_items:
        items.extend(sub_items)

    # 4 界面资源
    ui = _ui_dir()
    items.append(_item("界面资源", bool(ui) and os.path.exists(os.path.join(ui, "launch.html")),
                       ui or "(未定位)"))

    # 5 元音参考数据
    vr = _vowel_ref_path()
    items.append(_item("元音参考数据", os.path.exists(vr), vr))

    # 6 示例音频（缺了不影响测量，只提示）
    sd = os.path.join(settings.APP_BASE, "samples")
    items.append(_item("示例音频", os.path.isdir(sd), sd))

    # 7 日志目录可写
    ld = settings.log_dir()
    items.append(_item("日志目录", os.path.isdir(ld), ld))

    # 「示例音频」缺失不算失败，其余任一失败即整体不通过
    failed = [i for i in items if not i["ok"] and i["name"] != "示例音频"]
    result = {
        "ok": not failed,
        "items": items,
        "appBase": settings.APP_BASE,
        "frozen": settings.IS_FROZEN,
        "scriptDir": sdir,
        "praatExe": exe,
        "logDir": ld,
    }
    result["logPath"] = _write_log(result)
    _CACHE[0] = result
    return result


def cached():
    """取上次自检结果（没跑过就现跑一次），供界面首屏显示。"""
    return _CACHE[0] or run()


def _write_log(result):
    """把自检结果写入 logs/，作为本次启动的第一条记录。"""
    try:
        d = settings.log_dir()
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, "startup_%s.log" % time.strftime("%Y%m%d_%H%M%S"))
        lines = [
            "PraatSauce 启动自检",
            "时间: " + time.strftime("%Y-%m-%d %H:%M:%S"),
            "模式: " + ("分发版(exe)" if result["frozen"] else "开发版(源码)"),
            "程序根: " + result["appBase"],
            "=" * 62,
        ]
        for it in result["items"]:
            lines.append("[%s] %s — %s" % (" OK " if it["ok"] else "FAIL", it["name"], it["detail"]))
        lines.append("=" * 62)
        lines.append("结论: " + ("全部通过" if result["ok"] else "存在问题，见上面 FAIL 项"))
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        return path
    except Exception:
        return ""
