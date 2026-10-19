# -*- coding: utf-8 -*-
"""工作目录解析（兼容壳，已不再改写目录）。

设计原则（2026-10-02 用户定案）：工作目录**只有一个**绑定变量，其定义动作只两个——
① 在对话框直接指定；② 重采样同时由前端重新定位到 ``Resample/``。
后端**不得**再自作主张改变工作目录（旧版曾「发现 Resample/ 子目录就偷偷切过去」，
属画蛇添足，已删除）。

因此 :func:`resolve_working_dir` 现在原样返回入参，仅为兼容 9 处既有调用点保留外壳，
语义上等同于不调用。双副本（父目录原始 wav 与 Resample/ 副本同名）的防护已下沉到
扫描层：``review_grid._list_wavs`` 在 ``os.walk`` 时跳过名为 ``Resample`` 的子目录。
"""
import os

RESAMPLE_DIR = "Resample"


def _has_wavs(d, ext="wav"):
    if not d or not os.path.isdir(d):
        return False
    ext = (ext or "wav").strip().lstrip(".").lower()
    try:
        return any(n.lower().endswith("." + ext) for n in os.listdir(d))
    except Exception:
        return False


def resolve_working_dir(d, ext="wav"):
    """原样返回 d，不再改写目录（见模块注释）。

    保留外壳仅为兼容既有调用点；调用方传进来的就是用户指定的工作目录，后端不再动它。
    """
    return d
