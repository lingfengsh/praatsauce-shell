# -*- coding: utf-8 -*-
"""PraatSauce 助手 —— 启动入口（唯一打开方式）。

同一份代码，两种运行形态：

- **窗口模式（分发版）**：打包后的 exe 默认用它。界面跑在一个独立的 WebView2
  窗口里，不经过系统默认浏览器 —— 对方装的是 360、QQ 浏览器还是旧版 IE 都不影响。
- **浏览器模式（本机开发）**：源码态运行（python app.py、启动 vbs/bat）走这条，
  起服务后交给默认浏览器，改完界面刷新即可，调试最省事。

可用参数强制指定：``--window`` / ``--browser``（源码态就能提前验证壳的效果）。

壳起不来时逐级兜底：WebView2 窗口 → Edge 应用窗口 → 默认浏览器。
"""

import os
import subprocess
import sys
import time
import webbrowser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# 开发态直接跑 --window 时，pywebview 等依赖在 _build/_vendor（本机 site-packages
# 装不进去）。打包后该目录不存在——依赖已进 exe，此处天然跳过。
_VENDOR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_build", "_vendor"
)
if os.path.isdir(_VENDOR):
    sys.path.insert(0, _VENDOR)

# pythonnet 默认去找 .NET CoreCLR，而 Windows 只自带 .NET Framework，
# 不指定 netfx 的话 import clr 会直接失败——必须在 import webview 之前设置。
os.environ.setdefault("PYTHONNET_RUNTIME", "netfx")

from backend import server, settings  # noqa: E402

TITLE = "PraatSauce 助手"

# 关闭标签页后，后端最多再活这么久（秒）就自动退出（仅浏览器模式）
IDLE_TIMEOUT = 60


def _log(msg):
    """壳模式的启动信息写日志：分发出去出问题，这是唯一能问到的线索。

    不走 settings.log_dir()——它的可写性探测要先建后删一个测试文件，
    在部分安全软件/组策略下删除会被拦，于是误判不可写、回退到 %APPDATA% 并被吞掉异常。
    这里直接按「程序目录 → %APPDATA%」逐个真写，写成功即止。
    """
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n"
    for d in (os.path.join(settings.APP_BASE, "logs"), settings.APP_DIR):
        try:
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, "shell.log"), "a", encoding="utf-8") as f:
                f.write(line)
            return
        except Exception:
            continue


def _msgbox(text):
    """窗口起不来时用系统消息框说明原因，避免双击后"什么都没发生"。"""
    try:
        import ctypes

        ctypes.windll.user32.MessageBoxW(None, text, TITLE, 0x30)
    except Exception:
        pass


def _dpi_scale():
    """当前显示器的缩放比例（96 DPI = 1.0）。

    2026-10-18 加这个函数的原因：窗口尺寸参数被 WinForms 当作物理像素用，
    而 CSS 布局是按「逻辑像素」算的。150% 缩放下原来那个 1280×825 的窗口
    实际只有约 850 CSS 宽，顶栏的品牌名被挤成三行、步骤名被迫隐藏。
    """
    try:
        import ctypes

        user32 = ctypes.windll.user32
        try:
            dpi = user32.GetDpiForSystem()
        except Exception:
            dpi = 96
        dpi = int(dpi) or 96
        return dpi / 96.0
    except Exception:
        return 1.0


def _window_size():
    """按屏幕可得区域取窗口尺寸，返回 CSS 像素（调用方再乘缩放）。

    先按 DPI 把物理分辨率换算成逻辑像素，再留 12% 余量，最后夹在
    960~1360（宽）/ 640~900（高）之间——这样 1366×768 的笔记本、
    2K/4K 的高分屏、100%~200% 缩放都能得到同样宽松的界面宽度。
    """
    try:
        import ctypes

        user32 = ctypes.windll.user32
        scale = _dpi_scale()
        avail_w = user32.GetSystemMetrics(0) / scale * 0.88
        avail_h = user32.GetSystemMetrics(1) / scale * 0.88
        return max(960, min(1360, int(avail_w))), max(640, min(900, int(avail_h)))
    except Exception:
        return 1200, 820


def _run_window(url):
    """WebView2 独立窗口。成功返回 True。"""
    try:
        import webview
    except Exception as e:
        _log(f"pywebview 导入失败，转兜底：{e!r}")
        return False

    w, h = _window_size()
    s = _dpi_scale()
    try:
        webview.create_window(TITLE, url, width=int(w * s), height=int(h * s),
                              min_size=(int(880 * s), int(600 * s)))
        webview.start(storage_path=_webview_storage())
        _log("窗口已正常关闭")
        return True
    except Exception as e:
        _log(f"WebView2 窗口启动失败，转兜底：{e!r}")
        return False


def _webview_storage():
    """WebView2 的用户数据目录。

    pywebview 默认丢在系统临时目录里，而学校机房/清理软件常限制或清空 Temp，
    表现为"窗口一片空白"。改放 %LOCALAPPDATA%，拿不到就返回 None 用默认。
    """
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    p = os.path.join(base, "PraatSauceShell", "webview")
    try:
        os.makedirs(p, exist_ok=True)
        return p
    except Exception:
        return None


def _find_edge():
    for p in (
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ):
        if os.path.isfile(p):
            return p
    return None


def _run_edge_app(url):
    """用 Edge 的应用窗口（无地址栏）兜底，内核与壳一致。"""
    exe = _find_edge()
    if not exe:
        _log("未找到 Edge，转默认浏览器")
        return False
    try:
        w, h = _window_size()
        proc = subprocess.Popen([exe, f"--app={url}", f"--window-size={w},{h}"])
        proc.wait()
        _log("Edge 应用窗口已关闭")
        return True
    except Exception as e:
        _log(f"Edge 应用窗口启动失败：{e!r}")
        return False


def _run_browser(url):
    """默认浏览器 + 页面心跳。关掉标签页超过 IDLE_TIMEOUT 就退出，不留孤儿进程。"""
    webbrowser.open(url)
    started_at = time.time()
    try:
        while True:
            time.sleep(5)
            if server.LAST_PING["t"] == 0:
                # 页面始终没加载（如浏览器被拦），给启动宽限后也退出
                if time.time() - started_at > IDLE_TIMEOUT:
                    break
            elif time.time() - server.LAST_PING["t"] > IDLE_TIMEOUT:
                break
    except KeyboardInterrupt:
        pass


def main():
    try:
        return _main()
    except BaseException:
        # 分发版是无控制台的 exe，崩溃时否则什么线索都不留
        import traceback

        _log("未捕获异常：\n" + traceback.format_exc())
        raise


def _main():
    settings.ensure_dirs()
    srv = server.start_server(0)
    port = srv.server_address[1]
    url = f"http://127.0.0.1:{port}/launch.html"

    args = [a.lower() for a in sys.argv[1:]]
    if "--browser" in args:
        mode = "browser"
    elif "--window" in args:
        mode = "window"
    else:
        # 冻结态（分发出去的 exe）默认走壳；源码态保留浏览器，便于调试
        mode = "window" if getattr(sys, "frozen", False) else "browser"

    _log(f"启动：mode={mode} url={url}")

    print("=" * 56)
    print(f"  {TITLE}（{'窗口' if mode == 'window' else '浏览器'}模式）")
    print("=" * 56)
    print(f"  本地服务：{url}")
    print("=" * 56)

    ok = False
    if mode == "window":
        ok = _run_window(url)
        if not ok:
            ok = _run_edge_app(url)
        if not ok:
            _msgbox(
                "无法创建独立窗口（未检测到 WebView2 运行时与 Edge），"
                "已改用系统默认浏览器打开。\n\n"
                "若界面显示异常，请安装 Microsoft Edge WebView2 Runtime 后重试。"
            )
    if not ok:
        _run_browser(url)

    try:
        srv.shutdown()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
