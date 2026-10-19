/* review-grid-ui.js —— 全量审查 F0/共振峰（九宫格 + 文件详情）

 *   - 九宫格：选整个目录，一页 N 个文件（默认 3×3=9），每格一条 F0 曲线或
 *     「语图 + 共振峰轨迹」，格子右下角可试听，多文件翻页。
 *   - 顶部「F0 ｜ 共振峰」模式切换；两种数据后端一次性都抽回，切换只重绘不重抽。
 *   - 共振峰模式背景用浏览器 Web Audio 实时算 STFT 语图（零新增依赖），把 Praat Burg
 *     共振峰轨迹叠加其上 —— 规避本机 Praat 无界面模式下复合 Paint 不可脚本化的限制。
 *   - 点格子调起「文件详情」：F0 / 共振峰分两个标签页；可调 Praat 生成多组参数候选
 *     叠加对比、选最优、手动改 F0 点，并把最终采用的参数「存盘」到 wav 同目录的
 *     <文件名>.measure.json；另有「在 Praat 中打开此文件」与「导入修正数据」。
 *     （原来独立的「单文件精修」窗口已并入这里。）
 *
 * 依赖 app.js 全局： $, $$, api, esc, toast, openPicker, togglePlayback, stopPlayback
 */
(function () {
  "use strict";

  var state = {
    dir: "", mode: "f0", size: 16, page: 0, data: null, busy: false, detailFile: null,
    // 当前勾选参与「重测」的文件 name 集合，按模式各存一套（F0 页与共振峰页互不继承——
    // 用户 2026-10-01 明确要求：两页选择无关）。「重测」只作用于当前页这些文件（拍板：选中范围=仅当前页）
    selByMode: { f0: new Set(), formant: new Set() },
    // 语图参数：band = 分析窗长(ms)（越小越"宽带"：时间细、频率糊）；
    // dyn = 显示动态范围(dB)（越小对比越强）。用户可在工具栏实时调，调完重算语图。
    // ⚠️ 窗长按维度各存一份（2026-09-25 修正），两页默认值不同：
    // F0 页 = 窄带 25 ms（频率细，看单根谐波与基频走向）；共振峰页 = 宽带 5 ms（看暗纹）。
    // 用户改了仍分开记（applyBand 按 specDim 写回各自的 bandF0 / bandFormant）。
    bandF0: 25, bandFormant: 5, dyn: 40,
    // F0 页语图的显示频率上限（详情页专用，可调，默认 2 kHz）：
    // 窄带语图配 2 kHz 上限，正好覆盖基频与头几根谐波。F0 曲线纵轴由 f0Top 控制；九宫格用 FMAX_SPEC。
    specTop: 2000,
    // F0 曲线（右轴）的显示范围（详情页专用，2026-09-26 用户拍板）：
    // 上下限都可调（顶部「F0下 / F0上」输入框）；清空 = 回退性别默认数字
    // （男 50–250、女 100–350、未知 50–250）。旧「自适应」退役——用户嫌它随意。
    f0Top: 0,
    f0Bottom: 0,
    // 共振峰「多数量择优」（Praat 的 To Formant (burg) 按 4/5/6/7 各跑一套、逐音节挑最优）
    // 默认开启、不再提供关闭开关——用户 2026-09-26 拍板：择优本就应该是默认行为。
    // 「平滑（Track）」也没有独立开关：九宫格取数时默认就做（fetchPage 传 formantTrack:true），
    // 详情页另有单文件叠加显示（见 trackDetail）。
    // 文件详情当前标签页：f0 / formant。打开详情时会按九宫格当前模式（state.mode）重置，
    // 所以「看共振峰时点开就是共振峰」，不用再手动切一次。
    tab: "f0",
    // 九宫格 F0 的整页共用纵轴（renderCells 每次重算）；null = 退回 0–FMAX_F0
    f0Range: null,
  };
  // 候选配色。前 8 个保持原有的手工配色（F0 只有 3 组，视觉不变）；后 12 个按黄金角
  // 生成色相，保证相邻序号的颜色拉得开，再靠明暗交替多一层区分。
  // ⚠️ 共振峰候选**不再**逐个取色：20 组颜色太多太花，改为「同一上限同色、同色内用线型
  // 区分数量」（见 ceilColor / FORMANT_DASH），所以实际只会用到前 5 个颜色。
  var PALETTE = (function () {
    var base = ["#2f6fed", "#16a085", "#e67e22", "#9b59b6", "#c0392b",
                "#27ae60", "#2980b9", "#d35400"];
    for (var i = 0; i < 12; i++) {
      var h = (40 + i * 137.508) % 360;
      base.push("hsl(" + h.toFixed(0) + ", 62%, " + (i % 2 ? 42 : 58) + "%)");
    }
    return base;
  })();
  var _audioCtx = null;
  // 每种每页数量对应的列数（格子是 2:1 的扁方块，列多于行更省竖向空间）
  var COLS = { 4: 2, 6: 3, 9: 3, 12: 4, 16: 4, 20: 5, 24: 6, 25: 5, 30: 6, 36: 6 };
  // 显示用频率上限（Hz）。**必须与抽取时的 formant_ceiling 一致**——
  // 两者不一致时，超过上限的 F3 会被压出画布顶端，看起来就像「共振峰轨迹和语图错位」。
  // 语图与共振峰线共用这一个变量，保证两者同轴。
  // 抽取参数现在跟随用户设置（maxFormantHz），所以这里不再写死：每次取数后按后端
  // 回显的 formantCeiling 更新（见 fetchPage）。下面的值只在首次取数前兜底。
  var FMAX_FORMANT = 5500;
  // F0 页（九宫格格子 + 详情大图）的语图背景：**窄带 25 ms + 2 kHz 上限**（见 state.bandF0 / FMAX_SPEC）。
  // 窄带配 2 kHz：频率细、能看到单根谐波与基频走向，且不浪费 2 kHz 以上的空带。
  // ⚠️ 语图与 F0 曲线**各自独立纵坐标**（2026-09-22 用户定案）：语图固定 0–FMAX_SPEC 铺满，
  // F0 曲线按自身显示范围铺满（见 f0Top/f0Bottom）。共振峰页另走 FMAX_FORMANT，两页不混。
  var FMAX_SPEC = 2000;
  // F0 曲线自适应轴的兜底上限（测不到任何点时退回 0–FMAX_F0）；与语图上限无关。
  var FMAX_F0 = 2000;
  // 「当前生效的是哪一页」：详情页开着就跟随详情 tab，否则跟随九宫格模式。
  // 窗长按维度各存一份，所以取/写窗长前都先判这个。
  function specDim() {
    if (state.detailFile) return state.tab === "formant" ? "formant" : "f0";
    return state.mode === "formant" ? "formant" : "f0";
  }
  function bandFor(dim) {
    return dim === "formant" ? state.bandFormant : state.bandF0;
  }
  // 当前模式下的勾选集合（F0 / 共振峰各自独立，互不继承）
  function selSet() { return state.selByMode[state.mode === "formant" ? "formant" : "f0"]; }
  function syncBandInputs() {
    var v = String(bandFor(specDim()));
    var gb = $("#rgBand"); if (gb) gb.value = v;
    var gd = $("#rgBandDetail"); if (gd) gd.value = v;
  }
  // F0 曲线用橙色（2026-09-22 用户要求）：原蓝色在浅蓝语图背景上对比度不足。
  var F0_COLOR = "#f97316";
  // 「点图改 F0」的手动点原为红色，与橙色太接近 → 改深紫，保证一眼分得开。
  var F0_MANUAL_COLOR = "#7c3aed";
  // 共振峰三线的配色与线宽层次：F1 最粗、F3 最细，多条叠加时还能认出哪条是 F1。
  // CELL 给九宫格小格，DETAIL 给详情大图；2026-09-22 两档都再整体加粗（用户：不加粗看不清）。
  var FORMANT_STYLE_CELL = [["F1", "#2f6fed", 2.4], ["F2", "#16a085", 2.0], ["F3", "#e67e22", 1.6]];
  var FORMANT_STYLE_DETAIL = [["F1", "#2f6fed", 3.4], ["F2", "#16a085", 2.8], ["F3", "#e67e22", 2.2]];
  // 共振峰候选的线型（按「共振峰数量」区分，同色不同线型）。索引 = nFormants - 4：
  //   4 → 实线、5 → 点线、6 → 虚线、7 → 点划线
  var FORMANT_DASH = [[], [2, 4], [9, 5], [14, 4, 3, 4]];
  var FORMANT_NF_BASE = 4;

  // ----------------------------- 初始化 -----------------------------
  function init() {
    $$(".btnReviewGrid").forEach(function (b) { b.onclick = openGrid; });
    $("#reviewGridClose").onclick = closeGrid;
    $("#reviewGridModal").addEventListener("click", function (e) {
      if (e.target === $("#reviewGridModal")) closeGrid();
    });
    $("#rgPick").onclick = function () {
      openPicker($("#rgDir").value || "", function (folder) {
        $("#rgDir").value = folder;
        // 单一变量（2026-10-02 用户定案）：九宫格选目录统一写回全局 inputDir，
        // 不得另立工作目录。否则九宫格与全局各持一份目录、互相脱节。
        var id = $("#inputDir"); if (id) { id.value = folder; }
        if (window.state && window.state.values) { window.state.values.inputDir = folder; }
      });
    };
    // 用户在目录框直接改值也回流到单一变量 inputDir
    $("#rgDir").addEventListener("change", function () {
      var v = this.value.trim();
      var id = $("#inputDir"); if (id) { id.value = v; }
      if (window.state && window.state.values) { window.state.values.inputDir = v; }
    });
    $("#rgRefresh").onclick = buildPage;
    // 「重测」：对勾选文件用新参数覆盖式重抽（先 scan 列手工修正、弹参数框，用户确认后再 execute）
    $("#rgRerun").onclick = openRerun;
    $("#rgSelectAll").onchange = function () {
      var all = state.data && state.data.files
        ? state.data.files.map(function (f) { return f.name; }) : [];
      if (this.checked) all.forEach(function (n) { selSet().add(n); });
      else selSet().clear();
      renderCells();     // 刷新各格勾选框状态
    };
    // 重测参数弹窗
    $("#rgRerunClose").onclick = closeRerun;
    $("#rgRerunModal").addEventListener("click", function (e) {
      if (e.target === $("#rgRerunModal")) closeRerun();
    });
    $("#rgRerunCancel").onclick = closeRerun;
    $("#rgRerunStart").onclick = startRerun;
    $("#rgRerunSelectAllCov").onclick = function () {
      $$("#rgRerunCorrList input[type=checkbox]").forEach(function (c) { c.checked = true; });
    };
    // 「审核完成」= 审核环节的收尾动作：把整个目录所有 wav 的 F0/共振峰导出成对象文件，
    // 并给每个文件落 measure.json 的 choice（F0/共振峰两维都标已审）。向导第三步的
    // reviewed_state 就是看 measure.json 的 choice.pitch/formant 来判定「已审核」的。
    $("#rgFinishReview").onclick = finishReview;
    $("#rgPrev").onclick = function () { if (state.page > 0) { state.page--; render(); } };
    $("#rgNext").onclick = function () {
      if (state.data && state.page < state.data.pages - 1) { state.page++; render(); }
    };
    $("#rgSize").onchange = function () {
      state.size = parseInt(this.value, 10) || 16; state.page = 0; buildPage();
    };
    // 语图两个参数 + TextGrid 裁剪：只重算语图重绘，不重新调 Praat
    // 语图两个参数（窗长 band / 动态范围 dyn）：九宫格工具栏与详情页各有一组控件，
    // 共享同一份状态——任一处改了都同步到另一处并重算语图。
    // 窗长例外：按维度分开存（bandF0 / bandFormant），见 state 里的注释。
    function applyBand(v) {
      var n = parseFloat(v);
      if (specDim() === "formant") state.bandFormant = n; else state.bandF0 = n;
      syncBandInputs();
      clearSpec(); renderCells();
      if (state.detailFile) drawDetail(state.detailFile);
    }
    function applyDyn(v) {
      state.dyn = parseFloat(v);
      var gd = $("#rgDyn"); if (gd) gd.value = String(state.dyn);
      var gdd = $("#rgDynDetail"); if (gdd) gdd.value = String(state.dyn);
      clearSpec(); renderCells();
      if (state.detailFile) drawDetail(state.detailFile);
    }
    $("#rgBand").onchange = function () { applyBand(this.value); };
    $("#rgDyn").onchange = function () { applyDyn(this.value); };
    $("#rgBandDetail").onchange = function () { applyBand(this.value); };
    $("#rgDynDetail").onchange = function () { applyDyn(this.value); };
    // F0 页语图显示上限（详情页专用；可调，2026-09-27 默认 5 kHz）
    $("#rgSpecTop").onchange = function () {
      var v = Math.round(parseFloat(this.value));
      if (!isFinite(v)) v = FMAX_SPEC;
      v = Math.max(200, Math.min(8000, v));
      this.value = String(v);
      state.specTop = v;
      if (state.detailFile) drawDetail(state.detailFile);
    };
    // F0 曲线显示上限/下限（2026-09-26 用户拍板：上下限都可调；清空 = 回退性别默认数字
    // 男 50–250 / 女 100–350。旧「自适应」退役）
    $("#rgF0Top").onchange = function () {
      var v = parseFloat(this.value);
      if (!isFinite(v) || v <= 0) {
        var d = f0GenderRange(); this.value = String(d[1]); state.f0Top = d[1];
      } else {
        v = Math.round(Math.max(50, Math.min(2000, v)));
        this.value = String(v);
        state.f0Top = v;
      }
      if (state.detailFile) drawDetail(state.detailFile);
    };
    $("#rgF0Bottom").onchange = function () {
      var v = parseFloat(this.value);
      if (!isFinite(v) || v < 0) {
        var d = f0GenderRange(); this.value = String(d[0]); state.f0Bottom = d[0];
      } else {
        v = Math.round(Math.max(0, Math.min(1000, v)));
        this.value = String(v);
        state.f0Bottom = v;
      }
      if (state.detailFile) drawDetail(state.detailFile);
    };
    // 性别切换 → F0 纵轴范围**显式联动**（2026-09-26 用户反馈：切性别框里数字必须
    // 跟着变）：两个框直接填该性别默认（男 50–250 / 女 100–350），之后手改仍可覆盖。
    $("#rgGender").onchange = function () {
      syncF0RangeInputs();
      if (state.detailFile) drawDetail(state.detailFile);
    };
    $$("#rgMode .seg-btn").forEach(function (b) {
      b.onclick = function () {
        state.mode = b.dataset.mode;
        $$("#rgMode .seg-btn").forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        syncBandInputs(); // 语图窗长下拉框跟着模式切（两维默认都是宽带 5 ms）
        if (state.data) applyStatus(state.data); // 状态栏随模式刷新（F0/共振峰信息分流）
        renderCells(); // 两端数据都已抽回，仅重绘，不重新调 Praat
      };
    });
    // ---- 文件详情：选参数 / 手动改 F0 / 存盘 / 在 Praat 中打开 / 导入修正数据 ----
    $("#reviewDetailClose").onclick = closeDetail;
    $("#reviewDetailModal").addEventListener("click", function (e) {
      if (e.target === $("#reviewDetailModal")) closeDetail();
    });
    $("#rgDetailPlay").onclick = function () {
      if (state.detailFile) togglePlayback(state.detailFile.path, this);
    };
    $$("#rgDetailTabs .seg-btn").forEach(function (b) {
      b.onclick = function () {
        setTab(b.dataset.tab);
        renderCandList();
        if (state.detailFile) drawDetail(state.detailFile);
      };
    });
    $("#rgEditF0").onchange = function () {
      state.editF0 = $("#rgEditF0").checked;
      if (state.detailFile) drawDetail(state.detailFile);
    };
    // 「清空手工点」：清手工点 + 恢复所有被删的帧；只清当前显示，要点「存盘」才真正去掉
    $("#rgManualClear").onclick = function () {
      var f = state.detailFile;
      if (!f || (!(f._manual || []).length && !(f._deleted || []).length)) return;
      f._manual = [];
      f._deleted = [];
      drawDetail(f);
      toast("已清空手工点并恢复被删的帧（尚未存盘；点「保存（F0）」才会从记录里去掉）", "ok");
    };
    // 「平滑（Track）」：勾上就跑一次 Praat（叠加显示），取消就回到原始曲线
    $("#rgSmooth").onchange = function () {
      var f = state.detailFile;
      if (!f) return;
      if (!this.checked) { f._smoothed = null; drawDetail(f); return; }
      trackDetail(f);
    };
    $("#rgDetailBuild").onclick = buildCandidates;
    // 「恢复默认」（共振峰候选区，对标 F0 滑块的 #rgPrevReset）：
    // 回到刚进入详情页时的显示状态——撤掉所有叠加的候选、清掉「存盘记录用」选择、
    // 去掉「推荐」角标、隐藏候选二维表（回到「九宫格抽取的那一条曲线」）。只影响显示，
    // 不改动已存盘的 measure.json。
    $("#rgDetailReset").onclick = resetCandDefaults;
    $("#rgDetailSave").onclick = onSaveClick;
    // 标题栏也放一个保存按钮（上下各一个，用户 2026-10-18 要求）：镜像底部那个的
    // 文案/禁用态/悬停提示，点它等于点底部按钮。文案会随标签页在「保存（F0）/存盘（共振峰）」间变。
    if (window.mirrorButton) window.mirrorButton("rgDetailSave", "rgDetailSaveTop");
    $("#rgDetailCanvas").onclick = onDetailCanvasClick;
    // 叠放 / 追加 切换（2026-09-27 用户要求改左右并排的段式按钮，不用下拉）：
    // 追加 = 主图下方每参数一条窄带、画布自动加高
    $("#rgModeOverlay").onclick = function () { rdSetMode("overlay"); };
    $("#rgModeStrip").onclick = function () { rdSetMode("strip"); };
    // 悬停读数（2026-09-27 用户拍板）：多参数版上鼠标移动画十字线、读各参数该时刻的值。
    // 只是查已解析的点数组 + rAF 节流重绘，不碰 Praat、不重算，资源开销可忽略。
    $("#rgDetailCanvas").addEventListener("mousemove", onDetailCanvasMove);
    $("#rgDetailCanvas").addEventListener("mouseleave", function () {
      rd.hover = null;
      if (rd.on) drawDetail(rd.file);
    });
    $("#rgDetailOpenPraat").onclick = openPraat;
    $("#rgDetailFixPP").onclick = fixWithPointProcess;
    $("#rgDetailReadPP").onclick = readPointProcessResult;
    $("#rgDetailOpenFp").onclick = openFormantPath;
    $("#rgDetailReadFp").onclick = readFormantPathResult;
    $("#rgDetailImport").onclick = function () { $("#rgImportFile").click(); };
    $("#rgImportFile").onchange = onImportFile;
    // 结果版：前后翻文件（不回九宫格）。键盘 ← / → 同效（见下面 keydown）。
    $("#rgDetailPrev").onclick = function () { rdNav(-1); };
    $("#rgDetailNext").onclick = function () { rdNav(1); };
    document.addEventListener("keydown", function (e) {
      if (!rd.on || $("#reviewDetailModal").classList.contains("hidden")) return;
      var t = e.target || {};
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName || "")) return;  // 别抢输入框的键
      if (e.key === "ArrowLeft") { rdNav(-1); e.preventDefault(); }
      else if (e.key === "ArrowRight") { rdNav(1); e.preventDefault(); }
    });
    // 主输入框键入 → 按音段数自动展开下面的文本框（1 段→1 框，2 段→2 框）
    // 音段框直接输入（2026-09-26 用户要求：去掉长主输入框）。「＋」加段、「－」删段，
    // 首个「音段1」框常驻；collectIpaSegs 只认非空框，空框不存。
    $("#rgIpaAdd").onclick = addIpaSeg;
    $("#rgIpaDel").onclick = delIpaSeg;
    // ---- F0 测量参数滑块实时预览 ----
    $$("#rgPrevMethod .seg-btn").forEach(function (b) {
      b.onclick = function () {
        state.prev.method = b.dataset.m;
        $$("#rgPrevMethod .seg-btn").forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        state.prev.values = {};   // 两方法的标准值/参数集不同，切换即重置为标准值
        buildPrevSliders();
        schedulePreview();
      };
    });
    $("#rgPrevSave").onclick = savePreviewParams;
    // 「恢复默认」（用户 2026-09-26：拉了滑块后青线没法关掉）：滑块回到默认参数、
    // 撤掉青色预览线，图恢复成打开详情时的样子。只影响显示，不动已存盘的参数。
    $("#rgPrevReset").onclick = function () {
      var f = state.detailFile;
      if (state.prev && state.prev.timer) { clearTimeout(state.prev.timer); state.prev.timer = null; }
      if (!state.prev) state.prev = { method: "filtered", values: {}, timer: null, seq: 0 };
      state.prev.method = "filtered";
      state.prev.seq++;                  // 在途的预览请求结果回来直接作废
      $$("#rgPrevMethod .seg-btn").forEach(function (x) {
        x.classList.toggle("active", x.dataset.m === "filtered");
      });
      if (f) f._preview = null;
      resetPrevSliders();                // 滑块回 PREV_DEFS 默认值、清状态文字
      if (f) drawDetail(f);
    };
  }

  function openGrid() {
    $("#reviewGridModal").classList.remove("hidden");
    autoLoadDir();   // 自动套用第一步已设目录并抽第一页，避免再让用户选文件夹
  }
  function closeGrid() {
    stopPlayback();
    $("#reviewGridModal").classList.add("hidden");
    // 关九宫格时顺手刷新第三步的「已审核 / 尚未审核」提示——用户很可能刚点过「审核完成」。
    // 不刷的话，第三步的状态要等下次重新进这一步才更新。
    try { if (window.refreshReviewState) window.refreshReviewState(); } catch (e) { /* 忽略 */ }
  }

  // 自动套用向导第一步已设的声音目录；若没有则提示手动选
  function autoLoadDir() {
    // 优先用第一步输入框里当前看到的目录，其次回退到 state 里保存的值
    var liveDir = ($("#inputDir") ? $("#inputDir").value.trim() : "") || "";
    var stDir = (window.state && window.state.values && window.state.values.inputDir) || "";
    var dir = liveDir || stDir;
    if (!dir) {
      setStatus("请先在第一步选好声音目录，或点「浏览」手动指定。", false);
      return;
    }
    $("#rgDir").value = dir;
    buildPage();   // 自动抽取第一页
  }

  // isWarn（可选）= 本页没失败，但有事情没按预期完成（当前只有「部分文件未做 Track 平滑」）。
  function setStatus(msg, isErr, isWarn) {
    var el = $("#rgStatus");
    el.classList.remove("hidden");
    el.style.color = isErr ? "var(--err)" : (isWarn ? "var(--warn)" : "var(--muted)");
    el.textContent = msg;
  }

  // 按当前数据 + 当前模式（state.mode）拼状态栏文字。
  // F0 视图只显示与基频相关的信息（页数与 TextGrid 载入情况）；
  // 共振峰视图额外显示多数量择优、Track 平滑与未平滑警告。
  // 抽数与切模式都调用本函数，保证状态栏与当前视图一致。
  function applyStatus(r) {
    if (!r || !r.files) return;
    var tgN = (r.files || []).filter(function (x) { return x.intervals && x.intervals.length; }).length;
    var tg = r.tg || {};
    var tgMsg;
    if (tgN) {
      tgMsg = "｜已载 TextGrid：" + tgN + "/" + r.files.length;
    } else {
      // 明确区分「根本没找到 TextGrid」和「TextGrid 读不出来」，方便定位
      var miss = tg.missing || [], err = tg.error || [];
      if (err.length) {
        tgMsg = "｜TextGrid 解析失败：" + err.slice(0, 2).join("；");
      } else if (miss.length) {
        tgMsg = "｜本页无 TextGrid（缺 " + miss.length + " 个，如 " +
                miss.slice(0, 2).join("、") + "）";
      } else {
        tgMsg = "｜本页均无 TextGrid";
      }
    }
    // 复用回显（2026-09-26）：数据来源要一眼可辨——优先读已存盘中间文件，
    // 缺的才现算，且现算的结果已自动存盘（下次进来直接复用）。
    var nFiles = (r.files || []).length;
    if (r.reuse != null && nFiles) {
      var comp = r.computed || 0;
      tgMsg += comp
        ? "｜数据来源：现算并已存盘 " + comp + "/" + nFiles + "，其余读已存盘中间文件"
        : "｜数据来源：本页全部读已存盘中间文件";
    }
    // 共振峰专属信息：只在该模式下显示，避免 F0 视图里塞入无关内容
    var isFormant = state.mode === "formant";
    if (isFormant) {
      if (r.formantOpt) {
        tgMsg += "｜多数量择优" +
                 (r.optSwitched == null ? "" : "（" + r.optSwitched + "/" + r.optIntervals +
                  " 个音节段换用了别的共振峰数量）");
      }
      // 平滑回显：曲线来源要一眼可辨（TRACK_SKIP 的文件已并入 warns，绝不静默）
      if (r.formantTrack) {
        tgMsg += "｜共振峰已平滑（Track）";
        // 复用对象平滑升级（2026-09-26）：旧裸 burg 对象已补跑 Track 并写回盘上
        if (r.formantUpgraded > 0) {
          tgMsg += "｜本次升级平滑 " + r.formantUpgraded + " 个旧对象（已存盘，下次直接复用）";
        }
      }
    }
    // F0 视图不显示共振峰 Track 相关的警告
    var warns = isFormant ? (r.warnings || []) : [];
    var statusMsg = "本页 " + r.files.length + " 个文件（共 " + r.total +
                    " 个，第 " + (r.page + 1) + " / " + r.pages + " 页）" + tgMsg;
    if (warns.length) statusMsg += "｜⚠ " + warns.join("；");
    setStatus(statusMsg, !tgN && !warns.length, warns.length > 0);
  }

  // --------------------------- 取数据 ---------------------------
  function buildPage() {
    var dir = $("#rgDir").value.trim();
    if (!dir) { toast("先选择声音目录", "error"); return; }
    state.dir = dir; state.page = 0; state.data = null;
    fetchPage("正在调用 Praat 批量抽取本页…");
  }

  function render() {
    var d = state.data;
    if (!d || d.page !== state.page || d.size !== state.size || d.dir !== state.dir) {
      return fetchPage("正在加载第 " + (state.page + 1) + " 页…");
    }
    renderPager();
    renderCells();
  }

  // 审查抽取参数 = 用户当前设置。**审查阶段看到什么，批量运行就必须用什么**——
  // 两条路参数不同的话，同一批数据「审核过」与「未审核」会得到两套不同的 F0/共振峰
  // （历史缺口：这里写死 75/500/5500/5，而批量默认是 f0min 50 / f0max 300 / 5000）。
  // 只回传能解析出来的项；一项都取不到（如 app.js 未加载）时返回空对象，
  // 由后端用默认值兜底，行为与改动前一致。
  function reviewParams() {
    var v = (window.state && window.state.values) || {};
    var map = { pitchFloor: "f0min", pitchCeiling: "f0max",
                formantCeiling: "maxFormantHz", nFormants: "maxNumFormants",
                // 导出对象的时间步必须 = 批量的 intervalFixed：praatSauce 对齐时间网格时
                // 对帧数不足的序列是补 0，不插值，步长不一致会在结果里刷出一大片 0。
                timeStep: "intervalFixed" };
    var out = {};
    Object.keys(map).forEach(function (k) {
      var x = parseFloat(v[map[k]]);
      if (isFinite(x) && x > 0) out[k] = x;
    });
    return out;
  }

  function fetchPage(statusMsg) {
    if (state.busy) return;
    state.busy = true;
    if (statusMsg) setStatus(statusMsg, false);
    // 共振峰默认 Viterbi 平滑（Track）——与详情页同一拍板（2026-09-26「两处都默认平滑」）。
    // 这里显式传 true（后端同为此默认），让"看到的就是平滑轨迹"；要关只能改后端默认。
    var req = { dir: state.dir, page: state.page, size: state.size,
                formantOpt: true, formantTrack: true };
    var rp = reviewParams();
    Object.keys(rp).forEach(function (k) { req[k] = rp[k]; });
    api("/api/review/grid", req).then(function (r) {
      state.busy = false;
      if (!r.ok) { setStatus(r.error || "失败", true); return; }
      state.data = r;
      // 后端可能把工作目录切到 Resample/（重采样后），把目录标签同步成实际工作副本，
      // 避免界面显示父目录、实际却读 Resample/ 同名文件的「目录读取混乱」。
      if (r.dir) {
        state.dir = r.dir;
        var _rd = $("#rgDir"); if (_rd) _rd.value = r.dir;
      }
      // 纵轴上限跟抽取参数走，否则改设置后轨迹会与语图错位
      if (r.formantCeiling) FMAX_FORMANT = r.formantCeiling;
      applyStatus(r);
      // 排障用：打开 F12 控制台即可看到每个文件实际拿到了几段 TextGrid
      try {
        var _tgN = (r.files || []).filter(function (x) { return x.intervals && x.intervals.length; }).length;
        var _tg = r.tg || {};
        console.log("[review-grid]", "目录：", r.dir, "｜TextGrid：载入", _tgN, "个 / 缺",
                    (_tg.missing || []).length, "个 / 解析失败", (_tg.error || []).length, "个");
        (r.files || []).forEach(function (x) {
          console.log("   ", x.name, "时长", x.duration, "→ TextGrid",
                      (x.intervals || []).length, "段；F0", (x.pitch || []).length,
                      "点；共振峰", (x.formant || []).length, "点");
        });
      } catch (e) { /* 忽略控制台不可用的情况 */ }
      renderPager(); renderCells();
    }).catch(function (e) { state.busy = false; setStatus(String(e), true); });
  }

  // 语图是按 (画布尺寸 × 窗长 × 动态范围 × 时间窗) 缓存的，任一参数变了就作废重算
  function clearSpec() {
    var fs = (state.data && state.data.files) || [];
    fs.forEach(function (f) { f._specCache = null; f._specPending = null; });
  }
  function clearSpecOf(f) { f._specCache = null; f._specPending = null; }

  function renderPager() {
    var d = state.data;
    $("#rgPageInfo").textContent = d ? ("第 " + (d.page + 1) + " / " + d.pages + " 页") : "—";
    $("#rgPrev").disabled = !d || d.page <= 0;
    $("#rgNext").disabled = !d || d.page >= d.pages - 1;
  }

  function renderCells() {
    var box = $("#rgCells");
    var d = state.data;
    stopPlayback();     // 重绘会把播放按钮换掉，先停掉正在响的那条
    box.dataset.size = state.size;
    box.style.gridTemplateColumns = "repeat(" +
      (COLS[state.size] || Math.ceil(Math.sqrt(state.size))) + ", minmax(0, 1fr))";
    box.innerHTML = "";
    if (!d || !d.files.length) {
      box.innerHTML = '<div class="rg-empty muted">该目录没有 wav 文件，或本页为空。</div>';
      return;
    }
    // F0 纵轴：**整页共用一根自适应轴**（按本页所有文件的 F0 范围算）——
    // 每格各算一根的话，格子之间就没法横向比了。语图固定 0–FMAX_SPEC。
    state.f0Range = f0AutoRange(d.files.map(function (x) { return { points: x.pitch }; }));
    d.files.forEach(function (f) {
      var cell = document.createElement("div");
      cell.className = "rg-cell";
      var name = document.createElement("div");
      name.className = "rg-name";
      name.textContent = f.name;
      name.title = f.path;
      // 文件名常被截断，悬停看完整路径是「数据」不是「说明」，保留原生气泡
      name.setAttribute("data-keep-title", "");
      var cv = document.createElement("canvas");
      cv.className = "rg-canvas";
      cv.width = 300; cv.height = 150;
      cell.appendChild(name);
      cell.appendChild(cv);
      // 勾选框（右上角）：勾选后参与「重测」。点它不触发打开详情
      var chk = document.createElement("input");
      chk.type = "checkbox";
      chk.className = "rg-check";
      chk.checked = selSet().has(f.name);
      chk.title = "勾选后参与「重测」";
      chk.onclick = function (e) {
        e.stopPropagation();
        if (this.checked) selSet().add(f.name);
        else selSet().delete(f.name);
      };
      cell.appendChild(chk);
      // 试听：点按钮播放这一条，不触发「打开详情」
      var play = document.createElement("button");
      play.className = "rg-play";
      play.textContent = "▶";
      play.title = "试听这一条";
      play.onclick = function (e) { e.stopPropagation(); togglePlayback(f.path, play); };
      cell.appendChild(play);
      box.appendChild(cell);
      cell.onclick = function () { openDetail(f); };
      drawCell(cv, f, state.mode);
    });
    // 全选框状态：仅当本页所有文件都被勾选时才打勾
    var allNames = d.files.map(function (f) { return f.name; });
    $("#rgSelectAll").checked =
      allNames.length > 0 && allNames.every(function (n) { return selSet().has(n); });
  }

  // --------------------------- 批量重测（覆盖式单维强抽） ---------------------------
  // 流程：点「重测」→ 后端 scan 列出选中文件的手工修正 → 弹参数框（按模式给基频/共振峰参数
  // + 修正清单逐文件勾选覆盖/跳过）→ 开始：后端 execute 用新参数重抽并覆盖落盘 + 清该维标记。
  var rgRerunNames = [];   // 本次参与重测的候选文件名（当前页已勾选）

  function currentPageSelectedNames() {
    var all = state.data && state.data.files
      ? state.data.files.map(function (f) { return f.name; }) : [];
    return all.filter(function (n) { return selSet().has(n); });
  }

  function openRerun() {
    var names = currentPageSelectedNames();
    if (!names.length) {
      toast("先勾选要重测的文件（点每格右上角的框）", "error");
      return;
    }
    setStatus("正在检查选中文件的手工修正…", false);
    api("/api/review/rerun", { action: "scan", dir: state.dir, names: names, mode: state.mode })
      .then(function (r) {
        if (!r.ok) { setStatus(r.error || "失败", true); return; }
        showRerunModal(names, r.corrections || []);
      }).catch(function (e) { setStatus(String(e), true); });
  }

  function showRerunModal(names, corrList) {
    rgRerunNames = names || [];
    // 参数预填：优先当前网格回显，其次用户设置，再次兜底默认值
    var sv = (window.state && window.state.values) || {};
    var rp = reviewParams();
    $("#rgRerunF0min").value = rp.pitchFloor || parseFloat(sv.f0min) || 75;
    $("#rgRerunF0max").value = rp.pitchCeiling || parseFloat(sv.f0max) || 500;
    $("#rgRerunMaxFormant").value = rp.formantCeiling || parseFloat(sv.maxFormantHz) || 5500;
    $("#rgRerunNFormants").value = rp.nFormants || parseFloat(sv.maxNumFormants) || 5;
    // 按模式显隐参数组（重测跟模式走·单维：F0 模式只给基频参数，共振峰模式只给共振峰参数）
    var isF0 = state.mode === "f0";
    $("#rgRerunF0minField").classList.toggle("hidden", !isF0);
    $("#rgRerunF0maxField").classList.toggle("hidden", !isF0);
    $("#rgRerunMaxFormantField").classList.toggle("hidden", isF0);
    $("#rgRerunNFormantsField").classList.toggle("hidden", isF0);
    // 手工修正清单：默认都"跳过"（保护手工成果），需显式勾选才覆盖
    var box = $("#rgRerunCorrections");
    var list = $("#rgRerunCorrList");
    list.innerHTML = "";
    if (corrList && corrList.length) {
      box.classList.remove("hidden");
      corrList.forEach(function (c) {
        var row = document.createElement("label");
        row.className = "rg-rerun-corr-row";
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = false;
        cb.dataset.name = c.name;
        var span = document.createElement("span");
        span.innerHTML = esc(c.name) + ' <span class="muted small">（' +
          esc((c.types || []).join("、")) + "）</span>";
        row.appendChild(cb); row.appendChild(span);
        list.appendChild(row);
      });
    } else {
      box.classList.add("hidden");
    }
    $("#rgRerunModal").classList.remove("hidden");
  }

  function closeRerun() { $("#rgRerunModal").classList.add("hidden"); }

  function startRerun() {
    // 修正清单里未勾选覆盖的文件 → 跳过
    var skip = {};
    $$("#rgRerunCorrList input[type=checkbox]").forEach(function (cb) {
      if (!cb.checked) skip[cb.dataset.name] = true;
    });
    var names = rgRerunNames.filter(function (n) { return !skip[n]; });
    if (!names.length) {
      toast("没有要覆盖的文件（修正文件都选了跳过）", "error");
      return;
    }
    var isF0 = state.mode === "f0";
    var req = {
      action: "execute", dir: state.dir, mode: state.mode,
      // 与九宫格取数同款：默认多数量择优 + Viterbi 平滑，保证重测结果与网格一致
      formantOpt: true, formantTrack: true,
      pitchFloor: parseFloat($("#rgRerunF0min").value) || 75,
      pitchCeiling: parseFloat($("#rgRerunF0max").value) || 500,
      formantCeiling: parseFloat($("#rgRerunMaxFormant").value) || 5500,
      nFormants: parseFloat($("#rgRerunNFormants").value) || 5,
      names: names,
    };
    closeRerun();
    setStatus("正在用新参数重测 " + names.length + " 个文件…", false);
    api("/api/review/rerun", req).then(function (r) {
      if (!r.ok) { setStatus(r.error || "失败", true); return; }
      var msg = "重测完成：" + (r.done || []).length + " 个覆盖写入";
      if (r.errors && r.errors.length) msg += "，" + r.errors.length + " 个失败";
      if (r.warnings && r.warnings.length) msg += "；⚠ " + r.warnings.join("；");
      setStatus(msg, !!(r.errors && r.errors.length));
      selSet().clear();
      fetchPage(null);   // 重新取数，展示重测后的新曲线
      toast(msg, (r.errors && r.errors.length) ? "error" : "ok");
    }).catch(function (e) { setStatus(String(e), true); });
  }

  // ------------------------------ 绘制 ------------------------------
  function drawCell(cv, f, mode) {
    if (mode === "f0") drawF0Cell(cv, f);
    else drawFormantCell(cv, f);
  }

  // F0 曲线的自适应纵坐标（2026-09-22：与语图各自独立）。按给定曲线的实际频率范围
  // 留 15% 余量后铺满整个绘图区——否则 F0 只占图高 1/5，扁得看不清。
  // 九宫格传"整页所有文件"的点 → 每格同一根轴，格子之间才能横向比。
  function f0AutoRange(sets) {
    var lo = Infinity, hi = -Infinity;
    (sets || []).forEach(function (s) {
      (s && s.points || []).forEach(function (p) {
        if (p.f0 == null || !(p.f0 > 0)) return;
        if (p.f0 < lo) lo = p.f0;
        if (p.f0 > hi) hi = p.f0;
      });
    });
    if (!isFinite(lo)) return [0, FMAX_F0];   // 一点都没测到 → 退回语图那根轴
    var pad = Math.max(6, (hi - lo) * 0.15);
    lo -= pad; hi += pad;
    if (hi - lo < 40) { var mid = (lo + hi) / 2; lo = mid - 20; hi = mid + 20; }
    return [Math.max(0, Math.floor(lo / 10) * 10), Math.ceil(hi / 10) * 10];
  }

  // F0 纵轴默认范围（2026-09-26 用户拍板，取代旧「自适应」——用户嫌它随意）：
  // 男 50–250、女 100–350；性别未知时从男档（覆盖更宽的低频）。
  function f0GenderRange() {
    var g = "";
    try { g = $("#rgGender").value || ""; } catch (e) { /* 打桩环境无此元素 */ }
    return g === "female" ? [100, 350] : [50, 250];
  }

  // 性别 → F0 纵轴默认范围**显式联动**（2026-09-26 用户反馈：切性别框里数字必须
  // 跟着变，不能只有"空框隐式跟随"——用户看不出联动了）：把「音高下限/上限」
  // 两个框直接填上该性别的默认数字。之后手改框仍可覆盖（输入优先于性别默认）。
  function syncF0RangeInputs() {
    var d = f0GenderRange();
    state.f0Top = d[1];
    state.f0Bottom = d[0];
    $("#rgF0Top").value = String(d[1]);
    $("#rgF0Bottom").value = String(d[0]);
  }

  // 详情页 F0 纵轴范围：顶部「音高下限/上限」输入优先（state.f0Bottom/f0Top，
  // 默认填性别数字 男 50–250 / 女 100–350，清空即回退到该值）。手工点加在离曲线很远的地方时点和桥接曲线
  // 不能被裁到画布外（2026-09-26 拍板）——固定范围也要罩住它们。
  function f0DetailRange(f) {
    var d = f0GenderRange();
    var lo = +state.f0Bottom;
    var hi = +state.f0Top;
    if (!(lo > 0)) lo = d[0];
    if (!(hi > 0)) hi = d[1];
    if (hi <= lo) hi = lo + 50;    // 防呆：上限必须高于下限
    (f._manual || []).forEach(function (p) {
      if (!p || p.f0 == null || !(p.f0 > 0)) return;
      if (p.f0 < lo) lo = p.f0;
      if (p.f0 > hi) hi = p.f0;
    });
    lo = Math.max(0, Math.floor(lo / 10) * 10);
    hi = Math.ceil(hi / 10) * 10;
    return [lo, Math.max(hi, lo + 40)];
  }

  // F0 纵坐标：把 [rng[0], rng[1]] 线性映射到绘图区（与语图的 0–FMAX_F0 无关）
  function f0HzToY(hz, rng, padT, ph) {
    return padT + (1 - (hz - rng[0]) / ((rng[1] - rng[0]) || 1)) * ph;
  }

  // 右侧 F0 刻度（橙色，与左侧语图的灰色刻度区分开：一个轴一套数）
  function drawF0Ticks(ctx, x, padT, ph, rng, font) {
    ctx.save();
    ctx.fillStyle = F0_COLOR;
    ctx.font = font + " sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(fmtHz(rng[1]), x + 3, padT + 8);
    ctx.fillText(fmtHz(rng[0]), x + 3, padT + ph);
    ctx.restore();
  }

  // 中间三条横向网格线（2026-09-25 用户要求：方便估读数值）。
  // 在绘图区高度的 1/4、2/4、3/4 处各打一条淡线，并在 labelX 处标该线的数值；
  // 一条线在左右两套纵轴上各有一个值（如 F0 页左=语图 0–FMAX、右=F0 自适应），
  // 所以同一组线可以标两套数。alignRight=true 时 labelX 是右边界、文字右对齐。
  // 数值带半透明白底小片，压在语图上也读得清。
  function drawHGrid(ctx, x0, y0, pw, ph, lo, hi, labelX, color, font, alignRight, div) {
    ctx.save();
    ctx.strokeStyle = "rgba(130,140,160,0.30)";
    ctx.lineWidth = 1;
    ctx.font = (font || "9px") + " sans-serif";
    ctx.textAlign = "left";
    var n = div || 4;   // 默认四格（3 条内线）；传 5 = 纵向五格（2026-09-27 用户要求）
    for (var i = 1; i < n; i++) {
      var y = y0 + i * ph / n;
      ctx.beginPath();
      ctx.moveTo(x0, Math.round(y) + 0.5);
      ctx.lineTo(x0 + pw, Math.round(y) + 0.5);
      ctx.stroke();
      var v = hi - (i / n) * (hi - lo);
      var txt = fmtHz(v);
      var tx = alignRight ? (labelX - ctx.measureText(txt).width) : labelX;
      ctx.fillStyle = "rgba(250,251,252,0.78)";
      ctx.fillRect(tx - 2, y - 6, ctx.measureText(txt).width + 4, 11);
      ctx.fillStyle = color || "#8a93a6";
      ctx.fillText(txt, tx, y + 3.5);
    }
    ctx.restore();
  }

  function drawF0Cell(cv, f) {
    var ctx = cv.getContext("2d");
    var W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fafbfc"; ctx.fillRect(0, 0, W, H);
    var padL = 30, padR = 24, padT = 6, padB = 14;
    var pw = W - padL - padR, ph = H - padT - padB;
    var vr = viewRange(f);
    var pts = f.pitch || [];
    var rng = state.f0Range || [0, FMAX_F0];
    // 背景语图：窄带 25 ms + 0–FMAX_SPEC（2 kHz，F0 页专用；与共振峰页 FMAX_FORMANT 不混）
    paintSpectrogramIn(ctx, f, padL, padT, pw, ph, FMAX_SPEC, bandFor("f0"), vr);
    drawAxis(ctx, padL, padT, pw, ph, 0, FMAX_SPEC);
    drawF0Ticks(ctx, padL + pw, padT, ph, rng, "9px");
    // 中间三条网格线：左灰=语图轴数值、右橙=F0 自适应轴数值（两套各自标）
    drawHGrid(ctx, padL, padT, pw, ph, 0, FMAX_SPEC, 2, "#8a93a6", "9px", false, 5);
    drawHGrid(ctx, padL, padT, pw, ph, rng[0], rng[1], W - 1, F0_COLOR, "9px", true);
    paintSegments(ctx, f, function (t) { return mapT(t, vr, padL, pw); }, padT, padT + ph);
    ctx.strokeStyle = F0_COLOR; ctx.lineWidth = 2.0; ctx.beginPath();
    var started = false;
    pts.forEach(function (p) {
      // 静音/缝隙里 Praat 也会给值（常常是乱跳的倍频/半频），一律不画
      if (p.f0 == null || p.f0 <= 0 || !inSyllable(f, p.t)) { started = false; return; }
      var x = mapT(p.t, vr, padL, pw);
      var y = f0HzToY(p.f0, rng, padT, ph);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // 画语图底。方格内绘制（x,y,w,h 为绘图区），fmax / winMs 由调用方给定：
  // 共振峰页用 0–FMAX_FORMANT + 宽带；F0 页用 0–FMAX_SPEC（2 kHz）+ 窄带。两页窗长/上限各自独立。
  // 缓存键含全部影响结果的量（含矩形与 fmax/winMs），任一变化都重算。
  // redraw（可选）：语图是异步算的，算完后调它重画调用方那块画布——九宫格/详情走
  // 默认的 redrawFile，第四步「查看测量结果」走自己的 rvRedrawFile（两处画布不同）。
  function paintSpectrogramIn(ctx, f, x, y, w, h, fmax, winMs, vr, advanced, redraw) {
    var key = [x, y, w, h, fmax, winMs, state.dyn,
               vr[0].toFixed(3), vr[1].toFixed(3)].join("|");
    f._specCache = f._specCache || {};
    f._specPending = f._specPending || {};
    if (f._specCache[key]) { ctx.drawImage(f._specCache[key], x, y, w, h); return; }
    if (f._specPending[key]) return;         // 同一份已在算（九宫格 + 大图会各请求一次）
    f._specPending[key] = true;
    fetchWav(f.path).then(function (buf) {
      // 按画布实际像素算（不降采样）：宽带窗短、FFT 便宜，1:1 才不会糊
      var sp = computeSpectrogram(buf, Math.max(120, w), Math.max(80, h), fmax,
                                  winMs, state.dyn, vr[0], vr[1], advanced);
      f._specPending[key] = false;
      if (!sp) return;
      f._specCache[key] = sp;
      (redraw || redrawFile)(f);             // 语图到位，重画调用方那块画布
    }).catch(function () { f._specPending[key] = false; /* 无语图，退化为纯线 */ });
  }

  // 铺满整幅画布（共振峰页用，语图与共振峰线共用 0–FMAX_FORMANT 线性纵轴）
  function paintSpectrogram(ctx, f, W, H, vr, advanced) {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fafbfc"; ctx.fillRect(0, 0, W, H);
    paintSpectrogramIn(ctx, f, 0, 0, W, H, FMAX_FORMANT, bandFor("formant"), vr, advanced);
  }

  function drawFormantCell(cv, f) {
    var ctx = cv.getContext("2d");
    var W = cv.width, H = cv.height;
    var vr = viewRange(f);
    // 时间坐标与语图共用 viewRange，TextGrid 边界/底色叠在最上层
    paintSpectrogram(ctx, f, W, H, vr);
    // 中间三条网格线 + 左侧数值（语图与共振峰线共用 0–FMAX_FORMANT 一根轴）
    drawHGrid(ctx, 0, 0, W, H, 0, FMAX_FORMANT, 2, null, "9px", false, 5);
    paintSegments(ctx, f, function (t) { return mapT(t, vr, 0, W); }, 0, H);
    paintFormantLines(ctx, cv, f, FMAX_FORMANT, vr);
  }

  // 某文件的语图算完后重画它出现的所有画布（九宫格 + 详情大图）
  function redrawFile(f) {
    renderCells();
    if (state.detailFile === f) drawDetail(f);
  }

  /** 画一组共振峰点（F1/F2/F3 三色）。fmax 是纵轴上限，必须与语图同源，否则会"错位"。
   *  override 可整体覆盖颜色/线宽/线型：{color, width, dash}，width 可以是数组（按 F1/F2/F3 分别给）。
   *  dash 为 null/空数组 = 实线（线型用来区分"同一上限下的不同共振峰数量"）。
   */
  function paintFormantSeries(ctx, f, pts, W, H, vr, fmax, styles, override) {
    var list = styles || FORMANT_STYLE_CELL;
    var dash = (override && override.dash) || null;
    if (dash && dash.length) ctx.setLineDash(dash);
    list.forEach(function (pair, i) {
      ctx.strokeStyle = (override && override.color) || pair[1];
      ctx.lineWidth = (override && override.width != null)
        ? (Array.isArray(override.width) ? override.width[i] : override.width)
        : pair[2];
      ctx.beginPath();
      var st = false;
      (pts || []).forEach(function (p) {
        var v = p[pair[0]];
        // 只保留落在音节段内的共振峰点；音节之外（sil / 缝隙）的乱点不画
        if (v == null || v <= 0 || !inSyllable(f, p.t)) { st = false; return; }
        var x = mapT(p.t, vr, 0, W);
        var y = H - (v / fmax) * H;
        if (!st) { ctx.moveTo(x, y); st = true; } else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
    ctx.setLineDash([]);
  }

  function paintFormantLines(ctx, cv, f, fmax, vr, styles) {
    var W = cv.width, H = cv.height;
    // 该文件记了「已平滑」，九宫格里共振峰曲线改用 Track 平滑轨迹（与详情页同一份），
    // 让"存盘后回到九宫格"立刻看到平滑效果，而不是现算的 raw burg。
    var pts = (f.formantSmoothed && f._smoothed && f._smoothed.length)
      ? f._smoothed : f.formant;
    paintFormantSeries(ctx, f, pts, W, H, vr, fmax, styles || FORMANT_STYLE_CELL);
    // 频率参考（左上 5k / 左下 0）—— 语图已反相为浅底，故用深字
    ctx.fillStyle = "rgba(20,24,35,0.8)"; ctx.font = "10px sans-serif";
    ctx.fillText((fmax / 1000) + "k", 3, 11);
    ctx.fillText("0", 3, H - 3);
  }

  function fmtHz(v) {
    v = Math.round(v);
    return v >= 1000 ? (v / 1000) + "k" : String(v);
  }

  // 坐标轴框 + 上下限标签。F0 页纵轴固定 0–FMAX_F0（与语图同源）。
  function drawAxis(ctx, padL, padT, pw, ph, lo, hi) {
    ctx.strokeStyle = "#e2e6ee"; ctx.lineWidth = 1;
    ctx.strokeRect(padL, padT, pw, ph);
    ctx.fillStyle = "#8a93a6"; ctx.font = "9px sans-serif";
    ctx.fillText(fmtHz(hi), 2, padT + 8);
    ctx.fillText(fmtHz(lo), 2, padT + ph);
  }

  // 判断某时刻是否落在"音节"（非 sil、非空）区间内；无 TextGrid 时一律保留。
  // TextGrid 里一段非静音都没有（比如还没切分完）时也全部保留——否则整格会被遮空。
  function inSyllable(f, t) {
    var ivs = f.intervals || [];
    if (!ivs.length) return true;
    var hasSyl = false;
    for (var i = 0; i < ivs.length; i++) {
      var lab = (ivs[i].label || "").trim().toLowerCase();
      if (lab === "sil" || lab === "") continue;
      hasSyl = true;
      if (t >= ivs[i].t0 && t <= ivs[i].t1) return true;
    }
    return !hasSyl;
  }

  // 视图时间窗 = 整段音频：首尾静音也照样显示，TextGrid 只作为叠加在上面的时间标记，
  // 让人看清"音节落在哪"与"测出来的数值"的对应关系，不做任何裁剪放大。
  function viewRange(f) {
    return [0, (f.duration || 1) || 1];
  }

  // 时间 → 画布 x（vr 为 [起始, 结束] 时间窗，x0/pw 为绘图区左边界与宽度）
  function mapT(t, vr, x0, pw) {
    return x0 + ((t - vr[0]) / ((vr[1] - vr[0]) || 1)) * pw;
  }

  // 叠加 TextGrid 音节段：音节段浅蓝底、静音段淡灰底 + 清晰边界竖线 + 段标签。
  // 时间坐标与曲线/语图对齐；边界线贯穿整幅，便于一眼看清「曲线落在哪个音段」。
  function paintSegments(ctx, f, mapX, yTop, yBot) {
    var ivs = f.intervals || [];
    if (!ivs.length) return;
    // 1) 段底色（音节=浅蓝，sil=淡灰）；裁剪后首尾静音可能落在画布外，按画布边界夹住
    var CW = ctx.canvas.width;
    ivs.forEach(function (iv) {
      var lab = (iv.label || "").trim().toLowerCase();
      var a = Math.min(mapX(iv.t0), mapX(iv.t1)), b = Math.max(mapX(iv.t0), mapX(iv.t1));
      if (b <= 0 || a >= CW) return;
      a = Math.max(0, a); b = Math.min(CW, b);
      ctx.fillStyle = (lab === "sil" || lab === "")
        ? "rgba(120,120,130,0.13)"
        : "rgba(47,111,237,0.24)";
      ctx.fillRect(a, yTop, Math.max(1, b - a), yBot - yTop);
    });
    // 2) 边界竖线（每段衔接处，贯穿整幅，清晰可见）
    var edges = [];
    ivs.forEach(function (iv) { edges.push(iv.t0); edges.push(iv.t1); });
    ctx.save();
    ctx.strokeStyle = "rgba(30,41,59,0.6)";
    ctx.lineWidth = 1.2;
    ctx.setLineDash([]);
    ctx.beginPath();
    edges.forEach(function (t) {
      var x = mapX(t);
      ctx.moveTo(x, yTop); ctx.lineTo(x, yBot);
    });
    ctx.stroke();
    // 3) 音节段标签（段宽足够才写，避免九宫格小格互相叠字）
    ctx.fillStyle = "rgba(30,41,59,0.85)";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "center";
    ivs.forEach(function (iv) {
      var lab = (iv.label || "").trim();
      if (lab === "" || lab.toLowerCase() === "sil") return;
      var x0 = mapX(iv.t0), x1 = mapX(iv.t1);
      if (Math.abs(x1 - x0) < 22) return;   // 太窄不写
      ctx.fillText(lab, (x0 + x1) / 2, yTop + 9);
    });
    ctx.textAlign = "left";
    ctx.restore();
  }

  // --------------------- 浏览器实时 STFT 语图（共振峰背景） ---------------------
  function fetchWav(path) {
    return fetch("/api/review/wav?path=" + encodeURIComponent(path))
      .then(function (r) { if (!r.ok) throw new Error("wav " + r.status); return r.arrayBuffer(); })
      .then(function (ab) {
        if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        return _audioCtx.decodeAudioData(ab);
      });
  }

  // ------------------------------------------------------------------
  // 语图：为保证「共振峰轨迹压在共振峰暗纹上」，纵轴必须和共振峰线共用同一套坐标：
  //   共振峰线   y = H - (v/fmax)*H
  //   语图像素   第 b 行映射频率 v = (b/(freqBins-1))*fmax，再翻转写到 row=freqBins-1-b
  //             → drawImage 铺到 H 后，canvas y = (1 - v/fmax)*H  ← 与上者逐点相同
  // 频率轴是**线性**的（不能取对数），否则无法与共振峰线对齐。
  // ------------------------------------------------------------------
  // 多锥度（multitaper）正弦锥序列：详情页「更精细语图」用。每个频率点做 K 套正交互谱的平均，
  // 方差大幅下降、共振峰暗纹更干净，同时保持峰值位置（频率分辨由窗长 N 决定，多锥度不牺牲它）。
  // 只依赖窗长 N 与锥数 K，与音频无关 → 按 (N,K) 缓存复用，避免每次重算。
  var MT_K = 4;
  var _mtTapers = {};
  function getSineTapers(N, K) {
    var key = N + ":" + K;
    if (_mtTapers[key]) return _mtTapers[key];
    var tapers = [];
    var norm = Math.sqrt(2 / (N + 1));
    for (var k = 1; k <= K; k++) {
      var t = new Float64Array(N);
      for (var n = 0; n < N; n++) t[n] = norm * Math.sin(Math.PI * k * (n + 1) / (N + 1));
      tapers.push(t);
    }
    _mtTapers[key] = tapers;
    return tapers;
  }

  // 计算语图（返回 framesCol×freqBins 的灰阶离屏 canvas）。
  // advanced=true → 多锥度（详情页，更精细）；false → 单高斯窗（九宫格，便宜）。
  function computeSpectrogram(audioBuffer, framesCol, freqBins, fmax, winMs, dynRange, tStart, tEnd, advanced) {
    var data = audioBuffer.getChannelData(0);
    var sr = audioBuffer.sampleRate;
    var len = data.length;
    // 窗长 = 带宽旋钮（**窗越短越"宽带"**，别写反）：
    //   宽带 5 ms  → 时间细、频率糊（Δf ≈ 1/窗长 ≈ 200 Hz，大于谐波间距）
    //                → 单根谐波被糊掉，看到的是**共振峰暗纹**与**浊音横杠**（声门脉冲竖纹）。
    //   窄带 25 ms → 频率细（Δf ≈ 40 Hz，小于谐波间距）→ 能看到**单根谐波**与基频走向，
    //                代价是时间糊，看不到浊音横杠。
    //   极窄带 50 ms → Δf ≈ 20 Hz，F0 低于 ~80 Hz 的低男声（谐波间距 < 80 Hz）在 25 ms 下
    //                峰与谷会落进同一个分析 bin 而分不开（实测 F0=50 Hz 对比度仅 0.1 dB），
    //                50 ms 可回到可用区间；代价是时间更糊，只适合看基频走向、别拿它看音段边界。
    // N 取最接近目标窗长的 2 的幂（本 FFT 要求 2 的幂）。
    var want = (winMs || 5) / 1000 * sr;
    var N = Math.pow(2, Math.round(Math.log(want) / Math.LN2));
    N = Math.max(64, Math.min(2048, N));
    while (N > 64 && len < N * 2) N = N / 2;   // 极短音频退化，避免整帧补零
    // 只分析视图内的那一段（裁剪后 = 音节段），把横向分辨率全花在有音的部分
    var s0 = Math.max(0, Math.floor((tStart || 0) * sr));
    var s1 = Math.min(len, Math.ceil((tEnd || (len / sr)) * sr));
    var segLen = Math.max(1, s1 - s0);
    var hop = Math.max(1, Math.floor((segLen - N) / Math.max(1, framesCol - 1)));

    // 窗型按带宽分工：
    //   窄带(≥20 ms)用 Hann（能量铺满整窗，频率分辨率实打实=1/窗长，把间距=F0 的谐波一根根分开）。
    //   宽带(<20 ms)用 Praat 标准高斯窗 w=(exp(-48·phase²)-edge)/(1-edge)，无旁瓣、时间锐、共振峰暗纹干净。
    //   频率分辨率不再靠窗型硬扛——FFT 零填充过采样已把分箱间隔降到 sr/nFFT（见下方 nFFT）。
    var nFFT = Math.min(8192, Math.pow(2, Math.ceil(Math.log2(8 * N))));
    var win = new Float64Array(N);
    var windowssq = 0;
    if (winMs >= 20) {
      for (var wh = 0; wh < N; wh++) { win[wh] = 0.5 - 0.5 * Math.cos(2 * Math.PI * wh / (N - 1)); windowssq += win[wh] * win[wh]; }
    } else {
      var imid = 0.5 * (N + 1), edge = Math.exp(-12);
      for (var w = 0; w < N; w++) { var ph = (w - imid) / N; win[w] = (Math.exp(-48 * ph * ph) - edge) / (1 - edge); windowssq += win[w] * win[w]; }
    }

    // 只取到 fmax 的那一段频谱（超出部分不参与显示，也不参与归一化，避免被高频抬高基准）
    var binHz = sr / nFFT;
    var maxBin = Math.round(fmax / binHz);
    maxBin = Math.max(1, Math.min(maxBin, Math.floor(nFFT / 2)));
    var nBin = maxBin + 1;

    // 1) 逐帧 FFT → dB
    // 多锥度 = K 套正交锥的周期图在功率上平均，代价是频谱被按 ~(K+1)/T 平滑，
    // 有效频率分辨率比单窗（~1/T）差约 K+1 倍。所以它对两种目标的利害相反：
    //   · 共振峰是**宽峰**（几十~上百 Hz 宽）：压掉随机方差后暗纹更连贯 → 有益。
    //   · 谐波是**极窄谱线**：本就靠 Δf≈1/T 才勉强分开，再平滑一次相邻谐波之间的
    //     谷就被填平、糊成一片 → 有害（这正是"窄带看不清谐波"的根因）。
    // 窄带窗（≥20 ms）存在的唯一理由就是用频率分辨率换谐波，故一律退回单窗（Hann）。
    var useMT = !!advanced && winMs < 20;
    var tapers = useMT ? getSineTapers(N, MT_K) : null;
    var mag = new Float64Array(framesCol * nBin);
    var maxDB = -Infinity;
    // 能量守恒归一化：10·log10(功率/wssq)，wssq=Σwin²（单窗）或 1.0（多锥度正弦锥已归一化）。
    // FFT 长度放大到 nFFT 并零填充：频率分箱间隔 = sr/nFFT，短窗也能拿到细分箱（共振峰带不糊）。
    var wssq = useMT ? 1.0 : windowssq;
    var re = new Float64Array(nFFT), im = new Float64Array(nFFT);
    var accPow = useMT ? new Float64Array(nBin) : null;
    var invK = useMT ? (1 / tapers.length) : 0;
    for (var c = 0; c < framesCol; c++) {
      var start = s0 + Math.min(Math.max(0, segLen - N), c * hop);
      if (useMT) {
        // 多锥度：K 套正弦锥分别加窗做周期图，在功率上平均 → 方差骤降、共振峰带更连贯；
        // 正弦锥已归一化（Σtp²≈1），故 wssq=1.0，功率直接取 (re²+im²)。
        for (var ak = 0; ak < nBin; ak++) accPow[ak] = 0;
        for (var tk = 0; tk < tapers.length; tk++) {
          var tp = tapers[tk];
          for (var i2 = 0; i2 < nFFT; i2++) re[i2] = (i2 < N ? (data[start + i2] || 0) * tp[i2] : 0);
          for (var z2 = 0; z2 < nFFT; z2++) im[z2] = 0;
          fft(re, im);
          for (var k2 = 0; k2 < nBin; k2++) {
            accPow[k2] += (re[k2] * re[k2] + im[k2] * im[k2]) / wssq;
          }
        }
        for (var k3 = 0; k3 < nBin; k3++) {
          var db2 = 10 * Math.log10(accPow[k3] * invK + 1e-30);
          mag[c * nBin + k3] = db2;
          if (db2 > maxDB) maxDB = db2;
        }
      } else {
        for (var i = 0; i < nFFT; i++) re[i] = (i < N ? (data[start + i] || 0) * win[i] : 0);
        for (var z = 0; z < nFFT; z++) im[z] = 0;
        fft(re, im);
        for (var k = 0; k < nBin; k++) {
          var db = 10 * Math.log10((re[k] * re[k] + im[k] * im[k]) / wssq + 1e-30);
          mag[c * nBin + k] = db;
          if (db > maxDB) maxDB = db;
        }
      }
    }

    // 2) 轻度 3×3 平滑：压掉随机噪点、让共振峰带连贯，但不糊掉 F1/F2 之间的沟
    // nBin 已足够细（零填充过采样），不再做 3×3 模糊——那会抹掉分辨率。

    // 3) dB → 灰阶（反相：背景浅，振幅越大越深）。动态范围越小对比越强：
    //    70 dB 层次多但发灰，30–40 dB 会把弱噪声压成白底、共振峰带更黑更醒目。
    //    nBin 已足够细（零填充过采样），不再做 3×3 模糊——那会抹掉分辨率；显示时按频段对功率(dB)取平均。
    var off = document.createElement("canvas");
    off.width = framesCol; off.height = freqBins;
    var octx = off.getContext("2d");
    var img = octx.createImageData(framesCol, freqBins);
    var DRANGE = dynRange || 40;
    var loDB = maxDB - DRANGE;
    for (var b = 0; b < freqBins; b++) {
      // b=0 → 最低频（贴画布底），b=freqBins-1 → fmax（贴画布顶）。
      // 一行通常覆盖多个 FFT bin：在 [k0,k1) 上取平均，避免点采样产生摩尔纹/锯齿。
      var k0 = Math.floor(b * nBin / freqBins);
      var k1 = Math.floor((b + 1) * nBin / freqBins);
      if (k1 <= k0) k1 = k0 + 1;
      if (k0 > maxBin) k0 = maxBin;
      if (k1 > nBin) k1 = nBin;
      if (k1 <= k0) k1 = k0 + 1;
      if (k0 < 0) k0 = 0;
      if (k1 > nBin) k1 = nBin;
      var row = freqBins - 1 - b;
      for (var c3 = 0; c3 < framesCol; c3++) {
        var s2 = 0, cnt = 0;
        for (var kk = k0; kk < k1; kk++) { s2 += mag[c3 * nBin + kk]; cnt++; }
        var v = ((cnt ? s2 / cnt : mag[c3 * nBin + k0]) - loDB) / DRANGE;
        if (v < 0) v = 0; else if (v > 1) v = 1;
        var g = Math.round(246 - v * 230);
        var idx = (row * framesCol + c3) * 4;
        img.data[idx] = g; img.data[idx + 1] = g; img.data[idx + 2] = g; img.data[idx + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    return off;
  }

  // 迭代基-2 FFT（已用 node 验证：500Hz 正弦峰值落在正确 bin）
  function fft(re, im) {
    var n = re.length;
    for (var i = 1, j = 0; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        var tr = re[i]; re[i] = re[j]; re[j] = tr;
        var ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (var i2 = 0; i2 < n; i2 += len) {
        var cwr = 1, cwi = 0;
        for (var k = 0; k < len / 2; k++) {
          var a = i2 + k, b = i2 + k + len / 2;
          var tr = re[b] * cwr - im[b] * cwi, ti = re[b] * cwi + im[b] * cwr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] = re[a] + tr; im[a] = im[a] + ti;
          var ncwr = cwr * wr - cwi * wi; cwi = cwr * wi + cwi * wr; cwr = ncwr;
        }
      }
    }
  }

  // --------------------------- 元音音标输入（详情页顶部） ---------------------------
  // 主输入框填音节元音 IPA，程序按音段数自动展开下面的文本框（1 段→1 框，2 段→2 框）。
  // 双元音（如 ai）按首尾两元音分别比对参考值、用于共振峰轨迹择优/平滑。
  var IPA_VOWELS = ("iyɨʉɯuɪʏʊeɛøœəɜɵæɐaɑɒɔoʌɤɶɿʅɚɘɞ").split("");
  function parseSegments(ipa) {
    if (!ipa) return [];
    var out = [];
    for (var i = 0; i < ipa.length; i++) {
      if (IPA_VOWELS.indexOf(ipa[i]) >= 0) out.push(ipa[i]);
    }
    var dedup = [];
    for (var j = 0; j < out.length; j++) {
      if (!dedup.length || dedup[dedup.length - 1] !== out[j]) dedup.push(out[j]);
    }
    return dedup;
  }
  function setIpaSegs(segs) {
    var box = $("#rgIpaSegs");
    if (!box) return;
    box.innerHTML = "";
    var list = (segs || []).slice();
    // 至少留一个「音段1」框常驻（用户 2026-09-26：进去就能直接填，不用先想好整个音标串）
    if (!list.length) list = [""];
    list.forEach(function (s) {
      var inp = document.createElement("input");
      inp.type = "text";
      inp.className = "rg-ipa-seg";
      inp.value = s;
      inp.maxLength = 3;
      box.appendChild(inp);
    });
    refreshIpaPlaceholders(box);
  }
  // 每个框的灰字提示 = 它的序号「音段N」（加/删段后重排，序号始终连续）
  function refreshIpaPlaceholders(box) {
    box.querySelectorAll("input.rg-ipa-seg").forEach(function (inp, i) {
      inp.placeholder = "音段" + (i + 1);
    });
  }
  // 手动加/删一个音段文本框：「＋」在末尾追加空框（灰字提示音段N），「－」删最后一个；
  // 删到只剩一个时保留（音段1 常驻）。collectIpaSegs 只认非空框，空框不存。
  function addIpaSeg() {
    var box = $("#rgIpaSegs");
    if (!box) return;
    var inp = document.createElement("input");
    inp.type = "text"; inp.className = "rg-ipa-seg"; inp.value = ""; inp.maxLength = 3;
    box.appendChild(inp);
    refreshIpaPlaceholders(box);
  }
  function delIpaSeg() {
    var box = $("#rgIpaSegs");
    if (!box) return;
    var segs = box.querySelectorAll("input.rg-ipa-seg");
    if (segs.length > 1) box.removeChild(segs[segs.length - 1]);
    refreshIpaPlaceholders(box);
  }
  function collectIpaSegs() {
    var box = $("#rgIpaSegs");
    if (!box) return [];
    var arr = [];
    box.querySelectorAll("input.rg-ipa-seg").forEach(function (inp) {
      var v = (inp.value || "").trim();
      if (v) arr.push(v);
    });
    return arr;
  }

  // --------------------------- 文件详情（选参数 / 手动改 F0 / 存盘） ---------------------------
  // 这一页取代了原来独立的「单文件精修」窗口：多参数候选、选最优、手动改 F0、存盘、
  // 在 Praat 中打开、导入修正数据都在这里；F0 与共振峰用标签页分开看，不再挤在一张图上。
  // 详情页性别默认值：已存盘的优先；否则沿用前面全局已选的说话人（男/女预设，或其性别元数据）。
  // 用 window.state（app.js 暴露的全局）拿 boot，因为本文件的 state 是 IIFE 局部变量。
  function defaultGender(f) {
    var saved = (f.choice && f.choice.speaker);
    if (saved === "male" || saved === "female") return saved;
    var bs = window.state && window.state.boot && window.state.boot.settings;
    var g = (bs && bs.speaker) || "";
    if (g === "male" || g === "female") return g;
    var sp = ((window.state && window.state.boot && window.state.boot.speakers) || [])
      .filter(function (s) { return s.id === g; })[0];
    if (sp && (sp.gender === "male" || sp.gender === "female")) return sp.gender;
    return "";
  }

  function openDetail(f) {
    rd.on = false;          // 正常详情（F0 / 共振峰那一套）：撤掉第四步的「多参数叠加」界面
    state.detailFile = f;
    $("#rgDetailName").textContent = f.name;
    $("#rgDetailPath").value = f.path;
    // 元音音标 / 性别回填（已存盘的 measure.json 里有就恢复）
    var vip = (f.choice && f.choice.vowel_ipa) || [];
    if (typeof vip === "string") vip = parseSegments(vip);
    if (!Array.isArray(vip)) vip = [];
    setIpaSegs(vip);
    // 性别默认：本文件已存盘的优先；否则沿用前面全局已选的说话人（男/女预设，或其性别元数据）。
    // 用户仍可手动改，改后由 save_choice 记回 measure.json。
    $("#rgGender").value = defaultGender(f);
    // 音高上下限输入框直接显示性别默认数字（男 50–250 / 女 100–350）——
    // 与「性别切换联动」共用同一入口 syncF0RangeInputs，避免两处逻辑将来改漏
    syncF0RangeInputs();
    $("#rgSaveAsk").classList.add("hidden");
    // 手工点/删除标记从已存记录回填：不然重开详情后点存盘，会把上次的编辑清空。
    f._manual = f._manual || (f.choice && f.choice.manual) || [];
    f._deleted = f._deleted || (f.choice && f.choice.deleted) || [];
    // 候选状态每维独立（2026-09-25 用户拍板：两个标签页真正分开）——
    // 各页自己生成、自己存，互不覆盖；后端 save_choice 合并写盘。
    f._cands = f._cands || { pitch: null, formant: null };
    f._vis = f._vis || { pitch: {}, formant: {} };
    f._acc = f._acc || { pitch: null, formant: null };
    // 「读入的结果」标记跟着 measure.json 恢复：记着 formantImported 就说明这一维的
    // 定稿是 FormantPath 精修/导入的那条 —— 重开详情要能再存一次，否则会退回重抽。
    f._importedFormant = !!(f.choice && f.choice.formantImported);
    // 滑块预览状态随文件重置；上次存过自定义参数 → 直接按它初始化滑块并预览，
    // 重开详情就能核对"上次用的是哪组参数"。
    f._preview = null;
    resetPrevSliders();
    var savedP = (f.choice && f.choice.pitch && f.choice.pitch.method &&
                  f.choice.pitch.params) ? f.choice.pitch : null;
    if (savedP) {
      state.prev.method = savedP.method;
      $$("#rgPrevMethod .seg-btn").forEach(function (x) {
        x.classList.toggle("active", x.dataset.m === state.prev.method);
      });
      var pk = ["ceiling", "silence", "voicing", "octave", "octaveJump", "vuv", "attenuation"];
      pk.forEach(function (k) { if (savedP.params[k] != null) state.prev.values[k] = savedP.params[k]; });
      buildPrevSliders();
      schedulePreview();
    }
    // 打开时按九宫格当前模式决定看哪一页：在“共振峰”模式下点格子就直接进共振峰页，
    // 在“F0”模式下就直接进 F0 页（以前固定沿用上次的 state.tab，常和刚看的模式不一致）。
    setTab(state.mode === "formant" ? "formant" : "f0");
    rdSetUI(false);   // 摆回原版：显示标签页 / 调参面板 / 存盘按钮，收起参数表与已选栏
    // 详情页语图参数控件同步当前全局值（与九宫格工具栏同源）。
    syncBandInputs();   // 语图窗长下拉框按本页默认显示（F0 窄带 / 共振峰宽带）
    var dd = $("#rgDynDetail"); if (dd) dd.value = String(state.dyn);
    // 平滑（Track）默认选中（用户 2026-09-26 拍板：九宫格与详情页两处都默认平滑；
    // 九宫格侧在 fetchPage 里传 formantTrack:true，详情页在这里单文件跑一次）：
    // 进共振峰页且本会话还没算过 → 勾上并自动跑一次 Track（详情页单文件，开销可接受）；
    // 已算过（_smoothed 有值）或 F0 页 → 按现状。自动跑失败会自行取消勾选。
    // 存过平滑版（formantSmoothed=true，2026-09-26 用户拍板「后面再显示就默认先读取
    // 我存盘的结果」）：九宫格读回时 f.formant **已经是** .Formant 里的平滑轨迹 →
    // 直接展示它，不重跑（重跑默认参数反而画出另一条线）；_smoothed 指向同一份点，
    // 这样用户重开后直接再存盘，formantSmoothed 仍是 true（不因重开丢标记走普通 burg
    // 把平滑版覆盖掉）。
    if (state.tab === "formant") {
      var savedSm = !!(f.formantSmoothed && f.choice && f.choice.formantSmoothed);
      var auditedRaw = !!(f.choice && f.choice.formantSmoothed === false);
      if (savedSm && !(f._smoothed && f._smoothed.length)) {
        f._smoothed = f.formant;
        $("#rgSmooth").checked = true;
      } else if (auditedRaw && !(f._smoothed && f._smoothed.length)) {
        // 审定时明确记了「不要平滑」：九宫格与详情保持一致，不强加 Track（2026-09-26）
        $("#rgSmooth").checked = false;
      } else if (f._smoothed && f._smoothed.length) {
        $("#rgSmooth").checked = true;
      } else {
        $("#rgSmooth").checked = true;
        trackDetail(f);
      }
    } else {
      $("#rgSmooth").checked = false;
    }
    $("#reviewDetailModal").classList.remove("hidden");
    renderCandList();
    updateSmoothAvail(f);   // 打开详情即按勾选状态定平滑是否可用
    updateSaveBtn();        // 存盘按钮同一规则（勾选 ≠1 条 → 灰）
    drawDetail(f);
  }

  function closeDetail() {
    stopPlayback();
    $("#rgSaveAsk").classList.add("hidden");
    $("#reviewDetailModal").classList.add("hidden");
    state.detailFile = null;
    if (rd.on) { rd.on = false; rdSetUI(false); }
    // 详情窗是从第四步「查看测量结果」点开的（向导当前停在第 4 步）→ 关窗后重读
    // 本页：详情里改了 F0/共振峰并存了盘，回来要立刻看到改后的曲线，而不是旧快照。
    if (window.state && window.state.step === 4 && window.refreshResultsGrid) {
      window.refreshResultsGrid();
    }
  }

  function setTab(tab) {
    state.tab = (tab === "formant") ? "formant" : "f0";
    $$("#rgDetailTabs .seg-btn").forEach(function (b) {
      b.classList.toggle("active", b.dataset.tab === state.tab);
    });
    // 「点图改 F0」只在 F0 页有意义；「平滑（Track）」只在共振峰页有意义。
    // 编辑模式**默认关**（用户 2026-09-26 改拍板：改 F0 尽量先用滑块调参，点图是最后手段）；
    // 本会话内勾过就记住，切标签页不来回重置。
    // 元音音标只在共振峰页显示（2026-09-26：F0 页用不上）；「显示上限」只在 F0 页显示。
    // 新手状态不开放「点图改 F0」（用户 2026-09-26：点图编辑属进阶操作），
    // 同时强制取消勾选，避免画布点按仍走编辑分支。
    var novice = ((window.state && window.state.tier) || "novice") === "novice";
    $("#rgEditWrap").classList.toggle("hidden", state.tab !== "f0" || novice);
    $("#rgSmoothWrap").classList.toggle("hidden", state.tab !== "formant");
    $("#rgIpaWrap").classList.toggle("hidden", state.tab !== "formant");
    $("#rgSpecTopWrap").classList.toggle("hidden", state.tab !== "f0");
    $("#rgF0TopWrap").classList.toggle("hidden", state.tab !== "f0");
    $("#rgF0BottomWrap").classList.toggle("hidden", state.tab !== "f0");
    $("#rgEditF0").checked = (state.tab === "f0") && !novice && !!state.editF0;
    // 左侧面板按标签页切换（2026-09-26 用户拍板）：F0 页 = 调参滑块面板，
    // 共振峰页 = 「生成候选」+ 候选二维表面板。生成按钮从底部移进候选面板。
    $("#rgPreviewPanel").classList.toggle("hidden", state.tab !== "f0");
    $("#rgFormantPanel").classList.toggle("hidden", state.tab !== "formant");
    // 底部按钮也按标签页分组（用户 2026-09-25：哪个标签页就只显示哪个的按钮）。
    // 「在 Praat 中查看」是纯查看，已移到顶排试听旁（2026-09-25）；底部的通用按钮只剩「导入修正数据」。
    // 生成/存盘两页都有但只作用于当前页。
    $("#rgF0Btns").classList.toggle("hidden", state.tab !== "f0");
    $("#rgFmBtns").classList.toggle("hidden", state.tab === "f0");
    // 注释分维度：F0 页只显示 F0 注解、共振峰页只显示共振峰注解（通用说明常驻），用户 2026-09-26。
    $("#rgDetailHelpF0").classList.toggle("hidden", state.tab !== "f0");
    $("#rgDetailHelpFm").classList.toggle("hidden", state.tab !== "formant");
    // F0 候选已退役（2026-09-25 用户拍板：右侧滑块调参取代候选对比）；
    // 共振峰候选按钮/列表都在左侧候选面板里，随面板整体显隐，无需单独切。
    // 切页时同步刷新存盘按钮（title / 是否可用都随标签页变）：否则从 F0 切到共振峰后，
    // 存盘按钮仍停在上一页的「保存本页的 F0…」文案，与当前页语义不符。
    // 语图窗长同理由本页接管：切到 F0 页显示窄带 25 ms、切到共振峰页显示宽带 5 ms。
    syncBandInputs();
    updateSaveBtn();
  }

  // 档位切换联动：app.js 切 novice/advanced 时若详情窗正开着，重跑 setTab 让
  // 「点图改 F0」等按档位显隐的项立即刷新（review-grid 的局部 state 没有 tier 字段，
  // 真正的档位在 app.js 的全局 state；setTab 现改读 window.state.tier）。
  window.addEventListener("pstierchange", function () {
    var m = document.getElementById("reviewDetailModal");
    if (m && !m.classList.contains("hidden")) setTab(state.tab);
  });

  // 大图：把画布撑到容器宽度（1080 的弹窗里约 1030 px 宽），语图也按这个分辨率重算，
  // 不是把九宫格那张小图拉大 —— 拉伸会让共振峰暗纹糊掉，没法判断对错。
  // F0 页手工点存盘提示：有手工点时显示「已加 N 个，点保存写入 .Pitch」的常驻提醒，
  // 解决用户反馈「没看到点图后的结果如何存盘」。F0 页以外隐藏。
  function updateManualHint(f) {
    var el = $("#rgManualHint");
    if (!el) return;
    if (state.tab === "f0" && f && ((f._manual && f._manual.length) ||
                                    (f._deleted && f._deleted.length))) {
      el.textContent = "已编辑 " + ((f._manual || []).length) + " 个手工点、删 " +
        ((f._deleted || []).length) + " 个原始点 —— 点左下「保存（F0）」写入 measure/ 子目录的 .Pitch" +
        "（删的点用相邻帧平滑桥接，其余帧不动；有青色预览线时编辑作用在预览上，存盘会用同一组参数重算）。" +
        "点线上的帧点删除、点灰圈恢复、点紫点撤手工点。";
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  }

  function drawDetail(f) {
    if (!f) return;
    var cv = $("#rgDetailCanvas");
    var wrap = cv.parentNode;
    var W = Math.max(600, Math.min(1040, Math.floor((wrap && wrap.clientWidth) || 960)));
    // 高度受视口约束（2026-09-25 用户要求：窗口内要能看到整张图 + 底部按钮，不靠滚动找按钮）；
    // 2026-09-26 用户反馈「语图太大、不翻页看不到全貌」→ 再压到 ≤34% 视口高（下限 210px）。
    // 2026-09-27 堆叠模式例外：没有主图，画布 = 各参数窄带（110px/条）总高，
    // 上限放宽到 85% 视口，超出才滚动。
    var H = Math.min(Math.round(W * 0.34),
                     Math.max(210, Math.floor((window.innerHeight || 800) * 0.34)));
    if (rd.on && rd.mode === "strip" && rd.params.length) {
      // 堆叠模式没有主图：画布高度 = 窄带总高 + 上下留白，**不再压到 85% 视口**
      // （2026-09-27 用户反馈参数多了最底下的看不见）——弹窗 body 本来就能滚动，
      // 画布给足高度，往下滚看全部窄带。
      var stripArea = rd.params.length * RD_STRIP_H + (rd.params.length - 1) * RD_STRIP_GAP;
      H = Math.max(240, stripArea + 30);
    }
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    // 第四步「查看测量结果」点开的：多参数叠加版（各参数一根自己的彩色纵轴）
    if (rd.on) { drawResultsDetail(cv, f); $("#rgDetailMeta").textContent = rdMeta(f); return; }
    if (state.tab === "f0") drawF0Detail(cv, f);
    else drawFormantDetail(cv, f);
    $("#rgDetailMeta").textContent = metaText(f);
    // 「清空手工点」只在 F0 页、非新手档、且确实有手工点时出现（加/删点后随 drawDetail 刷新）。
    // 与「改F0」同步收起：点图改 F0 属进阶操作，新手档不应看到任何入口（用户 2026-09-27）。
    var novice = ((window.state && window.state.tier) || "novice") === "novice";
    $("#rgManualClear").classList.toggle("hidden",
      novice || state.tab !== "f0" ||
      !((f._manual && f._manual.length) || (f._deleted && f._deleted.length)));
    updateManualHint(f);
  }

  function metaText(f) {
    var s = "时长 " + (f.duration || 0).toFixed(3) + " s";
    if (f.pitchFixed) s += "｜F0 = Praat 修周期结果（已复用，未重算）";
    if (f._edited) s += "｜已导入修正数据（" + (f._edited === "pitch" ? "F0" : "共振峰") + "）";
    if (f.intervals && f.intervals.length) {
      var tgName = (f.tgPath || "").split(/[\\/]/).pop() || "?";
      s += "｜TextGrid " + tgName + "，" + f.intervals.length + " 段";
      if (f.span) s += "，音节跨度 " + f.span[0] + "–" + f.span[1] + " s";
    } else {
      s += "｜无 TextGrid：静音段未遮罩、视图未裁剪";
    }
    if (f.choice) s += "｜" + choiceText(f.choice);
    return s;
  }

  // 该文件已存盘的参数（wav 同目录 <名>.measure.json）——按当前标签页只显示这一维
  // 的采用参数（2026-09-25：两页分开后，F0 页不再显示共振峰那半句）。
  function choiceText(c) {
    var kind = state.tab === "formant" ? "formant" : "pitch";
    var dimName = kind === "pitch" ? "F0" : "共振峰";
    var cur = c[kind] && c[kind].label;
    var when = c.savedAt ? "（" + String(c.savedAt).replace("T", " ") + "）" : "";
    return "已存盘参数（" + dimName + "）：" + (cur || dimName + " 未存盘") + when;
  }

  // --------------------------- 多参数候选（对比 / 选最优） ---------------------------
  function candsOf(f, kind) { return (f._cands && f._cands[kind]) || null; }

  function visibleCands(f, kind) {
    var cs = candsOf(f, kind);
    if (!cs) return [];
    return cs.filter(function (c) { return f._vis[kind][c.id]; });
  }

  // 共振峰候选的颜色：**同一上限同色**（2026-09-22 用户定案，20 色太花）。
  // 上限集合排序后逐个取调色板前几色 → 换文件、换页都稳定，「5500 Hz 永远是蓝色」。
  function ceilColor(cs, ceiling) {
    var ks = [];
    (cs || []).forEach(function (c) {
      if (c.ceiling != null && ks.indexOf(c.ceiling) < 0) ks.push(c.ceiling);
    });
    ks.sort(function (a, b) { return a - b; });
    var i = ks.indexOf(ceiling);
    return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
  }

  function candColor(f, kind, id) {
    var cs = candsOf(f, kind) || [];
    if (kind === "formant") {
      for (var j = 0; j < cs.length; j++) {
        if (cs[j].id === id) return ceilColor(cs, cs[j].ceiling);
      }
      return "#888";
    }
    for (var i = 0; i < cs.length; i++) if (cs[i].id === id) return PALETTE[i % PALETTE.length];
    return "#888";
  }

  // 共振峰数量 → 线型数组（4→实线、5→点线、6→虚线、7→点划线，超出范围按 4 取模）
  function dashOfNf(n) {
    if (n == null) return null;
    var k = (((n - FORMANT_NF_BASE) % FORMANT_DASH.length) + FORMANT_DASH.length) %
            FORMANT_DASH.length;
    return FORMANT_DASH[k];
  }

  // 共振峰候选的线型：按「共振峰数量」区分（同色靠线型再分 4 档）。
  // 返回 canvas setLineDash 用的数组；F0 没有这个概念 → null（实线）。
  function candDash(f, kind, id) {
    if (kind !== "formant") return null;
    var cs = candsOf(f, kind) || [];
    for (var i = 0; i < cs.length; i++) {
      if (cs[i].id === id) return dashOfNf(cs[i].nFormants);
    }
    return null;
  }

  // 候选区里的「颜色 + 线型」示意条：CSS 类与 canvas 线型一一对应（实线/点线/虚线/点划线）。
  // 颜色走 CSS 变量 --c，线型走类名，所以一个 span 就把"这组会画成什么样"说清了。
  // ⚠️ 按**值**比较线型（不是引用），否则调用方传个等值的新数组就会退化成实线。
  function swatchClass(dash) {
    if (!dash || !dash.length) return "";
    var s = dash.join(",");
    if (s === FORMANT_DASH[1].join(",")) return " d5";
    if (s === FORMANT_DASH[2].join(",")) return " d6";
    if (s === FORMANT_DASH[3].join(",")) return " d7";
    return "";
  }

  function lineSwatchHtml(color, dash, extraCls) {
    return '<span class="cl-line' + swatchClass(dash) + (extraCls || "") +
      '" style="--c:' + color + '"></span>';
  }

  function tabKind() { return state.tab === "formant" ? "formant" : "pitch"; }

  // 候选按标签页分维生成（2026-09-25 用户拍板：两页真正分开）。后端一次 Praat 运行
  // 两维都会算出来，但前端只采纳当前页这一维——另一维保持"未生成"状态，
  // 切过去要自己点生成，绝不静默带着旧参数的结果。
  // 2026-09-26：按钮移到共振峰页左侧候选面板，文字固定「生成候选」（F0 页无此按钮）。

  function buildCandidates() {
    var f = state.detailFile;
    if (!f) return;
    var kind = tabKind();
    var btn = $("#rgDetailBuild");
    btn.disabled = true;
    btn.textContent = "正在生成候选…";
    api("/api/review/build", { wavPath: f.path }).then(function (r) {
      btn.disabled = false;
      btn.textContent = "生成候选";
      if (!r.ok) { toast(r.error || "生成候选失败", "error"); return; }
      var cs = (r[kind] && r[kind].candidates) || [];
      f._cands[kind] = cs;
      f._vis[kind] = {};
      f._acc[kind] = null;
      f._recFormant = null;
      // 默认：F0 全部叠着看；共振峰只勾**一条**（2026-09-26 拍板：平滑与候选耦合后，
      // 勾选 >1 条会灰掉平滑，所以默认不再把「同上限 6 个」一起勾上，要对比手动勾）。
      // 默认"存盘用这一组"对齐九宫格当前抽取用的参数（上限 = FMAX_FORMANT、
      // 数量 = 本页回显的 nFormants）。
      if (kind === "pitch") {
        cs.forEach(function (c) { f._vis.pitch[c.id] = true; });
        f._acc.pitch = pickDefault(cs, "500");
      } else {
        var gpN = (state.data && state.data.nFormants) || 5;
        var fBaseC = pickBaseCand(cs, FMAX_FORMANT, gpN);
        if (fBaseC) f._vis.formant[fBaseC.id] = true;
        else if (cs.length) f._vis.formant[cs[0].id] = true;
        f._acc.formant = (fBaseC && fBaseC.id) || (cs[0] && cs[0].id) || null;
      }
      // 该维度以前存过盘 → 直接用存过的那组做默认勾选+选定，一眼看到"上次用的是哪个"
      // （共振峰：先清掉上面默认勾的那条，保证"只勾一条"）
      var saved = f.choice && f.choice[kind];
      if (saved && saved.id != null) {
        var hit = pickCand(cs, saved.id);
        // 旧记录（本次改造前）只存了「上限」、没存「数量」，当时数量固定是 5，
        // 所以补成 "<上限>-5" 再匹配一次，免得历史存盘记录白白失效。
        if (!hit && kind === "formant" && /^\d+$/.test(String(saved.id))) {
          hit = pickCand(cs, saved.id + "-5");
        }
        if (hit) {
          if (kind === "formant") f._vis[kind] = {};
          f._vis[kind][hit.id] = true;
          f._acc[kind] = hit.id;
        }
      }
      // 元音音标软先验：共振峰候选生成后，若本文件填了 vowel_ipa 且没存过盘，
      // 把「参考贴合 + 顺滑」推荐的那组预选（界面仍可直接改选）。
      if (kind === "formant") {
        var rec = (r.formant && r.formant.recommend) || null;
        f._recFormant = rec;
        var alreadySaved = !!(saved && saved.id != null);
        if (rec && !alreadySaved && pickCand(cs, rec)) {
          f._vis.formant = {};
          f._vis.formant[rec] = true;
          f._acc.formant = rec;
        }
      }
      toast("候选已生成：" + (kind === "pitch" ? "F0 " : "共振峰 ") + cs.length +
            " 组。勾选可叠加对比；多条时存盘与平滑都要求先勾选一条（只有一条候选时不用勾，平滑直接对它跑），圆点选定要用的那一组。", "ok");
      renderCandList();
      updateSmoothAvail(f);
      updateSaveBtn();
      if (kind === "formant" && $("#rgSmooth").checked) {
        // 平滑与候选耦合（2026-09-26）：候选生成后默认勾了一条 → 平滑作用对象从
        // 「基础曲线」变成这条候选，旧 _smoothed 是基础曲线的 Track 结果，不匹配
        // → 用新勾那条的参数（上限+数量）重跑，所见 = 所存。
        trackDetail(f);
      } else {
        drawDetail(f);
      }
    }).catch(function (e) {
      btn.disabled = false;
      btn.textContent = "生成候选";
      toast(String(e), "error");
    });
  }

  function pickDefault(list, preferId) {
    if (!list || !list.length) return null;
    for (var i = 0; i < list.length; i++) if (list[i].id === preferId) return list[i].id;
    return list[0].id;
  }

  // 按 id 找候选；找不到返回 null（不要返回 undefined，调用方会直接拿 .ceiling）
  function pickCand(list, id) {
    if (!list || !list.length || id == null) return null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  // 找「与九宫格抽取参数对应」的那个共振峰候选（默认存盘用这一组）。
  // 候选的上限是按固定基数扫出来的 9 档，用户设的上限未必正好落在其中
  // （例如设 5000，候选是 4976.6 / 5231.8）→ 此时取最接近的上限，
  // 而不是让调用方退化成"列表里第一个 = 最低上限"。
  // ⚠️ 只在"选默认值"这里做近似匹配；按 id 精确取的 `pickCand` 保持原语义不动，
  //    否则「同一上限、6 个」那类调用会悄悄跳到别的上限上。
  function pickBaseCand(list, ceiling, nF) {
    var c = pickCand(list, Math.round(ceiling) + "-" + nF);
    if (c) return c;
    var best = null;
    (list || []).forEach(function (x) {
      if (x.ceiling == null || x.nFormants !== nF) return;
      if (!best || Math.abs(x.ceiling - ceiling) < Math.abs(best.ceiling - ceiling)) best = x;
    });
    return best;
  }

  // 候选的名字（下拉框 / 提示 / 存盘追问条共用同一份写法，免得三处各写一遍还不一致）。
  // 共振峰候选带 ceiling / nFormants 两个平铺字段 → 拼成"上限 5500 Hz · 5 个"；
  // F0 候选只有 label（形如 "F0上限500Hz"），直接用。
  function fmtName(c, kind) {
    if (kind === "formant" && c.ceiling != null && c.nFormants != null) {
      return "上限 " + c.ceiling + " Hz · " + c.nFormants + " 个";
    }
    return c.label || String(c.id);
  }

  // 一个候选 = 一个方格按钮（点一下 = 叠加显示 / 取消）。共振峰用 42px 小方格（文字交给表头），
  // F0 用带完整名字的宽方格。✓ 用 visibility 隐藏，保证选中与否格子宽度不跳。
  // 格内画的是「颜色 + 线型」示意条：颜色 = 该组曲线颜色（共振峰=上限色），
  // 线型 = 该组数量对应的线型，所以不用看表头也知道点下去会画出什么样。
  function cellHtml(f, kind, c, text, cls) {
    var col = candColor(f, kind, c.id);
    var on = !!f._vis[kind][c.id];
    var rec = (kind === "formant" && f._recFormant && f._recFormant === c.id);
    return '<button type="button" class="' + cls + (on ? " on" : "") + (rec ? " rec" : "") + '"' +
      ' role="checkbox" aria-checked="' + (on ? "true" : "false") + '"' +
      ' data-role="vis" data-kind="' + kind + '" data-id="' + esc(c.id) + '"' +
      ' title="' + esc(fmtName(c, kind)) + (on ? "（点击取消叠加）" : "（点击叠加显示）") + '">' +
      lineSwatchHtml(col, candDash(f, kind, c.id)) +
      (text ? '<span class="ct">' + esc(text) + "</span>" : "") +
      (rec ? '<span class="rec">推荐</span>' : "") +
      '<span class="ck">✓</span></button>';
  }

  // 共振峰候选 = 「上限 × 数量」二维（5 × 4 = 20 组）→ 直接画成二维表：
  // **一行一个上限**（行首 = 该行颜色 + 上限），**一列一个数量**（列头 = 该列线型 + 数量）。
  // 每个方格是一组参数的独立开关——点某一格只切换那一组，不会连带整行。
  function matrixHtml(f, cs) {
    var ceilings = [], nfs = [], byCeil = {};
    cs.forEach(function (c) {
      if (!byCeil[c.ceiling]) { byCeil[c.ceiling] = {}; ceilings.push(c.ceiling); }
      byCeil[c.ceiling][c.nFormants] = c;
      if (nfs.indexOf(c.nFormants) < 0) nfs.push(c.nFormants);
    });
    ceilings.sort(function (a, b) { return a - b; });
    nfs.sort(function (a, b) { return a - b; });
    var cells = ['<span class="cm-corner">上限 ＼ 数量</span>'];
    // 列头：用中性灰画该列的线型（颜色由行首决定，交叉即得该格）
    nfs.forEach(function (n) {
      cells.push('<span class="cm-colh">' +
        lineSwatchHtml("#94a3b8", dashOfNf(n), " neutral") +
        "<i>" + esc(n) + " 个</i></span>");
    });
    ceilings.forEach(function (k) {
      cells.push('<span class="cm-rowh">' +
        lineSwatchHtml(ceilColor(cs, k), null) + esc(k) + " Hz</span>");
      nfs.forEach(function (n) {
        var c = byCeil[k][n];
        cells.push(c ? cellHtml(f, "formant", c, "", "cm-cell")
                     : '<span class="cm-cell na" title="没有这一组候选"></span>');
      });
    });
    return '<div class="cand-matrix" style="grid-template-columns:112px repeat(' +
      nfs.length + ',42px)">' + cells.join("") + "</div>";
  }

  function bindCandEvents(box, f) {
    Array.prototype.forEach.call(box.querySelectorAll('button[data-role="vis"]'), function (b) {
      b.onclick = function () {
        var k = b.dataset.kind, id = b.dataset.id;
        f._vis[k][id] = !f._vis[k][id];
        updateSmoothAvail(f);   // 勾选/候选状态 → 平滑开关启用或灰掉（同一套状态机）
        updateSaveBtn();        // 同一规则：勾选 ≠1 条 → 存盘也灰掉（2026-09-26 拍板）
        renderCandList();
        // 平滑与候选耦合：平滑开着时勾选变了 = 作用对象变了，旧的 _smoothed 还是
        // 上一条候选（或基础曲线）的 Track 结果，直接画会误导（B 候选上叠 A 的平滑线）
        // → 自动对新作用对象重跑。灰掉状态（勾 ≥2 / 没勾且候选 ≥2）时 trackDetail
        // 防御分支会取消勾选并清掉。
        if (k === "formant" && $("#rgSmooth").checked) trackDetail(f);
        else drawDetail(f);
      };
    });
  }

  // 「恢复默认」：把候选对比区恢复成刚进入详情页时的显示状态。与 F0 滑块「恢复默认」
  // 同一语义（撤销用户自己加的东西、回到打开详情时的样子）：清掉叠加/选择/推荐角标、
  // 隐藏候选二维表，回到「九宫格抽取的那一条曲线」。只改显示，不动已存盘的 measure.json。
  function resetCandDefaults() {
    var f = state.detailFile;
    if (!f) return;
    f._vis = { pitch: {}, formant: {} };
    f._acc = { pitch: null, formant: null };
    f._recFormant = null;
    f._cands = { pitch: null, formant: null };
    // 平滑叠加线也一并撤掉（2026-09-26 用户要求：与 F0 滑块「恢复默认」同语义——
    // 回到「九宫格抽取的那一条曲线」，图上不能还留着 Track 彩线）。
    // 不自动重跑：想再平滑手动勾回「平滑（Track）」即可。
    f._smoothed = null;
    $("#rgSmooth").checked = false;
    $("#rgSaveAsk").classList.add("hidden");
    renderCandList();
    updateSmoothAvail(f);
    updateSaveBtn();
    drawDetail(f);
  }

  function renderCandList() {
    var box = $("#rgCandList");
    var f = state.detailFile;
    var kind = tabKind();
    if (kind === "pitch") {
      // F0 候选已退役（2026-09-25）：F0 参数用右侧滑块面板调，这里不再渲染候选
      box.innerHTML = "";
      return;
    }
    var cs = f && candsOf(f, kind);
    if (!cs || !cs.length) {
      box.innerHTML = '<span class="muted cand-empty">' +
        "当前是九宫格抽取的那一条曲线。点上方「生成候选」可与其它参数叠加对比、选定后存盘。" +
        "</span>";
      return;
    }
    var isMatrix = kind === "formant" && cs[0].ceiling != null;
    var body;
    if (isMatrix) {
      body = matrixHtml(f, cs);
    } else {
      body = '<div class="cand-list">' + cs.map(function (c) {
        return cellHtml(f, kind, c, fmtName(c, kind), "cand-toggle");
      }).join("") + "</div>";
    }
    box.innerHTML = body +
      '<p class="cand-hint muted small">点方格 = 叠加显示（可多选对比）。' +
      (isMatrix
        ? "每行一个上限、每列一个数量：<b>同一上限用同一种颜色</b>，" +
          "<b>数量决定线型</b>（4 个=实线、5 个=点线、6 个=虚线、7 个=点划线）；" +
          "方格里的示意条就是该组在图上画出来的样子。"
        : "颜色 = 该组曲线在图上用的颜色。") + "</p>";
    bindCandEvents(box, f);
  }

  function updateSaveBtn() {
    var f = state.detailFile;
    var kind = tabKind();
    var b = $("#rgDetailSave");
    if (kind === "pitch") {
      // F0 页：候选已退役，存盘负责记手工修正点/修周期标记（F0 参数走右侧滑块的
      // 「采用这组参数并存盘」），不再要求先生成候选。
      // 标签随标签页变（用户 2026-09-26：提示语里的「保存（F0）」要有对应按钮）——
      // 它确实保存 pitch：写 measure.json 后立即重导 .Pitch（apply_manual_pitch 落盘）。
      b.textContent = "保存（F0）";
      b.disabled = false;
      b.title = "把 F0 手工点/删除的原始点写入记录，并立即重导 measure/ 子目录的 .Pitch" +
                "（手工点替换最近帧的值；删的点用相邻帧平滑桥接；其余帧不动。" +
                "F0 测量参数用左侧滑块面板的「采用这组参数并存盘」记录）";
      return;
    }
    var cs = f && candsOf(f, kind);
    var has = !!(cs && cs.length);
    // 「读入的结果」本身就是这一维的最终数据（2026-09-26 用户反馈：FormantPath 精修
    // 读回来后存盘键是灰的，人工改的内容存不下来）——没有候选也要能存。
    if (!has && f && f._importedFormant) {
      b.textContent = "存盘（共振峰）";
      b.disabled = false;
      b.title = "把当前读进来的这条共振峰（勾了「平滑」就是 Track 之后那一条）**原样**" +
                "写成 measure/ 子目录的 .Formant——不重新抽取，否则人工精修的结果会被覆盖；" +
                "同时在 measure/ 子目录的 <文件名>.measure.json 记下这一维已审";
      return;
    }
    // 勾选必须恰好 1 条（2026-09-26 用户拍板）：勾多条时"存的是哪组"看不出，
    // 容易变成黑箱；圆点选定虽然始终唯一，但与勾选脱节时同样说不清。索性一致化：
    // 与「平滑」同一规则——勾 1 条才能存，勾多了先取消。
    var visLen = has ? visibleCands(f, kind).length : 0;
    var multi = has && visLen !== 1;
    b.textContent = "存盘（共振峰）";
    b.disabled = !has || multi;
    b.title = !has
      ? "先点左侧候选面板的「生成候选」，选好要用的那组参数后再存盘"
      : multi
        ? "现在勾选了 " + visLen + " 条候选：先取消到只剩一条再存盘（平滑也是同一规则）"
        : "把这一页（共振峰）最终采用的参数记到 measure/ 子目录的 <文件名>.measure.json（另一页的已存选择不受影响）";
  }

  // --------------------------- 详情绘制 ---------------------------
  // F0 页的坐标几何：绘制与「点图改 F0」共用同一份，避免画的位置和点的位置对不上。
  // 纵轴 = F0 曲线自身的自适应范围（lo/hi 来自 f0DetailRange），**与背后的语图各自独立**
  // ——语图 0–显示上限（顶部条可调，默认 2 kHz），两侧各标一套刻度（左灰 = 语图，右橙 = F0）。
  function f0Geom(cv, f) {
    var W = cv.width, H = cv.height;
    var padL = 30, padR = 30, padT = 8, padB = 16;
    var rng = f0DetailRange(f);
    return { W: W, H: H, padL: padL, padT: padT, pw: W - padL - padR, ph: H - padT - padB,
             dur: (f.duration || 1) || 1, lo: rng[0], hi: rng[1] };
  }

  function f0X(g, t) { return g.padL + (t / g.dur) * g.pw; }
  function f0Y(g, hz) { return f0HzToY(hz, [g.lo, g.hi], g.padT, g.ph); }

  // 保单调三次插值（PCHIP / Fritsch-Carlson）：过所有手工点、C1 连续、且不会在两点间
  // 过冲产生不自然的 F0 抖动（比线性直连光滑，比普通三次样条稳）。与后端
  // review_export._pchip_* 同一算法，保证详情页显示与写进 .Pitch 完全一致。
  function makePCHIP(xs, ys) {
    var n = xs.length;
    if (n === 0) return function () { return 0; };
    if (n === 1) return function () { return ys[0]; };
    if (n === 2) return function (t) {
      if (t <= xs[0]) return ys[0];
      if (t >= xs[n - 1]) return ys[n - 1];
      var k = (t - xs[0]) / (xs[1] - xs[0] || 1e-9);
      return ys[0] + (ys[1] - ys[0]) * k;
    };
    var h = [], d = [], i;
    for (i = 0; i < n - 1; i++) { h[i] = xs[i + 1] - xs[i]; d[i] = (ys[i + 1] - ys[i]) / (h[i] || 1e-9); }
    var m = new Array(n);
    for (i = 1; i < n - 1; i++) {
      if (d[i - 1] * d[i] <= 0) m[i] = 0;
      else {
        var w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
        m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
      }
    }
    m[0] = ((2 * h[0] + h[1]) * d[0] - h[0] * d[1]) / (h[0] + h[1]);
    m[n - 1] = ((2 * h[n - 2] + h[n - 3]) * d[n - 2] - h[n - 2] * d[n - 3]) / (h[n - 2] + h[n - 3]);
    for (i = 0; i < n - 1; i++) {
      if (d[i] === 0) m[i] = 0;
      else if (m[i] * d[i] < 0) m[i] = 0;
      else { var a = m[i] / d[i]; if (a > 3) m[i] = 3 * d[i]; }
    }
    if (d[n - 2] === 0) m[n - 1] = 0;
    else if (m[n - 1] * d[n - 2] < 0) m[n - 1] = 0;
    else { var a2 = m[n - 1] / d[n - 2]; if (a2 > 3) m[n - 1] = 3 * d[n - 2]; }
    return function (t) {
      if (t <= xs[0]) return ys[0];
      if (t >= xs[n - 1]) return ys[n - 1];
      for (var k = 0; k < n - 1; k++) {
        if (xs[k] <= t && t <= xs[k + 1]) {
          var hk = xs[k + 1] - xs[k] || 1e-9, u = (t - xs[k]) / hk;
          var u2 = u * u, u3 = u2 * u;
          var h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
          return h00 * ys[k] + h10 * hk * m[k] + h01 * ys[k + 1] + h11 * hk * m[k + 1];
        }
      }
      return ys[n - 1];
    };
  }

  // 逐点编辑（2026-09-26 用户拍板，取代旧"相邻手工点之间整段替换"）：
  // - 手工点只覆盖它吸附的那一帧（新值替换原测量点）；
  // - 被删的帧从曲线里去掉，值 = 相邻存活帧的 PCHIP 桥接（平滑跨过坏点）；
  // - 其余帧一律保持原值——两个手工点离得远时，中间的原始数据**原样保留**，
  //   不再被两点间的插值线抹掉（用户实测反馈旧语义"把中间原来的数据给删了"）。
  // 曲线 = PCHIP 过「存活帧（含手工覆盖值）」节点序列，与后端 apply_manual_pitch
  // 写盘同一算法——所见即所得。
  // 返回 { del: {帧t:true}, over: {帧t: 手工值} }，供画点与合并共用。
  // F0 页的「相关曲线」（用户 2026-09-26：有蓝绿预览线时，点图编辑要跟预览线连通，
  // 不能继续作用在原来的橙色曲线上）：有滑块预览 → 预览曲线；没有 → 原始测量曲线。
  // 吸附、删点、合并、画帧点全部以它为准；存盘时后端用同一组参数重算 .Pitch 再套
  // 手工点，帧网格一致，所见即所得。
  function activeF0Pts(f) {
    return (f._preview && f._preview.points && f._preview.points.length)
      ? f._preview.points : (f.pitch || []);
  }

  function f0EditMaps(f) {
    var pts = activeF0Pts(f);
    var dx = pts.length > 1 ? (pts[1].t - pts[0].t) : 0;
    var del = {}, over = {};
    (f._deleted || []).forEach(function (t) {
      if (dx > 0) t = pts[0].t + Math.round((t - pts[0].t) / dx) * dx;
      del[+t.toFixed(6)] = true;
    });
    (f._manual || []).forEach(function (p) {
      if (!p || p.f0 == null) return;
      var t = p.t;
      if (dx > 0) t = pts[0].t + Math.round((t - pts[0].t) / dx) * dx;
      var k = +t.toFixed(6);
      over[k] = p.f0;
      delete del[k];   // 同一帧既删又加点 = 改值（手工点优先）
    });
    return { del: del, over: over };
  }

  function mergedF0Points(f) {
    var pts = activeF0Pts(f);
    if (!pts.length) return pts;
    var maps = f0EditMaps(f);
    var hasEdit = (f._deleted && f._deleted.length) || (f._manual && f._manual.length);
    if (!hasEdit) return pts;
    var dx = pts.length > 1 ? (pts[1].t - pts[0].t) : 0;
    // PCHIP 节点 = 存活帧（值换成手工覆盖值，若有；无声/无效帧不进节点）
    //             ∪ 手工点本身。手工点即使没落在帧网格上（落在无声段/曲线外）也
    //             作为节点参与插值——无论点加得离曲线多远，曲线都会平滑连过去，
    //             不会出现孤立点（用户 2026-09-26）。
    var nodes = [];
    pts.forEach(function (p) {
      var k = +p.t.toFixed(6);
      if (maps.del[k]) return;
      if (maps.over.hasOwnProperty(k)) { nodes.push({ t: p.t, f0: maps.over[k] }); return; }
      if (p.f0 != null && p.f0 > 0) nodes.push({ t: p.t, f0: p.f0 });
    });
    (f._manual || []).forEach(function (p) {
      if (!p || p.f0 == null) return;
      nodes.push({ t: +p.t.toFixed(6), f0: p.f0 });
    });
    if (!nodes.length) return pts;       // 全删光了没有参照 → 退回原曲线
    nodes.sort(function (a, b) { return a.t - b.t; });
    // 同/近时间节点去重（差小于半帧视为同一点；手工点排在后面 → 手工值优先）
    var xs = [], ys = [];
    var half = dx > 0 ? dx / 2 : 1e-6;
    nodes.forEach(function (nd) {
      if (xs.length && Math.abs(nd.t - xs[xs.length - 1]) < half) {
        ys[ys.length - 1] = nd.f0;
        return;
      }
      xs.push(nd.t); ys.push(nd.f0);
    });
    var pchip = makePCHIP(xs, ys);
    var t1 = xs[0], t2 = xs[xs.length - 1];
    // 逐帧输出：覆盖帧取手工值、删帧取桥接值（与写盘一致）、
    // 无声/无效帧落在节点范围内 → 用 PCHIP 补上桥接值（手工点跨无声段时曲线连续），
    // 其余帧保持原值。范围外的无声帧保持空白（跟原来一样不画）。
    var out = pts.map(function (p) {
      var k = +p.t.toFixed(6);
      if (maps.over.hasOwnProperty(k)) return { t: p.t, f0: maps.over[k], _m: true };
      if (maps.del[k]) return { t: p.t, f0: pchip(p.t) };
      if ((p.f0 == null || p.f0 <= 0) && p.t >= t1 && p.t <= t2) {
        var v = pchip(p.t);
        if (v != null && v > 0) return { t: p.t, f0: v };
      }
      return p;
    });
    // 手工点本身也是曲线上的采样点（老记录里可能没吸附到帧网格）：插进输出序列，
    // 折线必然穿过它——不管离原曲线多远都不会画出孤立的点。
    // _m 标记 = 手工点（含覆盖帧）：绘制时与手工点相连的段用紫色重描，
    // 与原曲线区分（2026-09-26 用户要求「延长线要看出是手工加的」）。
    (f._manual || []).forEach(function (m) {
      if (m && m.f0 != null) out.push({ t: +m.t.toFixed(6), f0: m.f0, _m: true });
    });
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }

  function drawF0Detail(cv, f) {
    var ctx = cv.getContext("2d");
    var g = f0Geom(cv, f);
    ctx.clearRect(0, 0, g.W, g.H);
    ctx.fillStyle = "#fafbfc"; ctx.fillRect(0, 0, g.W, g.H);
    // 背景语图：窄带 25 ms + 显示上限（顶部条「谱上限」可调，默认 2 kHz；与 F0 曲线各自独立坐标）
    var specTop = Math.max(200, Math.min(8000, +state.specTop || FMAX_SPEC));
    paintSpectrogramIn(ctx, f, g.padL, g.padT, g.pw, g.ph, specTop, bandFor("f0"), viewRange(f), true);
    drawAxis(ctx, g.padL, g.padT, g.pw, g.ph, 0, specTop);
    // 右侧标 F0 自己的纵轴（橙色），免得跟左侧语图刻度混起来
    drawF0Ticks(ctx, g.padL + g.pw, g.padT, g.ph, [g.lo, g.hi], "10px");
    // 中间三条网格线：左灰=语图轴数值、右橙=F0 自适应轴数值（两套各自标）
    drawHGrid(ctx, g.padL, g.padT, g.pw, g.ph, 0, specTop, 2, "#8a93a6", "10px", false, 5);
    drawHGrid(ctx, g.padL, g.padT, g.pw, g.ph, g.lo, g.hi, g.W - 1, F0_COLOR, "10px", true);
    paintSegments(ctx, f, function (t) { return f0X(g, t); }, g.padT, g.padT + g.ph);

    var vis = visibleCands(f, "pitch");
    // 「相关曲线」（用户 2026-09-26）：有青色预览线 → 编辑/合并都作用在预览上；
    // 没有预览 → 作用在原始橙线上。有编辑时画「合并后的曲线」，与存盘导出的
    // .Pitch 完全同一语义；没有编辑画当前曲线本身。
    var hasPreview = !!(f._preview && f._preview.points && f._preview.points.length);
    var hasEdit = !!((f._manual && f._manual.length) || (f._deleted && f._deleted.length));
    var base = hasEdit ? mergedF0Points(f) : activeF0Pts(f);

    function strokeSeries(points, color, width, alpha, skipNonPos) {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.globalAlpha = alpha;
      ctx.beginPath();
      var started = false;
      (points || []).forEach(function (p) {
        // 与九宫格一致：静音/缝隙段的乱点不画（TextGrid 一段非静音都没有时不遮）；
        // 预览曲线还跳过 f0<=0 的无声帧（与旧预览绘制一致）
        if (p.f0 == null || !inSyllable(f, p.t) ||
            (skipNonPos && !(p.f0 > 0))) { started = false; return; }
        var x = f0X(g, p.t), y = f0Y(g, p.f0);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // 手工点参与的线段用紫色（手工点同色）重描（2026-09-26 用户要求）：
    // 「曲线后面加点后，应该用跟加的点的同色的曲线来连，而不是曲线同色，
    // 否则看不出是延长线还是本来的曲线」。段判定 = 相邻两点任一端带 _m 标记
    // （mergedF0Points 输出里手工点与被手工覆盖的帧才有 _m）。
    function strokeManualSegs(width) {
      var hasM = false;
      for (var i = 0; i < base.length; i++) if (base[i]._m) { hasM = true; break; }
      if (!hasM) return;
      ctx.strokeStyle = F0_MANUAL_COLOR; ctx.lineWidth = width; ctx.globalAlpha = 1;
      ctx.beginPath();
      var started = false;
      for (var j = 0; j < base.length - 1; j++) {
        var a = base[j], b = base[j + 1];
        if (!(a._m || b._m)) { started = false; continue; }
        if (a.f0 == null || b.f0 == null || a.f0 <= 0 || b.f0 <= 0 ||
            !inSyllable(f, a.t) || !inSyllable(f, b.t)) { started = false; continue; }
        if (!started) { ctx.moveTo(f0X(g, a.t), f0Y(g, a.f0)); started = true; }
        ctx.lineTo(f0X(g, b.t), f0Y(g, b.f0));
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (hasPreview) {
      // 原始曲线降为淡橙参考线；相关曲线 = 预览（含编辑合并）画青色粗线。
      // 编辑连接、删点、桥接都发生在青线上（用户 2026-09-26 拍板）；
      // 手工点相连的段再补紫色（延长线一眼可辨）。
      strokeSeries(f.pitch, F0_COLOR, 1.4, 0.35, true);
      strokeSeries(base, "#0891b2", 2.6, 1, true);
      strokeManualSegs(2.6);
    } else if (vis.length) {
      vis.forEach(function (c) {
        var acc = f._acc.pitch === c.id;
        ctx.strokeStyle = candColor(f, "pitch", c.id);
        ctx.lineWidth = acc ? 3.0 : 1.8;
        ctx.globalAlpha = acc ? 1 : 0.55;
        ctx.beginPath();
        var started = false;
        (c.points || []).forEach(function (p) {
          if (p.f0 == null || !inSyllable(f, p.t)) { started = false; return; }
          var x = f0X(g, p.t), y = f0Y(g, p.f0);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.globalAlpha = 1;
      });
    } else if (base && base.length) {
      strokeSeries(base, F0_COLOR, 3.0, 1);
      strokeManualSegs(3.0);
    }

    // 逐帧测量点（2026-09-26 用户反馈「点了点图改 F0，曲线上的点还是看不见」：
    // 原来 1.7px 半透明小点画在 3px 宽的不透明曲线上，被曲线整个吞掉）：
    // 勾「点图改 F0」→ 实心 3px 点 + 细白描边（压在曲线上也看得清，点它 = 删该帧、
    // 曲线桥接跨过）；没勾 → 不铺（没有交互意义，还糊图）。
    // 灰色空心圈 = 已删的帧（点它 = 恢复原值）。被手工点覆盖的帧不画点（紫点在那）。
    // 只在画单一主曲线时铺（候选叠加时铺点会糊成一片）。
    if (!vis.length && $("#rgEditF0").checked) {
      var orig = activeF0Pts(f);
      var dotColor = hasPreview ? "#0891b2" : F0_COLOR;
      var maps2 = f0EditMaps(f);
      orig.forEach(function (p) {
        if (p.f0 == null || !inSyllable(f, p.t)) return;
        var k = +p.t.toFixed(6);
        var x = f0X(g, p.t), y = f0Y(g, p.f0);
        if (maps2.over.hasOwnProperty(k)) return;      // 手工点已覆盖
        ctx.beginPath();
        if (maps2.del[k]) {
          // 已删：灰空心圆（还在原位，方便点回来）
          ctx.strokeStyle = "#9aa3b2"; ctx.lineWidth = 1.4; ctx.globalAlpha = 0.95;
          ctx.arc(x, y, 3.4, 0, 2 * Math.PI); ctx.stroke();
          ctx.globalAlpha = 1;
        } else {
          ctx.fillStyle = dotColor; ctx.globalAlpha = 1;
          ctx.arc(x, y, 3.0, 0, 2 * Math.PI); ctx.fill();
          ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 1;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      });
    }

    // 手动 F0 点（深紫，避免与橙色主曲线混淆）
    ctx.fillStyle = F0_MANUAL_COLOR;
    (f._manual || []).forEach(function (p) {
      ctx.beginPath(); ctx.arc(f0X(g, p.t), f0Y(g, p.f0), 3.4, 0, 2 * Math.PI); ctx.fill();
    });
  }

  function drawFormantDetail(cv, f) {
    var ctx = cv.getContext("2d");
    var W = cv.width, H = cv.height;
    var vr = viewRange(f);
    paintSpectrogram(ctx, f, W, H, vr, true);    // 语图底（多锥度更精细；与共振峰线共用 0–FMAX 线性映射）
    // 中间三条网格线 + 左侧数值（单轴 0–FMAX_FORMANT）
    drawHGrid(ctx, 0, 0, W, H, 0, FMAX_FORMANT, 2, null, "10px", false, 5);
    paintSegments(ctx, f, function (t) { return mapT(t, vr, 0, W); }, 0, H);
    // 平滑与候选**共存**（2026-09-26 用户拍板：「我是让平滑在有候选的时候平滑候选」——
    // 平滑不是替换候选对比视图，候选叠加始终要画，平滑线叠在它作用的那条上）。
    // 作用对象 = smoothTarget(f)：勾 1 条 → 它；没勾但唯一候选 → 也算它
    // （2026-09-26 第二次拍板：「如果只有一个就平滑这个对象」——判定看候选个数，
    // 勾选丢了不能让平滑悄悄退回基础曲线）；其余 → null = 基础曲线。
    var vis = visibleCands(f, "formant");
    var cs = candsOf(f, "formant") || [];
    var hasSmooth = !!(f._smoothed && f._smoothed.length);
    var tgt = hasSmooth ? smoothTarget(f) : null;
    // 要画的候选 = 勾选的 +（平滑作用对象若是未勾的唯一候选，也要画出来，否则平滑线悬空）
    var drawn = vis.slice();
    if (tgt) {
      var inDrawn = false;
      for (var di = 0; di < drawn.length; di++) if (drawn[di].id === tgt.id) { inDrawn = true; break; }
      if (!inDrawn) drawn.push(tgt);
    }
    if (drawn.length) {
      drawn.forEach(function (c) {
        var acc = f._acc.formant === c.id;
        // 叠加对比时可能同时有 3~5 组 × F1/F2/F3 十几条线，所以：颜色 = 上限（同上限同色）、
        // 线型 = 数量（实线/点线/虚线/点划线），未采用的那组降到半透明但不再变细
        // （细线压在语图上根本看不清，2026-09-22 用户要求整体加粗）。
        // 平滑作用对象 = tgt（勾 1 条或唯一候选 + 平滑开着）→ 这条原始候选线降为淡色
        // 参考，其上的 Track 彩粗线才是主角——一眼看出 Track 改了哪几帧。
        var smoothedThis = !!tgt && c.id === tgt.id;
        ctx.globalAlpha = smoothedThis ? 0.3 : (acc ? 1 : 0.55);
        paintFormantSeries(ctx, f, c.points, W, H, vr, FMAX_FORMANT, FORMANT_STYLE_DETAIL,
                           { color: candColor(f, "formant", c.id),
                             width: acc ? null : 2.4,
                             dash: candDash(f, "formant", c.id) });
        ctx.globalAlpha = 1;
      });
      if (tgt) {
        paintFormantSeries(ctx, f, f._smoothed, W, H, vr, FMAX_FORMANT, FORMANT_STYLE_DETAIL);
      }
    } else if (cs.length) {
      // 生成过候选但一条都没勾、也没有有效的平滑作用对象 → **纯语图**，什么都不画。
      // （2026-09-26 用户拍板：「点了生成候选，我又把所有候选没选择，那只能有
      // 没有叠加共振峰的语图，而不应该有别的东西」——候选模式下基础曲线不再出现。）
    } else if (hasSmooth) {
      // 没生成过候选（平滑作用在基础曲线上）：原始灰细线 + Track 彩粗线画在一起
      paintFormantSeries(ctx, f, f.formant, W, H, vr, FMAX_FORMANT, FORMANT_STYLE_DETAIL,
                         { color: "rgba(105,115,135,0.6)", width: 1.8 });
      paintFormantSeries(ctx, f, f._smoothed, W, H, vr, FMAX_FORMANT, FORMANT_STYLE_DETAIL);
    } else {
      paintFormantLines(ctx, cv, f, FMAX_FORMANT, vr, FORMANT_STYLE_DETAIL);
    }
  }

  // 平滑（Track）的作用对象（2026-09-26 第二次拍板，判定基准 = 候选**个数**而非勾选）：
  //   勾选 1 条 → 它；没勾但只生成了 1 条候选 → 也算它（「只有一个就平滑这个对象」，
  //   勾选丢了不能让平滑悄悄退回基础曲线）；其余 → null = 基础曲线。
  // 「没勾 + 候选 ≥2」返回 null——但那条路 updateSmoothAvail 已灰掉开关，到不了这。
  function smoothTarget(f) {
    var vis = visibleCands(f, "formant");
    if (vis.length === 1) return vis[0];
    if (vis.length === 0) {
      var cs = candsOf(f, "formant") || [];
      if (cs.length === 1) return cs[0];
    }
    return null;
  }

  // 「平滑（Track）」能用吗（与 smoothTarget 同一套状态机）：
  //   勾选 >1 条 → 灰掉（多条叠着看时分不清平滑的是哪条）；
  //   没勾但已生成 ≥2 条候选 → 灰掉（2026-09-26 用户拍板：「有多个就自动灰掉」——
  //     此时平滑基础曲线会让人以为「候选不起作用」，必须先勾选一条）；
  //   勾选 1 条 / 唯一候选（勾不勾都行）/ 没有候选 → 启用。
  function updateSmoothAvail(f) {
    var cb = $("#rgSmooth");
    if (!cb || !f) return;
    var vis = visibleCands(f, "formant");
    var cs = candsOf(f, "formant") || [];
    if (vis.length > 1) {
      cb.disabled = true;
      cb.title = "勾选了 " + vis.length + " 条候选：平滑一次只能作用一条，先取消到只剩一条再用。";
    } else if (vis.length === 0 && cs.length >= 2) {
      cb.disabled = true;
      cb.title = "已生成 " + cs.length + " 条候选：先在候选表里勾选其中一条，平滑（Track）会对它跑" +
                 "（用它自己的上限+数量）。没生成候选时才会平滑基础曲线。";
    } else if (vis.length === 1) {
      cb.disabled = false;
      cb.title = "对勾选的那条候选（上限+数量都用它的）跑 Viterbi 轨迹跟踪并叠加显示。";
    } else if (cs.length === 1) {
      cb.disabled = false;
      cb.title = "对唯一的那条候选（上限+数量都用它的）跑 Viterbi 轨迹跟踪并叠加显示。";
    } else {
      cb.disabled = false;
      cb.title = "对基础曲线（九宫格当前参数）跑 Viterbi 轨迹跟踪并叠加显示。";
    }
  }

  // 详情页的「平滑（Track）」：对当前文件跑一遍 Praat 的 Viterbi 轨迹跟踪。
  // 结果**叠加**在原始曲线上而不是替换——所以随时看得出它改了什么，取消勾选即恢复。
  // 作用对象 = smoothTarget(f)（2026-09-26 第二次拍板，判定基准 = 候选个数）：
  //   勾选 1 条候选 → 用**它自己的上限+数量**重跑 burg 再 Track（不再写死 5500/5）；
  //   没勾但只生成了 1 条候选 → 同样平滑它（「只有一个就平滑这个对象」）；
  //   没有候选 → 平滑基础曲线（九宫格当前参数）；
  //   勾选 ≥2 / 没勾且候选 ≥2 → 开关已灰掉，这里防御性直接返回。
  // 平滑成功后把「存盘选定」（圆点）对齐到被平滑的那条，保证所见 = 所存。
  // 只在 Praat 已算出的候选里重新选择，不插值、不造值（与后端 track_file 同源）。
  function trackDetail(f) {
    var cb = $("#rgSmooth");
    var vis = visibleCands(f, "formant");
    var cs = candsOf(f, "formant") || [];
    if (vis.length > 1 || (vis.length === 0 && cs.length >= 2)) {
      // 防御：灰掉状态不该跑到这（勾选切换路径会主动调进来）。旧的 _smoothed 是
      // 别的作用对象的 Track 结果，此时无从谈起 → 一并清掉再重画。
      cb.checked = false;
      f._smoothed = null;
      drawDetail(f);
      return;
    }
    var base = (vis.length === 1) ? vis[0] : (cs.length === 1 ? cs[0] : null);
    var fc = base ? base.ceiling : FMAX_FORMANT;
    var nf = base ? (parseInt(String(base.id).split("-")[1], 10) || 5)
                  : ((state.data && state.data.nFormants) || 5);
    cb.disabled = true;
    $("#rgDetailMeta").textContent = "正在调用 Praat 做 Viterbi 轨迹跟踪（Track）…";
    // 「读入的结果」（FormantPath 精修 / 外部导入）走另一条路：不重抽，直接对读入的
    // 那条 Formant 做 Track —— 见 review_grid.track_imported_formant。
    var imported = !!f._importedFormant;
    var payload = {
      path: f.path, tgPath: f.tgPath || "", formantCeiling: fc,
      // 顶部条刚填的元音音标 / 性别（未存盘也生效）：有音标 → Track 参考频率用该元音
      // 期望的 F1/F2/F3（双元音取首段），轨迹偏向该元音；没填 → 后端自动估计
      vowelIpa: collectIpaSegs(), speaker: $("#rgGender").value || "",
    };
    if (!imported) {
      payload.wavPath = f.path;
      payload.nFormants = nf;
    }
    api(imported ? "/api/review/track-imported" : "/api/review/track", payload)
      .then(function (r) {
      updateSmoothAvail(f);
      if (!r.ok) {
        cb.checked = false; f._smoothed = null;
        toast(r.error || "平滑失败", "error");
        drawDetail(f);
        return;
      }
      if (!r.tracked) {
        // Praat 确实跑了但 Track 被跳过（每帧落在 4950 Hz 内的共振峰不足 3 条）。
        // 不能默默显示一条和原来一样的线冒充"已平滑"。
        cb.checked = false; f._smoothed = null;
        toast("该文件每帧可用的共振峰不足 3 条，Praat 无法做 Track；已保留原始曲线。", "error");
        drawDetail(f);
        return;
      }
      f._smoothed = r.points || [];
      // 平滑的是读入的那条时，没有「上限/数量」这一说——别再报一组并不存在的参数
      var what = imported ? "读入的这条曲线"
                          : ("参数 " + Math.round(fc) + "Hz/" + nf + " 个");
      // 所见 = 所存：平滑的是勾选那条 → 圆点选定也切到它（存盘记的就是这组参数）
      if (base && f._acc.formant !== base.id) {
        f._acc.formant = base.id;
        renderCandList();
        toast("已叠加 Track 轨迹（" + f._smoothed.length + " 点，" + what +
              "）——存盘选定已对齐到这条候选", "ok");
      } else {
        toast("已叠加 Track 轨迹（" + f._smoothed.length + " 点，" + what +
              "）——灰线为原始，彩线为平滑", "ok");
      }
      drawDetail(f);
    });
  }

  // 「点图改 F0」逐点编辑（2026-09-26 拍板，只在 F0 页且勾选了编辑模式时生效）：
  //   点橙点（原始测量点）= 删掉它，曲线 PCHIP 桥接跨过；点灰空心点 = 恢复原值；
  //   点紫点（手工点）= 删掉手工点；点空白处 = 加手工点（t 吸附最近帧，新值替换该帧）。
  // 加点时 t 吸附到最近一帧（与后端 apply_manual_pitch 的 round 帧号同一语义）：
  // 不吸附的话单点一个帧都命中不了，曲线不会穿过这个点。
  function onDetailCanvasClick(e) {
    var f = state.detailFile;
    if (!f || state.tab !== "f0" || !$("#rgEditF0").checked) return;
    var cv = $("#rgDetailCanvas");
    var rect = cv.getBoundingClientRect();
    var x = (e.clientX - rect.left) * (cv.width / (rect.width || cv.width));
    var y = (e.clientY - rect.top) * (cv.height / (rect.height || cv.height));
    var g = f0Geom(cv, f);
    if (x < g.padL - 4 || x > g.padL + g.pw + 4) return;
    var t = (x - g.padL) / g.pw * g.dur;
    if (t < 0 || t > g.dur) return;
    // 手工点吸附到帧网格（有帧时）；有青色预览线时一切编辑都作用在预览曲线上
    // （用户 2026-09-26：相关线=有预览是青线、没预览是橙线）
    var pts = activeF0Pts(f);
    var snap = function (tt) {
      if (pts.length > 1) {
        var dx0 = pts[1].t - pts[0].t;
        tt = pts[0].t + Math.round((tt - pts[0].t) / dx0) * dx0;
      }
      return +tt.toFixed(6);
    };
    f._manual = f._manual || [];
    f._deleted = f._deleted || [];
    // 1) 紫点：删手工点
    for (var i = 0; i < f._manual.length; i++) {
      if (Math.hypot(f0X(g, f._manual[i].t) - x, f0Y(g, f._manual[i].f0) - y) < 8) {
        f._manual.splice(i, 1);
        drawDetail(f);
        return;
      }
    }
    var tsn = snap(t);
    // 2) 灰空心点：恢复被删的帧（按原帧位置命中）
    for (var d = f._deleted.length - 1; d >= 0; d--) {
      var dt = snap(f._deleted[d]);
      var dv = frameF0At(pts, dt);
      if (dv == null) continue;
      if (Math.hypot(f0X(g, dt) - x, f0Y(g, dv) - y) < 8) {
        f._deleted.splice(d, 1);
        drawDetail(f);
        return;
      }
    }
    // 3) 相关线上的帧点（橙点/青点）：删原始测量点（曲线桥接跨过）；点在纵向上要靠近曲线才算（±7px）
    for (var j = 0; j < pts.length; j++) {
      if (Math.abs(f0X(g, pts[j].t) - x) < 5 &&
          Math.abs(f0Y(g, pts[j].f0) - y) < 7) {
        var kt = snap(pts[j].t);
        if (f._deleted.map(snap).indexOf(kt) < 0) f._deleted.push(kt);
        drawDetail(f);
        return;
      }
    }
    // 4) 空白处：加手工点
    var hz = g.lo + (1 - (y - g.padT) / g.ph) * (g.hi - g.lo);
    f._manual.push({ t: +tsn.toFixed(3), f0: +hz.toFixed(1) });
    f._manual.sort(function (a, b) { return a.t - b.t; });
    drawDetail(f);
  }

  // 帧网格上时间 t 处的原始 F0 值（画已删点的位置用）
  function frameF0At(pts, t) {
    for (var i = 0; i < pts.length; i++) {
      if (Math.abs(pts[i].t - t) < 1e-6) return pts[i].f0;
    }
    return null;
  }

  // --------------------------- 存盘（记录采用的参数） ---------------------------
  // 存盘按标签页分维（2026-09-25 用户拍板）：F0 页只存 F0（+手工点/修周期标记），
  // 共振峰页只存共振峰。后端 save_choice 是合并写，另一维度沿用记录里的旧值。
  function onSaveClick() {
    var f = state.detailFile;
    var kind = tabKind();
    if (!f) return;
    if (kind === "pitch") {
      // F0 页：候选已退役，直接存（手工修正点/修周期标记；F0 参数由滑块面板负责）
      doSaveChoice();
      return;
    }
    // 没有候选也要能存：读入的那条就是最终结果（否则精修的结果永远存不下来）
    if (!(candsOf(f, kind) || []).length) {
      if (f._importedFormant) doSaveChoice();
      return;
    }
    if (!f._acc[kind]) {
      var list = visibleCands(f, kind);
      if (!list.length) list = candsOf(f, kind) || [];
      if (list.length) { renderSaveAsk([{ kind: kind, list: list }]); return; }
    }
    doSaveChoice();
  }

  function renderSaveAsk(asks) {
    var f = state.detailFile;
    var box = $("#rgSaveAsk");
    var name = function (k) { return k === "pitch" ? "F0" : "共振峰"; };
    box.innerHTML =
      '<div class="rg-ask-q">这一页还没指定最终「存盘记录用」哪一组 —— 请在这里选一组：</div>' +
      asks.map(function (a) {
        return '<div class="rg-ask-row"><b>' + name(a.kind) + '</b>' +
          a.list.map(function (c) {
            return '<label class="cand-chip"><input type="radio" name="rgAsk_' + a.kind +
              '" value="' + esc(c.id) + '"' + (f._acc[a.kind] === c.id ? " checked" : "") + '>' +
              lineSwatchHtml(candColor(f, a.kind, c.id), candDash(f, a.kind, c.id)) +
              esc(fmtName(c, a.kind)) + '</label>';
          }).join("") + '</div>';
      }).join("") +
      '<div class="rg-ask-btns"><button class="btn primary" id="rgAskOk">就存这一组</button>' +
      '<button class="btn ghost" id="rgAskCancel">取消</button></div>';
    box.classList.remove("hidden");
    $("#rgAskCancel").onclick = function () { box.classList.add("hidden"); };
    $("#rgAskOk").onclick = function () {
      asks.forEach(function (a) {
        var el = box.querySelector('input[name="rgAsk_' + a.kind + '"]:checked');
        if (el) f._acc[a.kind] = el.value;
      });
      box.classList.add("hidden");
      renderCandList();
      doSaveChoice();
    };
  }

  // ---------------- F0 测量参数滑块实时预览（2026-09-25） ----------------
  // raw AC 与批量 To Pitch（三参快捷形式）同一算法；filtered AC 是 Praat 2023 起的
  // 推荐方法（先高斯低通再自相关）：ceiling 在该命令里叫 pitch top（标准 800Hz），
  // 多一个 attenuation at top（标准 0.03），silence/voicing/octave 标准值也不同。
  var PREV_DEFS = {
    raw: [
      { k: "ceiling",    label: "测量上限 ceiling (Hz)", min: 50,  max: 1000, step: 5,    def: 600 },
      { k: "silence",    label: "静音阈值 silence",      min: 0.01, max: 0.3,  step: 0.01,  def: 0.03 },
      { k: "voicing",    label: "浊音阈值 voicing",      min: 0,    max: 1,    step: 0.01,  def: 0.45 },
      { k: "octave",     label: "八度代价 octave cost",  min: 0,    max: 0.3,  step: 0.005, def: 0.01 },
      { k: "octaveJump", label: "八度跳变代价",          min: 0,    max: 1,    step: 0.05,  def: 0.35 },
      { k: "vuv",        label: "浊/清转换代价",         min: 0,    max: 0.5,  step: 0.01,  def: 0.14 }
    ],
    filtered: [
      { k: "ceiling",    label: "pitch top (Hz)",        min: 200,  max: 2000, step: 10,    def: 800 },
      { k: "attenuation",label: "顶端衰减 attenuation",  min: 0.01, max: 0.5,  step: 0.01,  def: 0.03 },
      { k: "silence",    label: "静音阈值 silence",      min: 0.01, max: 0.3,  step: 0.01,  def: 0.09 },
      { k: "voicing",    label: "浊音阈值 voicing",      min: 0,    max: 1,    step: 0.01,  def: 0.5 },
      { k: "octave",     label: "八度代价 octave cost",  min: 0,    max: 0.3,  step: 0.005, def: 0.055 },
      { k: "octaveJump", label: "八度跳变代价",          min: 0,    max: 1,    step: 0.05,  def: 0.35 },
      { k: "vuv",        label: "浊/清转换代价",         min: 0,    max: 0.5,  step: 0.01,  def: 0.14 }
    ]
  };

  function resetPrevSliders() {
    // 默认 filtered AC（2026-09-25 用户拍板：与主批量 pitchMethod=0 一致）
    if (!state.prev) state.prev = { method: "filtered", values: {}, timer: null, seq: 0, dirty: false };
    if (state.prev.timer) clearTimeout(state.prev.timer);   // 掐掉还没触发的防抖，防止开新文件后旧预览回来串台
    state.prev.values = {};
    state.prev.timer = null;
    state.prev.dirty = false;          // 滑块脏标记：动过但预览没回来时，存盘直接取滑块值（WYSIWYG）
    buildPrevSliders();
    var st = $("#rgPrevStatus");
    if (st) st.textContent = "";
  }

  function fmtPrevVal(v, d) {
    if (d.step >= 1) return String(Math.round(v));
    return v.toFixed(d.step >= 0.1 ? 1 : (d.step >= 0.01 ? 2 : 3));
  }

  function buildPrevSliders() {
    var box = $("#rgSliders");
    if (!box) return;
    box.innerHTML = "";
    PREV_DEFS[state.prev.method].forEach(function (d) {
      var v = state.prev.values[d.k];
      if (v == null || isNaN(v)) { v = d.def; state.prev.values[d.k] = v; }
      var row = document.createElement("div");
      row.className = "rg-slider-row";
      var lab = document.createElement("label");
      lab.textContent = d.label; lab.title = d.label;
      var rng = document.createElement("input");
      rng.type = "range"; rng.min = d.min; rng.max = d.max; rng.step = d.step; rng.value = v;
      var num = document.createElement("span");
      num.className = "rv";
      num.textContent = fmtPrevVal(v, d);
      rng.oninput = function () {
        state.prev.values[d.k] = parseFloat(rng.value);
        state.prev.dirty = true;                        // 滑块动过：存盘须以此为准，不能信旧预览
        num.textContent = fmtPrevVal(state.prev.values[d.k], d);
        schedulePreview();
      };
      row.appendChild(lab); row.appendChild(rng); row.appendChild(num);
      box.appendChild(row);
    });
  }

  function schedulePreview() {
    if (!state.prev) return;
    if (state.prev.timer) clearTimeout(state.prev.timer);
    var st = $("#rgPrevStatus");
    if (st) st.textContent = "参数已改动，计算中…";
    state.prev.timer = setTimeout(runPreview, 350);   // 防抖：拖动停 350ms 才跑 Praat
  }

  function sliderParams() {
    // 滑块当前值 → 参数对象。预览请求（runPreview）与存盘兜底（doSaveChoice 脏分支）共用，
    // 两处字段必须严格一致——存盘的是"滑块上看到的"，预览画的是同一组。
    var rp = reviewParams();
    var vals = state.prev.values;
    return {
      method: state.prev.method,
      pitchFloor: rp.pitchFloor || 75,
      timeStep: rp.timeStep || 0.005,
      ceiling: vals.ceiling, silence: vals.silence, voicing: vals.voicing,
      octave: vals.octave, octaveJump: vals.octaveJump, vuv: vals.vuv,
      attenuation: vals.attenuation || 0.03
    };
  }

  function runPreview() {
    var f = state.detailFile;
    if (!f || !state.prev) return;
    var seq = ++state.prev.seq;                       // 旧请求的结果回来直接丢弃
    var params = sliderParams();
    api("/api/review/pitch-preview", { wavPath: f.path, params: params }).then(function (r) {
      if (seq !== state.prev.seq) return;             // 滑块又动了 → 丢弃过期结果
      if (state.detailFile !== f) return;             // 已切换文件 → 丢弃
      if (!r.ok) { $("#rgPrevStatus").textContent = (r.error || "预览失败"); return; }
      f._preview = { points: r.points, params: r.params };
      state.prev.dirty = false;                       // 预览已对上滑块值，此后存盘走 _preview.params 亦可
      $("#rgPrevStatus").textContent = "已更新：" + r.count + " 帧";
      drawDetail(f);
    }).catch(function (e) {
      if (seq === state.prev.seq) $("#rgPrevStatus").textContent = String(e);
    });
  }

  function savePreviewParams() {
    var f = state.detailFile;
    if (!f || !f._preview || !f._preview.params) { toast("先等预览算出结果再存", "error"); return; }
    var p = f._preview.params;
    var mName = p.method === "filtered" ? "filtered AC" : "raw AC";
    doSaveChoice({
      id: "custom",
      label: "自定义参数（" + mName + "·上限" + Math.round(p.ceiling) + "Hz）",
      method: p.method,
      params: {
        method: p.method, ceiling: p.ceiling, silence: p.silence, voicing: p.voicing,
        octave: p.octave, octaveJump: p.octaveJump, vuv: p.vuv,
        attenuation: p.attenuation, pitchFloor: p.pitchFloor, timeStep: p.timeStep
      }
    });
  }

  function doSaveChoice(pitchOverride) {
    var f = state.detailFile;
    if (!f) return;
    var kind = tabKind();
    var pick = function (k) {
      // 滑块预览的「采用这组参数并存盘」直接指定 F0 变体（自定义参数随 measure.json 落盘）
      if (k === "pitch" && pitchOverride) return pitchOverride;
      var id = f._acc[k];
      var c = (candsOf(f, k) || []).filter(function (x) { return x.id === id; })[0];
      return c ? { id: c.id, label: c.label } : null;
    };
    // 只带当前页这一维；manual（F0 手工点）和 ppfix（修周期标记）只属于 F0 维，
    // 共振峰页存盘不带它们，后端合并语义会原样保留记录里的旧值。
    // vowel_ipa / speaker 属于整文件的元信息，任何页存盘都带上（后端合并语义保留旧值）。
    var choice = {};
    choice.vowel_ipa = collectIpaSegs();
    choice.speaker = ($("#rgGender").value ||
                      ((f.choice && f.choice.speaker) || ""));
    if (kind === "pitch") {
      // F0 候选已退役（2026-09-25）：F0 的参数不再来自上限候选。F0 页「保存」时的取参顺序：
      // ① 「采用这组参数并存盘」的 pitchOverride；② 本会话拉过滑块 → 存预览曲线的参数
      //   （所见即所得——2026-09-26 用户踩坑：拉了滑块点「保存（F0）」，兜底分支却写
      //   全局批量默认 f0max，落盘曲线跟看到的预览完全两回事）；③ 沿用已存的自定义参数；
      // ④ 全都没有 → 写当前批量默认参数变体（等价于批量行为）。
      var existing = (f.choice || {}).pitch;
      if (pitchOverride) {
        choice.pitch = pitchOverride;
      } else if (state.prev && state.prev.dirty) {
        // 滑块动过但预览还没回来（350ms 防抖内就点保存 / Praat 还在算）：
        // 参数就写在滑块上，直接取——存盘不等预览，杜绝"存的跟看到的不一样"（2026-09-26 21.wav 二次踩坑）
        var sp = sliderParams();
        var sName = sp.method === "filtered" ? "filtered AC" : "raw AC";
        choice.pitch = {
          id: "custom",
          label: "自定义参数（" + sName + "·上限" + Math.round(sp.ceiling) + "Hz）",
          method: sp.method,
          params: sp
        };
      } else if (f._preview && f._preview.params) {
        var pp = f._preview.params;
        var pName = pp.method === "filtered" ? "filtered AC" : "raw AC";
        choice.pitch = {
          id: "custom",
          label: "自定义参数（" + pName + "·上限" + Math.round(pp.ceiling) + "Hz）",
          method: pp.method,
          params: {
            method: pp.method, ceiling: pp.ceiling, silence: pp.silence, voicing: pp.voicing,
            octave: pp.octave, octaveJump: pp.octaveJump, vuv: pp.vuv,
            attenuation: pp.attenuation, pitchFloor: pp.pitchFloor, timeStep: pp.timeStep
          }
        };
      } else if (existing && (existing.method === "filtered" || existing.method === "raw") && existing.params) {
        choice.pitch = existing;   // 沿用已存的自定义参数，不覆盖回默认
      }
      if (!choice.pitch) {
        var rp = reviewParams();
        choice.pitch = {
          id: "filtered", method: "filtered",
          label: "filtered AC（默认·上限" + Math.round(rp.pitchCeiling) + "Hz）",
          params: {
            method: "filtered", ceiling: rp.pitchCeiling, silence: 0.09, voicing: 0.5,
            octave: 0.055, octaveJump: 0.35, vuv: 0.14, attenuation: 0.03,
            pitchFloor: rp.pitchFloor, timeStep: rp.timeStep
          }
        };
      }
      choice.manual = f._manual || [];
      choice.deleted = f._deleted || [];
      choice.ppfix = (f.choice || {}).ppfix;
    } else {
      // 「读入的结果」= 这一维的最终数据时，候选早被清掉了 —— 此时不能按 pick(kind)
      // 退成 null，否则 measure.json 里共振峰维既没有参数记录、也没有"读过"标记，
      // 重开详情会退回「按参数重抽」，把人工精修的那条覆盖掉。
      var imported = !!f._importedFormant && !(candsOf(f, "formant") || []).length;
      choice.formant = imported
        ? { id: "imported", label: "读入的结果（FormantPath 精修）" }
        : pick(kind);
      // 显式带这个键（含 = null 的清除情形）→ 后端按本次为准，不再沿用旧标记
      choice.formantImported = imported ? { savedAt: new Date().toISOString() } : null;
      // 共振峰页：把「是否用 Track 平滑并存盘」一并带过去（平滑勾上 = 已叠加轨迹，
      // 没勾 = 取消平滑）。F0 页不碰这个键，后端合并语义保留记录里的旧值。
      choice.formantSmoothed = !!(f._smoothed && f._smoothed.length);
    }
    // tgPath / 音标 / 性别一并带过去：存盘时若要写回平滑结果，后端用同一组
    // Track 参考重跑，保证存的 = 预览所见
    api("/api/review/choice-save", { path: f.path, choice: choice,
                                     tgPath: f.tgPath || "",
                                     vowelIpa: collectIpaSegs(),
                                     speaker: $("#rgGender").value || "" }).then(function (r) {
      if (!r.ok) { toast(r.error || "存盘失败", "error"); return; }
      f.choice = r.choice;
      var dimName = kind === "pitch" ? "F0" : "共振峰";
      var label = (r.choice[kind] && r.choice[kind].label) ||
                  (kind === "pitch" ? "手工修正点/修周期标记" : dimName + " 未选");
      toast("已存盘（" + dimName + "）：" + label + " → " +
            String(r.path || "").split(/[\\/]/).pop(), "ok");
      // 存盘时后端对落盘 .Formant 重跑 Track 覆盖（勾了平滑 + 读入的结果）；失败要让人知道
      if (r.smoothError) toast("平滑写回失败：" + r.smoothError, "error");
      $("#rgDetailMeta").textContent = metaText(f);
      // 平滑落盘后让九宫格即时反映：记下标记，网格里共振峰曲线改用平滑轨迹绘制。
      // f 与 state.data.files 里的对象是同一个引用，renderCells 重绘即可生效。
      f.formantSmoothed = !!(f._smoothed && f._smoothed.length);
      renderCells();
      // 存盘 = 这个文件的 F0/共振峰定稿了，顺手把它的 .Pitch/.Formant 重导一次。
      // 不重导的话，改动/人工修正只留在 measure.json 里，批量时读到的还是上一次导出的旧对象。
      reexportFile(f);
    }).catch(function (e) { toast(String(e), "error"); });
  }

  // 导出单个文件的审查对象（批量运行读的就是这两个文件）。
  // 按标签页分维（2026-09-25 用户拍板）：F0 页存盘只落 .Pitch、共振峰页只落 .Formant，
  // 另一维的已有中间文件原样不动（不重算）。
  // 单文件约 0.1–0.4 秒，存在感很低；失败只提示、不打断——用户还可以用「审核完成」整批重导。
  function reexportFile(f) {
    if (!f) return;
    api("/api/review/export", {
      path: f.path, choice: f.choice || null, defaults: reviewParams(),
      dims: tabKind(),
    }).then(function (r) {
      if (r && r.ok) {
        setStatus("已导出审查对象：" + f.name +
          (r.manualFrames ? "（含 " + r.manualFrames + " 个手工修正帧）" : ""), false);
      } else {
        setStatus("审查对象导出失败：" + ((r && r.error) || "未知原因"), true);
      }
    }).catch(function (e) { setStatus("审查对象导出失败：" + String(e), true); });
  }

  // 「审核完成」：把这批（整个目录）**所有** wav 的 F0/共振峰一次性导出成
  // <主名>.Pitch / <主名>.Formant（放在 wav 旁边）。
  //
  // 为什么是"全部"而不是"只导改过的"：实际工作里只有少数文件需要修，但「已审核」
  // 必须是能被批量运行验证的事实判断，不能靠人记着自己改过谁。给全部文件落盘、并给
  // 每个文件落 measure.json 的 choice（F0/共振峰两维都标已审）后，向导第三步的
  // reviewed_state 就能认出整批过关——没改过的文件也用当前参数一并导出，
  // 批量时同样不重算。这正是"审核过了就不重复算 F0/共振峰"能成立的前提。
  function finishReview() {
    var dir = ($("#rgDir").value || state.dir || "").trim();
    if (!dir) { toast("请先选择声音目录", "error"); return; }
    if (state.busy) return;
    var btn = $("#rgFinishReview");
    btn.disabled = true;
    setStatus("正在导出审查对象（每个文件约 0.1–0.4 秒，请勿关闭窗口）…", false);
    api("/api/review/export", { dir: dir, defaults: reviewParams() }).then(function (r) {
      btn.disabled = false;
      if (!r || r.total == null) {
        setStatus("导出失败：" + ((r && r.error) || "未知原因"), true);
        return;
      }
      var failed = r.failed || [];
      var msg = "审核完成：已导出 " + r.done + " / " + r.total + " 个文件的 F0/共振峰对象" +
                "（用时 " + r.elapsed + " 秒）" +
                (r.manualFrames ? "，合并了 " + r.manualFrames + " 个手工修正帧" : "");
      if (failed.length) {
        msg += "；失败 " + failed.length + " 个：" + failed.slice(0, 5).join("、") +
               (failed.length > 5 ? " 等" : "");
      }
      setStatus(msg, failed.length > 0);
      toast(failed.length
        ? "导出完成，但有 " + failed.length + " 个文件失败"
        : "审核完成：批量处理时不再重算 F0/共振峰",
        failed.length ? "error" : "ok");
    }).catch(function (e) {
      btn.disabled = false;
      setStatus("导出失败：" + String(e), true);
    });
  }

  function openPraat() {
    var f = state.detailFile;
    if (!f) return;
    var btn = $("#rgDetailOpenPraat");
    btn.disabled = true;
    api("/api/review/open-praat", { path: f.path }).then(function (r) {
      btn.disabled = false;
      if (!r.ok) toast(r.error || "打开失败", "error");
      else toast("已在 Praat 中查看：「" + f.name + "」（纯查看；要把精修结果用起来，走「修周期 / FormantPath / 导入修正数据」）", "ok");
    }).catch(function (e) { btn.disabled = false; toast(String(e), "error"); });
  }

  // ---- 「在 Praat 中修周期」两段式人工修正（用户原有 PointProcess→PitchTier 工作流的界面化）----
  // 导出的 .Pitch/.Formant 直接落 wav 同目录 = 批量 pitchRead/formantRead、审核导出同一位置；
  // 读回时后端记 ppfix 标记，导出跳过重算，人工修一次批量就永久用这份结果。
  function fixWithPointProcess() {
    var f = state.detailFile;
    if (!f) return;
    var btn = $("#rgDetailFixPP");
    btn.disabled = true;
    var rp = reviewParams();   // 与九宫格抽取同一套参数，保证修正对象与批量一致
    api("/api/review/open-pointprocess", {
      path: f.path,
      pitchFloor: rp.pitchFloor, pitchCeiling: rp.pitchCeiling,
      timeStep: rp.timeStep, nFormants: rp.nFormants, formantCeiling: rp.formantCeiling
    }).then(function (r) {
      btn.disabled = false;
      if (!r.ok) { toast(r.error || "打开失败", "error"); return; }
      toast("已在 Praat 打开修周期流程：「" + f.name + "」。第 1 步改脉冲（可点「跳过脉冲」），" +
            "第 2 步修声调曲线（不需要改就直接点导出）；点「曲线改好了，导出」后" +
            "回来点「读回修周期结果」。", "ok");
    }).catch(function (e) { btn.disabled = false; toast(String(e), "error"); });
  }

  // 读回落到 wav 同目录的 .Pitch（不用选文件），复用「导入修正数据」的落图逻辑
  function readPointProcessResult() {
    var f = state.detailFile;
    if (!f) return;
    var btn = $("#rgDetailReadPP");
    btn.disabled = true;
    api("/api/review/pp-result", { path: f.path }).then(function (r) {
      btn.disabled = false;
      if (!r.ok) { toast(r.error || "读回失败", "error"); return; }
      f._manual = [];   // 整条曲线已替换，旧的手动点清掉，免得图上打架
      f._deleted = [];  // 删除标记同理清掉
      applyImport(r);
    }).catch(function (e) { btn.disabled = false; toast(String(e), "error"); });
  }

  // ---- FormantPath 人工精修闭环（在自动择优给出的初值上人工复核/纠正）----
  function openFormantPath() {
    var f = state.detailFile;
    if (!f) return;
    var btn = $("#rgDetailOpenFp");
    btn.disabled = true;
    api("/api/review/open-formantpath", {
      path: f.path, name: f.name, tgPath: f.tgPath || "",
    }).then(function (r) {
      btn.disabled = false;
      if (!r.ok) { toast(r.error || "打开失败", "error"); return; }
      toast("已在 Praat 打开 FormantPath 编辑器：「" + f.name + "」。" +
            "右侧每个矩形是一套 ceiling 分析，点矩形即把该时段换成那一套；" +
            "改完点「导出并退出」，再回来点「读回 FormantPath 结果」。", "ok");
    }).catch(function (e) { btn.disabled = false; toast(String(e), "error"); });
  }

  // 读回的是服务端固定路径上的导出文件（不用选文件），复用「导入修正数据」的落图逻辑
  function readFormantPathResult() {
    var f = state.detailFile;
    if (!f) return;
    var btn = $("#rgDetailReadFp");
    btn.disabled = true;
    api("/api/review/opt-result", { path: f.path }).then(function (r) {
      btn.disabled = false;
      if (!r.ok) { toast(r.error || "读回失败", "error"); return; }
      applyImport(r);
    }).catch(function (e) { btn.disabled = false; toast(String(e), "error"); });
  }

  function onImportFile(e) {
    var input = e.target;
    var file = input.files && input.files[0];
    if (!file) return;
    var kind = $("#rgImportKind").value; // auto / f0 / formant
    var reader = new FileReader();
    reader.onload = function () {
      api("/api/review/import", { text: String(reader.result), kind: kind,
                                 wavPath: (state.detailFile && state.detailFile.path) || "" })
        .then(function (r) {
          if (!r.ok) { toast(r.error || "导入失败", "error"); return; }
          applyImport(r);
        })
        .catch(function (err) { toast(String(err), "error"); });
    };
    reader.onerror = function () { toast("读取文件失败", "error"); };
    reader.readAsText(file);
    input.value = ""; // 允许再次选择同一文件
  }

  function applyImport(r) {
    var f = state.detailFile;
    if (!f) return;
    // 导入的是"这个文件修正后的那一条曲线"，所以把该维度的多候选撤掉，
    // 否则候选线还压在图上、看不出导入结果。
    if (r.kind === "pitch") {
      f.pitch = r.points;
      if (f._cands) { f._cands.pitch = null; f._vis.pitch = {}; f._acc.pitch = null; }
    } else {
      f.formant = r.points;
      if (f._cands) { f._cands.formant = null; f._vis.formant = {}; f._acc.formant = null; }
      // 读进来的是「这一维的最终结果」（FormantPath 精修 / 外部导入）——2026-09-26
      // 用户定案：它就是权威数据，后面一切基于它，不重抽。（没有它存盘键是灰的，
      // 人工精修的结果永远存不下来。）
      f._importedFormant = true;
      // 旧的 Track 线是按导入前那条曲线算的，留着会画在新曲线上冒充"已处理过读入的
      // 结果" → 一律清掉；勾着「平滑」就在下面对读入的这条重跑一遍 Track。
      f._smoothed = null;
    }
    f._edited = r.kind;      // 标记该格已被人工修正，详情 meta 里能看到
    var name = r.kind === "pitch" ? "F0" : "共振峰";
    toast("已用导入的 " + name + " 数据覆盖「" + f.name + "」（共 " + r.count + " 点）。" +
          "（该标签页已切回这条修正曲线；点「生成候选」可重新对比，存盘把它写成 measure/ 子目录的 .Formant。）", "ok");
    renderCells();      // 重绘九宫格（该格即时更新）
    renderCandList();   // 候选行跟着更新
    updateSmoothAvail(f);  // 导入清掉了候选 → 平滑恢复可用（作用对象回到基础曲线）
    updateSaveBtn();
    // 平滑勾着 → 对「读入的这条」跑 Track（不是退回 burg 重抽），保持所见 = 所存
    if (r.kind === "formant" && $("#rgSmooth").checked) trackDetail(f);
    else drawDetail(f);
  }

  // 只重读 TextGrid 并合并进当前页：不重跑 Praat，所以已导入的 F0 / 共振峰修正不会被冲掉。
  // 复用 /api/syllables/grid 的「读已有、不覆盖」模式；按文件名匹配，分页顺序不同也不会错配。
  function reloadTextGrid() {
    if (!state.dir || !state.data) return;
    setStatus("TextGrid 已变更，正在重读本页分段…", false);
    // readonly=1：只读取已有 TextGrid，缺文件的返回空区间、绝不写盘（审查页"无 TextGrid"是合法的）
    api("/api/syllables/grid", {
      dir: state.dir, page: state.page, size: state.size, ext: "wav", readonly: 1,
    })
      .then(function (r) {
        if (!r.ok || !r.files) return;
        var byName = {};
        r.files.forEach(function (x) { byName[x.name] = x; });
        var n = 0;
        (state.data.files || []).forEach(function (f) {
          var s = byName[f.name];
          if (!s) return;
          f.intervals = s.intervals || [];
          f.tgPath = s.tgPath || f.tgPath;
          f.span = spanOf(f.intervals);   // 服务端不回传 span，本地按同一口径重算
          n++;
        });
        renderCells();                                  // 段底色 / 边界 / 静音遮罩全部重画
        if (state.detailFile) drawDetail(state.detailFile);
        setStatus("已按最新 TextGrid 重绘本页（" + n + " 个文件的分段已更新）", false);
      })
      .catch(function (e) { setStatus("重读 TextGrid 失败：" + e, true); });
  }

  // 与后端 review_grid._syllable_span 同一口径：非静音段的总跨度
  function spanOf(ivs) {
    var ts = (ivs || []).filter(function (iv) {
      var lab = (iv.label || "").trim().toLowerCase();
      return lab !== "" && lab !== "sil";
    });
    if (!ts.length) return null;
    var a = Math.min.apply(null, ts.map(function (iv) { return iv.t0; }));
    var b = Math.max.apply(null, ts.map(function (iv) { return iv.t1; }));
    return [Math.round(a * 10000) / 10000, Math.round(b * 10000) / 10000];
  }

  /* ==================================================================
   * 第四步（新）· 查看测量结果：页面内嵌的「结果网格」
   *
   * 与九宫格（上面的 review-grid）同源同形，区别只在三处：
   *   1. 数据不调 Praat——纯读 wav 旁的 .Pitch/.Formant 对象与第三步汇总表 out.tsv
   *      （后端 series_export.grid_page），所以进这一步是秒开、不会重算任何东西；
   *   2. 每格画的是**用户在八个下拉里挑的参数**（可跨组叠加，最多一条/组），
   *      各参数按「本页范围」各自缩放，颜色区分、图例标名；
   *   3. 不开独立窗口，直接嵌在向导第四步里；点格子仍复用文件详情窗 openDetail()。
   *
   * 点格子怎么拿到详情：后端给每文件带全局序号 index，这里用 /api/review/grid 的
   * {page: index, size: 1} 精确取那一个文件（走 Praat 那条既有链路），
   * 不新增详情取数通道——详情窗里能改能存盘的还是原来那套。
   * ================================================================== */

  // 前四组常驻，第 5 组起折叠（与导出页 EXP_OPEN_COLS 同一口径：用户示例「第5列起默认不显示」）
  var RV_OPEN_COLS = 4;
  var rv = {
    ready: false,        // 下拉是否已铺过（boot 异步到位，首次进这一步才铺）
    defaulted: false,    // 是否已给过默认选择（只给一次，用户改过就不再覆盖）
    sel: {},             // {组 key: 选中的参数名}；空串/未设 = 该组不画
    page: 0, size: 16, params: [], data: null, busy: false, specBg: false,
    ranges: {},          // {参数名: [lo, hi]}：整页共用，格子之间才能横向比
    granges: {}, rangesBusy: false,   // 全批冻结量程（/api/results/param-ranges），覆盖本页自适应
    moreOpen: false,
  };

  function rvGroups() {
    return ((window.state && window.state.boot && window.state.boot.seriesGroups) || []);
  }

  // 目录沿用第一步：优先输入框里当前看到的，其次 state 里存的值
  function rvDir() {
    var live = ($("#inputDir") ? $("#inputDir").value.trim() : "") || "";
    return live || ((window.state && window.state.values && window.state.values.inputDir) || "");
  }
  function rvOutDir() {
    var live = ($("#outputDir") ? $("#outputDir").value.trim() : "") || "";
    return live || ((window.state && window.state.values && window.state.values.outputDir) || "");
  }

  // 八个下拉的当前选择 → 后端 params（按组顺序，去重）
  function rvParams() {
    var out = [], seen = {};
    rvGroups().forEach(function (g) {
      var c = rv.sel[g.key] || "";
      if (c && !seen[c]) { seen[c] = 1; out.push(c); }
    });
    return out;
  }

  function rvInit() {
    if (rv.ready) return;
    var box = $("#rvSelects");
    if (!box) return;
    var groups = rvGroups();
    if (!groups.length) { box.innerHTML = '<span class="muted small">（参数组还没加载，稍等一下）</span>'; return; }
    if (!rv.defaulted) {           // 默认：只画第一组的第一个参数（= F0）
      rv.defaulted = true;
      rv.sel[groups[0].key] = (groups[0].cols || [])[0] || "";
    }
    box.innerHTML = "";
    groups.forEach(function (g, gi) {
      var wrap = document.createElement("div");
      wrap.className = "rv-sel" + (gi >= RV_OPEN_COLS ? " folded" : "");
      var lab = document.createElement("span");
      lab.className = "rv-sel-lab";
      lab.textContent = g.label;
      var sel = document.createElement("select");
      var o0 = document.createElement("option");
      o0.value = ""; o0.textContent = "不画";
      sel.appendChild(o0);
      (g.cols || []).forEach(function (c) {
        var o = document.createElement("option");
        o.value = c; o.textContent = c;
        sel.appendChild(o);
      });
      sel.value = rv.sel[g.key] || "";
      sel.onchange = function () { rv.sel[g.key] = sel.value; rv.page = 0; rvFetch(); };
      wrap.appendChild(lab); wrap.appendChild(sel);
      box.appendChild(wrap);
    });
    var more = $("#rvMoreCols");
    if (more) {
      more.classList.toggle("hidden", groups.length <= RV_OPEN_COLS);
      more.onclick = function () {
        rv.moreOpen = !rv.moreOpen;
        $$("#rvSelects .rv-sel").forEach(function (w, i) {
          if (i >= RV_OPEN_COLS) w.classList.toggle("folded", !rv.moreOpen);
        });
        more.textContent = rv.moreOpen ? "收起参数组 ▾" : "更多参数组 ▸";
      };
    }
    var sz = $("#rvSize");
    if (sz) sz.onchange = function () { rv.size = parseInt(sz.value, 10) || 16; rv.page = 0; rvFetch(); };
    var bg = $("#rvSpecBg");
    if (bg) bg.onchange = function () { rv.specBg = !!bg.checked; rvRenderCells(); };
    var pv = $("#rvPrev"); if (pv) pv.onclick = function () { if (rv.page > 0) { rv.page--; rvFetch(); } };
    var nx = $("#rvNext"); if (nx) nx.onclick = function () {
      if (rv.data && rv.page < rv.data.pages - 1) { rv.page++; rvFetch(); }
    };
    rv.ready = true;
  }

  function rvStatus(msg, isErr, isWarn) {
    var el = $("#rvStatus");
    if (!el) return;
    el.classList.remove("hidden");
    el.style.color = isErr ? "var(--err)" : (isWarn ? "var(--warn)" : "var(--muted)");
    el.textContent = msg;
  }

  function rvFetch(statusMsg) {
    if (rv.busy) return;
    rv.params = rvParams();
    if (!rv.params.length) {
      rv.data = null;
      rvRenderCells();
      rvStatus("先在上面的下拉里挑至少一个参数（每组选一个，可多组叠加）。", false);
      return;
    }
    var dir = rvDir();
    if (!dir) {
      rv.data = null; rvRenderCells();
      rvStatus("请先在第一步选好声音目录。", false);
      return;
    }
    rv.busy = true;
    rvStatus(statusMsg || "正在读取本页曲线…", false);
    api("/api/results/grid", {
      dir: dir, page: rv.page, size: rv.size, params: rv.params, ext: "wav",
      outputDir: rvOutDir(), outputFile: "",
    }).then(function (r) {
      rv.busy = false;
      if (!r || !r.ok) { rv.data = null; rvRenderCells(); rvStatus(r && r.error || "读取失败", true); return; }
      rv.data = r;
      rv.page = r.page;
      rvComputeRanges();
      rvLoadRanges(dir);   // 全批量程异步补上后重校一次（先到先画，不阻塞格子）
      rvRenderPager();
      rvRenderCells();
      rvRenderLegend();
      var msg = "本页 " + r.files.length + " 个文件（共 " + r.total + " 个，第 " +
                (r.page + 1) + " / " + r.pages + " 页）｜参数：" + rv.params.join("、");
      var warns = r.warnings || [];
      if (warns.length) msg += "｜⚠ " + warns.join("；");
      else if (r.tsvPath) msg += "｜汇总表已找到";
      if (r.skipped) msg += "｜其中 " + r.skipped + " 个文件这些参数都没数据";
      rvStatus(msg, false, warns.length > 0);
    }).catch(function (e) { rv.busy = false; rvStatus(String(e), true); });
  }

  // 整页共用的纵轴范围（每个参数一根）：优先用**全批冻结量程**（跨页、跨时间可比，
  // 2026-09-27 用户定案）；还没拉到时按本页文件的实际取值算（留 8% 余量）。
  function rvComputeRanges() {
    rv.ranges = {};
    var files = (rv.data && rv.data.files) || [];
    rv.params.forEach(function (c) {
      if (rv.granges[c]) { rv.ranges[c] = rv.granges[c]; return; }
      var lo = Infinity, hi = -Infinity;
      files.forEach(function (f) {
        ((f.series || {})[c] || []).forEach(function (p) {
          var v = p[1];
          if (v == null || !isFinite(v)) return;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        });
      });
      if (!isFinite(lo)) { rv.ranges[c] = [0, 1]; return; }
      var pad = Math.max((hi - lo) * 0.08, Math.abs(hi) * 0.02, 1e-6);
      rv.ranges[c] = [lo - pad, hi + pad];
    });
  }

  // 拉全批量程（缺哪些参数补哪些；与详情窗 rdLoadRanges 同一后端口径）
  function rvLoadRanges(dir) {
    var missing = rv.params.filter(function (c) { return !rv.granges[c]; });
    if (!dir || !missing.length || rv.rangesBusy) return;
    rv.rangesBusy = true;
    api("/api/results/param-ranges", {
      dir: dir, params: missing, outputDir: rvOutDir(), outputFile: "",
    }).then(function (r) {
      rv.rangesBusy = false;
      if (!r || !r.ok) return;
      Object.keys(r.ranges || {}).forEach(function (c) { rv.granges[c] = r.ranges[c]; });
      rvComputeRanges();
      rvRenderCells(); rvRenderLegend();
    }).catch(function () { rv.rangesBusy = false; });
  }

  function rvRenderPager() {
    var d = rv.data;
    $("#rvPageInfo").textContent = d ? ("第 " + (d.page + 1) + " / " + d.pages + " 页") : "—";
    $("#rvPrev").disabled = !d || d.page <= 0;
    $("#rvNext").disabled = !d || d.page >= d.pages - 1;
  }

  // 图例：颜色 + 参数名 + 本页范围（各参数一根轴，不看图例没法读数值）
  function rvRenderLegend() {
    var el = $("#rvLegend");
    if (!el) return;
    el.innerHTML = rv.params.map(function (c, i) {
      var r = rv.ranges[c] || [0, 1];
      return '<span class="rv-lg"><i style="background:' + PALETTE[i % PALETTE.length] + '"></i>' +
             esc(c) + ' <em>' + fmtHz(r[0]) + "–" + fmtHz(r[1]) + "</em></span>";
    }).join("");
  }

  function rvRenderCells() {
    var box = $("#rvCells");
    if (!box) return;
    box.dataset.size = rv.size;
    box.style.gridTemplateColumns = "repeat(" +
      (COLS[rv.size] || Math.ceil(Math.sqrt(rv.size))) + ", minmax(0, 1fr))";
    box.innerHTML = "";
    var d = rv.data;
    if (!d || !d.files.length) {
      box.innerHTML = '<div class="rg-empty muted">' +
        (d ? "本页没有文件。" : "还没有数据：选好参数后会自动读取。") + "</div>";
      return;
    }
    d.files.forEach(function (f) {
      var cell = document.createElement("div");
      cell.className = "rg-cell";
      var name = document.createElement("div");
      name.className = "rg-name";
      name.textContent = f.name;
      name.title = f.path;
      // 文件名常被截断，悬停看完整路径是「数据」不是「说明」，保留原生气泡
      name.setAttribute("data-keep-title", "");
      var cv = document.createElement("canvas");
      cv.className = "rg-canvas";
      cv.width = 300; cv.height = 150;
      cell.appendChild(name);
      cell.appendChild(cv);
      box.appendChild(cell);
      cell.onclick = function () { rvOpenDetail(f); };
      rvDrawCell(cv, f);
    });
  }

  // 语图是异步的，算完要重画结果网格自己的格子（不能走九宫格的 redrawFile）
  function rvRedrawFile() { rvRenderCells(); }

  // 是否按「共振峰那套」画语图背景：选了 F1–F5/B1–B5 就用 FMAX_FORMANT（宽带），
  // 否则（纯 F0 / 汇总表参数）用 FMAX_SPEC（窄带 2 kHz）。两页各自独立、不混。
  function rvSpecAxis() {
    var fm = rv.params.some(function (c) { return /^(F[1-5]|B[1-5])$/.test(c); });
    return fm ? { fmax: FMAX_FORMANT, band: bandFor("formant") } : { fmax: FMAX_SPEC, band: bandFor("f0") };
  }

  function rvDrawCell(cv, f) {
    var ctx = cv.getContext("2d");
    var W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fafbfc"; ctx.fillRect(0, 0, W, H);
    var padL = 4, padR = 4, padT = 4, padB = 4;
    var pw = W - padL - padR, ph = H - padT - padB;
    var vr = [0, (f.duration || 1) || 1];
    if (rv.specBg) {
      var ax = rvSpecAxis();
      paintSpectrogramIn(ctx, f, padL, padT, pw, ph, ax.fmax, ax.band, vr, false, rvRedrawFile);
    }
    paintSegments(ctx, f, function (t) { return mapT(t, vr, padL, pw); }, padT, padT + ph);
    // 每条参数一根自己的纵轴（整页共用），颜色取自 PALETTE：叠加时靠图例认色
    rv.params.forEach(function (c, i) {
      var pts = (f.series || {})[c] || [];
      var rng = rv.ranges[c] || [0, 1];
      var span = (rng[1] - rng[0]) || 1;
      ctx.strokeStyle = PALETTE[i % PALETTE.length];
      ctx.lineWidth = 2.0;
      ctx.setLineDash([]);
      ctx.beginPath();
      var st = false;
      pts.forEach(function (p) {
        var v = p[1];
        // null / NaN = 该帧没值（静音、丢帧）→ 断线，绝不把缝连成直线
        if (v == null || !isFinite(v) || !inSyllable(f, p[0])) { st = false; return; }
        var x = mapT(p[0], vr, padL, pw);
        var y = padT + (1 - (v - rng[0]) / span) * ph;
        if (!st) { ctx.moveTo(x, y); st = true; } else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
  }

  // 点格子 → 直接开「多参数叠加」版详情（数据本页已经取回来了，不用再跑一次 Praat）
  function rvOpenDetail(f) {
    openResultsDetail(f, (rv.data ? rv.data.dir : rvDir()), f.index);
  }

  /* ==================================================================
   * 第四步详情窗（2026-09-27）：复用文件详情窗的壳子，但换成「多参数叠加」版
   *   - 顶部条只留语图三件套（窗长 / 对比度 / 谱上限），标签页与改点 / 平滑 / 存盘全收起；
   *     这里只看结果、不改数据。
   *   - 参数按组平铺成按钮表（与第五步导出表同一张），第 5 列起折叠；点一个叠一条曲线。
   *   - 已选参数落在左栏（原调参面板的位置），点一下去掉。
   *   - 最多 6 条：各参数量纲不同，每条曲线按自己的范围铺满图高，
   *     图左右各最多 3 条彩色纵轴，颜色与曲线一致（读哪条看哪个颜色的刻度）。
   * 数据：本页 /api/results/grid 已经带回来了，新增参数时再按同一个文件补取一次。
   * ================================================================== */

  var RD_MAX = 6;            // 同时叠加的曲线上限
  var RD_AXIS_W = 42;        // 一条纵轴占的横向宽度（含数字）
  var rd = {
    on: false,               // 详情窗当前是不是「多参数叠加」版
    dir: "", index: 0, total: 0, file: null,
    params: [], series: {}, ranges: {}, stats: {}, moreOpen: false, busy: false,
    mode: "overlay",     // 多参数显示方式：overlay=重叠（同一张语图+彩轴）| strip=堆叠（独立窄带）
    // 全批冻结量程（后端 /api/results/param-ranges：批内 2%–98% 分位 + 先验兜底）
    granges: {}, gsrc: {}, rangesBusy: false,
    hover: null, rafPending: false,   // 悬停十字线：{t, x}；rAF 节流重绘
    moreGroups: false,     // 分组按钮「更多」是否展开（后面不常用的组默认折叠）
  };
  var rdMenuGi = -1;       // 当前展开的分组菜单组号（-1 = 收起）；ensure 到货好刷新它
  var rdFillMenu = null;   // fillMenu 的引用（rdRenderPick 里赋值）
  var RD_STRIP_H = 110, RD_STRIP_GAP = 8;  // 堆叠模式窄带尺寸（加高/绘制/悬停三处共用；110 = 用户要求至少翻倍）
  var RD_GROUP_VIS = 4;      // 分组按钮默认直显前几个组，其余收进「更多」（用户 09-27：折叠不常用的）

  function rdGroups() { return rvGroups(); }

  // 当前真正上图 / 参与统计的参数：重叠模式只取前 RD_MAX 条，其余在左栏**排队变灰**
  //（去掉一个按顺序替补一个，2026-09-27 用户定案）；堆叠模式全部上图。
  // 切换模式只改"谁上图"，不动 rd.params 队列本身——切回堆叠灰的又都回来了。
  function rdActive() {
    return rd.mode === "strip" ? rd.params : rd.params.slice(0, RD_MAX);
  }

  // 语图背景按维度选轴：当前在共振峰维度 → 宽带 + FMAX_FORMANT；否则（F0 维度）窄带 + FMAX_SPEC（2 kHz）。
  // state.tab 由 rdSyncTab 跟着参数走，bandFor(specDim()) 才能和顶部「窗长」下拉对上。
  function rdSyncTab() {
    var fm = rd.params.some(function (c) { return /^(F[1-5]|B[1-5])$/.test(c); });
    state.tab = fm ? "formant" : "f0";
  }
  function rdSpecAxis() {
    var fm = state.tab === "formant";
    return {
      fmax: fm ? FMAX_FORMANT : Math.max(200, Math.min(8000, +state.specTop || FMAX_SPEC)),
      band: bandFor(fm ? "formant" : "f0"),
    };
  }

  // 段式切换按钮的高亮：当前模式那颗按下（实底）
  function rdModeSeg() {
    $("#rgModeOverlay").classList.toggle("on", rd.mode === "overlay");
    $("#rgModeStrip").classList.toggle("on", rd.mode === "strip");
  }
  function rdSetMode(mode) {
    if (rd.mode === mode) return;
    rd.mode = mode;
    rdRenderChips();   // 排队灰显 / 计数跟着模式走
    if (rd.on) { drawDetail(rd.file); rdSetUI(true); }
  }

  // 详情窗两套界面的切换：on = 多参数叠加版，off = 原来的 F0 / 共振峰版。
  // off 时只把 tab 相关的项按当前标签页摆回原样（window.state.tab 为准）。
  function rdSetUI(on) {
    var t = state.tab;
    rdModeSeg();
    $("#rgResPanel").classList.toggle("hidden", !on);
    $("#rgGroupDDs").classList.toggle("hidden", !on);
    $("#rgResModeWrap").classList.toggle("hidden", !on);
    $("#rgDetailHelpRes").classList.toggle("hidden", !on);
    $("#rgDetailHelpGen").classList.toggle("hidden", on);
    $("#rgDetailHelpF0").classList.toggle("hidden", on || t !== "f0");
    $("#rgDetailHelpFm").classList.toggle("hidden", on || t !== "formant");
    $("#rgPreviewPanel").classList.toggle("hidden", on || t !== "f0");
    $("#rgFormantPanel").classList.toggle("hidden", on || t !== "formant");
    $("#rgF0Btns").classList.toggle("hidden", on || t !== "f0");
    $("#rgFmBtns").classList.toggle("hidden", on || t === "f0");
    $("#rgImportGroup").classList.toggle("hidden", on);
    $("#rgDetailSave").classList.toggle("hidden", on);
    // 顶部条：多参数版 = 分类下拉 + 显示方式 + 语图三件套；堆叠模式不画语图，
    // 语图三件套整体灰掉（用户 2026-09-27：堆叠模式下语图没法看，就别让人调了）
    $("#rgDetailTabs").classList.toggle("hidden", on);
    var strip = on && rd.mode === "strip";
    ["rgBandWrap", "rgDynWrap", "rgSpecTopWrap"].forEach(function (id) {
      var el = $("#" + id);
      if (el) {
        el.classList.toggle("rg-dim", strip);
        $$("select,input", el).forEach(function (w) { w.disabled = strip; });
      }
    });
    $("#rgIpaWrap").classList.toggle("hidden", on || t !== "formant");
    $("#rgGenderWrap").classList.toggle("hidden", on);
    $("#rgSpecTopWrap").classList.toggle("hidden", on ? false : t !== "f0");
    $("#rgF0BottomWrap").classList.toggle("hidden", on || t !== "f0");
    $("#rgF0TopWrap").classList.toggle("hidden", on || t !== "f0");
    // 改F0 / 清手工点 只在结果叠加版(on)收起；普通详情(on=false)的显隐交给 setTab / drawDetail
    // 按标签页与档位决定，这里不能强制显示（否则会盖掉 setTab 在 formant / 新手 下对它们的隐藏）。
    // 这正是「共振峰页有时冒出改F0 按钮」的根因：openDetail 先 setTab(formant) 隐藏它，
    // 紧跟着的 rdSetUI(false) 又把 hidden 摘掉。所以 off 时只藏不显，交给上游决定。
    if (on) {
      $("#rgEditWrap").classList.add("hidden");
      $("#rgManualClear").classList.add("hidden");
    }
    $("#rgSmoothWrap").classList.toggle("hidden", on || t !== "formant");
    $("#rgManualHint").classList.add("hidden");
    $("#rgSaveAsk").classList.add("hidden");
    // 只看结果：底部那一排（保存 / 修周期 / FormantPath / 导入）整条收起；
    // 画布右上角只留「▶ 试听」，去掉「Praat」（那是拿去精修的入口）。
    $("#rgDetailFoot").classList.toggle("hidden", on);
    // 标题栏的镜像保存按钮同理：只看结果时不存盘，一起收起（2026-10-18）
    $("#rgDetailSaveTop").classList.toggle("hidden", on);
    $("#rgDetailOpenPraat").classList.toggle("hidden", on);
    // 前后翻文件的箭头只在结果版出现
    $("#rgDetailNav").classList.toggle("hidden", !on);
  }

  // 参数表：列 = 参数组，格子里是该组的参数名按钮（已选的高亮）
  function rdRenderPick() {
    // 分类参数下拉（2026-09-27 用户要求改回「按组分几个下拉菜单」）：
    // 顶栏同一行里 8 个组按钮，点谁展开谁组的勾选菜单（菜单 fixed 定位挂在按钮下，
    // 点菜单外才收起）；勾选即叠加 / 取消即去掉，勾中的自动进左栏。
    // 前几个常用组直显，后面不常用的折叠进「更多」（展开状态记在 rd.moreGroups）。
    var box = $("#rgGroupDDs");
    if (!box) return;
    var groups = rdGroups();
    function gbtn(gi) {
      var g = groups[gi];
      var n = (g.cols || []).filter(function (c) { return rd.params.indexOf(c) >= 0; }).length;
      // 整组都没测（没有一个 col 有数据、也没选中）→ 按钮变灰（2026-09-27 用户定案）
      var any = (g.cols || []).some(function (c) {
        return rd.params.indexOf(c) >= 0 || (rd.series[c] && rd.series[c].length);
      });
      return '<button type="button" class="btn tiny ghost rg-gbtn" data-gi="' + gi + '"' +
             (n ? ' style="color:var(--primary);border-color:var(--primary)"' :
              (!any ? ' style="opacity:.4"' : "")) + ">" +
             esc(g.label) + (n ? " (" + n + ")" : "") + " ▾</button>";
    }
    var vis = groups.slice(0, RD_GROUP_VIS).map(function (_g, gi) { return gbtn(gi); });
    if (groups.length > RD_GROUP_VIS) {
      var hiddenSel = groups.slice(RD_GROUP_VIS).reduce(function (s, g) {
        return s + (g.cols || []).filter(function (c) { return rd.params.indexOf(c) >= 0; }).length;
      }, 0);
      vis.push('<button type="button" class="btn tiny ghost" id="rgMoreGroups">' +
               (rd.moreGroups ? "收起 ▴" : "更多" + (hiddenSel ? " (" + hiddenSel + ")" : "") + " ▾") + "</button>");
      if (rd.moreGroups) {
        groups.slice(RD_GROUP_VIS).forEach(function (_g, k) { vis.push(gbtn(RD_GROUP_VIS + k)); });
      }
    }
    box.innerHTML = vis.join("");
    // 共享浮层菜单（body 级、fixed 定位；一次只开一组）
    var menu = $("#rgResCols");
    if (!menu) {
      menu = document.createElement("div");
      menu.id = "rgResCols";
      menu.className = "rg-res-menu hidden";
      menu.style.position = "fixed";
      document.body.appendChild(menu);
      menu.onclick = function (ev) { ev.stopPropagation(); };   // 菜单内点击不关
      document.addEventListener("click", function () {
        menu.classList.add("hidden"); rdMenuGi = -1;
      });
    }
    // 菜单内容单独提成 fillMenu：rdEnsureSeries 拉齐数据后要能刷新**已展开**的菜单
    // （否则菜单开着时数据才到，灰显要等下次打开才出现）
    function fillMenu(gi, anchor) {
      var g = groups[gi];
      menu.dataset.gi = String(gi);
      menu.innerHTML = '<div class="rg-res-col-h">' + esc(g.label) + "</div>" +
        (g.cols || []).map(function (c) {
          var on = rd.params.indexOf(c) >= 0;
          // 本文件没测的参数变灰 + 禁勾（rdEnsureSeries 已把该文件全部参数拉齐，
          // 这里的空 = 真没测；2026-09-27 用户定案：变灰而不是隐藏）
          var dim = !on && !(rd.series[c] && rd.series[c].length);
          return '<label class="rg-res-p' + (on ? " on" : "") + (dim ? " nodata" : "") + '"' +
                 (dim ? ' title="本文件没测这个参数"' : "") + '>' +
                 '<input type="checkbox" data-c="' + esc(c) + '"' +
                 (on ? " checked" : "") + (dim ? " disabled" : "") + ">" +
                 esc(c) + "</label>";
        }).join("");
      menu.classList.remove("hidden");
      var r = anchor || box.getBoundingClientRect();
      var mw = menu.offsetWidth || 180;
      menu.style.left = Math.max(6, Math.min(r.left, window.innerWidth - mw - 8)) + "px";
      menu.style.top = (r.bottom + 4) + "px";
      $$("#rgResCols input[type=checkbox]").forEach(function (cb) {
        cb.onchange = function () { rdToggle(cb.dataset.c); };
      });
    }
    rdFillMenu = fillMenu;   // 供 rdEnsureSeries 刷新已展开的菜单
    $$("#rgGroupDDs .rg-gbtn").forEach(function (b) {
      b.onclick = function (ev) {
        ev.stopPropagation();
        var gi = +b.dataset.gi;
        var open = !menu.classList.contains("hidden") && +menu.dataset.gi === gi;
        if (open) { menu.classList.add("hidden"); rdMenuGi = -1; return; }
        rdMenuGi = gi;
        fillMenu(gi, b.getBoundingClientRect());
      };
    });
    // 「更多 / 收起」折叠开关：只重铺按钮，不动已选参数
    var more = $("#rgMoreGroups");
    if (more) more.onclick = function (ev) { if (ev) ev.stopPropagation(); rd.moreGroups = !rd.moreGroups; rdRenderPick(); };
  }

  // 左栏：已选参数彩条（2026-09-27 紧凑化）——一行 = 色块 + 名字 + ▾ + ▲▼ + ×；
  // 范围 / 均值 / 中位数默认收起，点 ▾（或行）才展开。▲▼ 调上下位置，× 单独点。
  function rdRenderChips() {
    var box = $("#rgResChips");
    if (!box) return;
    rd.expanded = rd.expanded || {};
    var N = rd.params.length;
    var queueFrom = (rd.mode === "strip") ? N : RD_MAX;   // 重叠模式第 7 条起排队变灰
    box.innerHTML = N
      ? rd.params.map(function (c, i) {
          var color = PALETTE[i % PALETTE.length];
          var r = rd.ranges[c] || [0, 1];
          var st = rd.stats[c] || { n: 0 };
          return '<span class="rg-res-chip' + (rd.expanded[c] ? " open" : "") +
                 (i >= queueFrom ? " off" : "") +
                 '" data-c="' + esc(c) + '" style="border-color:' + color + '">' +
                 '<span class="rg-res-chip-t"><i style="background:' + color + '"></i>' +
                 esc(c) + '<span class="rg-res-caret">▶</span>' +
                 '<span class="rg-res-ops">' +
                 (i > 0 ? '<b data-u="1" title="上移">↑</b>' : "") +
                 (i < N - 1 ? '<b data-d="1" title="下移">↓</b>' : "") +
                 '<b data-x="1" title="去掉">×</b></span></span>' +
                 '<span class="rg-res-chip-s">范围 ' + fmtNum(r[0]) + "–" + fmtNum(r[1]) +
                 '｜均值 ' + (st.n ? fmtNum(st.mean) : "—") +
                 '｜中位 ' + (st.n ? fmtNum(st.median) : "—") +
                 "（" + st.n + " 点）</span></span>";
        }).join("")
      : '<span class="rg-res-chip-empty">还没选：点顶栏的分组参数下拉（如「基频/共振峰 ▾」）勾一个。</span>';
    var cnt = $("#rgResCount");
    if (cnt) {
      var nAct = Math.min(N, rd.mode === "strip" ? N : RD_MAX);
      var extra = N - nAct;
      cnt.textContent = N ? (nAct + " / " + (rd.mode === "strip" ? N : RD_MAX) +
                            (extra > 0 ? "（+" + extra + " 排队）" : "")) : "";
    }
    $$("#rgResChips .rg-res-chip").forEach(function (el) {
      var c = el.dataset.c;
      el.querySelector(".rg-res-chip-t").onclick = function (ev) {
        if (ev.target.dataset && (ev.target.dataset.x || ev.target.dataset.u || ev.target.dataset.d)) return;
        rd.expanded[c] = !rd.expanded[c];
        el.classList.toggle("open", !!rd.expanded[c]);
      };
      var x = el.querySelector("b[data-x]");
      if (x) x.onclick = function (ev) {
        ev.stopPropagation();
        rdRemove(c);
      };
      var u = el.querySelector("b[data-u]");
      if (u) u.onclick = function (ev) { ev.stopPropagation(); rdMove(c, -1); };
      var d = el.querySelector("b[data-d]");
      if (d) d.onclick = function (ev) { ev.stopPropagation(); rdMove(c, +1); };
    });
  }

  // 均值 / 中位数 / 点数（口径与图上画出来的那条线一致）
  function rdStats(vals) {
    if (!vals.length) return { n: 0, mean: null, median: null };
    var s = 0;
    vals.forEach(function (v) { s += v; });
    var a = vals.slice().sort(function (x, y) { return x - y; });
    var mid = a.length % 2 ? a[(a.length - 1) / 2]
                           : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
    return { n: vals.length, mean: s / vals.length, median: mid };
  }

  // 每条曲线各自的范围 + 统计量。
  // 量程优先用**全批冻结量程**（rd.granges，后端按批内 2%–98% 分位 + 先验兜底算好）：
  // 逐文件 min–max 会把平线的微起伏放大成波浪、抹掉不同文件间斜率/高度差异
  // （2026-09-27 用户定案）。全批数据没有该参数时才退回本文件自适应。
  // ⚠️ 统计与画图用同一套过滤（非 null 且落在音节段内），否则左栏数字会和曲线对不上。
  function rdRanges() {
    rd.ranges = {}; rd.stats = {};
    var f = rd.file || {};
    rd.params.forEach(function (c) {
      var lo = Infinity, hi = -Infinity, vals = [];
      (rd.series[c] || []).forEach(function (p) {
        var v = p[1];
        if (v == null || !isFinite(v) || !inSyllable(f, p[0])) return;
        vals.push(v);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      });
      rd.stats[c] = rdStats(vals);
      if (rd.granges[c]) { rd.ranges[c] = rd.granges[c]; return; }
      if (!vals.length) { rd.ranges[c] = [0, 1]; return; }
      var pad = Math.max((hi - lo) * 0.08, Math.abs(hi) * 0.02, 1e-6);
      rd.ranges[c] = [lo - pad, hi + pad];
    });
  }

  // 拉全批量程（缺哪些参数补哪些；同一目录同一参数只拉一次，量程冻结不随新文件漂移）
  function rdLoadRanges() {
    var missing = rd.params.filter(function (c) { return !rd.granges[c]; });
    if (!missing.length || !rd.dir || rd.rangesBusy) return;
    rd.rangesBusy = true;
    api("/api/results/param-ranges", {
      dir: rd.dir, params: missing, outputDir: rvOutDir(), outputFile: "",
    }).then(function (r) {
      rd.rangesBusy = false;
      if (!r || !r.ok) return;
      Object.keys(r.ranges || {}).forEach(function (c) {
        rd.granges[c] = r.ranges[c];
        rd.gsrc[c] = (r.sources || {})[c] || "";
      });
      rdRanges(); rdRenderChips();
      if (rd.on) drawDetail(rd.file);
    }).catch(function () { rd.rangesBusy = false; });
  }

  // 数值格式：Hz 用 k 缩写，dB / 比值这类小数保留 1~2 位（fmtHz 会把 0.4 打成 0）
  function fmtNum(v) {
    if (v == null || !isFinite(v)) return "—";
    var a = Math.abs(v);
    if (a >= 1000) return (v / 1000).toFixed(a >= 10000 ? 0 : 1) + "k";
    if (a >= 100) return String(Math.round(v));
    if (a >= 10) return v.toFixed(1);
    return v.toFixed(2);
  }

  function rdStatus(msg, isWarn) {
    var el = $("#rgResStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.style.color = isWarn ? "var(--warn)" : "var(--muted)";
  }

  function rdAdd(c) {
    if (rd.params.indexOf(c) >= 0) return;
    // 6 条上限只针对重叠模式（同一张图放多了看不清）；堆叠模式分格显示，随便加
    // （2026-09-27 用户定案）。注意：上限只在「加」的时候查，重叠切回来超了也不硬删。
    if (rd.mode !== "strip" && rd.params.length >= RD_MAX) {
      toast("重叠模式最多同时 " + RD_MAX + " 条曲线；先点左栏里一个去掉，再加新的", "error");
      return;
    }
    rd.params.push(c);
    rdSyncTab();
    rdRanges(); rdRenderPick(); rdRenderChips(); drawDetail(rd.file);
    // 这个参数还没取过（点开时没选它）→ 按同一个文件补取一次
    if (!(rd.series[c] && rd.series[c].length)) rdFetch();
  }

  // 左栏上下箭头：调整参数（= 图格）的上下位置，颜色跟着新位置走
  function rdMove(c, d) {
    var i = rd.params.indexOf(c);
    var j = i + d;
    if (i < 0 || j < 0 || j >= rd.params.length) return;
    rd.params.splice(j, 0, rd.params.splice(i, 1)[0]);
    rdRanges(); rdRenderChips(); drawDetail(rd.file);
  }

  function rdRemove(c) {
    var i = rd.params.indexOf(c);
    if (i < 0) return;
    rd.params.splice(i, 1);
    rdSyncTab();
    rdRanges(); rdRenderPick(); rdRenderChips(); drawDetail(rd.file);
  }

  function rdToggle(c) {
    if (rd.params.indexOf(c) >= 0) rdRemove(c); else rdAdd(c);
  }

  // 把本文件**全部**参数的曲线悄悄拉齐（只补 rd.series 里还没有的键）：
  // 分组菜单要靠「有数据 / 没数据」来灰显没测的参数，不拉齐会把没勾选的误当成没测。
  // 合并写入、不覆盖已有键；不发请求就算了，静默失败不影响主流程。
  function rdEnsureSeries() {
    if (!rd.dir) return;
    var miss = [];
    rdGroups().forEach(function (g) {
      (g.cols || []).forEach(function (c) {
        if (!(c in rd.series) && miss.indexOf(c) < 0) miss.push(c);
      });
    });
    if (!miss.length) return;
    api("/api/results/grid", {
      dir: rd.dir, page: rd.index, size: 1, params: miss, ext: "wav",
      outputDir: rvOutDir(), outputFile: "",
    }).then(function (r) {
      var f = (r && r.files || [])[0];
      if (!f) return;
      var s = f.series || {};
      Object.keys(s).forEach(function (c) { rd.series[c] = s[c]; });
      // race 兜底：ensure 没回来之前抢先勾上的参数，若查实本文件没测（空数组）→ 自动撤下
      var dropped = rd.params.filter(function (c) {
        return rd.series[c] && !rd.series[c].length;
      });
      if (dropped.length) {
        rd.params = rd.params.filter(function (c) { return dropped.indexOf(c) < 0; });
        rdStatus("这几个参数本文件没测，已自动撤下：" + dropped.join("、"), true);
      }
      rdRanges(); rdRenderChips(); rdRenderPick();   // 重铺分组按钮 + 彩条
      if (rd.on) drawDetail(rd.file);
      if (rdMenuGi >= 0 && rdFillMenu) rdFillMenu(rdMenuGi);   // 菜单开着就同步刷新灰显
    }).catch(function () {});
  }

  function rdFetch() {
    rdLoadRanges();   // 量程与曲线并行拉：先到先画，全批量程到了再校一次
    if (!rd.params.length) { rdRanges(); rdRenderChips(); drawDetail(rd.file); return; }
    if (rd.busy) return;
    rd.busy = true;
    rdStatus("正在读「" + rd.params.join("、") + "」…", false);
    api("/api/results/grid", {
      dir: rd.dir, page: rd.index, size: 1, params: rd.params, ext: "wav",
      outputDir: rvOutDir(), outputFile: "",
    }).then(function (r) {
      rd.busy = false;
      if (!r || !r.ok) { rdStatus("读取失败：" + ((r && r.error) || ""), true); return; }
      var f = (r.files || [])[0];
      if (!f) { rdStatus("没取到这个文件的曲线", true); return; }
      // 合并进 rd.series，**绝不整体替换**：替换会把 rdEnsureSeries 拉齐的
      // 全参数字典冲掉，没测参数的灰显就失效了（2026-09-27 实测踩坑）
      var s = f.series || {};
      Object.keys(s).forEach(function (c) { rd.series[c] = s[c]; });
      rdRanges(); rdRenderPick(); rdRenderChips(); drawDetail(rd.file);
      var warns = r.warnings || [];
      rdStatus(warns.length ? ("⚠ " + warns.join("；")) : "", warns.length > 0);
    }).catch(function (e) { rd.busy = false; rdStatus("读取失败：" + e, true); });
  }

  // 从第四步结果网格点格子进来：series 已在本页数据里，直接开
  function openResultsDetail(f, dir, index) {
    rd.on = true;
    rd.dir = dir; rd.index = index; rd.file = f;
    rd.total = (rv.data && rv.data.total) || 0;
    state.detailFile = f;
    rd.series = f.series || {};
    rd.params = (rv.params || []).slice(0, RD_MAX);
    if (!rd.params.length) rd.params = Object.keys(rd.series).slice(0, RD_MAX);
    rdSyncTab();
    rdSetUI(true);
    $("#rgEditF0").checked = false;   // 只看不改：别让点画布落进「手工改 F0」那条分支
    $("#rgDetailPath").value = f.path;
    rdTitle();
    syncBandInputs();
    var dd = $("#rgDynDetail"); if (dd) dd.value = String(state.dyn);
    rdStatus("", false);
    rdRanges(); rdRenderPick(); rdRenderChips();
    rdEnsureSeries();   // 后台把全参数拉齐，菜单才能准确灰掉没测的
    $("#reviewDetailModal").classList.remove("hidden");
    drawDetail(f);
  }

  function rdRedraw() { drawDetail(rd.file); }

  // 标题栏：文件名 + 「第 n / 共 m 个」，两头到顶就把箭头禁用
  function rdTitle() {
    var n = rd.index + 1, total = rd.total || 0;
    $("#rgDetailName").textContent = rd.file ? rd.file.name : "";
    var pos = $("#rgDetailPos");
    if (pos) pos.textContent = total ? (n + " / " + total) : String(n);
    var pv = $("#rgDetailPrev"), nx = $("#rgDetailNext");
    if (pv) pv.disabled = n <= 1;
    if (nx) nx.disabled = total ? n >= total : false;
  }

  // 前后翻一个文件：不回九宫格，按全局序号单独向后端要这一个文件的曲线。
  // 跨页也走得通——size=1 + page=index 就是精确取第 index 个文件。
  // 只带当前已选的几个参数，所以一次请求很轻（纯读文件，不跑 Praat）。
  function rdNav(d) {
    if (!rd.on || rd.busy) return;
    var ni = rd.index + (d < 0 ? -1 : 1);
    var total = rd.total || 0;
    if (ni < 0 || (total && ni >= total)) return;
    rd.busy = true;
    rdStatus("正在读取第 " + (ni + 1) + " 个文件…", false);
    api("/api/results/grid", { dir: rd.dir, page: ni, size: 1, params: rd.params })
      .then(function (r) {
        rd.busy = false;
        if (!r.ok || !r.files || !r.files.length) {
          rdStatus("没取到第 " + (ni + 1) + " 个文件：" + ((r && r.error) || "未知原因"), true);
          return;
        }
        var f = r.files[0];
        rd.index = ni;
        rd.file = f;
        rd.series = f.series || {};
        state.detailFile = f;
        if (r.total) rd.total = r.total;
        $("#rgDetailPath").value = f.path || "";
        rdStatus("", false);
        rdRanges(); rdRenderChips(); rdTitle();
        rdEnsureSeries();   // 换文件后重新拉齐全参数（灰显口径跟着新文件走）
        drawDetail(f);
      })
      .catch(function (e) { rd.busy = false; rdStatus("切换文件失败：" + e, true); });
  }

  function rdMeta(f) {
    var parts = rdActive().map(function (c) {
      var n = (rd.series[c] || []).filter(function (p) {
        return p[1] != null && isFinite(p[1]);
      }).length;
      return c + " " + n + " 点";
    });
    return "时长 " + (f.duration || 0).toFixed(2) + " s｜" +
           (parts.join("、") || "还没选参数");
  }

  // 一条彩色纵轴：竖线贴着绘图区，上/中/下三个刻度值，颜色 = 曲线颜色
  function drawResAxis(ctx, x0, padT, ph, rng, color, right) {
    var lx = right ? (x0 + 2) : (x0 + RD_AXIS_W - 5);
    ctx.save();
    ctx.strokeStyle = color; ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(lx + 0.5, padT); ctx.lineTo(lx + 0.5, padT + ph);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color; ctx.font = "9px sans-serif";
    var vals = [rng[1], (rng[0] + rng[1]) / 2, rng[0]];
    var ys = [padT + 8, padT + ph / 2 + 3, padT + ph];
    for (var i = 0; i < 3; i++) {
      var txt = fmtNum(vals[i]);
      if (right) { ctx.textAlign = "left"; ctx.fillText(txt, lx + 4, ys[i]); }
      else { ctx.textAlign = "right"; ctx.fillText(txt, lx - 3, ys[i]); }
    }
    ctx.textAlign = "left";
    ctx.restore();
  }

  // 一条曲线：按自己的范围铺满图高；null / NaN = 断线，绝不把静音缝连成直线
  function drawResLine(ctx, f, c, color, vr, padL, pw, padT, ph, rng) {
    var pts = rd.series[c] || [];
    var span = (rng[1] - rng[0]) || 1;
    ctx.strokeStyle = color; ctx.lineWidth = 2.0; ctx.setLineDash([]);
    ctx.beginPath();
    var started = false;
    pts.forEach(function (p) {
      var v = p[1];
      if (v == null || !isFinite(v) || !inSyllable(f, p[0])) { started = false; return; }
      var x = mapT(p[0], vr, padL, pw);
      var y = padT + (1 - (v - rng[0]) / span) * ph;
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // 悬停读数：t 时刻各参数的取值 = 曲线上最近的有值点（限 ±40ms 内，超出视为无值）
  function rdValueAt(c, t) {
    var pts = rd.series[c] || [];
    var best = null, bd = Infinity;
    for (var i = 0; i < pts.length; i++) {
      var d = Math.abs(pts[i][0] - t);
      if (d < bd) { bd = d; best = pts[i]; if (d === 0) break; }
      if (pts[i][0] > t + 0.2) break;   // 点按时间有序，越过即可停
    }
    return (best && best[1] != null && bd <= 0.04) ? best[1] : null;
  }

  // 十字线 + 数值浮框（stripMode 时在每条带里各画一个同色圆点）
  function drawHover(ctx, cv, f, vr, padL, pw, padT, ph, stripMode, STRIP_H, STRIP_GAP) {
    var hv = rd.hover;
    if (!hv || !rd.params.length) return;
    var t = hv.t;
    if (t < vr[0] || t > vr[1]) return;
    var x = mapT(t, vr, padL, pw);
    ctx.save();
    ctx.strokeStyle = "rgba(60,70,90,0.55)"; ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    var yBot = stripMode ? padT + rd.params.length * (STRIP_H + STRIP_GAP) : padT + ph;
    ctx.beginPath(); ctx.moveTo(x + 0.5, padT); ctx.lineTo(x + 0.5, yBot - STRIP_GAP); ctx.stroke();
    ctx.setLineDash([]);
    // 浮框：时间 + 各参数值（有值的才列）
    var rows = [];
    rdActive().forEach(function (c, i) {
      var v = rdValueAt(c, t);
      if (v == null) return;
      var color = PALETTE[i % PALETTE.length];
      rows.push({ c: c, v: v, color: color });
      if (stripMode) {
        var rng = rd.ranges[c] || [0, 1];
        var sy0 = padT + i * (STRIP_H + STRIP_GAP);
        var frac = (v - rng[0]) / ((rng[1] - rng[0]) || 1);
        var yy = sy0 + 18 + (STRIP_H - 24) * (1 - Math.max(0, Math.min(1, frac)));
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(x, yy, 3, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "#fff"; ctx.stroke();
      }
    });
    if (!rows.length) { ctx.restore(); return; }
    ctx.font = "11px sans-serif";
    var lines = [t.toFixed(3) + " s"].concat(rows.map(function (r) {
      return r.c + "  " + fmtNum(r.v);
    }));
    var bw = 0;
    lines.forEach(function (s) { bw = Math.max(bw, ctx.measureText(s).width); });
    bw += 14;
    var bh = 8 + lines.length * 14;
    var bx = x + 8; if (bx + bw > padL + pw) bx = x - 8 - bw;
    // 浮框贴着鼠标高度（2026-09-27 用户要求：原来固定在顶部，堆叠模式下翻后就看不见）；
    // 默认在鼠标上方，贴顶时翻到下方，始终夹在画布内
    var by = (hv.y != null) ? hv.y - bh - 10 : padT + 6;
    if (by < 2) by = (hv.y != null ? hv.y + 12 : padT + 6);
    if (by + bh > cv.height - 2) by = cv.height - bh - 2;
    ctx.fillStyle = "rgba(255,255,255,0.94)";
    ctx.strokeStyle = "rgba(60,70,90,0.35)";
    ctx.beginPath();
    ctx.rect(bx, by, bw, bh); ctx.fill(); ctx.stroke();
    ctx.textAlign = "left"; ctx.fillStyle = "#3a4356";
    lines.forEach(function (s, i) {
      ctx.fillStyle = i ? (rows[i - 1].color) : "#3a4356";
      ctx.fillText(s, bx + 7, by + 15 + i * 14);
    });
    ctx.restore();
  }

  function drawResultsDetail(cv, f) {
    var ctx = cv.getContext("2d");
    var W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fafbfc"; ctx.fillRect(0, 0, W, H);
    var ps = rdActive();
    // y 轴显示方式（2026-09-27 用户定案，顶栏段式按钮切换）：
    //   重叠 overlay：所有曲线画在同一张语图上，彩色纵轴左右交替（读数直观、便于比较）；
    //   堆叠 strip：**没有主图**（语图没法看，空着占地方），画布上从上到下每条参数
    //             一条独立窄带（small multiples：共享时间轴、各标 min—max—中位）。
    var stripMode = rd.mode === "strip";
    var nL = !stripMode ? Math.floor(ps.length / 2) : 0;   // 左轴：第 2、4、6 条参数
    var nR = !stripMode ? Math.ceil(ps.length / 2) : 0;    // 右轴：第 1、3、5 条参数
    var padT = 10, padB = 16;
    var padL = 6 + nL * RD_AXIS_W, padR = 6 + nR * RD_AXIS_W;
    var stripArea = stripMode ? ps.length * RD_STRIP_H + (ps.length - 1) * RD_STRIP_GAP : 0;
    var pw = Math.max(60, W - padL - padR);
    var ph = Math.max(40, H - padT - padB - stripArea);
    var vr = [0, (f.duration || 1) || 1];
    var ax = rdSpecAxis();
    if (stripMode) {
      // 堆叠：从画布顶部直接铺窄带，时间轴在画布最底下
      var sy0 = padT;
      ps.forEach(function (c, i) {
        var color = PALETTE[i % PALETTE.length];
        var rng = rd.ranges[c] || [0, 1];
        var st = rd.stats[c] || { n: 0 };
        // 底色条 + 左侧参数名（同色）+ 右端 min—max—中位
        ctx.fillStyle = "rgba(130,140,160,0.08)";
        ctx.fillRect(padL, sy0, pw, RD_STRIP_H);
        ctx.strokeStyle = color; ctx.globalAlpha = 0.6; ctx.lineWidth = 1;
        ctx.strokeRect(padL + 0.5, sy0 + 0.5, pw - 1, RD_STRIP_H - 1);
        ctx.globalAlpha = 1;
        ctx.fillStyle = color; ctx.font = "10px sans-serif"; ctx.textAlign = "left";
        ctx.fillText(c, padL + 5, sy0 + 14);
        ctx.textAlign = "right";
        ctx.fillText(fmtNum(rng[0]) + " — " + fmtNum(rng[1]) +
                     (st.n ? "（中位 " + fmtNum(st.median) + "）" : ""),
                     padL + pw - 5, sy0 + 14);
        // 带内画五格参考线（无频率数字，纯视觉分隔）
        drawHGrid(ctx, padL, sy0 + 18, pw, RD_STRIP_H - 24, 0, 1, -9999, "#8a93a6", "9px", false, 5);
        drawResLine(ctx, f, c, color, vr, padL, pw, sy0 + 18, RD_STRIP_H - 24, rng);
        sy0 += RD_STRIP_H + RD_STRIP_GAP;
      });
      ctx.textAlign = "left";
      drawHover(ctx, cv, f, vr, padL, pw, padT, 0, true, RD_STRIP_H, RD_STRIP_GAP);
      return;
    }
    paintSpectrogramIn(ctx, f, padL, padT, pw, ph, ax.fmax, ax.band, vr, false, rdRedraw);
    // 语图网格线：纵向分五格（4 条内线，带频率数字，2026-09-27 用户要求）
    drawHGrid(ctx, padL, padT, pw, ph, 0, ax.fmax, padL + 26, "#8a93a6", "9px", false, 5);
    paintSegments(ctx, f, function (t) { return mapT(t, vr, padL, pw); }, padT, padT + ph);
    ctx.strokeStyle = "#e2e6ee"; ctx.lineWidth = 1;
    ctx.strokeRect(padL, padT, pw, ph);
    // 重叠：彩轴左右交替（0→右、1→左、2→右……），曲线铺满主图
    ps.forEach(function (c, i) {
      var rng = rd.ranges[c] || [0, 1];
      var color = PALETTE[i % PALETTE.length];
      var right = (i % 2 === 0);
      var k = Math.floor(i / 2);          // 同侧第 k 根轴
      drawResAxis(ctx, right ? (padL + pw + 4 + k * RD_AXIS_W) : (4 + k * RD_AXIS_W),
                  padT, ph, rng, color, right);
      drawResLine(ctx, f, c, color, vr, padL, pw, padT, ph, rng);
    });
    // 时间轴（秒）
    ctx.fillStyle = "#8a93a6"; ctx.font = "9px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("0", padL, H - 4);
    ctx.textAlign = "right";
    ctx.fillText(vr[1].toFixed(2) + "s", padL + pw, H - 4);
    ctx.textAlign = "left";
    drawHover(ctx, cv, f, vr, padL, pw, padT, ph, false, RD_STRIP_H, RD_STRIP_GAP);
  }

  // 鼠标在详情画布上移动 → 记录悬停时刻（rAF 节流重绘）。仅多参数版生效。
  function onDetailCanvasMove(e) {
    if (!rd.on) return;
    var f = rd.file;
    if (!f || !rd.params.length) return;
    var cv = $("#rgDetailCanvas");
    var rect = cv.getBoundingClientRect();
    var x = (e.clientX - rect.left) * (cv.width / (rect.width || cv.width));
    var y = (e.clientY - rect.top) * (cv.height / (rect.height || cv.height));
    // 与 drawResultsDetail 相同的布局参数（只求时间映射，够用）
    var ps = rdActive();
    var stripMode = rd.mode === "strip";
    var nL = stripMode ? 0 : Math.floor(ps.length / 2);
    var nR = stripMode ? 0 : Math.ceil(ps.length / 2);
    var padL = 6 + nL * RD_AXIS_W, padR = 6 + nR * RD_AXIS_W;
    var pw = Math.max(60, cv.width - padL - padR);
    var dur = (f.duration || 1) || 1;
    if (x < padL || x > padL + pw) { if (rd.hover) { rd.hover = null; drawDetail(f); } return; }
    rd.hover = { t: (x - padL) / pw * dur, x: x, y: y };
    if (rd.rafPending) return;
    rd.rafPending = true;
    requestAnimationFrame(function () {
      rd.rafPending = false;
      if (rd.on && rd.hover) drawDetail(rd.file);
    });
  }

  // 供 app.js 的 setStep(4) 调用：第一次进这一步铺下拉并读第一页
  window.refreshResultsGrid = function () {
    rvInit();
    rvFetch();
  };

  init();
  // 供音节九宫格在 TextGrid 写盘后唤起（弹窗没打开就不做无谓请求）
  window.refreshReviewGrid = function () {
    if (!$("#reviewGridModal").classList.contains("hidden")) reloadTextGrid();
  };
  // 供向导第三步「测量路线」框任意位置点击进九宫格（app.js 里绑定）
  window.openGrid = openGrid;
  window.closeGrid = closeGrid;
})();
