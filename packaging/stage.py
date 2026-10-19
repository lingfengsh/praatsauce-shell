# -*- coding: utf-8 -*-
"""组装分发包 PraatSauceShell：把 exe 之外的全部资源复制进 PyInstaller 的 dist 目录。

「一个 exe + 按需复制资源」：exe 只装 Python 运行时与后端代码，
scripts/、samples/、ui/、vowel_ref.json、praat.exe、帮助文档一律外部复制。
于是改界面、改脚本、换素材都不必重新编译，只有后端 Python 变了才需要重打包。

流程：
  1. 先跑（workpath/distpath 必须与下面的 OUT 一致）：
       pyinstaller packaging/PraatSauce.spec --clean --noconfirm \
           --workpath _build/build --distpath _build/dist
     —— 产出 _build/dist/PraatSauceShell（exe + _internal）
  2. 再跑本脚本 —— 往同一个目录里补 scripts/、samples/、ui/、vowel_ref.json、
     praat.exe、入手简介.txt（不删除 exe/_internal，只刷新资源子目录）

samples 必须压平（不保留子目录）：批量测量与扫描都是非递归的，若 .wav 在子目录里，
向导示例按钮会扫到 0 个文件。原始 samples 按 1/、2/ 分了两个子目录且存在同名文件，
这里用「子目录名_原名」前缀去重（如 1_11.wav、2_11.wav），保证音频一个不丢。
"""
import os
import shutil
import time

# 路径一律由本脚本位置推导（本脚本位于 <仓库根>/packaging/），不写死任何机器绝对路径。
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 必须与 PyInstaller 的 --distpath 一致。两边一旦错开，就会把陈旧 exe 当成新构建
# 同步进分发 —— 这是过去"改了却没生效"的根因，故此处强绑定同一目录。
OUT = os.path.join(ROOT, "_build", "dist", "PraatSauceShell")

# 运行时 Praat 脚本的唯一副本（根级统一后不再散落 praatsauce-master/src 与 ps-shell/praat）
SCRIPT_SOURCES = [
    os.path.join(ROOT, "scripts"),
]

UI_SRC = os.path.join(ROOT, "ps-shell", "ui")           # 界面：外部资源，不进 exe
VOWEL_REF_SRC = os.path.join(ROOT, "ps-shell", "backend", "vowel_ref.json")

SAMPLES_SRC = os.path.join(ROOT, "samples")
README_SRC = os.path.join(ROOT, "packaging", "入手简介.txt")
PRAAT_SRC = os.path.join(ROOT, "praat.exe")  # 仓库根自带 Praat 引擎，打包进分发根目录


def _reset_dir(dst):
    """清空并重建 dst（不存在则直接建）。

    不在打包链路上硬依赖 shutil.rmtree：在受管/沙箱环境里 rmtree 会被替换成
    走回收站的实现，遇到深层目录会抛 OSError（SHFileOperationW 0x2），
    表现是「脚本跑到一半中断、目录被删了个半空」。删不掉就改名移出到
    _build/_trash（同盘、不进分发包）后重建，保证打包永远能继续。
    """
    if os.path.isdir(dst):
        try:
            shutil.rmtree(dst)
        except OSError as exc:
            # 受管环境的 rmtree 往往是「内容已删净、收尾 rmdir 时目录已不存在」
            # 才报 0x2。所以必须先复查：真没了就算删成功；还在才改名移出。
            if os.path.isdir(dst):
                trash = os.path.join(ROOT, "_build", "_trash")
                os.makedirs(trash, exist_ok=True)
                target = os.path.join(
                    trash, "%s_%d" % (os.path.basename(dst), int(time.time())))
                try:
                    os.rename(dst, target)
                    print("⚠ rmtree 失败（%s），已改名移出：%s" % (exc, target))
                except OSError as exc2:
                    print("⚠ 无法清空 %s（%s），改为覆盖复制" % (dst, exc2))
    os.makedirs(dst, exist_ok=True)


def stage_praat():
    """把仓库根的 praat.exe 复制到分发根目录，与主程序 PraatSauceShell.exe 同级。

    冻结态 settings.py 默认 praatExe = <exe 目录>/praat.exe，因此必须随包提供，
    否则首次启动默认路径指向一个不存在的文件。也契合「praat 程序也在根目录」的结构。
    """
    if os.path.exists(PRAAT_SRC):
        dst = os.path.join(OUT, "praat.exe")
        shutil.copy2(PRAAT_SRC, dst)
        print("praat.exe 已复制到根目录（%d 字节）" % os.path.getsize(dst))
    else:
        print("⚠ 找不到仓库根 praat.exe，请确认：", PRAAT_SRC)


def stage_scripts():
    dst = os.path.join(OUT, "scripts")
    _reset_dir(dst)
    collisions = {}
    for src in SCRIPT_SOURCES:
        if os.path.isfile(src):
            files = [os.path.basename(src)]
            base_dir = os.path.dirname(src)
        else:
            files = [f for f in os.listdir(src) if f.lower().endswith(".praat")]
            base_dir = src
        for f in files:
            sp = os.path.join(base_dir, f)
            dp = os.path.join(dst, f)
            if os.path.exists(dp):
                collisions.setdefault(f, []).append(sp)
            shutil.copy2(sp, dp)
    print("scripts/ 复制完成，共 %d 个 .praat 文件" % len(os.listdir(dst)))
    if collisions:
        print("⚠ 文件名冲突（已用后者覆盖）：")
        for f, lst in collisions.items():
            print("   ", f, "<=", lst)
    else:
        print("（无文件名冲突）")


# 这些目录是 Praat 的工作/中间产物（重采样、对象缓存、结果备份、历史结果），
# 不是原始示例音频，必须整目录排除，否则会把派生 .wav 当示例带进来。
WORKING_DIR_BLACKLIST = {'Resample', 'measure', 'output', '历史结果'}


def stage_samples():
    """示例音频：保留 samples/1、samples/2 两层结构（用户 2026-10-18 定）。

    - 1 = 女声，2 = 男声；默认「示例文件走一遍」只分析 samples/1。
    - 批量扫描是非递归的，所以默认示例目录必须指到子目录，不能指 samples 根。
    - 只复制 wav 与同名 TextGrid（有标注才能演示「只测标注段」）；
      measure/、output/、Resample/、历史结果 等派生物一律不带，示例应从零算一遍。
    """
    dst_root = os.path.join(OUT, "samples")
    _reset_dir(dst_root)
    count = 0
    for dirpath, dirnames, filenames in os.walk(SAMPLES_SRC):
        # 不进入工作/中间目录（Resample / measure / output / 历史结果 / _bak*）
        dirnames[:] = [d for d in dirnames
                       if d not in WORKING_DIR_BLACKLIST and not d.startswith("_bak")]
        for fn in filenames:
            low = fn.lower()
            if not (low.endswith(".wav") or low.endswith(".textgrid")):
                continue  # 排除 .Pitch/.Formant/json/tsv/xlsx 等派生文件
            sp = os.path.join(dirpath, fn)
            rel = os.path.relpath(sp, SAMPLES_SRC)
            dp = os.path.join(dst_root, rel)
            os.makedirs(os.path.dirname(dp), exist_ok=True)
            shutil.copy2(sp, dp)
            count += 1
    print("samples/ 复制完成，共 %d 个文件（1=女声 2=男声，保留子目录，不含 measure）" % count)


def stage_ui():
    """界面资源：外部复制，不进 exe —— 改界面无须重新编译。"""
    if not os.path.isdir(UI_SRC):
        print("⚠ 找不到界面源目录：", UI_SRC)
        return
    dst = os.path.join(OUT, "ui")
    _reset_dir(dst)
    shutil.copytree(UI_SRC, dst, dirs_exist_ok=True)
    # 防「exe 读到旧界面」：exe 的资源定位 _resource() 优先找 <exe>/_internal/ui，
    # 而那里可能是历史打包/同步残留的旧界面（2026-09-28 事故：_internal/ui 残留
    # 9-27 旧版，导致新修复全部"没生效"、默认值显示被清零）。发现即清除，
    # 强制 exe 回退读取本函数复制的顶层 ui/（与源码一致的唯一真相）。
    for stale in (os.path.join(OUT, "_internal", "ui"),
                  os.path.join(OUT, "_internal", "vowel_ref.json")):
        try:
            if os.path.isdir(stale):
                shutil.rmtree(stale)
                print("⚠ 已清除残留：%s" % stale)
            elif os.path.exists(stale):
                os.remove(stale)
                print("⚠ 已清除残留：%s" % stale)
        except OSError as exc:
            # 清不掉必须显式喊出来：残留旧界面会让新修复看起来"没生效"
            print("⚠ 未能清除残留（请手动删除）：%s —— %s" % (stale, exc))
    print("ui/ 复制完成，共 %d 个文件" % len(os.listdir(dst)))


def stage_vowel_ref():
    """元音参考数据：外部复制，不进 exe。"""
    if os.path.exists(VOWEL_REF_SRC):
        shutil.copy2(VOWEL_REF_SRC, os.path.join(OUT, "vowel_ref.json"))
        print("vowel_ref.json 已复制")
    else:
        print("⚠ 找不到：", VOWEL_REF_SRC)


def _check_freshness():
    """拦截「把陈旧 exe 当新构建」：exe 比源码旧就报警。

    过去 PyInstaller 默认输出到 ./dist、而本脚本组装到别处，同步出去的是
    旧 exe + 新资源（表现为"改了却没生效"）。这里用时间戳兜底拦住同类错误。
    """
    exe = os.path.join(OUT, "PraatSauceShell.exe")
    if not os.path.exists(exe):
        print("⚠ 缺少主程序：", exe)
        return
    newest_src = 0
    # 只比「进 exe 的东西」：后端 Python。ui/ 与 scripts/ 是外部资源，
    # 改界面/改脚本本就不该要求重编译（否则每次调界面都报"陈旧构建"，误警噪音）。
    for base in (os.path.join(ROOT, "ps-shell", "backend"),
                 os.path.join(ROOT, "ps-shell", "app.py")):
        targets = [base] if os.path.isfile(base) else [
            os.path.join(dp, f) for dp, _dn, fn in os.walk(base) for f in fn]
        for p in targets:
            if p.endswith((".py", ".js", ".html", ".css")):
                try:
                    newest_src = max(newest_src, os.path.getmtime(p))
                except OSError:
                    pass
    if newest_src and os.path.getmtime(exe) < newest_src:
        print("⚠ 陈旧构建：exe(%s) 早于后端源码(%s)，请先重新运行 pyinstaller"
              % (time.strftime("%H:%M:%S", time.localtime(os.path.getmtime(exe))),
                 time.strftime("%H:%M:%S", time.localtime(newest_src))))
    else:
        print("新鲜度检查：exe 不早于后端源码 ✓（界面/脚本为外部资源，不需重编译）")


def stage_readme():
    if os.path.exists(README_SRC):
        shutil.copy2(README_SRC, os.path.join(OUT, "入手简介.txt"))
        print("入手简介.txt 已复制")
    else:
        print("⚠ 找不到使用说明源文件：", README_SRC)


def stage_licenses():
    """把许可证与第三方声明复制进分发根目录。

    这是 GPL 合规的硬要求：分发包里带了 praat.exe（GPL-3.0-or-later），
    就必须同时提供 GPL 全文、Praat 的版权/版本说明与源码获取地址。
    少一份都算不合规，别因为"用户不会看"就省掉。
    """
    pairs = [
        (os.path.join(ROOT, "LICENSE"), "LICENSE"),
        (os.path.join(ROOT, "THIRD-PARTY-NOTICES.md"), "THIRD-PARTY-NOTICES.md"),
        (os.path.join(ROOT, "LICENSES", "GPL-3.0.txt"), os.path.join("LICENSES", "GPL-3.0.txt")),
        (os.path.join(ROOT, "LICENSES", "PraatSauce-MIT.txt"), os.path.join("LICENSES", "PraatSauce-MIT.txt")),
    ]
    ok = 0
    for src, rel in pairs:
        dst = os.path.join(OUT, rel)
        if not os.path.exists(src):
            print("⚠ 缺少许可证文件：", src)
            continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        ok += 1
    print("许可证文件已复制 %d/%d（Praat 为 GPL-3.0-or-later，必须随包附全文）" % (ok, len(pairs)))


def stage_version():
    """构建版本标识：让「新包 vs 旧包」一眼可辨（2026-09-28 事故：四轮打包同名 zip，
    旧包流到别的机器，新修复全被当成"没改"）。含构建时间与关键文件指纹。"""
    import hashlib
    lines = ["PraatSauceShell 构建版本", "构建时间: " + time.strftime("%Y-%m-%d %H:%M:%S")]
    for f in ("ps-shell/backend/settings.py", "ps-shell/backend/results.py",
              "ps-shell/ui/app.js", "ps-shell/ui/review-grid-ui.js"):
        p = os.path.join(ROOT, f)
        if os.path.exists(p):
            h = hashlib.md5(open(p, "rb").read()).hexdigest()[:8]
            lines.append("%s  %s" % (h, os.path.basename(f)))
    with open(os.path.join(OUT, "构建版本.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print("构建版本.txt 已生成")


if __name__ == "__main__":
    if not os.path.isdir(os.path.join(OUT, "_internal")):
        print("⚠ 未检测到 %s\\_internal，请先运行 pyinstaller 生成 exe。" % OUT)
    os.makedirs(OUT, exist_ok=True)
    _check_freshness()
    stage_praat()
    stage_scripts()
    stage_samples()
    stage_ui()
    stage_vowel_ref()
    stage_readme()
    stage_licenses()
    stage_version()
    print("\n分发包目录：", OUT)
