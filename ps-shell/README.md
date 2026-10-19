# PraatSauce 助手

给 [praatSauce](https://github.com/kirbyj/praatSauce) 脚本集套一个初学者友好的外壳。
**计算全部由本机 Praat 完成**，这个程序只负责：把参数翻译成人话 → 生成 `params.csv` →
调 Praat → 把结果翻回人话。

功能主体是 `praatsauce-master/src/praatSauce.praat`（55 个参数，见 `src/params.csv`）；
界面参考了 VoiceSauce 的操作流程，但把"8 个平级按钮 + 全目录盲跑"改成"五步向导 + 先试跑"。

---

## 启动

- **发布包**：双击 `PraatSauceShell.exe`。
- **源码态**：在仓库根执行 `python ps-shell/app.py`，或双击 `启动 PraatSauce 助手.bat`。

`app.py` 会起一个只监听 `127.0.0.1` 的本地 HTTP 服务，再用 pywebview 打开原生窗口；
没有 pywebview 时自动退回系统默认浏览器，功能完全一样。

### Praat 程序怎么找

本程序不附带 Praat 的源码，也不修改 Praat；它只是以**子进程**方式调用你机器上的
`praat.exe`。定位顺序（见 `backend/praat.py`）：

1. 设置页里手动指定的路径（最优先，点「浏览」选中即可）；
2. 程序根目录 / exe 同目录下的 `praat.exe`（发布包自带一份，见
   [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md)）；
3. 常见安装位置自动探测（`C:\Program Files\Praat\Praat.exe`、
   `%LOCALAPPDATA%\Programs\Praat\Praat.exe` 等）；
4. 都没有时，设置页会提示去 <https://praat.org> 下载。

本次发布验证的 Praat 版本是 **7.0.02**（上游脚本的测试基线是 6.4.01，建议不低于此版本）。

依赖：`pywebview`（原生窗口，可选）。没有它也能跑，只是用浏览器当界面。

---

## 五步流程

| 步骤 | 做什么 | 为什么 |
|---|---|---|
| 1 选择音频 | 选文件夹，看文件数/时长/采样率 | 先确认读到的东西是对的 |
| 2 要测什么 | 选研究目标预设 + 发音人，参数自动配好 | 新手不用面对 55 个参数 |
| 3 批量运行 | 运行前检查 → 试跑 → 进度/日志 → 诊断 | 参数错了在这里拦住 |
| 4 查看结果 | 九宫格 + 单文件详情，可改 F0 / 共振峰 | 跑完不等于测对 |
| 5 导出数据 | 选列、选版式，导出 CSV / XLSX | 结果要能直接进 R / Python |

### 试跑是关键

VoiceSauce 只能整目录批量跑，参数错了要重跑全部。这里在批量之前可以先只跑一个文件，
看完曲线确认基频、共振峰没问题，再放开整批。

体检结果会直接告诉你该改什么，例如：

- 基频检出率 < 25% → 建议男声 50–250 Hz / 女声 100–400 Hz
- 基频中位数贴着上限 → 建议把上限提到中位数的 1.4 倍
- 哪些文件的基频检出率异常低 → 单独处理（这是 VoiceSauce 没有的能力）

### 两档参数

- **新手**：只显示必须决定的（目录、测什么、基频范围、共振峰）
- **进阶**：开放声道、采样密度、降采样、复用 Pitch/Formant 中间文件等算法细节，55 个参数全部可见，也可在设置里导入自定义 `params.csv`

---

## 结果

- 输出：`输出目录/结果文件名.tsv`（制表符分隔，R / Python 直接读）
- Praat 在 Windows 上写的是 UTF-16，Excel 打开会乱码 → 点 **导出 CSV** 生成带 BOM 的 UTF-8，
  双击就能看
- 0 或 `--undefined--` 表示这一帧没测出来，程序会按列统计"检出率"

---

## 目录结构

```
ps-shell/
  启动 PraatSauce 助手.bat   源码态启动器（发布包用 PraatSauceShell.exe）
  serve_only.py             只起 HTTP 服务、不开窗口（调试 / 无 GUI 环境用）
  app.py                    入口：起本地服务，开原生窗口（失败退回浏览器）
  backend/
    params_schema.py        55 个参数的中文元数据、分组、档位、预设  ← 单一事实源
    params_io.py            生成 / 解析 params.csv
    praat.py                Praat 探测与调用（含 UTF-16 输出解码）
    audio.py                扫描目录、TextGrid 配对检查
    results.py              读结果表、列统计、检出率诊断
    review_*.py             九宫格审核、切分、人工修正回写
    server.py               HTTP 接口 + 任务调度
    settings.py             设置持久化（%APPDATA%\PraatSauceShell）
  ui/                       index.html / styles.css / app.js（无框架、无 CDN，离线可用）
  tests/                    unittest 后端测试 + rg_ui_regress.js 前端回归
  tools/make_samples.py     生成合成示例音频
  vowel_data/               IPA 元音参考值（VoxCommunis，用于候选排序与 Track 先验）
```

## 测试

```bash
# 后端（不需要真 Praat，全部 mock）
python -m unittest discover -s ps-shell/tests -t ps-shell -v

# 前端回归（node vm 里跑，不需要浏览器）
node ps-shell/tests/rg_ui_regress.js
```

## 已知问题

- Praat 每次运行会往 stderr 打一条 `Graphics_setWsViewport` 警告，无害，可忽略
- 日志里如果中文文件名显示成乱码，是 Praat 控制台输出本身的问题，不影响结果文件
- 取消任务会直接结束 Praat 进程，已写入的结果保留
- 只有一个文件时，「九宫格审核」的翻页 / 批量操作无意义，属正常现象
- 超长录音（> 10 分钟）整段测量会很慢，建议先用 TextGrid 切分区间
