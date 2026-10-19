# -*- coding: utf-8 -*-
"""把 pywebview 及其依赖的 wheel 下载并解包到 _build/_vendor。

为什么不用 pip：部分环境不允许写 Python 的 site-packages，
而 PyInstaller 只需在 pathex 里能 import 到即可，不需要全局安装。

用法（在仓库根执行）：
    python packaging/fetch_wheels.py
"""
import io
import json
import os
import re
import subprocess
import sys
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))          # <仓库根>/packaging
ROOT = os.path.dirname(HERE)                               # <仓库根>
VENDOR = os.path.join(ROOT, "_build", "_vendor")
WHEELHOUSE = os.path.join(ROOT, "_build", "_wheelhouse")

# 只列顶层包，依赖由 requires_dist 递归解析（只处理必需依赖）
TOP = ["pywebview"]

PY = f"cp{sys.version_info.major}{sys.version_info.minor}"

# packaging 可能只存在于 vendor 里（本机 PyPI 装不进 site-packages）
if os.path.isdir(VENDOR):
    sys.path.insert(0, VENDOR)


# 沙箱下 Python 的 urllib 会被代理拦截（400），curl 通道正常，统一走 curl
def _get(url):
    r = subprocess.run(
        ["curl", "-sSL", "--max-time", "120", url],
        capture_output=True, check=True,
    )
    return r.stdout


def pick_file(meta, name):
    """从 PyPI JSON 的文件列表里挑一个适配当前平台/解释器的 wheel。"""
    best = None
    for f in meta["urls"]:
        fn = f["filename"]
        if not fn.endswith(".whl"):
            continue
        tags = fn[:-4].split("-")
        # 形如 name-ver-py3-none-any.whl / name-ver-cp311.cp312-...-win_amd64.whl
        pytag = tags[-3] if len(tags) >= 5 else "py3"
        abi = tags[-2] if len(tags) >= 5 else "none"
        plat = tags[-1] if len(tags) >= 5 else "any"
        if plat not in ("any", "win_amd64"):
            continue
        if abi not in ("none", "abi3") and PY not in pytag:
            continue
        if pytag.startswith("cp") and PY not in pytag and "abi3" not in abi:
            continue
        # 优先平台专用 wheel
        score = (plat != "any") * 2 + (abi != "none")
        if best is None or score > best[0]:
            best = (score, f)
    return best[1] if best else None


def deps_of(meta):
    """只取当前平台真正需要的必需依赖。

    不用 packaging（它本身也得从 PyPI 装，形成先有鸡还是先有蛋），
    依赖列表格式简单，正则足够：剥掉版本约束，按 marker 排除 extras 与其它平台。
    """
    out = []
    for req in meta["info"].get("requires_dist") or []:
        body, _, marker = req.partition(";")
        m = marker.lower()
        if "extra" in m:                   # 可选依赖（qt/gtk 等）
            continue
        if "darwin" in m or "linux" in m or "macos" in m or "win32" not in m and m and "sys_platform" in m:
            continue
        name = re.split(r"[\s\[<>=!~]", body.strip())[0]
        if name:
            out.append(name)
    return out


def _install_sdist(meta, name):
    """没有 wheel 时退化为解包 sdist 里的包目录。"""
    import shutil
    import tarfile
    import tempfile

    want = name.replace("-", "_").lower()
    src = next((x for x in meta["urls"]
                if x["filename"].endswith((".tar.gz", ".zip"))), None)
    if not src:
        return False
    data = _get(src["url"])
    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, src["filename"])
        with open(path, "wb") as fh:
            fh.write(data)
        with tarfile.open(path) as tf:
            tf.extractall(os.path.join(td, "x"))
        for root, dirs, _files in os.walk(os.path.join(td, "x")):
            for d in dirs:
                if d.lower() == want and os.path.exists(os.path.join(root, d, "__init__.py")):
                    shutil.copytree(os.path.join(root, d),
                                    os.path.join(VENDOR, d), dirs_exist_ok=True)
                    print(f"  OK   {src['filename']} (sdist -> {d}/)")
                    return True
    return False


def main():
    os.makedirs(VENDOR, exist_ok=True)
    os.makedirs(WHEELHOUSE, exist_ok=True)

    seen, queue = set(), list(TOP)
    while queue:
        name = queue.pop(0)
        key = name.lower().replace("_", "-")
        if key in seen:
            continue
        seen.add(key)

        meta_raw = _get(f"https://pypi.org/pypi/{name}/json")
        try:
            meta = json.loads(meta_raw)
        except Exception:
            print(f"  FAIL {name}: 响应非 JSON ({len(meta_raw)} bytes) {meta_raw[:80]!r}")
            continue
        f = pick_file(meta, name)
        if not f:
            # 少数小包只发 sdist（如 proxy_tools），直接解包源码
            if _install_sdist(meta, name):
                queue.extend(deps_of(meta))
            else:
                print(f"  SKIP {name}: 无 wheel 也无 sdist")
            continue
        dest = os.path.join(WHEELHOUSE, f["filename"])
        if not os.path.exists(dest):
            data = _get(f["url"])
            with open(dest, "wb") as fh:
                fh.write(data)
        with zipfile.ZipFile(dest) as z:
            z.extractall(VENDOR)
        print(f"  OK   {f['filename']}")
        queue.extend(deps_of(meta))

    print(f"\n解包完成 -> {VENDOR}")


if __name__ == "__main__":
    main()
