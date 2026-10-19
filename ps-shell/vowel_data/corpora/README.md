# vowel_data/corpora — 元音共振峰参考语料存档

本目录存放**原始参考语料**，与运行时完全分离（运行时只读 `backend/vowel_ref.json`，绝不碰本目录）。
用途：为 `vowel_ref.json` 提供交叉验证与扩充的数据来源，"以后可能有用"。

> 重要：这里放的是**外部语料原始文件**，不是程序的一部分。改参考值请编辑 `vowel_data/sources.json` 后重跑 `vowel_data/build_vowel_ref.py`，不要直接改运行时记录。

## 已下载 vs. 仅记录

| 语料 | 是否下载到本目录 | 状态 / 说明 |
|------|----------------|------------|
| **VoxCommunis** (Ahn & Chodroff 2022, CC0) | ✅ 已下载（精简参考集 ~2 MB） | 见 `VoxCommunis/README.md`。原始的逐帧大文件（formants_cv7 2.5 GB、spkr_files 3.75 GB）未下载，但已在 README 中给出精确 OSF 路径，需要时再拉。 |
| **Iivonen (1991)** 共振峰库 | ❌ 未下载 | 出版物（约 20 种语言的汇总库），无公开可下载文件。见 `REFERENCES.md`。 |
| **Becker-Kristal (2010)** | ❌ 未下载 | UCLA 博士论文；304 套归一化共振峰语料本身不是官方开放文件，仅有个别研究者代码仓里的衍生 CSV。见 `REFERENCES.md`。 |
| **汉语各方言实测** | ❌ 未下载 | 散见于论文，无单一可下载共振峰数据集；大型 ASR 语料（WenetSpeech-Wu/Yue）不直接提供共振峰。见 `REFERENCES.md`。 |

## 目录结构
```
corpora/
├── README.md                 # 本文件
├── REFERENCES.md             # 三个未下载语料的出处、许可、获取方式
└── VoxCommunis/
    ├── README.md             # 已下载内容、许可、大文件获取路径、校验和
    ├── voxcommunis_vowel_averages.csv          # 36 语言 × 各元音 F1/F2 均值（高/低四分位 + N）
    ├── voxcommunis_vowel_averages_231117.csv   # 同上，较早快照
    ├── voxcommunis_vowel_plots.R               # 官方画图脚本
    └── formants_narrow/       # 10 种语言的逐说话人逐元音 F1/F2 均值 TSV
```

## 未来如何并入参考值
`voxcommunis_vowel_averages.csv` 已含 36 语言各元音的 F1/F2 均值与样本量 N。
若要扩充 `vowel_ref.json`，可写一个小脚本：按元音 IPA 符号归并、按性别（Common Voice 含说话人性别字段需另从 spkr_files 取）或整体求平均，
把结果并入 `vowel_data/sources.json` 的对应元音条目，再重跑 `build_vowel_ref.py` 重建运行时记录。
注意：VoxCommunis 的精简均值只含 F1/F2（无 F3），且是跨性别混合均值，不能直接替代现有 male/female/general 三分结构，需谨慎合并。
