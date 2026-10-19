# vowel_data —— 元音共振峰参考库（源）

## 这个目录是什么

本目录是**元音共振峰参考数据的"原始库"**，与程序运行时**分离**：

- `sources.json` —— 权威参考源：28 个元音的 F1/F2/F3（男/女/通用，均值±SD），
  每条都带 `source` 文献依据。**这是给人/给编辑看的库本体。**
- `build_vowel_ref.py` —— 一次性生成器：读 `sources.json`，剥掉文献标签，
  写出运行时用的精简记录 `../backend/vowel_ref.json`。
- `_make_sources.py` —— 引导脚本（仅在 `sources.json` 丢失、需从旧记录重建时用）。
  正常情况下**不要跑它**——直接编辑 `sources.json` 即可。

## 为什么单独放

用户要求：下载/汇集来的元音数据**不要整库塞进程序**；程序只需"用库算好各元音的大致
范围并记录下来"，之后运行时**不必再访问原始库**。

所以职责划分是：

| 文件 | 角色 | 运行时是否加载 |
|------|------|----------------|
| `vowel_data/sources.json` | 带出处的参考库（原始） | **否** |
| `backend/vowel_ref.json` | 精简记录（只留数值） | **是**（vowel_ref.py 只读它） |

`backend/vowel_ref.py` 的 `_DATA_PATH` 指向 `backend/vowel_ref.json`，**永远不碰本目录**。
改了元音参考值：编辑 `sources.json` → 跑 `python vowel_data/build_vowel_ref.py` 重算记录。

## 数据来源（sources.json 顶层 `meta.sources`）

- Hillenbrand, Getty, Clark & Wheeler (1995). *Acoustic characteristics of American English vowels.* JASA.
- Chung, Kong, Edwards, Weismer & Fourakis (2012). *Cross-language vowel space* (Cantonese/English/Greek/Japanese/Korean).
- 普通话 / 粤语 / 越南语 / 韩语 实测报道（聚合均值）。
- eudic《Formants and phonetics》cardinal 锚点；IPA cardinal vowel 体系 (1-22)。

## 重要说明

- 这些是**软先验**，不是真值；只用于辅助挑选共振峰 + 提前筛掉离谱结果。
- 匹配强调**比例**（F2/F1、F3/F2）而非绝对数：绝对数因声道大小飘，比例更稳。
- 非 Hillenbrand 来源的 SD 是默认估算（meta.default_sd），仅供偏差量级参考。
- 舌尖元音 ɿ/ʅ、卷舌 ɚ、鼻化、入声韵尾等参考稀疏，容差应放宽。

## 打包/分发提示

本目录是**参考数据**，不属于运行时程序。若打包分发 ps-shell 应用，可只包含
`backend/vowel_ref.json`，无需携带 `vowel_data/`（除非想让用户自行改参考值重算）。
