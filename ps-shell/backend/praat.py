# -*- coding: utf-8 -*-
"""Praat 可执行文件探测与脚本运行。

要点：
1. Windows 版 Praat 用 --run 执行脚本，且 stdout/stderr 是 UTF-16LE（带 BOM），
   必须按 BOM 判断解码方式，否则日志全是乱码。
2. 用 Popen + 读线程做流式输出，批量处理时才能实时显示进度。
"""

import os
import re
import time
import subprocess
import threading
import glob

# settings 不依赖 praat，可安全在此引用（无循环）
from . import settings as _settings  # noqa: E402

# 程序根：开发态=仓库根，冻结态=exe 所在目录 —— 唯一锚点，praatsauce.exe 放在这里。
# 两态同构，所有路径相对它推导，不写死任何绝对路径。
PROJECT_ROOT = _settings.APP_BASE


def q(s):
    """Praat 字符串字面量转义：把 `"` 双写成 `""`（实测 Praat 支持此转义）。

    文件名里含 `"` 时若不转义会提前闭合字符串，剩余内容被当作脚本命令执行
    （可触发 `Save as text file:` 任意写）。生成脚本时所有嵌入的路径都应过这里。
    """
    return str(s).replace('"', '""')


def _probe_path():
    """探针脚本落点：必须写到可写目录。

    程序根可能只读（装在 Program Files / 只读介质），往 scripts/ 里写会直接
    PermissionError，因此统一写临时工作区。带随机后缀：并发探测不互相覆盖。
    """
    try:
        os.makedirs(_settings.WORK_DIR, exist_ok=True)
    except Exception:
        pass
    import uuid as _uuid
    return os.path.join(_settings.WORK_DIR, "_probe_version_%s.praat" % _uuid.uuid4().hex)


def _write_probe():
    """写入探针脚本，返回路径；写失败（程序根只读等）返回 None。"""
    # 总是重写：早期版本可能写入过带 platform$ 的旧内容
    try:
        p = _probe_path()
        with open(p, "w", encoding="utf-8") as f:
            # 注意：新版 Praat 已经没有 platform$ 变量，只用 version$
            f.write('writeInfoLine: "PSA_PROBE ", version$, " Ready"\n')
        return p
    except Exception:
        return None


def _guess_encoding(chunk):
    """Praat 的 stdout 带 UTF-16 BOM，stderr 却是无 BOM 的 UTF-16，
    所以除了看 BOM，还要用「奇数位是不是 0」来判断。"""
    if chunk[:2] == b"\xff\xfe" or chunk[:2] == b"\xfe\xff":
        return "utf-16"
    sample = chunk[:64]
    if len(sample) >= 8:
        odd_zeros = sum(1 for i in range(1, len(sample), 2) if sample[i] == 0)
        if odd_zeros >= len(sample) // 4:
            return "utf-16-le"
    return "utf-8"


def _decode_stream(stream, sink, tag):
    """按 BOM/字节特征判断编码，逐块增量解码，按行回调。"""
    decoder = None
    buf = ""
    try:
        while True:
            chunk = stream.read(4096)
            if not chunk:
                break
            if decoder is None:
                enc = _guess_encoding(chunk)
                decoder = __import__("codecs").getincrementaldecoder(enc)(errors="replace")
            buf += decoder.decode(chunk)
            if "\n" in buf:
                parts = buf.split("\n")
                buf = parts.pop()
                for line in parts:
                    sink(line.rstrip("\r"), tag)
        if decoder is not None:
            buf += decoder.decode(b"", True)
        if buf.strip():
            sink(buf.rstrip("\r"), tag)
    except Exception:
        pass
    finally:
        try:
            stream.close()
        except Exception:
            pass


def run_script(exe, script, args=(), cwd=None, on_line=None, timeout=None, stop_event=None,
               full_trust=False):
    """运行 Praat 脚本。

    on_line(line, tag) 会被实时调用（tag 为 'out' / 'err'）。
    stop_event 被 set 时立即终止进程（用于"取消"）。
    full_trust=True 时在 --run 前加 --FULL-TRUST，允许脚本写文件（转码 Save as WAV 等
    被 Praat 7 视为"危险动作"，不加会直接报错退出）。
    返回 (returncode, lines)。
    """
    cmd = [exe]
    if full_trust:
        cmd.append("--FULL-TRUST")
    cmd += ["--run", script] + [str(a) for a in args]
    startupinfo = None
    if os.name == "nt":
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 0

    lines = []
    lock = threading.Lock()

    def sink(line, tag):
        if on_line:
            try:
                on_line(line, tag)
            except Exception:
                pass
        with lock:
            lines.append({"tag": tag, "text": line})

    proc = subprocess.Popen(
        cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        startupinfo=startupinfo,
    )
    threads = [
        threading.Thread(target=_decode_stream, args=(proc.stdout, sink, "out"), daemon=True),
        threading.Thread(target=_decode_stream, args=(proc.stderr, sink, "err"), daemon=True),
    ]
    for t in threads:
        t.start()
    if stop_event is None:
        try:
            rc = proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            rc = -1
    else:
        deadline = time.time() + (timeout or 3.15e7)
        rc = -1
        while True:
            if stop_event.is_set():
                sink("（已取消）", "err")
                try:
                    proc.kill()
                except Exception:
                    pass
                rc = -2
                break
            try:
                rc = proc.wait(timeout=0.4)
                break
            except subprocess.TimeoutExpired:
                if time.time() > deadline:
                    try:
                        proc.kill()
                    except Exception:
                        pass
                    rc = -1
                    break
                continue
    for t in threads:
        t.join(timeout=2)
    return rc, lines


def decode_bytes(raw):
    """把 Praat 的字节输出解码成文本（UTF-16 带/不带 BOM 都能处理）。"""
    if not raw:
        return ""
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16", errors="replace")
    return raw.decode(_guess_encoding(raw), errors="replace")


def _version_by_flag(exe):
    """Praat 6 支持 --version，输出形如 "Praat 6.4.46 (October 20 2025)"。"""
    startupinfo = None
    if os.name == "nt":
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 0
    try:
        p = subprocess.run([exe, "--version"], capture_output=True, timeout=25,
                           startupinfo=startupinfo)
    except Exception:
        return None
    text = decode_bytes((p.stdout or b"") + (p.stderr or b"")).strip()
    m = re.search(r"(\d+\.\d+(?:\.\d+)?)", text)
    if m:
        return m.group(1)
    return text or None


def probe_praat(exe):
    """返回版本字符串；不可用返回 None。"""
    if not exe or not os.path.exists(exe):
        return None

    ver = _version_by_flag(exe)
    if ver:
        return ver

    # 兜底：跑一个最小的脚本，看 Praat 能不能执行
    probe = _write_probe()
    if not probe:
        return None
    try:
        rc, lines = run_script(exe, probe, timeout=25)
    except Exception:
        return None
    finally:
        try:
            os.remove(probe)
        except Exception:
            pass
    text = " ".join(l["text"] for l in lines)
    if "PSA_PROBE" in text:
        return text.split("PSA_PROBE", 1)[1].strip() or "unknown"
    # 只要 Praat 能启动并且没有报 "not completed"，也当作可用
    if rc == 0 or "version" in text.lower():
        return "unknown"
    return None


_COMMON_PATHS = [
    # 项目自带 praat.exe（相对项目根目录）优先，便于随文件夹迁移、不依赖本机路径
    os.path.join(PROJECT_ROOT, "praat.exe"),
    r"C:\Program Files\Praat\Praat.exe",
    r"C:\Program Files (x86)\Praat\Praat.exe",
    r"C:\Praat\Praat.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Programs\Praat\Praat.exe"),
    os.path.expanduser(r"~\Desktop\Praat.exe"),
]


def detect_praat(roots=None, max_depth=3):
    """在常见位置和给定根目录里找能用的 Praat。返回候选列表。"""
    found = []
    seen = set()

    def add(p):
        p = os.path.abspath(p)
        if p in seen:
            return
        seen.add(p)
        if os.path.basename(p).lower() in ("praat.exe", "praatcon.exe", "praat"):
            found.append(p)

    for p in _COMMON_PATHS:
        if os.path.exists(p):
            add(p)

    roots = list(roots or []) + [PROJECT_ROOT, os.getcwd(), r"C:\Program Files", r"C:\Program Files (x86)"]  # noqa
    for root in roots:
        if not root or not os.path.isdir(root):
            continue
        try:
            for dirpath, dirnames, filenames in os.walk(root):
                depth = dirpath[len(root):].count(os.sep)
                if depth >= max_depth:
                    dirnames[:] = []
                    continue
                dirnames[:] = [d for d in dirnames if not d.startswith(".")]
                for f in filenames:
                    if f.lower() == "praat.exe":
                        add(os.path.join(dirpath, f))
        except Exception:
            continue

    # 优先 GUI 版（praatcon 老版本不支持新语法）
    found.sort(key=lambda p: (0 if os.path.basename(p).lower() == "praat.exe" else 1, p))
    return found
