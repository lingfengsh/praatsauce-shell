# -*- coding: utf-8 -*-
"""参数取值校验：把一组参数值校验成「人话」的 errors / warnings，并给出修正值。

与 praatSauce 的 read_params.praat 脚本端校验对齐并加严：
read_params 只做最少的退出式校验（interval 互斥、maxNumFormants>=3），
这里在前端入口就把常见错误用人话报出来，避免跑到 Praat 才崩。

每条消息结构：{"field": <参数名或"">, "msg": <人话>, "fix": <怎么修，可空>}
fixed 里放被自动回退到默认值的字段（choice 超界等），供调用方必要时采用。
"""

import re

from . import params_schema as schema


def _to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _to_int(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def validate_params(values):
    """校验参数取值，返回 {"errors": [...], "warnings": [...], "fixed": {...}}。"""
    errors = []
    warnings = []
    fixed = {}

    def err(field, msg, fix=None):
        errors.append({"field": field, "msg": msg, "fix": fix})

    def warn(field, msg):
        warnings.append({"field": field, "msg": msg, "fix": None})

    # ---- 基频范围 ----
    f0min = _to_float(values.get("f0min", schema.BY_NAME["f0min"]["default"]))
    f0max = _to_float(values.get("f0max", schema.BY_NAME["f0max"]["default"]))
    if f0min is None or f0max is None:
        err("f0min", "基频范围必须是数字")
    else:
        if f0min <= 0 or f0max <= 0:
            err("f0min", "基频上下限都必须大于 0")
        elif f0min >= f0max:
            err("f0min",
                f"基频下限 {int(f0min)} 比上限 {int(f0max)} 还大，请检查是否男女声范围填反")
        # 警告：超出常人说话范围
        if f0min < 20:
            warn("f0min", "基频下限明显低于常人说话范围（<20 Hz），请确认")
        if f0max > 2000:
            warn("f0max", "基频上限明显高于常人说话范围（>2000 Hz），请确认")
        # 警告：跨度过大（跨超过一个数量级）
        if f0min > 0 and f0max / f0min > 10:
            warn("f0max",
                 "基频范围过宽（跨超过一个数量级），八度错误风险高，建议按发音人分别设定")

    # ---- 测量间隔：固定步长 与 等距点数 二选一（intervalMode 指定哪种生效）----
    ie = _to_int(values.get("intervalEquidistant", 0) or 0)
    iff = _to_float(values.get("intervalFixed", 0) or 0)
    if ie is None:
        ie = 0
    if iff is None:
        iff = 0.0
    mode = values.get("intervalMode", None)
    if mode is None or _to_int(mode) is None:
        # 旧档没有 intervalMode：沿用「一个必须为 0」的旧语义报错
        if (ie == 0 and iff == 0) or (ie > 0 and iff > 0):
            err("intervalFixed",
                "测量间隔只能二选一：固定间隔（秒）或等分点数，其中一个必须是 0")
    else:
        mode = _to_int(mode)
        if mode == 0:
            if iff <= 0:
                err("intervalFixed", "当前方式是「固定步长」，测量步长必须大于 0 秒")
        else:
            if ie <= 0:
                err("intervalEquidistant", "当前方式是「等分点数」，每区间取点数必须至少为 1")

    # ---- 共振峰数量 ----
    nf = _to_int(values.get("maxNumFormants", schema.BY_NAME["maxNumFormants"]["default"]))
    if nf is None:
        nf = 0
    if nf < 3:
        err("maxNumFormants", "共振峰数量至少为 3")

    # ---- 标注筛选正则 ----
    pat = values.get("includeTheseLabels", "")
    if pat:
        try:
            re.compile(pat)
        except re.error as e:
            err("includeTheseLabels",
                f"标注筛选不是合法的表达式：{e}。可改回默认 ^(?!\\s*$).+ ")

    # ---- choice 类超界：自动回默认 ----
    choice_rules = [
        ("pitchMethod", {0, 1, 2}, "基频算法"),
        ("pitchWindowShape", {0, 1}, "基频窗形"),
        ("cppTrendType", {0, 1}, "CPP 趋势线类型"),
        ("cppFast", {0, 1}, "CPP 快速模式"),
    ]
    for name, allowed, label in choice_rules:
        raw = values.get(name, schema.BY_NAME[name]["default"])
        iv = _to_int(raw)
        if iv is None or iv not in allowed:
            default = schema.BY_NAME[name]["default"]
            err(name, f"{label}只能是 {'/'.join(str(x) for x in sorted(allowed))} 之一，已恢复默认")
            fixed[name] = default

    # ---- 分析窗长 ----
    wl = _to_float(values.get("windowLength", schema.BY_NAME["windowLength"]["default"]))
    if wl is not None:
        if wl <= 0 or wl > 0.2:
            err("windowLength", "分析窗长必须在 0–0.2 秒之间（建议 0.005–0.025）")
        elif wl > 0.05:
            warn("windowLength", "分析窗长偏大（>0.05 秒），可能平滑掉共振峰细节")

    return {"errors": errors, "warnings": warnings, "fixed": fixed}
