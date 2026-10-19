# 第三方组件与许可证说明 / Third-Party Notices

本项目（PraatSauce 助手 / PraatSauce Shell）自身以 **MIT** 许可发布，见根目录 [`LICENSE`](LICENSE)。
但发布包中随附的 `praat.exe` **不是** MIT，它适用 GNU GPL v3.0 或更高版本。
两者许可不同，请分别遵守。

---

## 1. Praat（`praat.exe`）

| 项目 | 内容 |
|---|---|
| 程序 | Praat: doing phonetics by computer |
| 随包版本 | **7.0.02**（构建日期 2026-08-26） |
| 版权 | © 1992–2025 Paul Boersma and David Weenink, University of Amsterdam |
| 许可证 | **GNU General Public License, version 3 or later**（GPL-3.0-or-later） |
| 许可证全文 | [`LICENSES/GPL-3.0.txt`](LICENSES/GPL-3.0.txt)（也可在线查看 <https://www.gnu.org/licenses/gpl-3.0.txt>） |
| 官方许可页 | <https://praat.org/manual/License.html> |
| 官方源码 | <https://www.praat.org/download_sources.html> → <https://github.com/praat/praat> |
| 官网 | <https://praat.org> |

官方许可页原文：

> Praat is free software distributed under the General Public License, version 3 or higher.

### 修改状态

发布包中的 `praat.exe` 是 **官方原版二进制，未经任何修改**（未重命名、未打补丁、未重新链接）。
其 SHA-256 校验值可由使用者与官方发布包比对。

### 为什么 MIT 程序里可以带 GPL 程序

本程序与 Praat 是**两个独立进程**：

```
PraatSauceShell.exe  ──subprocess.Popen(args)──▶  praat.exe --run script.praat ...
        │                                              │
        └──────────── 通过命令行参数 + 磁盘文件交换数据 ───┘
```

二者不共享地址空间、不动态链接、不互相包含对方代码。GPL 的“传染”针对的是**衍生作品**
（derivative work）与**链接**行为；仅仅是“在同一台机器上调用另一个程序”不构成衍生作品，
因此本程序可以继续以 MIT 发布。

### 分发合规（重要）

GPL-3.0 对**分发二进制**有明确要求。凡是你把 `praat.exe` 一起打包发给别人的场合
（例如网盘 zip、U 盘拷贝、内部群文件），**必须同时提供**：

1. 本文件（`THIRD-PARTY-NOTICES.md`）——写明 Praat 的版本、许可证、版权人；
2. GPL-3.0 许可证全文（`LICENSES/GPL-3.0.txt`）；
3. 获取对应源码的途径（见下）。

**关于源码获取途径**，以下任一做法均符合 GPL-3.0 第 6 条：

- **推荐**：在发布页/说明里给出官方源码地址
  <https://www.praat.org/download_sources.html>（该页指向 <https://github.com/praat/praat>）。
  官方长期托管、版本可追溯，属于第 6(d) 条允许的“equivalent access”。
- **最稳妥**：在 zip 里额外放一份对应版本的 Praat 源码压缩包（体积较大，约几十 MB）。
- 或提供书面要约：承诺在收到请求后至少三年内，以不超过实际成本的价格提供源码。

> 本项目**源代码仓库本身不包含 `praat.exe`**（见 `.gitignore`）。GitHub 上的源码遵循 MIT。
> 只有你另行发布的**安装包/压缩包**才涉及上面的 GPL 义务。

### Praat 内嵌的第三方库

Praat 自身还打包了一些第三方库（如 FLAC、mp3、portaudio 等），它们的许可见
<https://praat.org/manual/Acknowledgments.html>。这些义务由 Praat 官方二进制一并承担，
本项目不再重复分发。

---

## 2. PraatSauce（`scripts/` 与 `praatsauce-master/`）

| 项目 | 内容 |
|---|---|
| 项目 | PraatSauce: Praat-based tools for spectral processing |
| 上游版本 | **1.0.8** |
| 作者 | James Kirby & Rasmus Puggaard-Rode |
| 许可证 | **MIT**，Copyright (c) 2024 praatsauce authors |
| 许可证全文 | [`LICENSES/PraatSauce-MIT.txt`](LICENSES/PraatSauce-MIT.txt) |
| 上游仓库 | <https://github.com/kirbyj/praatsauce> |

`praatsauce-master/` 是上游 1.0.8 的**原样副本**（保留其 `LICENSE.md`）。

`scripts/` 是实际运行的脚本目录，在上游基础上做了以下**修改**（均为本项目作者改动）：

- 新增 `ps_` 前缀的辅助脚本（TextGrid 切分、区间导出、人工修正回写等）；
- `get_pitch.praat` / `get_formants.praat`：读取分支增加文件存在性回退；
  非整段模式下用整段声音计算并保存整段对象，供后续区间复用（避免区间循环把
  整段对象覆盖成最后一个片段）；读回时校验对象时长，坏缓存自动重算；
- `get_formants.praat`：读回分支补 `Copy: "x"`，恢复“原对象 + 副本”双对象不变式；
- `read_params.praat`：参数目录为空时回退到 `inputDir`；补 `cpps` 参数行；
- `praatSauce.praat` / `initiateTable.praat` / `combineMatrices.praat`：
  增加进度旁路与 `HNR38`、`H4-2Ku` 两列；
- `get_SoE.praat` / `get_spectralMeasures.praat` / `zeroPadding.praat`：
  无值处写 `undefined`（NaN）而不是 0，避免把“没测出来”当成真实测量值。

修改后的脚本仍以 MIT 发布，与上游一致。

### 引用

若你在研究中使用了本工具，请同时引用上游 PraatSauce：

> Kirby, James & Rasmus Puggaard-Rode (2025) *PraatSauce. Praat-based tools for
> spectral processing.* Version 1.0.8. GitHub: <https://github.com/kirbyj/praatsauce>

本工具的引用格式见 [`CITATION.cff`](CITATION.cff)。

---

## 3. Python 运行时依赖

发布包（`PraatSauceShell.exe`）内置以下库，**源码仓库中不包含**它们的副本：

| 库 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| Python | 3.13 | PSF License 2.0 | 运行时 |
| pywebview | 6.2.1 | MIT | 原生窗口壳 |
| pythonnet | 3.2.1 | MIT | pywebview 的 .NET/WebView2 后端 |
| clr-loader | 0.3.1 | MIT | pythonnet 依赖 |
| bottle | 0.13.4 | MIT | 本地 HTTP 服务 |
| cffi | 2.1.1 | MIT | pythonnet 依赖 |
| pycparser | 3.11 | BSD-3-Clause | cffi 依赖 |
| importlib-resources | 7.1.0 | Apache-2.0 | pythonnet 依赖 |
| typing-extensions | 4.16.0 | PSF-2.0 | pythonnet 依赖 |

以上均为宽松许可，允许闭源或 MIT 分发，只需保留版权声明。PyInstaller 打包时会自动
收集其许可证文件到 `_internal/`。

## 4. 数据文件

### 示例音频（`samples/`）

`samples/1`（女声）、`samples/2`（男声）下是**程序合成**的元音信号，由
`ps-shell/tools/make_samples.py` 生成，不含任何真人录音，可自由使用。

语音数据若来自你自己的田野调查，请注意发音人知情同意与匿名化，不要随代码一起公开。

### 元音参考值（`ps-shell/vowel_data/`）

`vowel_data/corpora/VoxCommunis/` 下的共振峰参考值来自 **VoxCommunis**：

> Ahn, Emily P. & Eleanor Chodroff (2022). *VoxCommunis: A Corpus for Cross-linguistic
> Phonetic Analysis.* LREC 2022, pp. 5286–5294.

- 许可：**CC0 1.0**（公有领域贡献，可自由使用、修改、商用）
- 来源：<https://osf.io/t957v/>（HuggingFace 镜像：<https://huggingface.co/datasets/pacscilab/VoxCommunis>）
- 本仓库只保留了对"元音参考"最有用的汇总文件（约 2 MB），未拉取逐帧原始数据。

目录内的 `README.md` 与 `REFERENCES.md` 记录了完整来源、校验和，以及另外三份
**未下载**语料（Iivonen 1991、Becker-Kristal 2010 等）的出处——它们没有公开可下载的
数据文件，仅供日后追溯线索。
