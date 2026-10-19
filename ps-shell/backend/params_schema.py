# -*- coding: utf-8 -*-
"""praatSauce 参数元数据。

这是整个 GUI 的单一事实源：界面控件、校验规则、预设方案、CSV 生成
全部由这里驱动。字段名必须与 praatsauce 的 params.csv 完全一致。
"""

# ---------------------------------------------------------------- 分组定义

GROUPS = [
    {"id": "io", "name": "文件与输出", "icon": "folder", "tier": "novice",
     "desc": "告诉程序去哪里找声音文件、把结果写到哪里。"},
    {"id": "measures", "name": "要测什么", "icon": "target", "tier": "novice",
     "desc": "勾选你研究需要的参数。不知道选什么就用上面的预设方案。"},
    {"id": "pitch", "name": "基频（F0）设置", "icon": "wave", "tier": "novice",
     "desc": "基频是绝大多数嗓音参数的基础，范围设错了后面全错。"},
    {"id": "formant", "name": "共振峰设置", "icon": "wave", "tier": "novice",
     "desc": "共振峰用于谐波幅度校正，也用于元音研究。"},
    {"id": "textgrid", "name": "标注区间（TextGrid）", "icon": "grid", "tier": "novice",
     "desc": "只测标注过的区间，而不是整个文件。"},
    {"id": "advanced", "name": "进阶设置", "icon": "sliders", "tier": "advanced",
     "desc": "声道选择、采样密度、中间结果复用，以及 Praat 底层算法参数（窗长、阈值、参考值等）。除非你知道自己在改什么，否则保持默认。"},
]

TIERS = [
    {"id": "novice", "name": "新手", "desc": "只显示必须决定的选项"},
    {"id": "advanced", "name": "进阶", "desc": "增加采样密度、声道、中间结果等"},
]

# ---------------------------------------------------------------- 参数定义
# type: dir / file / text / int / number / bool / choice
# tier: novice / advanced

PARAMS = [
    # ---------------- 文件与输出 ----------------
    dict(name="inputDir", label="声音文件目录", type="dir", group="io", tier="novice",
         default="", required=True,
         help="存放 wav 等声音文件的文件夹。程序会处理该文件夹下所有指定扩展名的文件。"),
    dict(name="outputDir", label="结果输出目录", type="dir", group="io", tier="novice",
         default="", required=True,
         help="测量结果表写到哪个文件夹。建议单独建一个 results 文件夹。"),
    dict(name="outputFile", label="结果文件名", type="text", group="io", tier="novice",
         default="out.tsv",
         help="结果表文件名，制表符分隔（tsv），Excel 可直接打开。"),
    dict(name="soundExt", label="声音文件扩展名", type="text", group="io", tier="novice",
         default="wav",
         help="不带点。常见：wav、WAV、flac（Praat 能读的都行）。"),

    # ---------------- 要测什么 ----------------
    dict(name="pitch", label="基频 F0", type="bool", group="measures", tier="novice",
         default=1, cols=["f0"],
         help="基频（音高）轨迹。声调、语调研究必需，也是其他参数的计算基础。"),
    dict(name="formant1", label="F1", type="bool", group="measures", tier="novice",
         default=1, cols=["F1"],
         help="第一共振峰。元音/辅音音色研究核心，也用于谐波幅度的共振峰校正。"),
    dict(name="formant2", label="F2", type="bool", group="measures", tier="novice",
         default=1, cols=["F2"],
         help="第二共振峰。区分元音（如 /i/ 与 /u/）最关键。"),
    dict(name="formant3", label="F3", type="bool", group="measures", tier="novice",
         default=1, cols=["F3"],
         help="第三共振峰。对鼻化、儿化、嗓音音色敏感。"),
    dict(name="formant4", label="F4", type="bool", group="measures", tier="novice",
         default=0, cols=["F4"],
         help="第四共振峰。高元音或高共振峰音色研究时可单独开启。"),
    dict(name="formant5", label="F5", type="bool", group="measures", tier="novice",
         default=0, cols=["F5"],
         help="第五共振峰。一般研究较少用到，可按需只开前几个。"),
    dict(name="ha_h1c", label="H1c", type="bool", group="measures", tier="novice",
         default=1, cols=["H1c"],
         help="H1c 的单列。由「谐波幅度（已校正）」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="ha_h2c", label="H2c", type="bool", group="measures", tier="novice",
         default=1, cols=["H2c"],
         help="H2c 的单列。由「谐波幅度（已校正）」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="ha_h4c", label="H4c", type="bool", group="measures", tier="novice",
         default=1, cols=["H4c"],
         help="H4c 的单列。由「谐波幅度（已校正）」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="ha_a1c", label="A1c", type="bool", group="measures", tier="novice",
         default=1, cols=["A1c"],
         help="A1c 的单列。由「谐波幅度（已校正）」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="ha_a2c", label="A2c", type="bool", group="measures", tier="novice",
         default=1, cols=["A2c"],
         help="A2c 的单列。由「谐波幅度（已校正）」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="ha_a3c", label="A3c", type="bool", group="measures", tier="novice",
         default=1, cols=["A3c"],
         help="A3c 的单列。由「谐波幅度（已校正）」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="harmonicAmplitude", label="谐波幅度（已校正）", type="bool", group="measures", tier="novice",
         default=0, help="内部：是否计算已校正谐波幅度。由 H1c/A1c 等原子列自动合成，界面不显示。", internal=True),
    dict(name="sl_h1h2c", label="H1–H2", type="bool", group="measures", tier="novice",
         default=1, cols=["H1H2c"],
         help="H1–H2 的单列。由「频谱斜率（已校正）」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="sl_h2h4c", label="H2–H4", type="bool", group="measures", tier="novice",
         default=1, cols=["H2H4c"],
         help="H2–H4 的单列。由「频谱斜率（已校正）」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="sl_h1a1c", label="H1–A1", type="bool", group="measures", tier="novice",
         default=1, cols=["H1A1c"],
         help="H1–A1 的单列。由「频谱斜率（已校正）」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="sl_h1a2c", label="H1–A2", type="bool", group="measures", tier="novice",
         default=1, cols=["H1A2c"],
         help="H1–A2 的单列。由「频谱斜率（已校正）」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="sl_h1a3c", label="H1–A3", type="bool", group="measures", tier="novice",
         default=1, cols=["H1A3c"],
         help="H1–A3 的单列。由「频谱斜率（已校正）」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="slope", label="频谱斜率（已校正）", type="bool", group="measures", tier="novice",
         default=0, help="内部：是否计算已校正频谱斜率。由 H1–H2 等原子列自动合成，界面不显示。", internal=True),
    dict(name="cpp", label="CPP 倒谱峰值突显", type="bool", group="measures", tier="novice",
         default=1, cols=["CPP"], pickbox="noise",
         help="衡量谐波结构清晰程度。数值越低，声音越「气」或越粗糙。Praat 逐帧算（cepstral peak prominence，dB），未做平滑。"),
    dict(name="hnr_05", label="HNR 0.5k", type="bool", group="measures", tier="novice",
         default=1, cols=["HNR05"],
         help="HNR 0.5k 的单列。由「HNR 谐噪比」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="hnr_15", label="HNR 1.5k", type="bool", group="measures", tier="novice",
         default=1, cols=["HNR15"],
         help="HNR 1.5k 的单列。由「HNR 谐噪比」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="hnr_25", label="HNR 2.5k", type="bool", group="measures", tier="novice",
         default=1, cols=["HNR25"],
         help="HNR 2.5k 的单列。由「HNR 谐噪比」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="hnr_35", label="HNR 3.5k", type="bool", group="measures", tier="novice",
         default=1, cols=["HNR35"],
         help="HNR 3.5k 的单列。由「HNR 谐噪比」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="hnr_38", label="HNR 3.8k", type="bool", group="measures", tier="novice",
         default=1, cols=["HNR38"],
         help="HNR 3.8k 的单列。由「HNR 谐噪比」组按钮统一开关，也可在展开详情里单独勾选。"
              "0–3800 Hz 频带，是 VoiceSauce 的第五个 HNR 频带（HNR05/15/25/35/38 均为 0 到上界）。"),
    dict(name="hnr", label="HNR 谐噪比", type="bool", group="measures", tier="novice",
         default=0, help="内部：是否计算 HNR 谐噪比。由 HNR 0.5k 等原子列自动合成，界面不显示。", internal=True),
    dict(name="intensity", label="强度（RMS 能量）", type="bool", group="measures", tier="novice",
         default=0, cols=["intensity"], more=True,
         help="每帧的均方根能量，单位 dB。"),
    dict(name="soe", label="SoE 激励强度", type="bool", group="measures", tier="novice",
         default=0, cols=["soe"], more=True,
         help="Strength of Excitation：每个声门闭合瞬间（epoch）激励脉冲的相对幅度，越高＝浊声越强、周期性越好；气声、弱化发声与强构音阻碍都会降低它（Chong 等 2020；Garellek 等 2023）。"),
    dict(name="shr", label="SHR 次谐谐波比", type="bool", group="measures", tier="advanced",
         default=0, cols=["SHR"],
         help="基于 Sun (2002) 算法：量化次谐波与谐波幅度比，对周期加倍/气泡嗓音敏感。"),
    dict(name="cpps", label="CPPS 标准平滑倒谱峰值突显", type="bool", group="measures", tier="advanced",
         default=0, cols=["CPPS"],
         help="Praat 标准算法（Maryn & Weenink 2015 / ps_get_CPPS.praat）：先对倒谱做时间 0.01s + 倒频 0.001s 二维平滑、再逐帧取峰（Straight/Robust）。独立于 CPP 开关，输出逐帧 CPPS 列。⚠ 与 2026-09-27 之前的旧 CPPS 列（Python 对 CPP 轮廓滑动平均）算法不同，绝对值不可混比；平滑削峰，通常比 CPP 低几 dB。"),

    # ---------------- 基频 ----------------
    dict(name="f0min", label="基频下限", type="number", group="pitch", tier="novice",
         default=50, unit="Hz", min=20, max=1000, step=5,
         help="预期最低基频。设太低会把噪声当基频，设太高会丢失低音。"),
    dict(name="f0max", label="基频上限", type="number", group="pitch", tier="novice",
         default=400, unit="Hz", min=50, max=2000, step=5,
         help="预期最高基频。女声常用 300–350 Hz 的余量设 400；男声 250 足够。通常取下限的 3–4 倍。"),

    # ---------------- 共振峰 ----------------
    dict(name="maxNumFormants", label="共振峰个数", type="int", group="formant", tier="novice",
         default=5, min=3, max=8, step=1,
         help="每次分析找几个共振峰（至少 3 个）。元音 [u] 较多时可提高到 6。"),
    dict(name="maxFormantHz", label="共振峰频率上限", type="number", group="formant", tier="novice",
         default=5000, unit="Hz", min=2000, max=11000, step=100,
         help="在这个频率以下寻找共振峰。男声一般 5000，女声/儿童建议 5500。"),

    # ---------------- TextGrid ----------------
    dict(name="useTextGrid", label="使用 TextGrid 限定测量区间", type="bool", group="textgrid", tier="novice",
         default=0,
         help="勾选后只测量标注区间内的部分；不勾选则测整个声音文件。"),
    dict(name="tgDir", label="TextGrid 目录", type="dir", group="textgrid", tier="novice",
         default="", depends_on="useTextGrid",
         help="存放 .TextGrid 文件的文件夹。留空表示与声音文件同目录。"),
    dict(name="intervalTier", label="标注层序号", type="int", group="textgrid", tier="novice",
         default=1, min=1, max=20, depends_on="useTextGrid",
         help="读取第几层区间层（Tier）。第一层填 1。"),

    # ---------------- 进阶 ----------------
    dict(name="channel", label="声道", type="choice", group="advanced", tier="advanced",
         default=1, choices=[(1, "第 1 声道（左）"), (2, "第 2 声道（右）"), (0, "保持立体声")],
         help="只分析某一个声道时选择；立体声录音选 1。"),
    dict(name="intervalMode", label="测量间隔方式", type="choice", group="advanced", tier="advanced",
         default=0, shell_only=True,
         choices=[(0, "固定步长：每隔固定秒数测一点"), (1, "等分点数：每个区间取 N 个点")],
         help="两种取点方式二选一。没被选中的那个数值框不参与计算（运行时自动按 0 处理）。"),
    dict(name="intervalFixed", label="固定测量步长", type="number", group="advanced", tier="advanced",
         default=0.005, unit="秒", min=0, max=1, step=0.001, decimals=4,
         depends_on="intervalMode:0",
         help="每隔多少秒测一个点。0.005 表示 5 毫秒一个点（即 200 Hz 采样率）。仅「固定步长」方式下生效。"),
    dict(name="intervalEquidistant", label="等距取点数", type="int", group="advanced", tier="advanced",
         default=0, min=0, max=1000, depends_on="intervalMode:1",
         help="把每个区间等分成 N 份，只取这 N 个点。填 10 表示每个区间取 10 个点。仅「等分点数」方式下生效。"),
    dict(name="resample16kHz", label="先降采样到 16 kHz", type="bool", group="advanced", tier="advanced",
         default=0,
         help="统一采样率可提升速度、避免不同录音设备带来的差异。会临时处理，不改动原文件。"),
    dict(name="hau_h1u", label="H1u", type="bool", group="measures", tier="advanced",
         default=1, cols=["H1u"],
         help="H1u 的单列。由「谐波幅度（未校正）」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="hau_h2u", label="H2u", type="bool", group="measures", tier="advanced",
         default=1, cols=["H2u"],
         help="H2u 的单列。由「谐波幅度（未校正）」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="hau_h4u", label="H4u", type="bool", group="measures", tier="advanced",
         default=1, cols=["H4u"],
         help="H4u 的单列。由「谐波幅度（未校正）」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="hau_a1u", label="A1u", type="bool", group="measures", tier="advanced",
         default=1, cols=["A1u"],
         help="A1u 的单列。由「谐波幅度（未校正）」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="hau_a2u", label="A2u", type="bool", group="measures", tier="advanced",
         default=1, cols=["A2u"],
         help="A2u 的单列。由「谐波幅度（未校正）」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="hau_a3u", label="A3u", type="bool", group="measures", tier="advanced",
         default=1, cols=["A3u"],
         help="A3u 的单列。由「谐波幅度（未校正）」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="hau_h2ku", label="H2Ku", type="bool", group="measures", tier="advanced",
         default=1, cols=["H2Ku"],
         help="H2Ku 的单列。由「谐波幅度（未校正）」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="hau_h5ku", label="H5Ku", type="bool", group="measures", tier="advanced",
         default=1, cols=["H5Ku"],
         help="H5Ku 的单列。由「谐波幅度（未校正）」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="harmonicAmplitudeUncorrected", label="谐波幅度（未校正）", type="bool", group="measures", tier="advanced",
         default=0, help="内部：是否计算未校正谐波幅度。由 H1u/A1u 等原子列自动合成，界面不显示。", internal=True),
    dict(name="slu_h1h2u", label="H1–H2（未校正）", type="bool", group="measures", tier="advanced",
         default=0, cols=["H1H2u"],
         help="H1–H2（未校正） 的单列。由「频谱斜率（未校正）」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="slu_h2h4u", label="H2–H4（未校正）", type="bool", group="measures", tier="advanced",
         default=0, cols=["H2H4u"],
         help="H2–H4（未校正） 的单列。由「频谱斜率（未校正）」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="slu_h1a1u", label="H1–A1（未校正）", type="bool", group="measures", tier="advanced",
         default=0, cols=["H1A1u"],
         help="H1–A1（未校正） 的单列。由「频谱斜率（未校正）」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="slu_h1a2u", label="H1–A2（未校正）", type="bool", group="measures", tier="advanced",
         default=0, cols=["H1A2u"],
         help="H1–A2（未校正） 的单列。由「频谱斜率（未校正）」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="slu_h1a3u", label="H1–A3（未校正）", type="bool", group="measures", tier="advanced",
         default=0, cols=["H1A3u"],
         help="H1–A3（未校正） 的单列。由「频谱斜率（未校正）」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="slu_h2kh5ku", label="H2K–H5K（未校正）", type="bool", group="measures", tier="advanced",
         default=0, cols=["H2KH5Ku"],
         help="H2K–H5K（未校正） 的单列。由「频谱斜率（未校正）」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="sl_h42ku", label="H4–2K（未校正）", type="bool", group="measures", tier="advanced",
         default=0, cols=["H4-2Ku"],
         help="H4 与最接近 2 kHz 的谐波之振幅差（VoiceSauce 的 H4*–2K*）。本脚本不校正 2K 谐波，"
              "因此只有未校正版。由「频谱斜率（已校正）」组按钮统一开关，也可在展开详情里单独勾选。"),
    dict(name="slopeUncorrected", label="频谱斜率（未校正）", type="bool", group="measures", tier="advanced",
         default=0, help="内部：是否计算未校正频谱斜率。由 H1–H2（未校正）等原子列自动合成，界面不显示。", internal=True),
    dict(name="bw1", label="B1", type="bool", group="advanced", tier="advanced",
         default=0, cols=["B1"],
         help="F1 带宽（Hz）。需开启共振峰测量。"),
    dict(name="bw2", label="B2", type="bool", group="advanced", tier="advanced",
         default=0, cols=["B2"],
         help="F2 带宽（Hz）。需开启共振峰测量。"),
    dict(name="bw3", label="B3", type="bool", group="advanced", tier="advanced",
         default=0, cols=["B3"],
         help="F3 带宽（Hz）。需开启共振峰测量。"),
    # 以下两个是「内部总开关」：界面不直接显示，由 F1–F5 / B1–B3 的独立勾选在
    # _prepare 里通过 derive_formant_flags 自动合成，供 praatSauce 脚本判断是否计算共振峰。
    dict(name="formant", label="共振峰（计算总开关）", type="bool", group="measures", tier="novice",
         default=0,
         help="内部：是否计算共振峰。由 F1–F5 的独立勾选自动合成，界面不显示。", internal=True),
    dict(name="bw", label="带宽（计算总开关）", type="bool", group="advanced", tier="advanced",
         default=0,
         help="内部：是否计算共振峰带宽。由 B1–B3 的独立勾选自动合成。", internal=True),
    dict(name="bwHawksMiller", label="用 Hawks–Miller 公式估算带宽", type="bool", group="advanced", tier="advanced",
         default=1,
         help="勾选时用 Hawks–Miller 经验公式估算带宽；不勾选则用 Praat 实测带宽（需要开启共振峰测量）。"),
    dict(name="pitchSave", label="保存 Pitch 中间文件", type="bool", group="advanced", tier="advanced",
         default=1,
         help="把基频对象存成 .Pitch 文件（目录留空时存到输入目录的 measure 子目录），下次可直接复用；也便于排查中间结果。"),
    dict(name="pitchSaveDir", label="Pitch 保存目录", type="dir", group="advanced", tier="advanced",
         default="", depends_on="pitchSave",
         help=".Pitch 文件保存位置。留空 = 输入目录的 measure 子目录。"),
    dict(name="pitchRead", label="复用已有 Pitch 文件", type="bool", group="advanced", tier="advanced",
         default=1,
         help="勾选后优先读取已有 .Pitch 文件（手工修正过的基频常用此法）；目录留空 = 输入目录的 measure 子目录。文件缺失时自动改为本批重算并存盘，不会中断。"),
    dict(name="pitchReadDir", label="Pitch 读取目录", type="dir", group="advanced", tier="advanced",
         default="", depends_on="pitchRead",
         help="已有 .Pitch 文件所在目录。留空 = 输入目录的 measure 子目录。"),
    dict(name="formantSave", label="保存 Formant 中间文件", type="bool", group="advanced", tier="advanced",
         default=1, help="把共振峰对象存成 .Formant 文件（目录留空时存到输入目录的 measure 子目录），供第四步九宫格/详情直接复用。"),
    dict(name="formantSaveDir", label="Formant 保存目录", type="dir", group="advanced", tier="advanced",
         default="", depends_on="formantSave", help=".Formant 文件保存位置。留空 = 输入目录的 measure 子目录。"),
    dict(name="formantRead", label="复用已有 Formant 文件", type="bool", group="advanced", tier="advanced",
         default=1, help="勾选后优先读取已有 .Formant 文件；文件缺失时自动改为本批重算并存盘，不会中断。注意：改共振峰参数重跑前需先删旧 .Formant，否则静默用旧结果。目录留空 = 输入目录的 measure 子目录。"),
    dict(name="formantReadDir", label="Formant 读取目录", type="dir", group="advanced", tier="advanced",
         default="", depends_on="formantRead", help="已有 .Formant 文件所在目录。留空 = 输入目录的 measure 子目录。"),

    # ---------------- 专家 ----------------
    dict(name="windowLength", label="分析窗长", type="number", group="advanced", tier="advanced",
         default=0.025, unit="秒", min=0.005, max=0.1, step=0.001, decimals=4,
         help="共振峰分析的高斯窗宽度。基频偏低时可适当加长。"),
    dict(name="pitchMethod", label="基频算法", type="choice", group="advanced", tier="advanced",
         default=0, choices=[(0, "滤波自相关（Praat 默认）"), (1, "原始互相关")],
         help="滤波自相关对大多数录音效果更好。"),
    dict(name="pitchWindowShape", label="基频窗形", type="choice", group="advanced", tier="advanced",
         default=0, choices=[(0, "Hanning"), (1, "Gaussian")],
         help="分析窗形状，默认 Hanning。"),
    dict(name="pitchMaxNoCandidates", label="最大基频候选数", type="int", group="advanced", tier="advanced",
         default=15, min=1, max=50,
         help="自相关保留的候选峰个数。嗓音质量差时可适当增加。"),
    dict(name="silenceThreshold", label="静音阈值", type="number", group="advanced", tier="advanced",
         default=0.01, min=0, max=1, step=0.001, decimals=4,
         help="相对强度低于此值视为静音。数值越大，越多部分被当作静音。"),
    dict(name="voicingThreshold", label="浊音阈值", type="number", group="advanced", tier="advanced",
         default=0, min=0, max=1, step=0.01, decimals=3,
         help="0 表示由程序按算法自动设定（0.5 或 0.45）。数值越高，被判为浊音的部分越少。"),
    dict(name="octaveCost", label="高音偏好（octave cost）", type="number", group="advanced", tier="advanced",
         default=0, min=0, max=1, step=0.001, decimals=4,
         help="0 表示自动。数值越高越倾向选择更高的基频。"),
    dict(name="octaveJumpCost", label="音程突变代价", type="number", group="advanced", tier="advanced",
         default=0.35, min=0, max=1, step=0.01, decimals=3,
         help="数值越高越拒绝基频的八度跳变。跳八度严重时可提高到 0.5。"),
    dict(name="voicedUnvoicedCost", label="清浊转换代价", type="number", group="advanced", tier="advanced",
         default=0.14, min=0, max=1, step=0.01, decimals=3,
         help="数值越高，清浊切换越少（曲线更平滑）。"),
    dict(name="killOctaveJumps", label="强制去除八度跳变", type="bool", group="advanced", tier="advanced",
         default=0,
         help="让 Praat 直接抹平八度跳变。慎用，可能掩盖真实问题。"),
    dict(name="preEmphFrom", label="预加重起始频率", type="number", group="advanced", tier="advanced",
         default=50, unit="Hz", min=0, max=1000,
         help="共振峰分析时的预加重起点。"),
    dict(name="f1ref", label="F1 参考值", type="number", group="advanced", tier="advanced",
         default=500, unit="Hz", min=100, max=2000, help="谐波校正用的 F1 参考值。"),
    dict(name="f2ref", label="F2 参考值", type="number", group="advanced", tier="advanced",
         default=1500, unit="Hz", min=500, max=4000, help="谐波校正用的 F2 参考值。"),
    dict(name="f3ref", label="F3 参考值", type="number", group="advanced", tier="advanced",
         default=2500, unit="Hz", min=1000, max=6000, help="谐波校正用的 F3 参考值。"),
    dict(name="pitchSynchronous", label="基频同步窗（频谱测量）", type="bool", group="advanced", tier="advanced",
         default=0,
         help="勾选后频谱测量按基频周期同步开窗，精度更高但更慢。"),
    dict(name="cppTrendType", label="CPP 趋势线类型", type="choice", group="advanced", tier="advanced",
         default=0, choices=[(0, "指数衰减"), (1, "线性")],
         help="计算 CPP 时如何拟合倒谱趋势。"),
    dict(name="cppFast", label="CPP 快速模式", type="bool", group="advanced", tier="advanced",
         default=1,
         help="速度更快、精度略低。取消勾选更精确但慢很多。"),
    dict(name="filelist", label="文件清单（只处理清单中的文件）", type="file", group="advanced", tier="advanced",
         default="0",
         help="一个纯文本文件，每行一个文件名（不含路径）。留 0 表示处理整个目录。"),
    dict(name="includeTheseLabels", label="要处理的标注（正则）", type="text", group="advanced", tier="advanced",
         default=r"^(?!\s*$).+", depends_on="useTextGrid",
         help="只处理标签匹配该正则的区间。默认跳过空白标签。"),
    dict(name="verbose", label="输出运行日志", type="bool", group="advanced", tier="advanced",
         default=1,
         help="在日志窗口显示每个文件的处理进度。"),
]

BY_NAME = {p["name"]: p for p in PARAMS}

# ---------------------------------------------------------------- 预设方案

PRESETS = [
    {
        "id": "tone",
        "name": "声调 / 语调",
        "icon": "wave",
        "tagline": "只要基频曲线",
        "desc": "用于声调、语调、音高研究。只输出 F0，速度最快。",
        "values": {"pitch": 1, "formant1": 0, "formant2": 0, "formant3": 0, "formant4": 0, "formant5": 0,
                   "ha_h1c":0,"ha_h2c":0,"ha_h4c":0,"ha_a1c":0,"ha_a2c":0,"ha_a3c":0, "sl_h1h2c":0,"sl_h2h4c":0,"sl_h1a1c":0,"sl_h1a2c":0,"sl_h1a3c":0, "sl_h42ku":0,
                   "cpp": 0, "hnr_05":0,"hnr_15":0,"hnr_25":0,"hnr_35":0,"hnr_38":0, "intensity": 0, "soe": 0,
                   "hau_h1u":0,"hau_h2u":0,"hau_h4u":0,"hau_a1u":0,"hau_a2u":0,"hau_a3u":0,"hau_h2ku":0,"hau_h5ku":0, "slu_h1h2u":0,"slu_h2h4u":0,"slu_h1a1u":0,"slu_h1a2u":0,"slu_h1a3u":0,"slu_h2kh5ku":0,
                   "bw1": 0, "bw2": 0, "bw3": 0, "bwHawksMiller": 0},
    },
    {
        "id": "vowel",
        "name": "元音 / 共振峰",
        "icon": "target",
        "tagline": "F1 F2 F3 + F0",
        "desc": "用于元音空间、元音共振峰轨迹研究。",
        "values": {"pitch": 1, "formant1": 1, "formant2": 1, "formant3": 1, "formant4": 0, "formant5": 0,
                   "ha_h1c":0,"ha_h2c":0,"ha_h4c":0,"ha_a1c":0,"ha_a2c":0,"ha_a3c":0, "sl_h1h2c":0,"sl_h2h4c":0,"sl_h1a1c":0,"sl_h1a2c":0,"sl_h1a3c":0, "sl_h42ku":0,
                   "cpp": 0, "hnr_05":0,"hnr_15":0,"hnr_25":0,"hnr_35":0,"hnr_38":0, "intensity": 0, "soe": 0,
                   "hau_h1u":0,"hau_h2u":0,"hau_h4u":0,"hau_a1u":0,"hau_a2u":0,"hau_a3u":0,"hau_h2ku":0,"hau_h5ku":0, "slu_h1h2u":0,"slu_h2h4u":0,"slu_h1a1u":0,"slu_h1a2u":0,"slu_h1a3u":0,"slu_h2kh5ku":0,
                   "bw1": 0, "bw2": 0, "bw3": 0, "bwHawksMiller": 0},
    },
    {
        "id": "phonation",
        "name": "嗓音 / 发声态",
        "icon": "activity",
        "tagline": "H1-H2、H1-A1、CPP、HNR",
        "desc": "气嗓音、紧喉音、发声态对比的常用组合：H1–H2 / H1–A1 等谐波差、CPP 倒谱峰值突显、HNR 谐噪比，需要基频与共振峰做校正。强度（RMS）、SoE、带宽（B1/B2/B3）与 CPPS、SHR 等进阶指标收进「更多参数」，按需再开。",
        "values": {"pitch": 1, "formant1": 1, "formant2": 1, "formant3": 1, "formant4": 0, "formant5": 0,
                   "ha_h1c":1,"ha_h2c":1,"ha_h4c":1,"ha_a1c":1,"ha_a2c":1,"ha_a3c":1, "sl_h1h2c":1,"sl_h2h4c":1,"sl_h1a1c":1,"sl_h1a2c":1,"sl_h1a3c":1, "sl_h42ku":0,
                   "cpp": 1, "hnr_05":1,"hnr_15":1,"hnr_25":1,"hnr_35":1,"hnr_38":1, "intensity": 0, "soe": 0,
                   "hau_h1u":1,"hau_h2u":1,"hau_h4u":1,"hau_a1u":1,"hau_a2u":1,"hau_a3u":1,"hau_h2ku":1,"hau_h5ku":1, "slu_h1h2u":1,"slu_h2h4u":1,"slu_h1a1u":1,"slu_h1a2u":1,"slu_h1a3u":1,"slu_h2kh5ku":1},
    },
    {
        "id": "all",
        "name": "全部参数",
        "icon": "layers",
        "tagline": "55 项全开",
        "desc": "输出所有可用指标。文件多时很慢，建议先小样本试跑。",
        "values": {"pitch": 1, "formant1": 1, "formant2": 1, "formant3": 1, "formant4": 1, "formant5": 1,
                   "ha_h1c":1,"ha_h2c":1,"ha_h4c":1,"ha_a1c":1,"ha_a2c":1,"ha_a3c":1, "sl_h1h2c":1,"sl_h2h4c":1,"sl_h1a1c":1,"sl_h1a2c":1,"sl_h1a3c":1, "sl_h42ku":1,
                   "cpp": 1, "hnr_05":1,"hnr_15":1,"hnr_25":1,"hnr_35":1,"hnr_38":1, "intensity": 1, "soe": 1,
                   "shr": 1, "cpps": 1,
                   "hau_h1u":1,"hau_h2u":1,"hau_h4u":1,"hau_a1u":1,"hau_a2u":1,"hau_a3u":1,"hau_h2ku":1,"hau_h5ku":1, "slu_h1h2u":1,"slu_h2h4u":1,"slu_h1a1u":1,"slu_h1a2u":1,"slu_h1a3u":1,"slu_h2kh5ku":1,
                   "bw1": 1, "bw2": 1, "bw3": 1, "bwHawksMiller": 1, "filelist": "0"},
    },
]

# 发音人预设：影响基频范围和共振峰上限
SPEAKER_PRESETS = [
    {"id": "male", "name": "成年男声", "f0min": 50, "f0max": 250, "maxFormantHz": 5000},
    {"id": "female", "name": "成年女声", "f0min": 100, "f0max": 400, "maxFormantHz": 5500},
    {"id": "child", "name": "儿童", "f0min": 150, "f0max": 450, "maxFormantHz": 5500},
    {"id": "custom", "name": "自定义", "f0min": 50, "f0max": 400, "maxFormantHz": 5000},
]

MEASURE_FLAGS = ["pitch", "formant1", "formant2", "formant3", "formant4", "formant5",
                 "ha_h1c", "ha_h2c", "ha_h4c", "ha_a1c", "ha_a2c", "ha_a3c",
                 "hau_h1u", "hau_h2u", "hau_h4u", "hau_a1u", "hau_a2u", "hau_a3u", "hau_h2ku", "hau_h5ku",
                 "sl_h1h2c", "sl_h2h4c", "sl_h1a1c", "sl_h1a2c", "sl_h1a3c", "sl_h42ku",
                 "slu_h1h2u", "slu_h2h4u", "slu_h1a1u", "slu_h1a2u", "slu_h1a3u", "slu_h2kh5ku",
                 "bw1", "bw2", "bw3", "cpp",
                 "hnr_05", "hnr_15", "hnr_25", "hnr_35", "hnr_38",
                 "intensity", "soe", "shr", "cpps"]

# 共振峰/带宽按列拆分后，给「脚本总开关 + 计算数量」合成用的辅助集合
FORMANT_PARAMS = ["formant1", "formant2", "formant3", "formant4", "formant5"]
BW_PARAMS = ["bw1", "bw2", "bw3"]
HARMONIC_C = ["ha_h1c", "ha_h2c", "ha_h4c", "ha_a1c", "ha_a2c", "ha_a3c"]
HARMONIC_U = ["hau_h1u", "hau_h2u", "hau_h4u", "hau_a1u", "hau_a2u", "hau_a3u", "hau_h2ku", "hau_h5ku"]
SLOPE_C = ["sl_h1h2c", "sl_h2h4c", "sl_h1a1c", "sl_h1a2c", "sl_h1a3c", "sl_h42ku"]
SLOPE_U = ["slu_h1h2u", "slu_h2h4u", "slu_h1a1u", "slu_h1a2u", "slu_h1a3u", "slu_h2kh5ku"]
HNR_PARAMS = ["hnr_05", "hnr_15", "hnr_25", "hnr_35", "hnr_38"]


def any_formant(values):
    return any(_truthy(values.get(n, 0)) for n in FORMANT_PARAMS)


def any_bw(values):
    return any(_truthy(values.get(n, 0)) for n in BW_PARAMS)


def selected_formant_max(values):
    """已勾选的最大共振峰序号（没勾返回 0）。用于决定 maxNumFormants 下限。"""
    mx = 0
    for n in FORMANT_PARAMS:
        if _truthy(values.get(n, 0)):
            mx = max(mx, int(n[-1]))
    return mx


def derive_formant_flags(values):
    """为 praatSauce 脚本合成 ``formant`` / ``bw`` 总开关与 ``maxNumFormants``。

    脚本按旧的 ``formant``/``bw``/``maxNumFormants`` 三个键决定算不算、算几个共振峰；
    界面拆成 F1–F5 / B1–B3 独立勾选后，这里把它们聚合成脚本要的总开关，
    并让 maxNumFormants 不低于已勾选的最大序号（Praat 要求至少 3）。
    已校谐波幅度/斜率需要共振峰做校正，勾了它们也得算共振峰。
    """
    v = dict(values)
    # 先派生隐藏总开关，再据此算 formant/bw：否则只勾 H1–H2 等斜率类、不勾
    # F1–F5 时，need 看到的是派生前的旧值（0），formant=0 而 slope=1 →
    # Praat 不算共振峰却要做校正，结果静默错误。
    v["harmonicAmplitude"] = 1 if any(_truthy(v.get(n, 0)) for n in HARMONIC_C + SLOPE_C) else 0  # 斜率依赖 H1/H2，需先算谐波幅度
    v["harmonicAmplitudeUncorrected"] = 1 if any(_truthy(v.get(n, 0)) for n in HARMONIC_U + SLOPE_U) else 0  # 未校正斜率依赖未校正 H1/H2
    v["slope"] = 1 if any(_truthy(v.get(n, 0)) for n in SLOPE_C) else 0
    v["slopeUncorrected"] = 1 if any(_truthy(v.get(n, 0)) for n in SLOPE_U) else 0
    v["hnr"] = 1 if any(_truthy(v.get(n, 0)) for n in HNR_PARAMS) else 0
    need = (any_formant(v) or _truthy(v.get("harmonicAmplitude", 0))
            or _truthy(v.get("slope", 0)))
    v["formant"] = 1 if need else 0
    v["bw"] = 1 if any_bw(v) else 0
    cur = int(_to_int(v.get("maxNumFormants", BY_NAME["maxNumFormants"]["default"])) or 0)
    v["maxNumFormants"] = max(cur, selected_formant_max(v), 3)
    return v


def normalize_legacy_formants(values):
    """旧版用 ``formant``/``bw`` 总开关；迁移到 per-formant 选择。

    仅在缺少 per-formant 键时生效（用旧档时会把总开关的值摊到每个 F/B 上），
    不覆盖已经存在的 per-formant 选择。
    """
    v = dict(values)
    if "formant1" not in v and "formant" in v:
        fv = 1 if _truthy(v.get("formant")) else 0
        for n in FORMANT_PARAMS:
            v.setdefault(n, fv)
    if "bw1" not in v and "bw" in v:
        bv = 1 if _truthy(v.get("bw")) else 0
        for n in BW_PARAMS:
            v.setdefault(n, bv)
    if "ha_h1c" not in v and "harmonicAmplitude" in v:
        fv = 1 if _truthy(v.get("harmonicAmplitude")) else 0
        for n in HARMONIC_C: v.setdefault(n, fv)
    if "hau_h1u" not in v and "harmonicAmplitudeUncorrected" in v:
        fv = 1 if _truthy(v.get("harmonicAmplitudeUncorrected")) else 0
        for n in HARMONIC_U: v.setdefault(n, fv)
    if "sl_h1h2c" not in v and "slope" in v:
        fv = 1 if _truthy(v.get("slope")) else 0
        for n in SLOPE_C: v.setdefault(n, fv)
    if "slu_h1h2u" not in v and "slopeUncorrected" in v:
        fv = 1 if _truthy(v.get("slopeUncorrected")) else 0
        for n in SLOPE_U: v.setdefault(n, fv)
    if "hnr_05" not in v and "hnr" in v:
        fv = 1 if _truthy(v.get("hnr")) else 0
        for n in HNR_PARAMS: v.setdefault(n, fv)
    return v


def _to_int(v, default=0):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def default_values():
    return {p["name"]: p.get("default") for p in PARAMS}


def output_columns(values):
    """根据勾选的测量项，预测结果表里会有哪些列。"""
    cols = ["file", "t"]
    for p in PARAMS:
        if p.get("cols") and _truthy(values.get(p["name"], p.get("default"))):
            cols.extend(p["cols"])
    if _truthy(values.get("useTextGrid", 0)):
        cols.extend(["label", "intervalID"])
    return cols


def _truthy(v):
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0
    if isinstance(v, str):
        return v.strip() not in ("", "0", "false", "False")
    return bool(v)


def visible_params(tier):
    order = {"novice": 0, "advanced": 1}
    limit = order.get(tier, 0)
    return [p for p in PARAMS if order.get(p["tier"], 0) <= limit]
