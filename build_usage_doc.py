# -*- coding: utf-8 -*-
"""生成《PraatSauce 助手 使用说明》.docx —— 基于已核实的软件事实与两份参考文档范式。

用法（在仓库根执行）：
    python build_usage_doc.py
输出：docs/PraatSauce使用说明.docx（路径相对本文件推导，不含任何机器绝对路径）
"""
import os

from docx import Document
from docx.shared import Pt, RGBColor, Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

_HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(_HERE, "docs", "PraatSauce使用说明.docx")

BASE = "微软雅黑"
TITLE_COLOR = RGBColor(0x1F, 0x3A, 0x5F)
ACCENT = RGBColor(0xC0, 0x50, 0x2E)
GREY = RGBColor(0x55, 0x55, 0x55)

doc = Document()

# ---------- 字体 / 样式 ----------
def set_eastasia(run, name=BASE):
    rPr = run._element.get_or_add_rPr()
    rf = rPr.find(qn('w:rFonts'))
    if rf is None:
        rf = OxmlElement('w:rFonts'); rPr.append(rf)
    rf.set(qn('w:eastAsia'), name)
    rf.set(qn('w:ascii'), name)
    rf.set(qn('w:hAnsi'), name)

# 给所有内置样式统一 CJK 字体
for s in doc.styles:
    try:
        rpr = s.element.get_or_add_rPr()
        rf = rpr.find(qn('w:rFonts'))
        if rf is None:
            rf = OxmlElement('w:rFonts'); rpr.append(rf)
        rf.set(qn('w:eastAsia'), BASE)
    except Exception:
        pass

normal = doc.styles['Normal']
normal.font.name = BASE
normal.font.size = Pt(11)
normal._element.get_or_add_rPr().get_or_add_rFonts().set(qn('w:eastAsia'), BASE)

# ---------- 辅助 ----------
def para(text="", size=11, bold=False, color=None, align=None, italic=False, after=6, before=0):
    p = doc.add_paragraph()
    if align is not None:
        p.alignment = align
    p.paragraph_format.space_after = Pt(after)
    p.paragraph_format.space_before = Pt(before)
    if text:
        r = p.add_run(text)
        r.bold = bold; r.italic = italic
        r.font.size = Pt(size)
        if color is not None: r.font.color.rgb = color
        set_eastasia(r)
    return p

def rich(parts, size=11, after=6):
    """parts: list of (text, dict) 其中 dict 可含 bold/color/italic"""
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(after)
    for text, opts in parts:
        r = p.add_run(text)
        r.font.size = Pt(size)
        r.bold = opts.get('bold', False)
        r.italic = opts.get('italic', False)
        if 'color' in opts: r.font.color.rgb = opts['color']
        set_eastasia(r)
    return p

def h1(text):
    p = doc.add_heading(level=1)
    r = p.add_run(text); r.font.color.rgb = TITLE_COLOR; r.font.size = Pt(17); set_eastasia(r)
    p.paragraph_format.space_before = Pt(14); p.paragraph_format.space_after = Pt(6)
    return p

def h2(text):
    p = doc.add_heading(level=2)
    r = p.add_run(text); r.font.color.rgb = ACCENT; r.font.size = Pt(13.5); set_eastasia(r)
    p.paragraph_format.space_before = Pt(10); p.paragraph_format.space_after = Pt(4)
    return p

def h3(text):
    p = doc.add_heading(level=3)
    r = p.add_run(text); r.font.size = Pt(12); r.bold = True; set_eastasia(r)
    p.paragraph_format.space_before = Pt(6); p.paragraph_format.space_after = Pt(3)
    return p

def bullets(items, size=11):
    for it in items:
        if isinstance(it, str):
            parts, lvl = [(it, {})], 0
        elif isinstance(it, (list, tuple)):
            if len(it) == 2 and isinstance(it[0], str) and isinstance(it[1], dict):
                parts, lvl = [it], 0                       # (text, opts) 单片段
            elif len(it) == 2 and isinstance(it[1], int):
                parts, lvl = [(it[0], {})], it[1]           # (text, lvl)
            else:
                parts, lvl = list(it), 0                   # 片段列表
        else:
            parts, lvl = [(str(it), {})], 0
        norm = [(s, {}) if isinstance(s, str) else s for s in parts]
        p = doc.add_paragraph(style='List Bullet')
        if lvl: p.paragraph_format.left_indent = Inches(0.5 * (lvl + 1))
        p.paragraph_format.space_after = Pt(2)
        for t, o in norm:
            r = p.add_run(t); r.font.size = Pt(size)
            r.bold = o.get('bold', False); r.italic = o.get('italic', False)
            if 'color' in o: r.font.color.rgb = o['color']
            set_eastasia(r)

def numbered(items, size=11):
    for it in items:
        p = doc.add_paragraph(style='List Number')
        p.paragraph_format.space_after = Pt(2)
        r = p.add_run(it); r.font.size = Pt(size); set_eastasia(r)

def code(text):
    p = doc.add_paragraph()
    p.paragraph_format.left_indent = Inches(0.3)
    p.paragraph_format.space_after = Pt(6)
    p.paragraph_format.space_before = Pt(2)
    for line in text.split('\n'):
        r = p.add_run(line + '\n')
        r.font.name = 'Consolas'; r.font.size = Pt(9.5)
        r._element.get_or_add_rPr().get_or_add_rFonts().set(qn('w:eastAsia'), BASE)
        r.font.color.rgb = RGBColor(0x22,0x33,0x44)
    # 浅底纹
    pPr = p._p.get_or_add_pPr()
    shd = OxmlElement('w:shd'); shd.set(qn('w:val'),'clear'); shd.set(qn('w:fill'),'F2F4F7')
    pPr.append(shd)
    return p

def note(text):
    p = doc.add_paragraph()
    p.paragraph_format.left_indent = Inches(0.2)
    p.paragraph_format.space_after = Pt(6)
    r = p.add_run('提示：')
    r.bold = True; r.font.color.rgb = ACCENT; r.font.size = Pt(10.5); set_eastasia(r)
    r2 = p.add_run(text); r2.font.size = Pt(10.5); r2.font.color.rgb = GREY; set_eastasia(r2)
    return p

def make_table(headers, rows, widths=None, col_colors=None):
    t = doc.add_table(rows=1, cols=len(headers))
    t.style = 'Light Grid Accent 1'
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    hdr = t.rows[0].cells
    for i, htext in enumerate(headers):
        hdr[i].text = ''
        rp = hdr[i].paragraphs[0].add_run(htext)
        rp.bold = True; rp.font.size = Pt(10.5); rp.font.color.rgb = RGBColor(0xFF,0xFF,0xFF)
        set_eastasia(rp)
        # 表头底色
        tcPr = hdr[i]._tc.get_or_add_tcPr()
        shd = OxmlElement('w:shd'); shd.set(qn('w:val'),'clear'); shd.set(qn('w:fill'),'3B6EF0')
        tcPr.append(shd)
    for row in rows:
        cells = t.add_row().cells
        for i, val in enumerate(row):
            cells[i].text = ''
            rp = cells[i].paragraphs[0].add_run(str(val))
            rp.font.size = Pt(10); set_eastasia(rp)
    if widths:
        for i, w in enumerate(widths):
            for row in t.rows:
                row.cells[i].width = Inches(w)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return t

def add_toc():
    p = doc.add_paragraph()
    run = p.add_run()
    b = OxmlElement('w:fldChar'); b.set(qn('w:fldCharType'),'begin')
    instr = OxmlElement('w:instrText'); instr.set(qn('xml:space'),'preserve'); instr.text = 'TOC \\o "1-3" \\h \\z \\u'
    sep = OxmlElement('w:fldChar'); sep.set(qn('w:fldCharType'),'separate')
    t = OxmlElement('w:t'); t.text = '（在 Word 中右键此区域，选择“更新域”即可自动生成目录）'
    e = OxmlElement('w:fldChar'); e.set(qn('w:fldCharType'),'end')
    run._r.append(b); run._r.append(instr); run._r.append(sep); run._r.append(t); run._r.append(e)

# ============ 封面 ============
sp = doc.add_paragraph(); sp.paragraph_format.space_before = Pt(90)
para('PraatSauce 助手', size=30, bold=True, color=TITLE_COLOR, align=WD_ALIGN_PARAGRAPH.CENTER, after=4)
para('语音声学参数提取 · 使用说明', size=18, color=ACCENT, align=WD_ALIGN_PARAGRAPH.CENTER, after=30)
para('—— 一套围绕本机 Praat 引擎的图形化操作外壳，复刻 VoiceSauce 工作流', size=11, color=GREY, align=WD_ALIGN_PARAGRAPH.CENTER, after=60)
para('适用对象：语言学 / 语音学 / 方言与发声态研究者在 Windows 平台的自助声学分析', size=11, align=WD_ALIGN_PARAGRAPH.CENTER, after=6)
para('界面语言：简体中文', size=11, align=WD_ALIGN_PARAGRAPH.CENTER, after=6)
para('版本：VoiceSauce 风格界面 1.2 / 向导版 1.2', size=11, align=WD_ALIGN_PARAGRAPH.CENTER, after=40)
para('编写依据：本软件源代码核实 + 凌锋《VoiceSauce 操作说明》(2017) 与《发声态研究与 VoiceSauce 的使用》(2019) 之范式参考', size=10, color=GREY, align=WD_ALIGN_PARAGRAPH.CENTER, after=6)
doc.add_page_break()

# ============ 目录 ============
para('目录', size=15, bold=True, color=TITLE_COLOR, after=6)
add_toc()
doc.add_page_break()

# ============ 1 概述 ============
h1('1  软件概述')
para('PraatSauce 助手是一个用于语音声学参数批量提取的图形化工具。它把开源项目 praatSauce（Kirby & Puggaard-Rode，MIT）包装成一个面向中文研究者、零编程门槛的操作外壳：所有声学参数都真正由你本机安装的 Praat 计算，软件本身只负责选文件、选参数、批量调度与结果展示。')

h2('1.1  与原版 VoiceSauce 的关系')
rich([
    ('本助手在', {}), ('操作逻辑', {'bold':True}), ('上复刻了凌锋两篇文档所介绍的 VoiceSauce（VS）八按钮命令栏与参数提取流程，但在', {}),
    ('底层引擎', {'bold':True}), ('上有本质区别，因此请不要被原文档的某些细节局限：', {}),
])
bullets([
    'VS 基于 MATLAB，需要安装 MATLAB Runtime 才能独立运行；本助手基于 Praat 脚本，无需 MATLAB Runtime，只要本机有 praat.exe。',
    'VS 的基频默认用 STRAIGHT、共振峰用 Snack；本助手统一用 Praat 算法（基频＝滤波自相关 To Pitch，共振峰＝Burg To Formant），效果等价、参数含义一致。',
    'VS 的“已校正 / 未校正”谐波差以星号（*）与字母 u 区分；本助手沿用同一约定，输出列分别以 c（已校正）与 u（未校正）结尾。',
    '本助手在 VS 工作流之上新增了三样东西：五步向导、九宫格审核（可单人逐文件检查并修正 F0／共振峰）、以及单文件“数据调整”面板——这些是 VS 没有的。',
    'SHR（次谐谐波比）在原 VS 中由 MATLAB 计算；本助手改由内置 Python 外接补算，列名仍为 SHR。',
])

h2('1.2  两套界面，同一套后端')
para('启动后你会先看到“选择界面”页，有两个入口，计算结果、中间文件、导出格式完全一致：')
make_table(
    ['界面', '入口文件', '特点', '适合谁'],
    [
        ['向导版', 'index.html', '五步引导：选音频→选要测什么→批量（可先试跑一个样本）→查看/审核→导出；内置发音人档案、结果质检、容错', '新手、需要把关质量的场景'],
        ['VoiceSauce 风格', 'vs.html', '复刻 VS 八按钮命令栏与参数提取对话框，熟悉 VS 的老用户零学习成本', '用过 VS 的研究者'],
    ],
    widths=[1.0, 1.1, 3.2, 1.6])
note('两套界面在右上角都有“切换界面”按钮，可随时互转；也可在“选择界面”页勾选“记住我的选择”，下次直接打开。')

h2('1.3  核心概念：中间文件即权威')
rich([
    ('本助手的结果管理遵循一条铁律——', {}), ('“落盘即权威”', {'bold':True, 'color':ACCENT}),
    ('。每一次提取都会在音频所在目录的 ', {}), ('measure/', {'bold':True}),
    (' 子文件夹里写出基频对象 ', {}), ('.Pitch', {'bold':True}), ('、共振峰对象 ', {}), ('.Formant', {'bold':True}),
    (' 与汇总 ', {}), ('.measure.json', {'bold':True}),
    ('；查看、审核、导出都直接读取这些落盘文件，不重复计算。理解这一点，是正确使用本软件、避免“改了参数却没生效”困惑的关键（详见第 8 章）。', {}),
])

# ============ 2 安装与启动 ============
h1('2  安装与启动')
h2('2.1  启动方式')
numbered([
    '确认本机已安装 Praat（praat.exe），记下它的路径（如 C:\\Program Files\\Praat\\Praat.exe）。',
    '双击项目里的“启动PraatSauce.vbs”。它会用 pythonw 在后台启动后端，不弹出黑色控制台窗口。',
    '后端在本地随机端口（仅监听 127.0.0.1）起一个 HTTP 服务，并自动用浏览器打开“选择界面”页（launch.html）。',
    '首次使用建议先进入“设置”，把 Praat 程序路径指到你的 praat.exe（VoiceSauce 风格页：Manual Data 旁边无，请在 Settings；向导版在设置页）。',
])
note('关闭浏览器标签页后，后端会在约 60 秒内自动退出；重新打开只需再次双击启动脚本。')
code('启动流程（后台，用户无需操作）：\n'
     '启动PraatSauce.vbs  →  pythonw app.py  →  本地 HTTP 服务  →  浏览器打开 launch.html')

h2('2.2  Praat 与脚本目录设置')
para('在“设置（Settings）”里需要确认两项：')
bullets([
    'Praat 程序（praat.exe）：点 Browse 选到本机 praat.exe；旁边“测试”按钮可验证路径有效。',
    'praatSauce 脚本目录：指向软件自带的 praat 脚本目录（通常无需改动，默认即可）。',
    '默认参数层级：新手 / 进阶。新手档只显示必须决定的选项；进阶档开放算法细节参数。',
    'F0 范围、共振峰频率上限：可在此预设全局默认值（也可在“发音人预设”里一键套用）。',
])

h2('2.3  路径与文件名的建议')
rich([
    ('虽然底层是 Praat，仍建议 ', {}), ('音频目录与结果目录的路径尽量使用英文、避免中文与空格', {'bold':True}),
    ('，并避免特殊符号。Praat 对路径中的非 ASCII 字符较为敏感，路径纯净能规避绝大多数“找不到文件/无结果”的意外。', {}),
])

# ============ 3 参数提取（VoiceSauce 风格）============
h1('3  VoiceSauce 风格界面 · 参数提取')
para('这是熟悉 VS 的用户最常用的入口。主窗口复刻了 VS 的八按钮命令栏：Parameter Estimation、Parameter Display、Output to Text、Output to EMU（暂不支持，置灰）、Manual Data、Settings、About、Exit。')

h2('3.1  Parameter Estimation（参数提取）')
numbered([
    '点“Parameter Estimation”按钮，弹出参数提取对话框。',
    '在 “Input (*.wav) directory” 框输入声音目录，或点 Browse 用文件夹选择器定位。定位后下方列表框会列出该目录下所有声音文件。',
    '（可选）勾选“显示波形”，再点列表里的某个文件，可在上方画布预览其波形。',
    '点 “Parameter Selection…” 打开参数选择对话框，勾选你研究需要的参数（默认全选；常规研究不必全开，见第 6 章）。',
    '设置“输出到文本”的目录与文件名（默认 out.tsv，制表符分隔，Excel / R 可直接打开）。留空则结果写在与音频同目录。',
    '底部三个选项按需勾选：① 测量前把 >16 kHz 采样率的音频降采样到 16 kHz（提升速度、减少采样率差异，仅临时处理、不改原文件）；② 使用 Praat TextGrid 限定测量区间（默认读第 1 层）；③ 显示波形。',
    '点 “Start!” 开始批量运行。中间文件（.Pitch / .Formant）会自动落盘到 measure/ 子目录；结果表 out.tsv 写到最后指定的输出目录。',
])
note('第一次跑完，去音频目录下的 measure/ 子目录看一眼，应该已经有 .Pitch 与 .Formant 躺在那里——这就是“默认就保存中间文件”的铁证。')

h2('3.2  Parameter Display（参数显示）')
para('退出参数提取后，点“Parameter Display”可把提取结果以曲线形式叠加显示：左侧画布展示波形/语图背景，右侧参数列表可点选多个参数叠加查看（例如同时看 F0 曲线与 F1–F3 共振峰轨迹）。这与 VS 的“参数显示”一致，且支持多参数叠加，对检查共振峰尤有用。')

h2('3.3  Manual Data（数据调整）')
para('这是本助手相对 VS 的增强之一，用于单文件微调基频或共振峰：')
bullets([
    '选好 wav 目录、加载曲线后，顶部画布会显示已提取的 F0（蓝线）。',
    '在左侧滑块区调整 F0 算法参数（filtered AC / raw AC、基频上下限、阈值等），橙色曲线实时预览。',
    '满意后点 “保存 F0”：用这套参数对当前音频重抽基频、把新的 .Pitch 落盘到 measure/，并写 .measure.json。',
    '切到 Formant 页：设定共振峰频率上限与数量，点 “保存 Formant” 重抽 .Formant 落盘；之后可点 “平滑 Formant” 用 Viterbi 轨迹（Track）消除 F2/F3 上下跳变并写回。',
])
note('“保存 F0 / 保存 Formant” 走的是独立的 review_export 脚本，没有读缓存分支——它永远用新参数重算并覆盖旧文件，无需先删旧 .Pitch/.Formant。这一点与“批量重跑”完全不同（见第 8.3 节）。')

h2('3.4  Output to Text（输出到文本）')
numbered([
    '点“Output to Text”，对话框里列出本次批量已算出的参数，勾选要导出的列。',
    '选 “Single file”（合并输出到一个 CSV/TSV）或多个文件模式（每个参数分开）。',
    '点 “Start!” 生成结果文件。',
])
rich([('导出布局在向导版里更丰富，详见第 5.5 节（single / per_audio / per_param / xlsx 四种）。', {'color':GREY})])

h2('3.5  Settings / About / Exit')
bullets([
    'Settings：见 2.2 节（Praat 路径、脚本目录、参数层级、F0/共振峰默认值）。',
    'About：显示版本与版权信息；明确说明本助手基于 praatSauce（MIT），所有参数由本机 Praat 计算，无需 MATLAB Runtime。',
    'Exit：关闭窗口（后端会在 60 秒内自动退出）。',
])

# ============ 4 向导版 ============
h1('4  向导版界面（五步）')
para('向导版把整个流程拆成五步，并在第三步前提供“试跑一个样本”的把关环节，适合新手与需要质量控制的批量研究。地址栏支持 #step=2 这样的锚点，刷新后停留在当前步骤。')

h2('4.1  五步流程')
numbered([
    '第 1 步 · 选音频：选择声音文件目录（与结果输出目录）。',
    '第 2 步 · 选要测什么：从预设方案一键套用，或逐项勾选参数。',
    '第 3 步 · 批量运行：点“开始批量处理”前，可先选一个样本音频“试跑”，在页面上直接查验 F0/共振峰是否合理；确认参数无误再全量跑。',
    '第 4 步 · 查看测量结果：以九宫格缩略图浏览全部文件，点开任一项进入详情页，可叠加显示曲线与语图、并审核（保存）F0 / 共振峰。',
    '第 5 步 · 导出：选参数与布局，导出 out.tsv（或 xlsx 等）。',
])

h2('4.2  预设方案（第 2 步）')
para('向导版预置了四套方案，避免逐个勾选的麻烦：')
make_table(
    ['预设', '含义', '默认开启的参数'],
    [
        ['声调 / 语调', '只要基频曲线', 'F0（其余全关），速度最快'],
        ['元音 / 共振峰', 'F1 F2 F3 + F0', 'F0 + F1 F2 F3'],
        ['嗓音 / 发声态', 'H1–H2、H1–A1 等 + CPP + HNR', 'F0 + F1–F3 + H1c/H2c/H4c/A1c–A3c + H1–H2 等频谱斜率 + CPP + HNR 四频段'],
        ['全部参数', '55 项全开', '所有可测指标（文件多时很慢，建议小样本试跑）'],
    ],
    widths=[1.4, 2.4, 3.1])

h2('4.3  发音人档案')
para('在参数设置里可套用发音人预设，一键给出合理的 F0 范围与共振峰上限：')
make_table(
    ['发音人', '基频下限', '基频上限', '共振峰频率上限'],
    [
        ['成年男声', '50 Hz', '250 Hz', '5000 Hz'],
        ['成年女声', '100 Hz', '400 Hz', '5500 Hz'],
        ['儿童', '150 Hz', '450 Hz', '5500 Hz'],
        ['自定义', '50 Hz', '300 Hz', '5000 Hz'],
    ],
    widths=[1.6, 1.6, 1.6, 2.1])

h2('4.4  九宫格审核（第 4 步）')
bullets([
    '九宫格只读 measure/ 里已落盘的对象：F0 读 .Pitch，FN/BN 读 .Formant，其余列读 out.tsv——不重算、不重写。',
    '点开某文件的详情页，可叠加显示 F0、共振峰轨迹与语图；在此点“保存”即标记该文件已审核（F0 与共振峰分开算：存了基频不代表存了共振峰）。',
    '无需逐个审的文件，可在九宫格整批点“审核完成”，给目录里全部 wav 落盘当前参数并标记过关。',
    '审完回到第 3 步点“开始批量处理”时，已审部分不会重算。',
])

# ============ 5 可测量参数 ============
h1('5  可测量的参数与发声态意义')
para('下表列出本助手当前支持的全部参数。命名上，“已校正”沿用 VS 的星号（*）约定、输出列以 c 结尾；“未校正”对应 VS 的 u、输出列以 u 结尾。原 VS 因 MATLAB 限制无法输出星号，故以 c/u 区分；本助手直接输出 c/u，含义不变。')

h2('5.1  参数清单')
make_table(
    ['类别', '参数（界面标签 → 输出列）', '声学 / 发声态意义（要点）'],
    [
        ['基础', 'F0(f0)', '基频（音高）轨迹。声调/语调研究的核心，也是其余绝大多数参数的计算基础。'],
        ['基础', 'F1–F5 / B1–B3', '第 1–5 共振峰频率与带宽。元音音色、鼻化、嗓音音色研究核心；B 为带宽(Hz)。'],
        ['谐波幅度(已校正)', 'H1c H2c H4c A1c–A3c', '经共振峰校正后的谐波振幅（H1/H2/H4 与最靠近 F1–F3 的谐波），用于后续谐波差。'],
        ['谐波幅度(未校正)', 'H1u H2u H4u A1u–A3u H2Ku H5Ku', '未经共振峰校正的谐波振幅；H2Ku/H5Ku 为靠近 2000/5000 Hz 的谐波。'],
        ['频谱斜率(已校正)', 'H1–H2 H2–H4 H1–A1/A2/A3（c）', '关键发声态指标：H1–H2 反映声带开合度（气声↑→H1>H2）；H1–A1/A2/A3 反映声门后部开合速率。'],
        ['频谱斜率(未校正)', 'H1–H2 H2–H4 H1–A1/A2/A3 H2K–H5K（u）', '未做共振峰校正的谐波差，作为对照。'],
        ['噪音水平', 'CPP', '倒谱峰值突显（dB）。数值越低，声音越“气”或越粗糙；气声的 CPP 通常低于常态。不受共振峰/抖动干扰，是稳定的发声态指标。'],
        ['噪音水平', 'HNR 0.5k/1.5k/2.5k/3.5k', '谐噪比（四个频段）。气声因含大量噪音，HNR 偏小。注意：元音音质差异大时 HNR 不可直接横比。'],
        ['噪音水平', 'SHR（进阶）', '次谐谐波比。量化次谐波与谐波幅度比，对大小周期/气泡嗓音（嘎裂声）敏感。'],
        ['噪音水平', 'CPPS（进阶）', '标准平滑倒谱峰值突显（M&W 2015 算法）。与 CPP 不同：先二维平滑再逐帧取峰，绝对值不可与 CPP 混比，通常比 CPP 低几 dB。'],
        ['能量与激励', '强度(强度 RMS)', '每帧均方根能量(dB)。'],
        ['能量与激励', 'SoE（激励强度）', 'Strength of Excitation：每个声门闭合瞬间（epoch）激励脉冲的相对幅度，数值越高＝浊声越强、周期性越好。气声、弱化发声与强构音阻碍（塞音/擦音）都会让它变低。定义见 Murty & Yegnanarayana 2008、Mittal et al. 2014；方向依据 Chong 等 2020（JASA，doi:10.1121/10.0001585）与 Garellek, Chai, Huang & Van Doren 2023（JIPA 53(2):305–332，doi:10.1017/S0025100321000116）；实现见 VoiceSauce（Shue et al. 2011）。'],
    ],
    widths=[1.3, 2.5, 3.1])

h2('5.2  与发声态研究的关系（对照参考文档）')
rich([
    ('凌锋(2019) 把 VS 的 15 项参数归纳为四类：基础参数（F0、共振峰、能量）、谐波振幅、噪音水平（HNR、CPP）、激励特征（epoch/SoE）。本助手基本覆盖并扩展了这套体系——例如把“已校正/未校正”谐波差都开放勾选，并新增 CPPS、SHR 等进阶指标。', {}),
])
bullets([
    '气声（breathy）：表现为 H1 偏强、H1–H2 向上倾斜、CPP/HNR 偏低、SoE 偏低。',
    '嘎裂声（creaky）：常见大小周期，SHR 在 0.2–0.4 时嘎裂感最重；并非所有嘎裂都伴明显噪音（如气泡音 HNR 反而高）。',
    '常态浊声：频谱倾斜介于气声与嘎裂之间。',
    '综合建议（参考文档强调）：不要只依赖单一参数，应组合 H1–H2、H1–A1、CPP、HNR 等多指标判断。',
])
note('方法学提示（参考文档）：H1–H2 等谐波差容易受低频共振峰与基频抖动干扰；若要严格比较，应使用“已校正”列（c），或避免用第一共振峰偏低的高元音作调查对象。')

# ============ 6 参数设置详解 ============
h1('6  参数设置详解（进阶档）')
para('以下为“进阶”层级开放的算法参数。多数研究用默认值即可；只有结果明显异常（如基频八度跳变、共振峰上下跳）时才需要调整。')

h2('6.1  基频(F0)')
make_table(
    ['参数', '默认', '说明'],
    [
        ['f0min / f0max', '50 / 300 Hz', '预期基频上下限。设太低会把噪音当基频，设太高会丢低音；上限最好不超过下限 3 倍。'],
        ['pitchMethod', '滤波自相关', '对多数录音优于原始互相关。'],
        ['pitchWindowShape', 'Hanning', '分析窗形状。'],
        ['voicingThreshold', '0(自动)', '越高被判为浊音的部分越少。'],
        ['octaveCost', '0(自动)', '越高越倾向选高基频。'],
        ['octaveJumpCost', '0.35', '越高越拒绝八度跳变；跳八度严重时提到 0.5。'],
        ['voicedUnvoicedCost', '0.14', '越高清浊切换越少（曲线更平滑）。'],
        ['killOctaveJumps', '关', '强制抹平八度跳变，慎用（可能掩盖真实问题）。'],
    ],
    widths=[1.7, 1.4, 3.8])

h2('6.2  共振峰')
make_table(
    ['参数', '默认', '说明'],
    [
        ['maxNumFormants', '5', '每次分析找几个共振峰（≥3）。[u] 等共振峰接近的元音可提到 6。'],
        ['maxFormantHz', '5000 Hz', '在此频率以下寻找共振峰；男声 5000、女声/儿童建议 5500。'],
        ['windowLength', '0.025 s', '共振峰分析的高斯窗宽；基频偏低时可适当加长。'],
        ['preEmphFrom', '50 Hz', '预加重起始频率。'],
        ['bwHawksMiller', '开', '用 Hawks–Miller 经验公式估算带宽；关则用 Praat 实测带宽（需开启共振峰）。'],
    ],
    widths=[1.7, 1.4, 3.8])

h2('6.3  TextGrid 与采样')
make_table(
    ['参数', '默认', '说明'],
    [
        ['useTextGrid', '关', '勾选后只测标注区间，不勾则测整段文件。'],
        ['intervalTier', '1', '读取第几层区间层（Tier）。'],
        ['includeTheseLabels', '跳过空白标签', '只处理标签匹配该正则的区间。'],
        ['intervalFixed', '0.005 s', '固定测量步长（5 ms＝200 Hz 采样率）。'],
        ['intervalEquidistant', '0', '把每个区间等分 N 份只取 N 点；0 表示不使用。'],
        ['resample16kHz', '关', '先把 >16 kHz 音频降采样到 16 kHz（仅临时处理，不改原文件）。'],
        ['channel', '第 1 声道', '立体声录音选 1。'],
    ],
    widths=[1.7, 1.4, 3.8])

# ============ 7 中间文件与结果管理 ============
h1('7  中间文件与结果管理')
h2('7.1  落盘位置')
bullets([
    [('所有中间结果进音频所在目录的 ', {}), ('measure/', {'bold':True}), (' 子目录：.Pitch、.Formant、.measure.json。', {})],
    [('TextGrid 与音频放在同一级目录（不进 measure/）。', {})],
    [('批量结果表（out.tsv）默认写到你在输出目录指定的位置；若未单独指定，批量输出默认在 ', {}), ('<音频目录>/output/', {'bold':True}), ('。', {})],
])

h2('7.2  四个“保存/复用”开关（默认全开）')
para('在进阶档的“文件与输出”里，有四个与中间文件相关的开关，默认都为 1（开）：')
make_table(
    ['开关', '默认', '作用'],
    [
        ['保存 Pitch 中间文件 (pitchSave)', '1', '把基频对象存成 .Pitch（落 measure/）。'],
        ['复用已有 Pitch 文件 (pitchRead)', '1', '优先读已有 .Pitch（手工修正过的基频常用）；文件缺失时自动改为本批重算。'],
        ['保存 Formant 中间文件 (formantSave)', '1', '把共振峰对象存成 .Formant，供查看/审核/导出复用。'],
        ['复用已有 Formant 文件 (formantRead)', '1', '优先读已有 .Formant；文件缺失时自动重算。'],
    ],
    widths=[2.6, 0.8, 3.5])
note('因为 pitchRead / formantRead 默认开，你点开“参数提取→Start”批量跑时，中间文件会默认落盘，无需任何额外操作。')

# ============ 8 关键陷阱 ============
h1('8  关键陷阱：为什么“改了参数重跑却没生效”')
para('这是本助手最容易让人困惑的一点，务必理解其机理，否则会误以为软件有 bug。')

h2('8.1  两条“存盘”路径，两套脚本')
rich([
    ('本助手存在两条性质不同的“重算/存盘”路径，分别对应两个不同的 Praat 脚本：', {}),
])

h3('路径 A · 批量 Parameter Estimation 里改参数再点 Start!')
bullets([
    '走 get_pitch.praat / get_formants.praat。',
    '这两个脚本顶部的第一句逻辑是读缓存判断：若 pitchRead=1 且旧 .Pitch 文件还在，就直接 Read from file 读回旧结果，跳过计算分支。',
    '计算分支（含 Save 行）因此根本不执行——旧文件不是被覆盖，而是被读回来复用。',
    '该对话框没有“先看结果再存盘”的按钮，Start! 一按就跑完，看到的可能还是旧参数结果。',
])
rich([('结论：批量里改参数 B 重跑时，旧 .', {}), ('Pitch', {'bold':True}), (' / .', {}), ('Formant', {'bold':True}),
      (' 不会被覆盖，而是被静默复用。', {'bold':True, 'color':ACCENT})])

h3('路径 B · 数据调整面板里拉滑块 → 点“保存 F0 / 保存 Formant”')
bullets([
    '走 review_export.praat。',
    '我把这个脚本通读确认：它完全没有读缓存分支，直接 To Pitch → Save、To Formant → Save，无条件覆盖旧 .Pitch / .Formant。',
    '所以你在面板里“改参数→看橙色预览→点保存覆盖”这套直觉，在路径 B 完全成立，无需先删旧文件。',
])

h2('8.2  改参数重跑的正确做法（路径 A）')
para('如果你确实要在批量流程里换参数重跑，必须逼脚本进“计算分支”，二选一：')
numbered([
    '删除 measure/ 里对应的旧 .Pitch / .Formant（最干脆）；或',
    '把 pitchRead / formantRead 关掉（设为 0），让“读缓存”判断不成立，从而用新参数重算并重新存盘。',
])
note('一句话记忆：批量重跑改参数 → 先删旧文件或关复用开关；单文件微调 → 直接用数据调整面板的“保存”即可，永远重算覆盖。')

# ============ 9 典型工作流示例 ============
h1('9  典型工作流示例')
h2('例 1 · 声调研究（向导版，最快）')
numbered([
    '启动 → 选“向导版”。',
    '第 1 步选音频目录；第 2 步选预设“声调/语调”（只开 F0）。',
    '第 3 步先试跑一个样本查验 F0 曲线，确认无误后“开始批量处理”。',
    '第 4 步浏览九宫格，必要时在详情页修正个别基频；第 5 步导出 out.tsv，直接用 Excel 画图。',
])

h2('例 2 · 发声态研究（VoiceSauce 风格）')
numbered([
    '启动 → 选“VoiceSauce 风格”。',
    'Settings 里套用发音人档案（如成年女声），把 Praat 路径指好。',
    'Parameter Estimation：选音频目录 → Parameter Selection 勾选 F0、F1–F3、H1c/A1c 等、H1–H2、H1–A1、CPP、HNR → 点 Start!。',
    'Parameter Display 叠加看 F0 与共振峰轨迹，发现个别文件异常 → Manual Data 面板对该文件“保存 F0 / 保存 Formant”重抽修正。',
    'Output to Text 勾选所需参数，导出到文本，带入 R/Python 做 H1–H2、CPP、HNR 的组间比较。',
])

h2('例 3 · 单文件修基频（数据调整面板）')
numbered([
    'VoiceSauce 风格 → Manual Data。',
    '选 wav 目录、加载曲线；在滑块区调整基频参数，橙色预览实时跟随。',
    '满意后点“保存 F0”，新 .Pitch 落盘；之后批量运行时该文件直接复用修正结果。',
])

# ============ 10 常见问题 ============
h1('10  常见问题与注意事项')
make_table(
    ['问题 / 现象', '原因与对策'],
    [
        ['批量改了参数重跑，结果没变', '见第 8 章：pitchRead/formantRead 默认开，旧文件被静默复用。删旧 .Pitch/.Formant 或关复用开关。'],
        ['某文件 F0/共振峰明显错', '用数据调整面板对该文件单独“保存 F0 / 保存 Formant”重抽修正；不要在批量里硬调全局参数。'],
        ['结果表 out.tsv 打不开/乱码', '它是制表符分隔文本，用 Excel 选“数据→从文本”按 TAB 导入；或用记事本/WPS 打开。'],
        ['路径含中文或空格导致无结果', '把音频与结果目录改到纯英文、无空格路径（见 2.3 节）。'],
        ['共振峰 F2/F3 上下乱跳', '在数据调整面板对相应文件“平滑 Formant”（Viterbi Track）消除跳变。'],
        ['Output to EMU 点不了', '该按钮暂不支持，置灰；结果仍可通过 Output to Text 导出。'],
        ['想要更细的算法参数', '在设置里把“默认参数层级”切到“进阶”，开放阈值、窗长、octave cost 等。'],
    ],
    widths=[2.6, 4.3])

h2('10.1  与 VoiceSauce 的主要异同（小结）')
bullets([
    [('同：', {'bold':True}), ('八按钮操作逻辑、参数体系（已校正 c / 未校正 u）、TextGrid 限定区间、降采样到 16 kHz、结果导出的“单文件/多文件”思路一致。', {})],
    [('异：', {'bold':True}), ('本助手用 Praat 引擎、免 MATLAB Runtime；新增向导版、九宫格审核、单文件数据调整；SHR 由 Python 补算；CPPS/SHR 等进阶指标直接开放。', {})],
])

# ============ 结尾 ============
doc.add_paragraph()
para('—— 本文档内容已对照本软件源代码核实；两份凌锋文档仅作范式参考，凡涉及具体算法与界面细节以本软件实际为准。', size=9.5, color=GREY, italic=True)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
doc.save(OUT)
print("saved:", OUT)
