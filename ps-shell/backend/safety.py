# -*- coding: utf-8 -*-
"""结果防覆盖：跑新一批前先把上一版结果归档，而不是直接让 Praat 覆盖掉。"""

import os
import re
import shutil
from datetime import datetime


def archive_previous_result(result_path, keep=10):
    """把已存在的结果文件复制到「同目录/历史结果/<stem>.<时间戳><ext>」，返回归档路径。

    - 文件不存在 → 返回 None（无需归档）。
    - 存在 → 复制（不移动）到历史结果目录，返回归档路径。
    - 同名归档超过 keep 份时，删除最旧的（保留最新 keep 份）。
    - 任何异常都不抛出：返回 None，由调用方记 warning 日志。
    """
    try:
        if not os.path.exists(result_path):
            return None
        hist_dir = os.path.join(os.path.dirname(result_path), "历史结果")
        os.makedirs(hist_dir, exist_ok=True)

        stem, ext = os.path.splitext(os.path.basename(result_path))
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        archived = os.path.join(hist_dir, f"{stem}.{ts}{ext}")
        shutil.copy2(result_path, archived)

        # 修剪：同名归档超过 keep 份时删最旧
        pat = re.compile(re.escape(stem) + r"\.\d{8}-\d{6}" + re.escape(ext) + r"$")
        others = sorted(n for n in os.listdir(hist_dir) if pat.match(n))
        excess = len(others) - keep
        if excess > 0:
            for n in others[:excess]:
                try:
                    os.remove(os.path.join(hist_dir, n))
                except Exception:
                    pass
        return archived
    except Exception:
        return None
