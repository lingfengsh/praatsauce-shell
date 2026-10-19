# -*- coding: utf-8 -*-
"""临时 e2e：造一个工作目录，跑通双源导出（对象 + 汇总表）四种布局，跑完即删。"""
import os
import sys
import tempfile
import shutil

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend import series_export as se, praat_objects

d = tempfile.mkdtemp(prefix="e2e_exp_")
try:
    # 两个音频 + 对象文件
    for base, base_f0 in (("11", 200), ("12", 300)):
        open(os.path.join(d, base + ".wav"), "w").close()
        with open(os.path.join(d, base + ".Pitch"), "w", encoding="utf-8") as f:
            f.write('File type = "ooTextFile"\nObject class = "Pitch 1"\n'
                    "xmin = 0.0 \nxmax = 0.015 \nx1 = 0.0025 \n"
                    "nx = 3 \ndx = 0.005 \n"
                    "frames []:\n" + "".join(
                        "    frames [%d]:\n        intensity = 1.0 \n"
                        "        nCandidates = 1 \n"
                        "        candidates [1]:\n            frequency = %d \n"
                        % (i + 1, base_f0 + 10 * i) for i in range(3)))
        praat_objects.write_formant_text(
            os.path.join(d, base + ".Formant"),
            [{"t": 0.0025, "F1": 500, "F2": 1500, "F3": 2500, "F4": 3500, "F5": 4500,
              "B1": 50, "B2": 60, "B3": 70, "B4": 80, "B5": 90},
             {"t": 0.0125, "F1": 520, "F2": 1520, "F3": 2520, "F4": 3520, "F5": 4520,
              "B1": 51, "B2": 61, "B3": 71, "B4": 81, "B5": 91}],
            xmin=0.0, maxn=5)

    # 汇总表（真实表头，只填几个谐波/噪声/能量列）
    cols = ("file\tlabel\tintervaldID\tt\tf0\tF1\tF2\tF3\t"
            "H1c\tH2c\tH4c\tA1c\tA2c\tA3c\tH2Ku\tH5Ku\t"
            "H1u\tH2u\tH4u\tA1u\tA2u\tA3u\t"
            "H1H2c\tH2H4c\tH1A1c\tH1A2c\tH1A3c\tH2KH5Ku\t"
            "CPP\tHNR05\tHNR15\tHNR25\tHNR35\tintensity\tsoe").split("\t")
    lines = ["\t".join(cols)]
    for base in ("11", "12"):
        for i, t in enumerate((0.0025, 0.0075, 0.0125)):
            row = {c: "" for c in cols}
            row.update({"file": base + ".wav", "t": str(t), "f0": str(200 + 10 * i),
                        "H1H2c": str(4 + i), "HNR05": str(20.5 + i),
                        "CPP": str(15 + i), "intensity": str(70 + i), "soe": str(60 + i),
                        "H1c": "40", "H2c": "35"})
            lines.append("\t".join(str(row.get(c, "")) for c in cols))
    with open(os.path.join(d, "out.tsv"), "w", encoding="utf-8-sig", newline="") as f:
        f.write("\n".join(lines) + "\n")

    allcols = list(se.COLUMNS)
    print("导出全部 %d 列：" % len(allcols))
    for layout, out in (("single", os.path.join(d, "all.csv")),
                        ("per_audio", os.path.join(d, "逐音频序列")),
                        ("per_param", os.path.join(d, "分参数序列")),
                        ("xlsx", os.path.join(d, "all.xlsx"))):
        r = se.export_series(d, allcols, method="raw", layout=layout,
                             out_path=out, ext="wav")
        assert r["ok"], (layout, r.get("error"))
        print("  %-10s -> %s  (%d 文件 / %d 行, kind=%s, tsv=%s)"
              % (layout, os.path.basename(r["path"]), r["files"], r["rows"],
                 r["kind"], os.path.basename(r["tsv"] or "-")))

    # 抽检 single 的前两行与表头
    with open(os.path.join(d, "all.csv"), encoding="utf-8-sig") as f:
        head = f.readline().strip()
        l1 = f.readline().strip()
    print("表头列数:", len(head.split(",")))
    c = l1.split(",")
    print("首行: file=%s t=%s F0=%s F4=%s B5=%s H1H2c=%s HNR05=%s CPP=%s intensity=%s soe=%s"
          % (c[0], c[1], c[2], c[6], c[12], c[13], c[19], c[21], c[29], c[30]))
finally:
    shutil.rmtree(d, ignore_errors=True)
    print("（临时目录已删）")
