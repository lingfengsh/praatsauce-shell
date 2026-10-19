/* PraatSauce 助手 —— 点击式帮助
 *
 * 设计取舍（2026-10-18 用户拍板）：
 *   原来靠 title 属性做悬停提示。对初学者友好，但熟练使用者会被不停弹出的
 *   气泡打断，也没必要。改成显式帮助模式：右上角「?」→ 鼠标变问号 → 点哪儿
 *   讲哪儿。进入帮助模式后才消耗注意力，平时界面保持干净。
 *
 * 实现要点：
 *  1. 载入时把所有 [title] 收进 data-help-fallback 并删掉 title，从根上关掉
 *     浏览器原生气泡；动态插入的节点由 MutationObserver 补做同样处理。
 *  2. 点击命中顺序：data-help 精确条目 → 旧 title 文本 → 所在面板总览。
 *     所以「点界面任意处都有说明」成立，不会点了没反应。
 *  3. 帮助模式下点击一律拦截（capture 阶段 preventDefault + 阻断传播），
 *     不会误触按钮、开关、下拉。
 *  4. 内容里的判读方向来自项目内已核过的文献，逐条标出处；没有把握的
 *     方向性结论不写死，只写「怎么比」。
 */
(function () {
  'use strict';

  /* ================================================================
   *  一、条目内容
   *  t=标题  g=分类  b=正文  r=怎么读  w=注意  c=文献
   * ================================================================ */
  const R = {

    /* ---------------- 总览与流程 ---------------- */

    'app': {
      t: 'PraatSauce 助手',
      g: '总览',
      b: '这个界面把一次完整的声学分析拆成五步：<b>选音频 → 选参数 → 批量算 → 看结果 → 导出</b>。' +
        '顶部五个圆点是进度，点一下就能跳；参数和结果都保存在你自己的文件夹里，不上传。' +
        '<br><br>所有测量都由本机 <b>Praat</b> 完成，这个程序只是外壳：负责把参数整理成 Praat 能读的文件、' +
        '把结果画成图、把审过的曲线存回对象文件。',
      r: [
        '第一次用：按顶部五个步骤顺着走，第二步不知道选什么就点「研究目标」。',
        '想快速看说明：点右上角 <b>?</b>，再点任何控件。再点一次 ? 或按 <b>Esc</b> 退出。',
        '弹窗盖住顶栏时，按 <b>F1</b> 也能随时打开/关闭帮助。'
      ]
    },

    'step1': {
      t: '第一步 · 选择音频',
      g: '流程',
      b: '选一个文件夹，程序会处理里面所有音频（默认 wav）。输出目录留空时，结果写到<b>音频目录下的 output/</b>。' +
        '<br><br>如果这个文件夹之前做过重采样，里面会有一个 <code>Resample/</code> 子目录；程序会自动把工作目录切到那里，' +
        '避免原始文件和副本被同时扫进来、互相覆盖。',
      r: [
        '录音建议：16 kHz 或更高、单声道、每个音节一个文件最省事。',
        '已经有 TextGrid 的话，放在 wav 同目录、同名即可，第二步会自动配对。'
      ],
      w: '目录里如果有 mp3/flac，程序会先转成 wav（写进 converted_wav/），不会改动你的原文件。'
    },

    'step2': {
      t: '第二步 · 要测什么',
      g: '流程',
      b: '上方「研究目标」是一键套用的常用组合；下方按类别勾选单个参数。' +
        '<br><br>三个常见起点：<b>声调/语调</b>只要 F0；<b>元音格局</b>要 F1–F3（必要时加 F4/F5）；' +
        '<b>发声态/嗓音</b>要 H1–H2、HNR、CPP、SHR 这一组，再配 F1–F3 做校正。',
      r: [
        '「新手 / 进阶」只决定<b>显示多少选项</b>，不会改动你已经勾好的参数。',
        '参数之间的依赖会自动处理：开 H1c 会自动带上 F1–F3，因为谐波校正需要共振峰。'
      ],
      w: '别一次把所有参数都打开。测量项越多越慢，而且多数研究只需要其中一组。'
    },

    'step3': {
      t: '第三步 · 批量运行',
      g: '流程',
      b: '先过「运行前检查」（Praat 能不能跑、脚本齐不齐、文件配不配得上），通过了才让开始。' +
        '也可以先「试跑一个样本」，看曲线和体检结果没问题再批量。' +
        '<br><br>如果走「先审 F0 / 共振峰」路线，批量只会算这两项；审核完再点「继续算其余嗓音参数」，已审的文件不会重算。',
      r: [
        '进度条下面有实时日志，报错会翻成人话，并给出原因和下一步。',
        '「结果数值按规则舍入」只影响导出的表格，不影响曲线和对象文件里的原始精度。'
      ]
    },

    'step4': {
      t: '第四步 · 查看结果',
      g: '流程',
      b: '每格一个文件，画出你选的参数。F0、F1–F5、B1–B5 来自 wav 旁的 <code>.Pitch</code> / <code>.Formant</code> 对象文件；' +
        'HNR、CPP、谐波幅度等来自第三步的汇总表 <code>out.tsv</code>。哪一类没算，对应的曲线就是空的。' +
        '<br><br>点格子打开<b>文件详情</b>，和九宫格审核是同一套界面。',
      r: ['先扫一眼有没有明显的断线、掉半频、共振峰跳到别的暗纹上，再决定要不要逐条审。']
    },

    'step5': {
      t: '第五步 · 导出',
      g: '流程',
      b: '导出的是<b>逐点曲线</b>（每个时间点一行），不是每文件一个均值。' +
        '先勾参数列，再选「怎么取点」和「怎么组织文件」，最后点导出。',
      r: [
        '做统计：单文件长表 + 原始数据或平滑后 N 点，直接进 R/Python。',
        '给合作者看：每音频一个文件，或 Excel 工作簿。',
        '按指标做语料级汇总：每参数一个文件。'
      ]
    },

    'tier': {
      t: '新手 / 进阶',
      g: '界面',
      b: '只控制<b>参数面板显示多少项</b>。新手档藏起窗长、阈值、参考频率这类底层算法参数；' +
        '进阶档把它们全部展开，并多出「更多高级设置」。',
      r: ['不确定就留在新手档。需要调算法时再切进阶，已经勾好的测量项不会丢。']
    },

    'tg': {
      t: 'TextGrid（测量区间）',
      g: '流程',
      b: '两种策略：<b>利用 TextGrid</b> 只测标注区间；<b>不限制</b> 测整个文件。' +
        '<br><br>程序读 wav 同目录、同名的 <code>.TextGrid</code>，默认读第 1 层。缺标注的文件会自动补切（整目录），' +
        '已有标注不会被覆盖。',
      r: [
        '每个音节一个文件：通常「不限制」更省事，反正整段都是要测的。',
        '成段录音、需要按音节取数：用 TextGrid，并确认每层标的是音节而不是句子。'
      ],
      w: 'TextGrid 不是必需的。个数和音频个数不一致时不会整体退出：有同名标注的按标注分段，没有的整段测，日志里会列出配对情况。' +
        '预检里遇到这种情况只会给一条提醒，后面带「自动制作 TextGrid」入口，可以在原地把缺的补上，不用回第一步。'
    },

    'speaker': {
      t: '发音人',
      g: '流程',
      b: '性别决定两件事：F0 的搜索范围，以及共振峰分析的上限。选错会让高音被截掉或多出一堆伪共振峰。' +
        '<br><br>「管理档案」可以把当前这套范围存成常用配置，下次一键调用。',
      r: ['成年男：F0 50–250 Hz、共振峰上限 5000 Hz（软件预设）。', '成年女：F0 100–400 Hz、共振峰上限 5500 Hz。', '儿童：F0 150–450 Hz、共振峰上限 5500 Hz。']
    },

    'review-grid': {
      t: '九宫格审核',
      g: '审核',
      b: '一眼看很多文件：每格一个文件的 F0 曲线或共振峰候选。点格子进详情。<br><br>' +
        '工具栏可以勾选文件后「按新参数重算」，也可以「审核完成」——把本目录所有文件按各自采用的参数导出对象文件，' +
        '批量时直接读、不再重算。',
      r: [
        '只关心个别文件：进详情改完点「存盘」，其余用「审核完成」整批过关。',
        'F0 和共振峰<b>分开计</b>：存了基频不等于存了共振峰。'
      ],
      w: '审核完成写的是对象文件（.Pitch / .Formant），不会改动原始音频和 TextGrid。'
    },

    'detail': {
      t: '文件详情',
      g: '审核',
      b: '上方是操作区：<b>F0 页</b>是参数滑块与「试算预览」，<b>共振峰页</b>是候选列表与「生成候选 / 平滑」。' +
        '下方是语图加曲线；最下面是这一条的路径、元数据与操作提示。' +
        '<br><br>所有手工修改都先停在界面里，点<b>「保存」</b>才写回对象文件；关窗不存会丢。',
      r: [
        '看谐波结构：F0 页用窄带（25 ms）。',
        '看共振峰暗纹：共振峰页用宽带（5 ms）。',
        '拉滑块只是预览；确认曲线合理后再点保存，程序会按这套参数重算并覆盖记录。'
      ]
    },

    'manual-f0': {
      t: '手工改 F0',
      g: '审核',
      b: '打开「改F0」后，图上会出现逐帧点，四种点击各有分工：' +
        '<br>· <b>点空白处</b>：加一个手工点（时间吸附到最近帧）。' +
        '<br>· <b>点曲线上的帧点</b>：删掉这一帧的测量值，曲线用 PCHIP 平滑跨过去。' +
        '<br>· <b>点灰色空心圈</b>：恢复刚才删掉的帧。' +
        '<br>· <b>点紫色点</b>：撤销这个手工点。',
      r: [
        '掉半频 / 翻倍：先把错误那一段的帧点删掉，再在中间补一两个手工点，曲线会平滑接上。',
        '清音段被误判成浊音：直接删掉那一串帧点。',
        '改完先看曲线是否连续，再点「保存（F0）」写回；只改界面不存盘，关窗就丢。'
      ],
      w: '算法有一条硬约束：<b>原本有声的帧绝不会被插值改写</b>。手工段以深紫色重描，和 Praat 原始轨迹一眼可分。「清手工点」会同时恢复所有被删的帧，但同样要点保存才生效。'
    },

    'formant-candidates': {
      t: '共振峰候选与择优',
      g: '审核',
      b: '按 4、5、6、7 个共振峰各跑一套 Burg，再按<b>带宽是否合理</b>与<b>帧间是否平滑</b>打分，合并成一条最优轨迹。' +
        '顶部填了元音音标时，还会按该元音的常见 F1/F2/F3 加权（男/女分开，双元音按段取参考）。',
      r: [
        '先点「生成候选」，再在右侧列表里挑一条最贴近语图暗纹的。',
        '只有一条候选时，平滑开关直接作用于它；多条时要先勾一条。'
      ],
      w: '带宽小于 30 Hz 多半是谐波伪极点；大于 400–1500 Hz 多半是污染帧。择优会把这两类压下去。'
    },

    'formant-track': {
      t: '平滑（Formant: Track）',
      g: '审核',
      b: '用 Praat 的 Viterbi 轨迹跟踪，把逐帧候选连成一条平滑轨迹。它<b>只在 Praat 已经算出的候选里重新选择</b>，' +
        '不插值、不造值，所以不会凭空生成不存在的共振峰。',
      r: [
        '叠加显示时，淡色细线是原始逐帧点，彩色粗线是 Track 结果，改了什么一眼可见。',
        '填了元音音标，连线会整体偏向该元音的参考频率；没填则自动估计。'
      ],
      w: '作用对象：没生成候选 → 平滑基础曲线；只有一条候选 → 平滑它；勾了一条 → 平滑勾的那条；多条都没勾 → 开关自动灰掉。'
    },

    'ipa': {
      t: '元音音标',
      g: '审核',
      b: '非必填。单元音填一段（如 a、ɿ），双元音填两段（如 a、i）。填了之后有三个作用：' +
        '<b>共振峰择优</b>、<b>候选推荐</b>、<b>Track 参考频率</b>都会改用该元音的常见 F1/F2/F3。',
      r: ['不确定音标就先不填，用通用判据也能出结果；填对了通常更稳。'],
      w: '双元音只按首段取参考，因为 Track 更关心起点。'
    },

    'review-state': {
      t: '审核状态',
      g: '审核',
      b: 'F0 与共振峰<b>分开计</b>：某文件算「已审」= 曾在详情页点过对应维度的「保存」。两者独立。' +
        '<br><br>不需要逐个审的文件，用九宫格工具栏的「审核完成」整批标记过关。',
      r: ['批量时已审的部分直接读对象文件，不再重算；没审的照常计算。']
    },

    'round-values': {
      t: '数值舍入',
      g: '导出',
      b: '按列规则舍入：时间列原样保留；SHR 三位；F0、F1–F5、B1–B5、全部 dB 列（HNR、CPP、CPPS、谐振幅、幅差、intensity、soe）两位；' +
        '未知列保守一位。绝对值小于 1e-4 的非零值不抹成 0。',
      r: ['要保留 Praat 原始精度就取消勾选。曲线和对象文件不受影响。']
    },

    'export-method': {
      t: '导出方式',
      g: '导出',
      b: '<b>原始数据</b>：每帧一个点（约 5 ms 一帧），不重采样，最忠实但点最多。' +
        '<br><b>平滑后每文件取 N 点</b>：先在小窗内平滑，再等间隔降采样；平滑只在浊音段内做，<b>不跨静音缝</b>。' +
        '<br><b>按固定时间间隔</b>：每隔固定秒数线性插值取一点，点数随音频时长变化。',
      r: [
        '做时间归一化/生长曲线：平滑后 N 点。',
        '做逐帧建模：原始数据。',
        '要和别的软件按固定采样率对齐：固定间隔。'
      ]
    },

    'export-layout': {
      t: '文件布局',
      g: '导出',
      b: '<b>单文件长表</b>：所有音频堆进一个 CSV（file, time_s, 参数…）。' +
        '<br><b>每音频一个文件</b>：每个音频一张宽表，写进「逐音频序列」子目录。' +
        '<br><b>每参数一个文件</b>：每个参数一张跨音频长表，写进「分参数序列」子目录。' +
        '<br><b>Excel 工作簿</b>：一个 .xlsx，每参数一页 + 说明页（需要 openpyxl）。',
      r: ['布局和取点方式是两件事，可以任意组合。']
    },

    'settings': {
      t: '设置',
      g: '界面',
      b: '这里能改 Praat 路径、跑自检、设默认参数层级，也可以直接编辑 <code>params.csv</code> 文本再导入。' +
        '<br><br>「立即自检」会检查：Praat 能不能执行、脚本是否齐全、界面资源是否到位，并直接给出原因。',
      r: ['换机器后第一件事就是点「测试」或「立即自检」。'],
      w: '脚本目录由程序结构决定，不需要也不允许配置。'
    },

    'switch-ui': {
      t: '切换界面',
      g: '界面',
      b: '同一套引擎有两个外壳：<b>向导版</b>（五步流程，适合按顺序做完一件事）和 <b>VoiceSauce 风格</b>（复刻 VoiceSauce 的八个按钮，适合熟悉 VS 的人）。' +
        '<br><br>两边共用同一份参数、同一批结果文件，随时切回来不会丢数据。',
      r: ['第一次用建议留在向导版；已经知道 VS 怎么操作就直接切过去。']
    },

    'feedback': {
      t: '意见反馈',
      g: '界面',
      b: '打开在线收集表，报 bug、提需求都走这里。',
      r: ['报错时把程序目录下 <code>logs/</code> 整个文件夹打包附上，定位会快很多。']
    },

    'about': {
      t: '关于本软件',
      g: '界面',
      b: '版本号与来源说明。计算内核是 <a href="https://github.com/kirbyj/praatSauce" target="_blank" rel="noopener">praatSauce</a>' +
        '（Kirby &amp; Puggaard-Rode，MIT 许可）加本项目的补丁；所有声学参数由本机 Praat 计算。',
      r: ['想确认自己用的是哪一版，看这里的版本号。']
    },

    'picker': {
      t: '选择文件夹 / 文件',
      g: '界面',
      b: '这是程序自带的目录选择器，不依赖系统对话框（分发出去在不同电脑上表现一致）。' +
        '上方是当前位置的层级路径，中间列出子文件夹或文件（取决于当前是选目录还是选文件），底部可以直接输入或粘贴一个路径。',
      r: [
        '双击文件夹进入；点「↑ 上级」退一层。',
        '选文件时（例如「浏览…」挑一个 wav），点列表里的文件名即可。',
        '已经有完整路径：直接粘到底部的输入框，再点确认。',
        '想新建目录：在底部输入新名字后点「新建文件夹」。'
      ]
    },

    'defaults': {
      t: '默认值',
      g: '界面',
      b: '「存为我的默认」把当前参数记下来，下次打开自动套用；机器路径类设置（Praat 路径、目录）不参与。' +
        '「恢复我的默认」回到你存过的那套；「恢复出厂默认」清掉自定义，回到软件初始值。',
      r: ['调好一套常用参数后存一次，以后开软件就不用重设。']
    },

    'spectrogram-window': {
      t: '语图窗长',
      g: '看图',
      b: '窗长决定时间分辨率和频率分辨率怎么分：<b>窗越短越「宽带」</b>，时间细、频率糊，适合看共振峰暗纹；' +
        '<b>窗越长越「窄带」</b>，频率细，能看到单根谐波和基频走向。',
      r: ['F0 页默认 25 ms（窄带，看谐波）。', '共振峰页默认 5 ms（宽带，看暗纹）。'],
      w: '两页各记各的窗长，切换标签不会互相覆盖。'
    },

    'spectrogram-dynamic': {
      t: '语图对比度',
      g: '看图',
      b: '动态范围（dB）。数值越小，只显示最强的部分，对比更强、共振峰更黑；数值越大，层次越多但整体发灰。',
      r: ['暗纹看不清就调小（30），细节糊在一起就调大（55–70）。']
    },

    'spectrogram-bg': {
      t: '语图作为背景',
      g: '看图',
      b: '在每格曲线下面垫一层浏览器实时计算的窄带语图（25 ms 窗、0–2 kHz），方便对照音段位置和共振峰暗纹。',
      r: ['文件多、只想快速扫曲线：关掉，加载更快。', '要判断某条曲线贴不贴谐波/暗纹：打开。']
    },

    'result-display': {
      t: '重叠 / 堆叠',
      g: '看图',
      b: '<b>重叠</b>：所有曲线画在同一张语图上，彩色纵轴左右交替，适合比较走势。' +
        '<br><b>堆叠</b>：每条参数一根窄带上下排列，时间轴对齐，各自的起伏都看得清，参数多了画布会自动加高。',
      r: ['参数少、看相互关系：重叠。参数多、看各自形状：堆叠。']
    },

    /* ---------------- 参数 ---------------- */

    'param:pitch': {
      t: 'F0（基频）',
      g: '测量参数',
      b: '声带振动的基本频率，单位 Hz，是音高的物理对应。Praat 用滤波自相关逐帧估计（默认 5 ms 一帧），' +
        '在「基频下限 / 上限」之间找最可能的周期。',
      r: [
        '声调研究看<b>相对升降和调域</b>，不要跨性别、跨年龄比绝对值。',
        '同一发音人内部比较最可靠；跨人比较先做半音或 z-score 归一化。',
        'F0 也是谐波定位的基础：F0 错了，H1、H2、HNR 会跟着全错。'
      ],
      w: '最常见的错误是<b>掉半频 / 翻倍</b>：曲线突然整体低一半或高一倍。九宫格里一眼能看出来，进详情删掉重画即可。'
    },

    'param:formant1': {
      t: 'F1（第一共振峰）',
      g: '测量参数',
      b: '声道最低频的共振峰，和<b>开口度</b>关系最直接：开口越大，F1 越高。用 Burg LPC 逐帧估计。',
      r: ['元音格局看 F1×F2 平面：F1 高 = 低元音（a），F1 低 = 高元音（i、u）。'],
      w: '高元音、女声、儿童里 F1 可能接近 F0，LPC 容易把 F1 拉到基频或某根谐波上；这时看 B1 是否异常小（<30 Hz）。'
    },

    'param:formant2': {
      t: 'F2（第二共振峰）',
      g: '测量参数',
      b: '和<b>舌位前后</b>关系最直接：舌越靠前，F2 越高。区分 /i/ 与 /u/ 主要靠它。',
      r: ['F1–F2 平面是元音格局图的标准画法。', '圆唇会整体压低 F2，比较时注意唇形是否一致。']
    },

    'param:formant3': {
      t: 'F3（第三共振峰）',
      g: '测量参数',
      b: '对<b>卷舌、鼻化、儿化</b>和整体音色敏感。F3 突然降低常见于卷舌或 r 色彩。',
      r: ['研究儿化/卷舌时看 F3 的下降幅度和过渡段。', '鼻化会让 F3 附近出现额外极点，曲线变毛躁。']
    },

    'param:formant4': {
      t: 'F4（第四共振峰）',
      g: '测量参数',
      b: '更高频的共振峰。元音研究一般用不到，但在<b>谐波校正</b>里很重要：校正公式要用 F1–F4 的频率和带宽。',
      r: ['只测 F1–F3 时，校正仍会在内部估 F4；显式打开只是把它也输出。']
    },

    'param:formant5': {
      t: 'F5（第五共振峰）',
      g: '测量参数',
      b: '一般研究很少单独用。它只在对象文件与第四步序列里出现，汇总表没有这一列。',
      r: ['除非研究高共振峰音色，否则不用开。']
    },

    'formant-group': {
      t: '共振峰组（F1–F5 / B1–B3）',
      g: '测量参数',
      b: '这一组是一起用的：<b>F1–F3</b> 是元音研究的基本盘，<b>F4–F5</b> 用于更高频的音色或谐波校正，' +
        '<b>B1–B3</b> 是对应的带宽。开谐波幅度（H1c、A1c 等）时程序会自动带上 F1–F3，因为校正要用。',
      r: [
        '只做元音格局：F1–F3 就够。',
        '做发声态：F1–F3 必开（校正要用），F4 建议开。',
        '专门研究带宽：再单独开 B1–B3。'
      ],
      w: 'F4/F5/B4/B5 不在第三步的汇总表里，只在对象文件和第四步序列中出现。'
    },

    'param:bw1': {
      t: 'B1–B3（共振峰带宽）',
      g: '测量参数',
      b: '共振峰的宽度，单位 Hz，反映这个极点有多「尖锐」。带宽越小，共振峰越尖；越大，越平缓。',
      r: [
        '正常语音大致几十到几百 Hz，随共振峰序号升高而变大。',
        '小于 30 Hz：多半是谐波造成的伪极点。',
        '大于 400–1500 Hz：多半是污染帧或鼻化/噪声。'
      ],
      w: '带宽受声道壁阻抗、鼻化、录音滤波影响，不是「越窄越好」。'
    },

    'param:bwHawksMiller': {
      t: 'Hawks–Miller 带宽公式',
      g: '测量参数',
      b: '用中心频率按经验回归式估算带宽（Hawks & Miller 1995），替代 LPC 直接测出的带宽。' +
        '谐波校正需要稳定的带宽，实测带宽抖动大时这个选项更稳。',
      r: ['默认开启。若你专门研究带宽本身，才需要关掉它、用 LPC 实测值。'],
      c: 'Hawks, J. W., & Miller, J. D. (1995). A formant bandwidth estimation procedure for vowel synthesis. <i>JASA</i>, 97(2), 1343–1344.'
    },

    'harmonic-corrected': {
      t: '谐波幅度（已校正）',
      g: '测量参数',
      b: 'H1c/H2c/H4c 是第 1/2/4 次谐波的幅度；A1c/A2c/A3c 是第 1/2/3 共振峰处最强谐波的幅度。' +
        '<br><br>「校正」指按 Iseli–Alwan 公式，用 F1–F4 的频率与带宽把声道共振的影响去掉，' +
        '这样不同元音之间才能比较（文献里常写成 H1*、A3*）。',
      r: ['单个绝对值意义有限，真正有用的是它们的<b>差值</b>：H1–H2、H1–A1、H1–A3。'],
      w: '校正依赖共振峰估得准。F1/F2 错了，校正值会跟着错，所以先确保 F1–F3 曲线贴着语图暗纹。',
      c: 'Iseli, M., & Alwan, A. (2004). An improved correction formula for the estimation of harmonic magnitudes… <i>ICASSP 2004</i>, I-666–669.；Shue et al. (2011), <i>ICPhS XVII</i>, 1846–1849.'
    },

    'harmonic-uncorrected': {
      t: '谐波幅度（未校正）',
      g: '测量参数',
      b: '和已校正组同一批测量，但直接取频谱上的幅度，不扣掉声道共振的影响。' +
        '<br><br>好处是「所见即所得」，坏处是换一个元音、换一个 F1，数值就变了。',
      r: ['只有在固定元音、固定发音人的内部比较时才适合用未校正值。'],
      w: 'H2Ku/H5Ku（4 kHz 以上的高次谐波）声学上属于未校正，但列的出现跟随「已校正」总开关。'
    },

    'h1h2': {
      t: 'H1–H2（第一、二谐波差）',
      g: '发声态判读',
      b: '最常用的发声态指标之一，与声门开放商（OQ）相关。已校正版扣掉了 F1 的影响，可以跨元音比较。',
      r: [
        '<b>H1 > H2（差值偏正）</b>：声门关闭较缓、漏气多，常见于<b>气声</b>。',
        '<b>H1 < H2（差值偏负）</b>：关闭急促、高频能量强，常见于<b>嘎裂 / 紧喉</b>。',
        '<b>常态浊声居中</b>，具体数值随发音人、元音、录音而变。'
      ],
      w: '这是<b>方向性</b>判读，不是绝对阈值。务必同元音、同性别、同录音条件比较；单个数值不能判定发声态。' +
        '<br><a href="#" class="ps-help-link" data-help-jump="phonation">查看发声态判读速查表 →</a>',
      c: '凌锋、史濛辉、袁丹、沈瑞清（2019）《发声态研究的相关问题与 VoiceSauce 的使用》，《方言》41(4)：385–397。'
    },

    'h2h4': {
      t: 'H2–H4（第二、四谐波差）',
      g: '发声态判读',
      b: '看频谱在中高频端的衰减斜率。差值越负，高频掉得越快，频谱越「陡」。',
      r: ['常用来观察<b>声带紧张度 / 假声</b>色彩：紧张、假声化的声音高频相对更强。'],
      w: '受元音和麦克风频响影响很大，必须同元音比较。',
      c: '凌锋等（2019），《方言》41(4)：385–397。'
    },

    'h1a1': {
      t: 'H1–A1',
      g: '发声态判读',
      b: '第一谐波与第一共振峰处谐波幅度之差，反映 F1 附近的频谱倾斜。气声通常让这个差值变大。',
      r: ['和 H1–H2 一起看：两者同向变化，结论更稳。'],
      w: 'F1 越低（高元音），H1 越容易被 F1 抬起来；优先用已校正版。'
    },

    'h1a2': {
      t: 'H1–A2',
      g: '发声态判读',
      b: '第一谐波与第二共振峰处谐波幅度之差，跨度比 H1–A1 大，反映更整体的频谱倾斜。',
      r: ['气声通常更大；和 CPP 一起看能互相印证。']
    },

    'h1a3': {
      t: 'H1–A3',
      g: '发声态判读',
      b: '第一谐波与第三共振峰处谐波幅度之差，是文献中区分气声与常态最常用的指标之一，对整体频谱倾斜敏感。',
      r: ['气声通常更大（频谱更陡）。', '与 CPP 联用：CPP 降、H1–A3 升，是气声的典型组合。'],
      w: '受 F3 及以上共振峰估计影响；F3 曲线不稳时这个值也会抖。',
      c: '凌锋等（2019），《方言》41(4)：385–397。'
    },

    'hnr': {
      t: 'HNR（谐波噪声比）',
      g: '发声态判读',
      b: '谐波成分与噪声成分的能量比，单位 dB。数值越高，周期性越强、声音越「干净」。本项目按 0.5/1.5/2.5/3.5/3.8 kHz 五个频带分别算（每个都是 0 到该上界，不是相邻频段），与 VoiceSauce 的 HNR05–HNR38 对齐。',
      r: [
        '气声通常<b>降低</b>（漏气带来噪声）。',
        '气泡音 / 嘎裂反而可能<b>升高</b>：周期拉长、每个周期内噪声相对少。',
        '所以 HNR 低不等于「嗓音差」，要看和谁比。'
      ],
      w: '文献明确提醒：<b>HNR 不能跨元音比较</b>，不同元音的固有噪声水平不同；也不能跨录音设备比较。',
      c: '凌锋等（2019），《方言》41(4)：385–397。'
    },

    'cpp': {
      t: 'CPP（倒谱峰值突显）',
      g: '发声态判读',
      b: '在倒谱上衡量谐波结构的突出程度，单位 dB。周期性越强，倒谱峰越突出，CPP 越高。',
      r: [
        '气声通常<b>低于</b>常态。',
        '文献认为它是区分发声态时<b>最稳定的指标之一</b>，尤其适合连续语流。'
      ],
      w: 'CPP 受元音、F0、窗长影响；跨文件比较必须固定分析参数。',
      c: '凌锋等（2019），《方言》41(4)：385–397。'
    },

    'cpps': {
      t: 'CPPS（平滑倒谱峰值突显）',
      g: '发声态判读',
      b: 'Praat 的 <code>Get CPPS</code>：先对倒谱做时间与倒频两个方向的平滑，再逐帧取峰。' +
        '相比 CPP，它对连续语音更稳，受单个周期抖动的影响更小。',
      r: ['适合成段录音、连续语流；和 CPP 同向变化时结论更可靠。'],
      w: '本项目是 Praat 直算（Maryn–Weenink 方案），和 2026-09-27 之前的旧 CPPS 列（Python 滑动平均）<b>算法不同，绝对值不可混比</b>。',
      c: 'Maryn, Y., & Weenink, D. (2015). Objective dysphonia measures in the program Praat… <i>Journal of Voice</i>, 29(1), 35–43.'
    },

    'shr': {
      t: 'SHR（次谐波谐波比）',
      g: '发声态判读',
      b: '次谐波能量与谐波能量之比。次谐波出现，说明相邻周期不完全相同——这是嘎裂/气泡音的典型特征，也会导致基频减半。',
      r: [
        '常见读法：<b>&lt; 0.2</b> 谐波结构清楚（常态浊声）；<b>0.2–0.4</b> 过渡；<b>&gt; 0.4</b> 出现次谐波，常见于嘎裂 / 气泡音。',
        '也可用来判断 F0 是不是掉半频：SHR 高的地方，F0 往往低了一个八度。'
      ],
      w: '阈值随发音人、元音、窗长变化，只作线索，不要单独据此判定发声态。',
      c: 'Sun, X. (2002). Pitch determination and voice quality analysis using subharmonic-to-harmonic ratio. <i>ICASSP 2002</i>, I-333–336.'
    },

    'intensity': {
      t: 'Intensity（强度）',
      g: '测量参数',
      b: '按 RMS 能量算出的声强，单位 dB。主要反映<b>响度</b>，也常用来判断音节边界。',
      r: ['同一次录音内比较有意义；跨录音比较要先确认增益一致。'],
      w: '它不是声门激励强度。要研究发声效率请用 SoE。'
    },

    'soe': {
      t: 'SoE（激励强度）',
      g: '发声态判读',
      b: '声门闭合瞬间（epoch）处信号斜率的相对幅度，衡量声门激励有多强、周期性有多好。',
      r: [
        '越高 = 激励越强、周期性越好。',
        '气声、弱化发声通常<b>降低</b>；构音阻碍越强（塞音、擦音）也越低。',
        '跨人比较前应做说话人内 min–max 归一化。'
      ],
      w: '受构音环境影响很大，只在元音段内比较，不要拿元音和擦音比。',
      c: 'Murty & Yegnanarayana (2008)；Mittal 等（2014）。方向依据：Chong 等（2020，JASA，doi:10.1121/10.0001585）——构音阻碍越强，SoE 越低（"breathier and weaker voicing"）；Garellek, Chai, Huang & Van Doren (2023, JIPA 53(2):305–332)——气声元音发声强度低于常态、嘎裂元音较强。实现见 VoiceSauce（Shue et al. 2011）。'
    },

    'pitch-range': {
      t: '基频下限 / 上限',
      g: '算法设置',
      b: 'Praat 在这个范围内找周期。范围设得合适，能避免大部分掉半频和翻倍。',
      r: ['软件预设：成年男 50–250 Hz；成年女 100–400 Hz；儿童 150–450 Hz。', '只要覆盖发音人的实际音域即可，不要无限放宽。'],
      w: '上限放太宽容易翻倍（把二倍频当基频），下限放太低容易掉半频。'
    },

    'pitch-method': {
      t: '基频算法',
      g: '算法设置',
      b: '本项目全路径统一用 <code>To Pitch (filtered autocorrelation)</code>：先滤掉高频、再做自相关，' +
        '对嗓音研究比原始自相关稳。',
      r: ['一般不用改。换算法会让新旧结果不可直接比较。']
    },

    'pitch-costs': {
      t: '八度跳变 / 清浊代价',
      g: '算法设置',
      b: 'Viterbi 选路径时的惩罚项。<b>octaveJumpCost</b> 越大，越不愿意在相邻帧之间跳八度；' +
        '<b>voicedUnvoicedCost</b> 越大，越不愿意在清音/浊音之间切换。',
      r: ['曲线老是莫名跳八度：调大 octaveJumpCost。', '清音段被误判成浊音：调大 voicedUnvoicedCost 或静音阈值。']
    },

    'formant-order': {
      t: '共振峰个数',
      g: '算法设置',
      b: 'LPC 的阶数 = 2 × 共振峰个数。个数设少了，相邻共振峰会合并；设多了，会多出并不存在的极点。',
      r: ['成人常规 5 个；儿童或高共振峰研究可加到 6–7 个。', '做候选择优时程序会分别按 4/5/6/7 各跑一套再合并。']
    },

    'formant-ceiling': {
      t: '共振峰频率上限',
      g: '算法设置',
      b: '分析的最高频率。它同时决定 LPC 的内部重采样率，所以不是「随便填个大数」就行。',
      r: ['软件预设：成年男 5000 Hz；成年女与儿童 5500 Hz。'],
      w: '填 0 或明显不合理的值会产生无意义的共振峰。改这个值等于换了一套分析条件，旧结果不可直接比。'
    },

    'analysis-window': {
      t: '分析窗长',
      g: '算法设置',
      b: '每一帧取多长的信号做 LPC。常规 25 ms。',
      r: ['窗太短：噪声大、共振峰抖。', '窗太长：会把快速变化的过渡段抹平。']
    },

    'time-step': {
      t: '固定测量步长',
      g: '算法设置',
      b: '每隔多少秒取一帧，默认 0.005 s（5 ms）。对象文件的时间轴就是按它铺的。',
      r: ['一般不用改。'],
      w: '如果要改，导出时间序列的步长必须和批量时一致，否则会对不齐、补 0，产生看似正常的空值。'
    },

    'pitch-sync': {
      t: '基频同步窗',
      g: '算法设置',
      b: '按基频周期长度取分析窗，而不是固定时长。谐波幅度会更准，但每帧长度随 F0 变，计算更慢。',
      r: ['研究谐波幅度、发声态时建议开；只测 F0 时无所谓。']
    },

    'cache-read': {
      t: '中间结果复用（读缓存）',
      g: '算法设置',
      b: '批量时会优先读已有的 <code>.Pitch</code> / <code>.Formant</code>，避免重复计算。',
      r: ['同一批参数重跑：开着更省时间。'],
      w: '<b>换了参数要重跑，必须先删旧对象文件，或把「读」关掉。</b>读缓存优先于计算，否则会静默沿用旧结果，看起来像参数没生效。'
    },

    'cpp-trend': {
      t: 'CPP 趋势线',
      g: '算法设置',
      b: '计算 CPP 前先拟合一条倒谱趋势线，再从峰到趋势线量高度。不同的趋势线类型会改变 CPP 的绝对值和它对噪声的敏感度。',
      r: ['默认即可；跨研究比较时要确认对方用的也是同一种。']
    },

    /* ---------------- 方法论 ---------------- */

    'phonation': {
      t: '发声态判读的三条底线',
      g: '方法论',
      b: '<b>1. 声学参数不等于发声态。</b>同一个 H1–H2 可以由不同的声门策略产生，参数只是线索。' +
        '<br><b>2. 不要用单一参数下结论。</b>至少两三个参数同向，再结合听感。' +
        '<br><b>3. 只在可比的条件内比较。</b>同元音、同性别、同录音设备、同分析参数。' +
        '<div class="ps-help-table-wrap"><table class="ps-help-table">' +
        '<thead><tr><th>参数</th><th>气声</th><th>嘎裂 / 紧喉</th></tr></thead><tbody>' +
        '<tr><td>H1–H2</td><td>偏正（H1&gt;H2）</td><td>偏负（H1&lt;H2）</td></tr>' +
        '<tr><td>H1–A3</td><td>偏大</td><td>偏小</td></tr>' +
        '<tr><td>CPP / CPPS</td><td>偏低</td><td>偏高或接近常态</td></tr>' +
        '<tr><td>HNR</td><td>偏低</td><td>可能偏高</td></tr>' +
        '<tr><td>SHR</td><td>低</td><td>高（常 &gt; 0.4）</td></tr>' +
        '<tr><td>SoE</td><td>偏低</td><td>偏高</td></tr>' +
        '</tbody></table></div>' +
        '<div class="ps-help-note">方向性参考，不是绝对阈值；数值随发音人、元音、录音条件变化。</div>',
      r: [
        '常用组合：H1–H2 + H1–A3 + CPP；气声一般是 H1–H2 升、H1–A3 升、CPP 降。',
        '嘎裂：SHR 升、H1–H2 降、F0 可能掉半频。',
        '统计上做说话人内归一化或混合效应模型，别把绝对值直接混在一起跑。'
      ],
      c: '凌锋、史濛辉、袁丹、沈瑞清（2019）《发声态研究的相关问题与 VoiceSauce 的使用》，《方言》41(4)：385–397。'
    },

    'compare': {
      t: '跨文件比较的注意事项',
      g: '方法论',
      b: '声学参数的绝对值同时受发音人、元音、录音设备、分析参数影响。跨文件比较前，先确认这四件事里变了几件。',
      r: [
        '同一发音人、同一元音：可以直接比。',
        '换了元音：先看这个参数是否依赖元音（HNR、CPP、H1–A3 都依赖）。',
        '换了人：做归一化（半音、z-score、说话人内 min–max）。',
        '换了录音设备：尽量别比绝对值，只比同设备内部的相对差异。'
      ]
    }

  };

  /* 参数名 → 条目 key。没列到的参数退回 schema 自带的 help 文本。 */
  const PARAM_KEY = {
    pitch: 'param:pitch',
    formant1: 'param:formant1', formant2: 'param:formant2', formant3: 'param:formant3',
    formant4: 'param:formant4', formant5: 'param:formant5',
    bw1: 'param:bw1', bw2: 'param:bw1', bw3: 'param:bw1',
    bwHawksMiller: 'param:bwHawksMiller',
    ha_h1c: 'harmonic-corrected', ha_h2c: 'harmonic-corrected', ha_h4c: 'harmonic-corrected',
    ha_a1c: 'harmonic-corrected', ha_a2c: 'harmonic-corrected', ha_a3c: 'harmonic-corrected',
    hau_h2ku: 'harmonic-uncorrected', hau_h5ku: 'harmonic-uncorrected',
    hau_h1u: 'harmonic-uncorrected', hau_h2u: 'harmonic-uncorrected', hau_h4u: 'harmonic-uncorrected',
    hau_a1u: 'harmonic-uncorrected', hau_a2u: 'harmonic-uncorrected', hau_a3u: 'harmonic-uncorrected',
    sl_h1h2c: 'h1h2', slu_h1h2u: 'h1h2',
    sl_h2h4c: 'h2h4', slu_h2h4u: 'h2h4',
    sl_h1a1c: 'h1a1', slu_h1a1u: 'h1a1',
    sl_h1a2c: 'h1a2', slu_h1a2u: 'h1a2',
    sl_h1a3c: 'h1a3', slu_h1a3u: 'h1a3',
    slu_h2kh5ku: 'h2h4', sl_h42ku: 'h2h4',
    hnr_05: 'hnr', hnr_15: 'hnr', hnr_25: 'hnr', hnr_35: 'hnr', hnr_38: 'hnr',
    cpp: 'cpp', cpps: 'cpps', shr: 'shr',
    intensity: 'intensity', soe: 'soe',
    f0min: 'pitch-range', f0max: 'pitch-range',
    pitchMethod: 'pitch-method',
    octaveJumpCost: 'pitch-costs', voicedUnvoicedCost: 'pitch-costs', killOctaveJumps: 'pitch-costs',
    maxNumFormants: 'formant-order', maxFormantHz: 'formant-ceiling',
    windowLength: 'analysis-window',
    intervalFixed: 'time-step',
    pitchSynchronous: 'pitch-sync',
    pitchRead: 'cache-read', formantRead: 'cache-read',
    cppTrendType: 'cpp-trend'
  };

  /* ================================================================
   *  二、引擎
   * ================================================================ */

  const S = {
    on: false,
    key: null,          // 当前显示的条目 key
    anchor: null,       // 当前高亮的元素
    panel: null,
    badge: null,
    btn: null,
    lastX: 0,
    lastY: 0
  };

  const $ = (s, r) => (r || document).querySelector(s);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------- 2.1 把原生 title 收编 ---------- */

  function stripTitles(root) {
    if (!root || root.nodeType !== 1 && root.nodeType !== 9) return;
    const list = [];
    if (root.nodeType === 1 && root.hasAttribute && root.hasAttribute('title')) list.push(root);
    if (root.querySelectorAll) root.querySelectorAll('[title]').forEach(el => list.push(el));
    list.forEach(el => {
      if (el.closest('#psHelpPanel, #psHelpBadge')) return;
      if (el.hasAttribute('data-keep-title')) return;   // 数据标签的完整路径等，保留原生提示
      const t = el.getAttribute('title');
      if (t != null) {
        if (!el.dataset.helpFallback) el.dataset.helpFallback = t;
        el.removeAttribute('title');
      }
      if (!el.getAttribute('aria-label') && !(el.textContent || '').trim()) {
        el.setAttribute('aria-label', el.dataset.helpFallback || '');
      }
    });
  }

  let moTimer = null;
  function startObserver() {
    if (!window.MutationObserver) return;
    let pending = [];
    let needFull = false;
    const mo = new MutationObserver(muts => {
      for (const m of muts) {
        if (m.type === 'attributes') { needFull = true; continue; }
        // 只处理新增节点，避免日志/进度刷新时反复全页扫描
        m.addedNodes.forEach(n => { if (n.nodeType === 1) pending.push(n); });
      }
      if (!needFull && !pending.length) return;
      clearTimeout(moTimer);
      moTimer = setTimeout(() => {
        const list = pending; pending = [];
        const full = needFull; needFull = false;
        if (full) stripTitles(document.body);
        list.forEach(n => { if (n.isConnected) stripTitles(n); });
      }, 30);
    });
    mo.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['title']
    });
  }

  /* ---------- 2.2 命中解析 ---------- */

  function entryFor(key, fallback, fallbackTitle) {
    if (key && R[key]) return R[key];
    const m = key && /^param:(.+)$/.exec(key);
    if (m && PARAM_KEY[m[1]] && R[PARAM_KEY[m[1]]]) return R[PARAM_KEY[m[1]]];
    if (fallback) {
      const t = (fallbackTitle || '').trim().replace(/\s+/g, ' ').slice(0, 28);
      return { t: t || '说明', g: '界面', b: esc(fallback).replace(/\n/g, '<br>') };
    }
    return null;
  }

  function resolve(el) {
    if (!el || el.nodeType !== 1) return null;

    // 1) 显式条目
    let n = el.closest('[data-help]');
    if (n) {
      const e = entryFor(n.dataset.help, n.dataset.helpFallback);
      if (e) return { entry: e, el: n, key: n.dataset.help };
    }

    // 2) 旧 title 文本（已收编到 data-help-fallback）
    n = el.closest('[data-help-fallback]');
    if (n && n.dataset.helpFallback) {
      return {
        entry: entryFor(null, n.dataset.helpFallback, (n.textContent || '').trim()),
        el: n, key: 'fallback'
      };
    }

    // 3) 所在面板总览
    n = el.closest('[data-help-scope]');
    if (n) {
      const e = entryFor(n.dataset.helpScope);
      if (e) return { entry: e, el: n, key: n.dataset.helpScope };
    }

    return null;
  }

  /* ---------- 2.3 高亮 ---------- */

  function setHover(el) {
    if (S.anchor === el) return;
    if (S.anchor) S.anchor.classList.remove('ps-help-target');
    S.anchor = el;
    if (el && el !== document.body && el !== document.documentElement) {
      el.classList.add('ps-help-target');
    }
  }

  /* ---------- 2.4 面板 ---------- */

  function buildPanel() {
    if (S.panel) return S.panel;
    const p = document.createElement('div');
    p.id = 'psHelpPanel';
    p.className = 'ps-help-panel';
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-live', 'polite');
    p.innerHTML =
      '<div class="ps-help-head">' +
        '<span class="ps-help-group" id="psHelpGroup"></span>' +
        '<button type="button" class="ps-help-x" data-help-close aria-label="关闭说明">✕</button>' +
      '</div>' +
      '<h4 class="ps-help-title" id="psHelpTitle"></h4>' +
      '<div class="ps-help-scroll" id="psHelpScroll">' +
        '<div class="ps-help-body" id="psHelpBody"></div>' +
        '<div class="ps-help-block hidden" id="psHelpRead"><div class="ps-help-block-h">怎么读</div><ul id="psHelpReadList"></ul></div>' +
        '<div class="ps-help-warn hidden" id="psHelpWarn"></div>' +
        '<div class="ps-help-cite hidden" id="psHelpCite"></div>' +
      '</div>' +
      '<div class="ps-help-foot">' +
        '<span class="ps-help-tip">Esc 退出帮助</span>' +
        '<button type="button" class="btn tiny ghost" data-help-exit>退出帮助</button>' +
      '</div>';
    document.body.appendChild(p);

    p.addEventListener('click', e => {
      if (e.target.closest('[data-help-close]')) { closePanel(); return; }
      if (e.target.closest('[data-help-exit]')) { exit(); return; }
      const jump = e.target.closest('[data-help-jump]');
      if (jump) {
        e.preventDefault();
        const k = jump.getAttribute('data-help-jump');
        if (R[k]) showPanel({ entry: R[k], el: document.body, key: k }, S.lastX, S.lastY);
      }
    });
    S.panel = p;
    return p;
  }

  function buildBadge() {
    if (S.badge) return S.badge;
    const b = document.createElement('div');
    b.id = 'psHelpBadge';
    b.className = 'ps-help-badge';
    b.innerHTML = '<span class="ps-help-badge-dot">?</span>' +
      '<span>帮助模式 · 点击界面任意处查看说明</span>' +
      '<button type="button" class="ps-help-badge-x" data-help-exit>退出</button>';
    b.addEventListener('click', e => {
      if (e.target.closest('[data-help-exit]')) exit();
    });
    document.body.appendChild(b);
    S.badge = b;
    return b;
  }

  function showPanel(hit, x, y) {
    const p = buildPanel();
    const e = hit.entry || R['app'];
    S.lastX = x;
    S.lastY = y;

    $('#psHelpGroup').textContent = e.g || '说明';
    $('#psHelpTitle').textContent = e.t || '说明';
    $('#psHelpBody').innerHTML = e.b || '';

    const read = $('#psHelpRead'), list = $('#psHelpReadList');
    list.innerHTML = '';
    if (e.r && e.r.length) {
      e.r.forEach(t => {
        const li = document.createElement('li');
        li.innerHTML = t;
        list.appendChild(li);
      });
      read.classList.remove('hidden');
    } else {
      read.classList.add('hidden');
    }

    const warn = $('#psHelpWarn');
    if (e.w) { warn.innerHTML = '<b>注意</b>' + e.w; warn.classList.remove('hidden'); }
    else warn.classList.add('hidden');

    const cite = $('#psHelpCite');
    if (e.c) { cite.innerHTML = '<b>文献</b>' + e.c; cite.classList.remove('hidden'); }
    else cite.classList.add('hidden');

    p.classList.remove('hidden', 'ps-help-in');
    p.style.visibility = 'hidden';
    p.style.left = '0px';
    p.style.top = '0px';

    // 尺寸算完再定位，避免闪一下
    const pw = p.offsetWidth, ph = p.offsetHeight;
    const pad = 12;
    let left = x + 16, top = y + 16;
    if (left + pw > window.innerWidth - pad) left = x - pw - 16;
    if (left < pad) left = pad;
    if (top + ph > window.innerHeight - pad) top = window.innerHeight - ph - pad;
    if (top < pad) top = pad;
    p.style.left = Math.round(left) + 'px';
    p.style.top = Math.round(top) + 'px';
    p.style.visibility = '';
    requestAnimationFrame(() => p.classList.add('ps-help-in'));

    S.key = hit.key;
    setHover(hit.el);
    // 面板与底部提示条不同时出现，避免在窄屏上叠在一起
    if (S.badge) S.badge.style.display = 'none';
  }

  function closePanel() {
    if (!S.panel) return;
    S.panel.classList.add('hidden');
    S.panel.classList.remove('ps-help-in');
    S.key = null;
    setHover(null);
    if (S.badge) S.badge.style.display = '';
  }

  /* ---------- 2.5 开关 ---------- */

  function enter() {
    if (S.on) return;
    S.on = true;
    document.body.classList.add('ps-help-on');
    buildBadge();
    if (S.btn) { S.btn.classList.add('active'); S.btn.setAttribute('aria-pressed', 'true'); }
    closePanel();
  }

  function exit() {
    if (!S.on) return;
    S.on = false;
    document.body.classList.remove('ps-help-on');
    if (S.badge) S.badge.remove();
    S.badge = null;
    if (S.btn) { S.btn.classList.remove('active'); S.btn.setAttribute('aria-pressed', 'false'); }
    closePanel();
  }

  function toggle() { S.on ? exit() : enter(); }

  /* ---------- 2.6 事件 ---------- */

  function inChrome(t) {
    return !!(t.closest && t.closest('#psHelpPanel, #psHelpBadge, #btnHelp'));
  }

  function onClick(e) {
    if (!S.on) return;
    if (inChrome(e.target)) return;   // 面板与「?」自己处理

    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();

    const hit = resolve(e.target);
    if (hit) showPanel(hit, e.clientX, e.clientY);
    else {
      // 理论上 body 上有 data-help-scope="app"，这里只是保险
      showPanel({ entry: R['app'], el: document.body, key: 'app' }, e.clientX, e.clientY);
    }
  }

  function onDown(e) {
    if (!S.on) return;
    if (inChrome(e.target)) return;
    // 阻止 input/select 抢焦点、阻止文本被拖选；滚动条不受影响
    e.preventDefault();
  }

  let moveRaf = 0;
  function onMove(e) {
    if (!S.on) return;
    if (inChrome(e.target)) { setHover(null); return; }
    if (moveRaf) return;
    const x = e.clientX, y = e.clientY;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0;
      const hit = resolve(document.elementFromPoint(x, y));
      setHover(hit ? hit.el : null);
    });
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      if (!S.on) return;
      // 帮助模式优先吃掉 Esc：先收说明面板，再按一次才退出帮助模式；
      // 不让它顺带把下面的弹窗/选择器也关掉。
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      if (S.panel && !S.panel.classList.contains('hidden')) closePanel();
      else exit();
      return;
    }
    // F1 随时可开/关（输入框里也生效）——弹窗盖住顶栏时这是唯一入口
    if (e.key === 'F1') {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      toggle();
      return;
    }
    // Shift + / = ?，在没有输入焦点时切换帮助模式
    // （有的浏览器/输入法把 Shift+/ 报成 key="/" + shiftKey，两者都认）
    const tag = (e.target.tagName || '').toLowerCase();
    const isQuestion = e.key === '?' || (e.key === '/' && e.shiftKey) || (e.code === 'Slash' && e.shiftKey);
    if (isQuestion && !/^(input|textarea|select)$/.test(tag) && !e.target.isContentEditable) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      toggle();
    }
  }

  /* ---------- 2.7 初始化 ---------- */

  function init() {
    stripTitles(document.body || document.documentElement);
    startObserver();

    S.btn = $('#btnHelp');
    if (S.btn) {
      S.btn.setAttribute('aria-pressed', 'false');
      S.btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); toggle(); });
    }

    document.addEventListener('click', onClick, true);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('keydown', onKey, true);

    window.addEventListener('resize', () => { if (S.on) closePanel(); });
  }

  /* 供其它脚本（app.js / review-grid-ui.js）取参数对应的帮助 key */
  window.PSHelp = {
    keyForParam: function (name) {
      const k = PARAM_KEY[name];
      return k ? k : 'param:' + name;
    },
    open: function (key) {
      const e = entryFor(key);
      if (!e) return false;
      enter();
      showPanel({ entry: e, el: document.body, key: key },
        Math.max(24, window.innerWidth / 2 - 180), Math.max(60, window.innerHeight / 2 - 120));
      return true;
    },
    exit: exit
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
