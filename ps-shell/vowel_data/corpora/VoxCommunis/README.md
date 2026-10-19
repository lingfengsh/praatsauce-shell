# VoxCommunis 语料存档（已下载精简参考集）

**来源**：Ahn, Emily P. & Eleanor Chodroff (2022). *VoxCommunis: A Corpus for Cross-linguistic Phonetic Analysis.* LREC 2022, pp. 5286–5294.
**许可**：CC0 1.0（完全自由使用，含商用）。
**官方地址**：
- OSF 项目页：<https://osf.io/t957v/>（含文件树与直接下载）
- HuggingFace 镜像：<https://huggingface.co/datasets/pacscilab/VoxCommunis>

## 语料概况
基于 Mozilla Common Voice 7.0，覆盖 **36 种语言**，多数语言有数十~数百名说话人。
提供 F1–F4 共振峰（来自各元音四分位的声学测量）。本目录只保留了**最精简、对参考最有用的汇总文件**，未拉取庞大的逐帧/对齐原始数据。

## 本目录已下载的文件

| 文件 | 大小 | 内容 |
|------|------|------|
| `voxcommunis_vowel_averages.csv` | 56 KB | 36 语言 × 各元音（含长元音/鼻化等变体）的 F1/F2 均值。列：`lang, vowel, setting(high/low), meanf1hz, meanf2hz, meanf1erb, meanf2erb, total(N)`。680 行。 |
| `voxcommunis_vowel_averages_231117.csv` | 55 KB | 同上，较早快照（2023-11-17），留作对照。 |
| `voxcommunis_vowel_plots.R` | 4.8 KB | 官方 R 画图脚本（画元音图用）。 |
| `formants_narrow/*.tsv` | ~2 MB（10 个语言） | 逐说话人逐元音 F1/F2 均值。列：`spkr, setting, vowel, mean_f1, mean_f2, V_count_spkr`。语言：armenian, dutch, greek, hungarian, italian, kazakh, tatar, turkish, uzbek, abkhaz。 |

> 注：`setting` 为 high/low 四分位；`total`/`V_count_spkr` 为样本量。这些值跨性别混合，且只有 F1/F2（无 F3/F4）。

## 校验和（sha256 前 16 位，2026-09-25 下载）
```
voxcommunis_vowel_averages.csv          c6361d78c6bb1186
voxcommunis_vowel_averages_231117.csv   80ddb04958f6e114
voxcommunis_vowel_plots.R               9ad48e7bdcbe539c
formants_narrow/abkhaz_avg_formants.tsv 96aa6d6410cbf838
formants_narrow/armenian_avg_formants.tsv 19d958649c46ddb4
formants_narrow/dutch_avg_formants.tsv   6a918b107ed58c54
formants_narrow/greek_avg_formants.tsv    81463b66ebf15cab
formants_narrow/hungarian_avg_formants.tsv cd0e444f38e85501
formants_narrow/italian_avg_formants.tsv   f6fd6ca85e8b1717
formants_narrow/kazakh_avg_formants.tsv   81edd0180a1b8e66
formants_narrow/tatar_avg_formants.tsv     f0d6e644c11762df
formants_narrow/turkish_avg_formants.tsv   0348ed662ab9ba07
formants_narrow/uzbek_avg_formants.tsv     82765e70ad9f5fa0
```

## 未下载但可获取的大文件（同一 OSF 节点，按需再拉）
这些文件体积大、且本工具暂不需要，故未下载；如未来要逐帧数据或说话人级性别/F3/F4，可到 OSF 节点 `t957v` 直接下载：

| OSF 路径（节点内） | 体积 | 说明 |
|-------------------|------|------|
| `formants_cv7/` | ~2.5 GB | 36 语言逐帧 F1–F4 CSV（按语言分文件，如 `italian_formants_low4.csv` 1.5 GB）。 |
| `spkr_files/` | ~3.75 GB | 逐说话人的词/音素级对齐 + 共振峰 TSV（含说话人性别等元信息，可分语言/说话人拉取）。 |
| `textgrids/` | 大 | 文本网格标注。 |
| `lexicons/` | 中 | 发音词典。 |
| `acoustic_models/` | 大 | 声学模型。 |

获取方式示例（OSF 直接下载链接，单个文件）：
1. 用 OSF API 列文件：`GET https://api.osf.io/v2/nodes/t957v/files/osfstorage/<文件夹id>/`
2. 取每个文件的 `links.download`，用支持重定向的下载器抓取（见 `../README.md` 顶部说明）。
