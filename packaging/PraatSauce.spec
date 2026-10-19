# -*- mode: python ; coding: utf-8 -*-
"""PraatSauce 助手 —— PyInstaller（onedir）打包配置。

所有路径相对本 spec 所在目录推导（本文件在 <仓库根>/packaging/，
仓库根 = packaging 的上一级），不写死任何本机绝对路径，换机器/换盘符直接可用。

⚠ 用法务必显式指定 workpath/distpath：
    pyinstaller packaging/PraatSauce.spec --clean --noconfirm \
        --workpath _build/build --distpath _build/dist
  否则 PyInstaller 默认输出到「当前工作目录」下的 ./build 与 ./dist，
  会与 stage.py 的组装目录错开 —— 这正是过去把陈旧 exe 当成新构建
  同步进分发的根因（表现为"改了却没生效"）。

关于壳（窗口模式）依赖：
pywebview/pythonnet/clr_loader 等第三方库解包在 _build/_vendor，
由下方 pathex 引入。换一台机器重打包时若 _vendor 不存在，
先跑 `python packaging/fetch_wheels.py` 重新拉取。
"""

import os
import sys

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs

# SPECPATH 由 PyInstaller 执行 spec 时注入（= 本 spec 所在目录，即 packaging/）
ROOT = os.path.dirname(SPECPATH)

# 壳模式依赖（pywebview → pythonnet → clr_loader → cffi），缓冲在 _build/_vendor
VENDOR = os.path.join(ROOT, "_build", "_vendor")
if os.path.isdir(VENDOR):
    sys.path.insert(0, VENDOR)

# pywebview 的后端是运行时按平台挑的，静态分析看不出来，必须显式列出；
# pythonnet 的 .NET 程序集（Python.Runtime.dll、WebView2 wrapper）是数据文件，
# 走 collect_* 才会随包带上——缺了它们的表现是"exe 双击没反应"。
hiddenimports = [
    "webview",
    "webview.platforms.edgechromium",
    "webview.platforms.winforms",
    "clr",
    "pythonnet",
    "pythonnet.runtime",
    "clr_loader",
    "clr_loader.netfx",
    "clr_loader.ffi",
    "cffi",
    "_cffi_backend",
    "pycparser",
    "proxy_tools",
    "bottle",
    "importlib_resources",
    "typing_extensions",
]

datas = (
    collect_data_files("webview")
    + collect_data_files("pythonnet")
    + collect_data_files("clr_loader")
)
binaries = collect_dynamic_libs("pythonnet")

a = Analysis(
    [os.path.join(ROOT, "ps-shell", "app.py")],
    pathex=[os.path.join(ROOT, "ps-shell"), VENDOR],
    binaries=binaries,
    # 程序自身的资源一律不进包：ui/ 与 vowel_ref.json 由 stage.py 在打包后复制到
    # exe 同目录，与 scripts/、samples/、praat.exe 一样按需复制。这样改界面、改脚本、
    # 换示例都不必重新编译 exe —— 只有后端 Python 变了才需要重打包（"一个 exe + 资源"）。
    # 运行期由 settings._resource() 依次在 _MEIPASS、_internal、exe 同目录查找。
    # 注：上方 collect_* 收的是第三方库自己的数据（.NET 程序集），与本条不冲突。
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "numpy", "PIL", "pillow", "lxml", "pandas",
        # pywebview 的其它 GUI 后端，Windows 上用不到，排除以免拖进无关依赖
        "PyQt5", "PyQt6", "PySide2", "PySide6", "gi", "cefpython3",
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="PraatSauceShell",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="PraatSauceShell",
)
