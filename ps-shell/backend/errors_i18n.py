# -*- coding: utf-8 -*-
"""把 Praat 的英文报错翻译成人话。

Praat 崩溃时 stderr/stdout 里是一堆英文，普通用户看不懂。这里按日志尾部特征
匹配成「标题 + 建议 + 原始错误行」，让失败更可读。
"""

import re

# (编译好的正则, 人话标题, 建议动作)
PATTERNS = [
    (re.compile(r"Found \d+ arguments but expected", re.I),
     "脚本与助手版本不匹配（脚本要的参数个数变了）",
     "彻底退出助手（关掉页面后等 60 秒自动退出，或关掉启动黑框），再重新启动后重试"),
    (re.compile(r"There is not a one-to-one correspondence", re.I),
     "声音文件与 TextGrid 数量不相等",
     "在「选择音频」步骤查看配对情况，移除多余文件或补齐缺失的 TextGrid"),
    (re.compile(r"Cannot read|No such file|Cannot open file", re.I),
     "找不到文件",
     "检查路径是否被移动或重命名；中文/特殊字符路径建议整体移到纯英文短路径下重试"),
    (re.compile(r"Permission denied", re.I),
     "文件被占用或只读",
     "关闭正在使用该文件的其他程序（如播放器、Excel）"),
    (re.compile(r"Should be a number|not a number|not defined", re.I),
     "参数文件里某个值不是合法数字",
     "回到参数页检查刚改过的数值"),
    (re.compile(r"Script's line|Script line", re.I),
     "脚本在执行中出错",
     "属于脚本内部问题，请把本页日志反馈给维护者"),
]


def _line_text(line):
    """日志条目可能是字符串（原始行）或 job.log 里的 dict。"""
    if isinstance(line, str):
        return line
    if isinstance(line, dict):
        return line.get("text", "")
    return str(line)


def translate_log_tail(lines, tail_n=100):
    """从日志尾部约 tail_n 行里找第一个命中的模式。

    命中返回「标题 + 建议 + 原始错误行」拼好的字符串；无命中返回 None。
    """
    if not lines:
        return None
    window = lines[-tail_n:]
    for line in window:
        text = _line_text(line)
        if not text:
            continue
        for rx, title, suggestion in PATTERNS:
            if rx.search(text):
                return f"{title}\n建议：{suggestion}\n原始日志：{text}"
    return None
