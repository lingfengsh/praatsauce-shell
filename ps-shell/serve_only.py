# -*- coding: utf-8 -*-
"""仅启动本地 HTTP 服务（不创建原生窗口/不自动开浏览器）。

用法：python serve_only.py
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from backend import server  # noqa: E402

if __name__ == "__main__":
    srv = server.start_server(0)
    port = srv.server_address[1]
    print(f"SERVE_URL=http://127.0.0.1:{port}/launch.html")
    print(f"  VS 皮肤：http://127.0.0.1:{port}/vs.html")
    print(f"  向导版：http://127.0.0.1:{port}/index.html")
    print("  按 Ctrl+C 退出。")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        srv.shutdown()
