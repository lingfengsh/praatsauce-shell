# -*- coding: utf-8 -*-
"""用户设置持久化（Praat 路径、上次目录、默认档位等）。"""

import os
import sys
import json
import threading
import tempfile

# 是否由 PyInstaller 冻结（--onedir）。冻结后"程序根目录"= exe 所在目录，
# 所有默认路径必须相对它动态确定，不能再依赖开发机的绝对路径。
IS_FROZEN = getattr(sys, "frozen", False)


def app_base():
    """程序根目录：开发态=仓库根 praatsauce-latest；冻结态=exe 所在目录。"""
    if IS_FROZEN:
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


APP_BASE = app_base()
PROJECT_ROOT = APP_BASE  # 向后兼容：开发态等于仓库根


def _resource(*rel):
    """冻结态定位随包数据文件。

    PyInstaller 6.x 的 onedir 把 --add-data 的资源放到 ``<exe 目录>/_internal`` 下；
    onefile 则放到 ``sys._MEIPASS`` 临时目录。这里两者都试，再回退 exe 同目录，
    保证无论哪种打包方式都能找到 ui/、vowel_ref.json 等随包资源。
    （注意：scripts/ 由分发流程手动放在 exe 同目录，不在此列，直接用 APP_BASE/scripts。）
    """
    exe = os.path.dirname(sys.executable)
    candidates = []
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        candidates.append(meipass)
    candidates.append(os.path.join(exe, "_internal"))
    candidates.append(exe)
    for base in candidates:
        p = os.path.join(base, *rel)
        if os.path.exists(p):
            return p
    return os.path.join(os.path.join(exe, "_internal"), *rel)


APP_DIR = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "PraatSauceShell")
# 配置落点（settings / param_overrides）首选「程序根目录」，见下方 _config_dir()。
# 旧设计直接写进 %APPDATA%\\PraatSauceShell，既违背「程序只能依赖本目录内部文件」的自包含要求，
# 又会随用户账户（漫游/同机拷贝）残留上次的绝对工作目录，导致拷贝到别的电脑仍召回旧目录。


def load_param_overrides():
    """读用户参数默认值 override；只保留 schema 里存在的键。损坏时移走坏文件并回落空。"""
    try:
        with open(PARAM_OVERRIDES_PATH, encoding="utf-8") as f:
            d = json.load(f)
        if not isinstance(d, dict):
            raise ValueError("not a dict")
    except FileNotFoundError:
        return {}
    except Exception:
        try:
            os.replace(PARAM_OVERRIDES_PATH, PARAM_OVERRIDES_PATH + ".bad")
        except OSError:
            pass
        return {}
    from backend import params_schema as _schema
    return {k: v for k, v in d.items() if k in _schema.BY_NAME}


# 这些键含机器相关路径/会话状态，不允许固化成默认值（换机器会指向不存在的目录）
_NO_DEFAULT_KEYS = {"inputDir", "outputDir", "tgDir", "filelist", "skipCols",
                    "pitchSaveDir", "pitchReadDir", "formantSaveDir", "formantReadDir"}


def save_param_overrides(values):
    """写 override：与出厂默认相同的键不写（只存差异，用户文件保持最小）。"""
    from backend import params_schema as _schema
    factory = _schema.default_values()
    diff = {k: v for k, v in (values or {}).items()
            if k in _schema.BY_NAME and k not in _NO_DEFAULT_KEYS
            and v != factory.get(k)}
    os.makedirs(APP_DIR, exist_ok=True)
    tmp = PARAM_OVERRIDES_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(diff, f, ensure_ascii=False, indent=2)
    os.replace(tmp, PARAM_OVERRIDES_PATH)
    return diff


def clear_param_overrides():
    try:
        os.remove(PARAM_OVERRIDES_PATH)
    except FileNotFoundError:
        pass


def effective_param_defaults():
    """出厂默认 + 当前发音人 + 用户 override 合并后的「生效默认值」。

    2026-10-18 修：此前只把 speaker 这个 id 存进 settings，参数默认却恒取出厂值
    （f0max=300）。于是「点成年女声 → 400；点恢复默认参数 / 重启 → 又变 300」，
    同一个发音人出现两套上限、界面高亮还是女声，极难排查。
    现在把当前发音人的 f0min / f0max / maxFormantHz 覆盖到默认层：
    优先级 = 出厂默认 < 发音人 < 用户 override（用户自己存过就以用户为准）。
    """
    d = {}  # 出厂默认本身可能含 None（无 default 键的项），保持 default_values() 原样
    from backend import params_schema as _schema
    d.update(_schema.default_values())

    spk = ""
    try:
        spk = (load() or {}).get("speaker") or ""
    except Exception:
        spk = ""
    if spk:
        hit = None
        for s in _schema.SPEAKER_PRESETS:
            if s.get("id") == spk:
                hit = s
                break
        if hit is None:
            # 也可能是用户自建的发音人档案（profiles.json）；拿不到就退回出厂默认
            try:
                from backend import profiles as _profiles
                for p in _profiles.list_profiles():
                    if p.get("id") == spk:
                        hit = p
                        break
            except Exception:
                hit = None
        if hit:
            for k in ("f0min", "f0max", "maxFormantHz"):
                if hit.get(k) is not None:
                    d[k] = hit[k]

    d.update(load_param_overrides())
    return d
WORK_DIR = os.path.join(tempfile.gettempdir(), "PraatSauceShell")

# 开发态与冻结态同构：运行时数据一律是 <程序根>/{scripts,samples,logs}
# 与 <程序根>/praat.exe。开发态程序根=仓库根，冻结态程序根=exe 所在目录，
# 相对形状完全一致 —— 因此不需要分支。过去两类路径各写一套分支，正是
# 分发版路径错位的根源（脚本散落 praatsauce-master/src 与 ps-shell/praat）。
DEFAULT_SCRIPT_DIR = os.path.join(APP_BASE, "scripts")
DEFAULT_PRAAT_EXE = os.path.join(APP_BASE, "praat.exe")
DEFAULT_SAMPLE_DIR = os.path.join(APP_BASE, "samples")

DEFAULTS = {
    "praatExe": DEFAULT_PRAAT_EXE,
    "praatVersion": "",
    "scriptDir": DEFAULT_SCRIPT_DIR,
    "lastInputDir": "",
    "lastOutputDir": "",
    "lastTgDir": "",
    "tier": "novice",
    "preset": "phonation",
    "speaker": "custom",
    "soundExt": "wav",
    # 双界面：启动时选择（wizard=向导版四步向导，vs=VoiceSauce 风格皮肤）
    "uiMode": "wizard",
    "rememberUi": False,
}


_LOG_DIR_CACHE = [None]


def _writable_dir(d):
    """目录可写性探测（不存在则尝试创建），用于挑选日志落点。"""
    try:
        os.makedirs(d, exist_ok=True)
        t = os.path.join(d, ".writetest")
        with open(t, "w", encoding="utf-8") as f:
            f.write("1")
        os.remove(t)
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# 配置落点：默认程序根目录（自包含，随程序一起拷贝），程序根不可写时（如装进
# Program Files 等只读区）才回退到 %APPDATA%\\PraatSauceShell。
# 这样配置既不依赖机器外部位置、又能随程序便携；只读介质下仍有可写回落。
# ---------------------------------------------------------------------------
def _config_dir():
    for d in (APP_BASE, APP_DIR):
        if _writable_dir(d):
            return d
    return APP_DIR


CONFIG_DIR = _config_dir()
# 按模式分开存：开发版与分发版各用一份（避免开发态绝对路径污染分发版）。
SETTINGS_PATH = os.path.join(CONFIG_DIR, "settings_frozen.json" if IS_FROZEN else "settings.json")
# 用户自定义参数默认值（override 层）：只存与出厂默认不同的键，与 settings 同目录、按模式分开。
# 文件缺失/损坏/被删 → 自动回落出厂默认（params_schema.default_values()），永不阻塞启动。
PARAM_OVERRIDES_PATH = os.path.join(
    CONFIG_DIR, "param_overrides_frozen.json" if IS_FROZEN else "param_overrides.json")


# 这些键是「上次使用的工作目录」，存的是绝对路径。换电脑 / 删目录后若仍原样召回，
# 会指向不存在的旧目录 —— 正是「拷贝到别的电脑仍跑出当时的工作目录」的根因。
# 加载与保存时一律做存在性校验：目录不存在即清空，绝不召回失效的绝对路径。
_WORKING_DIR_KEYS = ("lastInputDir", "lastOutputDir", "lastTgDir")


def _sanitize_working_dirs(data):
    for k in _WORKING_DIR_KEYS:
        v = data.get(k)
        if v and not os.path.isdir(v):
            data[k] = ""
    return data


def log_dir():
    """日志与报错快照目录。

    优先 <程序根>/logs —— 用户一眼就能找到，出问题时把整个目录打包回传即可。
    程序根不可写时（装在 Program Files、只读介质）自动回退到
    %APPDATA%\\PraatSauceShell\\logs。路径由程序所在位置推导，绝不写死绝对路径。
    """
    if _LOG_DIR_CACHE[0]:
        return _LOG_DIR_CACHE[0]
    for d in (os.path.join(APP_BASE, "logs"), os.path.join(APP_DIR, "logs")):
        if _writable_dir(d):
            _LOG_DIR_CACHE[0] = d
            return d
    _LOG_DIR_CACHE[0] = os.path.join(APP_DIR, "logs")
    return _LOG_DIR_CACHE[0]


def resolve_script_dir(cfg=None):
    """脚本目录：结构统一后恒为 <程序根>/scripts，不接受外部配置。

    理由有二：
    1. 脚本位置由程序自身结构决定，让用户配置只会制造"指到错误目录"的机会；
    2. 设置历史上是跨模式共享的，一旦存进开发路径，分发版 exe 就会跑到开发目录
       去找脚本（表现为"跑的是 exe、用的是开发版"）。
    因此这里直接返回程序根下的 scripts/，忽略任何历史配置值。
    """
    return DEFAULT_SCRIPT_DIR


def resolve_praat_exe(cfg=None):
    """Praat 程序：配置值不存在时自动回退程序根下的 praat.exe。"""
    cfg = load() if cfg is None else cfg
    exe = cfg.get("praatExe") or ""
    if exe and os.path.exists(exe):
        return exe
    if os.path.exists(DEFAULT_PRAAT_EXE):
        return DEFAULT_PRAAT_EXE
    return exe


def ensure_dirs():
    for d in (CONFIG_DIR, WORK_DIR):
        try:
            os.makedirs(d, exist_ok=True)
        except Exception:
            pass


# 必须用 RLock：save() 持锁期间会调 load()，普通 Lock 不可重入会永久死锁
# （2026-09-28 事故：bootstrap 首次探测到 Praat 版本后调 save → 死锁，
#  表现为分发版 exe 首页能开、后续所有请求全部挂起）。
_SETTINGS_LOCK = threading.RLock()


def load():
    ensure_dirs()
    data = dict(DEFAULTS)
    try:
        with _SETTINGS_LOCK:
            if os.path.exists(SETTINGS_PATH):
                with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
                    data.update(json.load(f))
    except Exception:
        pass   # 读失败按默认值继续；半截 JSON 通常是写进程被杀，下次 save 会覆盖
    return _sanitize_working_dirs(data)


def save(data):
    """合并写入。先写临时文件再 os.replace 原子替换：
    写一半被杀只会留下孤儿临时文件，不会把 settings.json 弄成半截 JSON。"""
    ensure_dirs()
    with _SETTINGS_LOCK:
        merged = load()
        merged.update(data or {})
        _sanitize_working_dirs(merged)  # 防御：保存前再清一次失效目录，杜绝旧绝对路径固化
        tmp = SETTINGS_PATH + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(merged, f, ensure_ascii=False, indent=2)
            os.replace(tmp, SETTINGS_PATH)
        except Exception:
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except Exception:
                pass
    return merged


def path_defaults():
    """程序自身的相对默认路径（Praat 与脚本目录），作为「恢复默认」的唯一真相源。

    冻结态 = exe 同目录（scripts/、praat.exe）；开发态 = 仓库根
    （praatsauce-master/src、仓库根 praat.exe）。全部相对于程序实际所在目录
    动态计算，绝不写死任何机器相关绝对路径——换机器、换盘符、换文件夹都能
    自动回到程序所在目录。设置界面「恢复默认」按钮即把这两个值重置回此处。
    """
    return {"praatExe": DEFAULT_PRAAT_EXE, "scriptDir": DEFAULT_SCRIPT_DIR}
