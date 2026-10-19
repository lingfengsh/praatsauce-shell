/* VS 风格皮肤逻辑 —— 复刻 VoiceSauce 八按钮流程，底层调用与向导版相同的 /api 后端 */
  (function () {
    "use strict";

    // 原生窗口保活：页面加载即发一次心跳，避免 app.py 的 15 秒超时误判“无响应”而退回浏览器
    fetch("/api/ping");
    // 心跳：每 10s 打一次，后端据此判断页面是否还开着——关闭标签页后自动退出进程
    setInterval(function () { try { fetch("/api/ping"); } catch (e) {} }, 10000);

    var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  function api(method, path, body) {
    var opt = { method: method, headers: { "Content-Type": "application/json" } };
    if (body) opt.body = JSON.stringify(body);
    return fetch(path, opt).then(function (r) { return r.json(); }).catch(function (e) {
      return { ok: false, error: String(e) };
    });
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // ---- 完整 VS 参数清单（照 VS 原样列出；能算的亮，不能算的灰并标注）----
  var VS_PARAMS = [
    { vs: "F0 (STRAIGHT)",       our: "pitch",    active: true,  disp: "F0", label: "F0（本工具用 Praat 滤波自相关 / 互相关，无 STRAIGHT）" },
    { vs: "Formants (Snack)",    our: "formant",   active: true,  disp: "Formants", label: "Formants（本工具用 Praat Burg，无 Snack）" },
    { vs: "H1, H2, H4",          our: "harmonicAmplitude", active: true },
    { vs: "A1, A2, A3",          our: "harmonicAmplitude", active: true },
    { vs: "2K, 5K",              our: "harmonicAmplitude", active: true },
    { vs: "H1*-H2*, H2*-H4*",    our: "slope",     active: true },
    { vs: "H1*-A1*, H1*-A2*, H1*-A3*", our: "slope", active: true },
    { vs: "H4*-2K*, 2K*-5K",     our: "slope",     active: true },
    { vs: "Energy",              our: "intensity", active: true },
    { vs: "CPP",                 our: "cpp",       active: true },
    { vs: "HNR",                 our: "hnr",       active: true },
    { vs: "SoE (epoch)",         our: "soe",       active: true },
    { vs: "SHR",                 our: "shr",       active: true,  note: "次谐谐波比（Sun 2002），Python 外接补算" },
    { vs: "CPPS (标准 Praat 算法)", our: "cpps", active: true,  note: "ps_get_CPPS.praat：平滑倒谱后逐帧取峰（M&W 2015）" }
  ];
  var OUR_BY_VS = {};
  VS_PARAMS.forEach(function (p) { OUR_BY_VS[p.vs] = p.our; });

  var boot = null;
  var state = {
    currentDir: "", outDir: "", outFile: "out.tsv", soundExt: "wav",
    selectedVs: {}, files: [], selectedFiles: new Set(), lastResultPath: null, adjustFile: "", adjustFiles: []
  };
  // VS 版「参数显示」状态：与「数据调整」同构，但右侧是参数列表而非参数修改面板
  var DP = {
    dir: "", file: "", available: {}, ranges: {}, selected: [], series: {},
    showSpec: false, specBuf: null, duration: 0, busy: false
  };
  var DP_MAX = 8;           // 同时叠加的曲线上限（彩色纵轴左右各占 42px，太多会挤）
  var DP_AXIS_W = 42;       // 一条纵轴占的横向宽度（含数字）

  // -------------------------------------------------------------- 启动
  api("GET", "/api/bootstrap").then(function (b) {
    boot = b;
    state.values = Object.assign({}, b.defaults || {});
    var s = b.settings || {};
    if (s.lastInputDir) { state.currentDir = s.lastInputDir; $("#exDir").value = s.lastInputDir; }
    if (s.lastOutputDir) state.outDir = s.lastOutputDir;
    if (s.soundExt) state.soundExt = s.soundExt;
    // VS 默认选中常规参数；SHR/CPPS 为进阶项，默认不勾选
    var VS_DEFAULT_ON = ["F0 (STRAIGHT)", "Formants (Snack)", "H1, H2, H4", "A1, A2, A3",
      "2K, 5K", "H1*-H2*, H2*-H4*", "H1*-A1*, H1*-A2*, H1*-A3*", "H4*-2K*, 2K*-5K",
      "Energy", "CPP", "HNR", "SoE (epoch)"];
    VS_DEFAULT_ON.forEach(function (n) { state.selectedVs[n] = true; });
    buildParamGrid();
    updateParamSummary();
    refreshExStatus();
  });

  // -------------------------------------------------------------- 命令栏
  $$(".cmdbar button[data-act]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var a = btn.getAttribute("data-act");
      if (a === "extract") openExtract();
      else if (a === "display") openDisplay();
      else if (a === "export") openExport();
      else if (a === "adjust") openAdjust();
      else if (a === "settings") openSettings();
      else if (a === "about") openMask("mAbout");
      else if (a === "quit") { if (window.close) window.close(); else alert("请直接关闭窗口。"); }
      else if (a === "emu") { /* disabled */ }
    });
  });

  // 反馈（标题栏「反馈」链接）
  var fb = $("#vsFeedback");
  if (fb) fb.addEventListener("click", function (e) { e.preventDefault(); openFeedback(); });

  // -------------------------------------------------------------- 模态开关
  function openMask(id) { $("#" + id).classList.add("open"); }
  function closeMask(el) { el.classList.remove("open"); }
  $$(".mask").forEach(function (m) {
    m.addEventListener("click", function (e) { if (e.target === m) closeMask(m); });
    $$("[data-close]", m).forEach(function (x) { x.addEventListener("click", function () { closeMask(m); }); });
  });

  // -------------------------------------------------------------- 文件夹选择器
  // 统一选择器见 ui/picker.js（与主程序向导共用，自包含 DOM+样式，含面包屑/加载反馈/防重入/滚动归顶）。
  // 这里只保留一个转发函数，历史调用方（exBrowse / exOutBrowse / DP.dir / adjDataDir / pickFile）无需改动。
  function openPicker(initPath, cb) {
    if (window.openFolderPicker) window.openFolderPicker(initPath, cb);
  }

  // -------------------------------------------------------------- 参数提取
  // 进入「参数提取」界面：若已记录输入目录（来自上次的 lastInputDir 或刚在别处设过），
  // 立即扫描并列出其中的声音文件，避免顶部有路径、下方却空着「请先选择目录。」
  function openExtract() {
    openMask("mExtract");
    refreshExStatus();
    if (state.currentDir) doScan();
  }
  function refreshExStatus() {
    var ok = state.currentDir && /\S/.test(state.currentDir);
    $("#exStatus").textContent = ok ? "已选定目录：" + state.currentDir : "尚未选择音频目录";
  }
  $("#exBrowse").addEventListener("click", function () {
    openPicker(state.currentDir, function (p) {
      state.currentDir = p; state.values.inputDir = p;
      $("#exDir").value = p;
      api("POST", "/api/settings", { lastInputDir: p });
      doScan();
    });
  });
  $("#exOutBrowse").addEventListener("click", function () {
    openPicker(state.outDir, function (p) { state.outDir = p; $("#exOutDir").value = p; });
  });
  function renderFileList() {
    var box = $("#exFileList");
    if (!state.files.length) { box.innerHTML = '<div style="color:#9aa4b2">请先选择目录。</div>'; return; }
    box.innerHTML = state.files.slice(0, 200).map(function (n) {
      var on = state.selectedFiles.has(n);
      return '<div class="fsel' + (on ? " on" : "") + '" data-file="' + esc(n) + '">' +
        '<span class="ck">' + (on ? "✓" : "") + '</span><span class="nm">' + esc(n) + "</span></div>";
    }).join("") + (state.files.length > 200 ? '<div class="more">…还有 ' + (state.files.length - 200) + " 个（已默认选中）</div>" : "");
    $$("#exFileList .fsel").forEach(function (row) {
      row.addEventListener("click", function () {
        var f = row.getAttribute("data-file");
        if ($("#exShowWave").checked) { previewWave(f); return; }
        var on = state.selectedFiles.has(f);
        if (on) state.selectedFiles.delete(f); else state.selectedFiles.add(f);
        row.classList.toggle("on", !on);
        row.querySelector(".ck").textContent = on ? "" : "✓";
        updateSelCount();
      });
    });
  }
  function updateSelCount() {
    var m = state.files.length, n = state.selectedFiles.size;
    var el = $("#exSelCount");
    el.textContent = m ? "选中 " + n + "/" + m : "";
    el.classList.toggle("empty", n === 0);
  }
  var _actx = null;
  function previewWave(name) {
    var cv = $("#exWave");
    cv.style.display = "";
    $("#exWaveHint").style.display = "";
    var ctx = cv.getContext("2d");
    var W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#f3f5f8"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#9aa4b2"; ctx.font = "13px sans-serif";
    ctx.fillText("加载 " + name + " …", 10, H / 2);
    var dir = (state.currentDir || "").replace(/[\\\/]+$/, "");
    var path = dir ? dir + "/" + name : name;
    fetch("/api/review/wav?path=" + encodeURIComponent(path))
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.arrayBuffer(); })
      .then(function (buf) {
        if (!_actx) _actx = new (window.AudioContext || window.webkitAudioContext)();
        return _actx.decodeAudioData(buf);
      })
      .then(function (audio) { drawWave(ctx, cv, audio); })
      .catch(function (e) {
        ctx.clearRect(0, 0, W, H); ctx.fillStyle = "#f3f5f8"; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = "#a33726"; ctx.fillText("波形加载失败：" + e.message, 10, H / 2);
      });
  }
  function drawWave(ctx, cv, audio) {
    var ch = audio.getChannelData(0);
    var n = ch.length, W = cv.width, H = cv.height, mid = H / 2;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#f3f5f8"; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#2e7af6"; ctx.lineWidth = 1; ctx.beginPath();
    var step = n / W;
    for (var x = 0; x < W; x++) {
      var s = Math.floor(x * step), e = Math.floor((x + 1) * step);
      var min = 1, max = -1;
      for (var i = s; i < e && i < n; i++) { var v = ch[i]; if (v < min) min = v; if (v > max) max = v; }
      ctx.moveTo(x, mid + min * mid); ctx.lineTo(x, mid + max * mid);
    }
    ctx.stroke();
  }
  function doScan() {
    if (!state.currentDir) return;
    api("POST", "/api/scan", { dir: state.currentDir, ext: state.soundExt }).then(function (r) {
      if (!r.ok) { $("#exFileList").innerHTML = '<div style="color:#a33726">' + esc(r.error) + "</div>"; return; }
      state.files = (r.files || []).map(function (f) { return f.name; });
      if (!state.files.length) { state.selectedFiles = new Set(); $("#exFileList").innerHTML = '<div style="color:#9aa4b2">该目录下没有 .' + esc(state.soundExt) + " 文件</div>"; updateSelCount(); return; }
      state.selectedFiles = new Set(state.files);   // 默认全选
      renderFileList();
      updateSelCount();
    });
  }
  $("#exDir").addEventListener("change", function () {
    state.currentDir = this.value.trim(); state.values.inputDir = state.currentDir; refreshExStatus(); doScan();
  });
  $("#exUseTG").addEventListener("change", function () { $("#exTierRow").style.display = this.checked ? "flex" : "none"; });
  $("#exShowWave").addEventListener("change", function () {
    if (!this.checked) { $("#exWave").style.display = "none"; $("#exWaveHint").style.display = "none"; }
  });

  // 参数选择对话框
  function buildParamGrid() {
    $("#paramGrid").innerHTML = VS_PARAMS.map(function (p) {
      var checked = state.selectedVs[p.vs] ? "checked" : "";
      var dis = p.active ? "" : "disabled";
      var cls = "param-row" + (p.active ? "" : " disabled");
      var shown = p.label || p.vs;
      var meta = (p.note && !p.label) ? '<div class="meta">' + esc(p.note) + "</div>" : "";
      return '<label class="' + cls + '"><input type="checkbox" data-vs="' + esc(p.vs) + '" ' + checked + " " + dis + ">" +
        "<span><div>" + esc(shown) + "</div>" + meta + "</span></label>";
    }).join("");
    $$('#paramGrid input[type=checkbox]').forEach(function (c) {
      c.addEventListener("change", function () {
        var vs = c.getAttribute("data-vs");
        if (!c.disabled) state.selectedVs[vs] = c.checked;
        updateParamSummary();
      });
    });
  }
  function updateParamSummary() {
    var active = VS_PARAMS.filter(function (p) { return p.active && state.selectedVs[p.vs]; });
    $("#exParamSummary").textContent = "已选 " + active.length + " 项可算参数" +
      (VS_PARAMS.some(function (p) { return !p.active; }) ? "（另有 " + VS_PARAMS.filter(function (p) { return !p.active; }).length + " 项暂不支持，已置灰）" : "");
    $("#paramCount").textContent = "激活 " + active.length + " / " + VS_PARAMS.length + " 项";
  }
  $("#exParamSel").addEventListener("click", function () { openMask("mParamSel"); });

  // 构建提交给后端的 values
  function buildValues() {
    var v = Object.assign({}, state.values);
    v.inputDir = state.currentDir;
    v.outputDir = state.outDir || state.currentDir;
    v.outputFile = state.outFile || "out.tsv";
    v.soundExt = state.soundExt || "wav";
    v.resample16kHz = $("#exResample").checked ? 1 : 0;
    v.useTextGrid = $("#exUseTG").checked ? 1 : 0;
    v.intervalTier = parseInt($("#exTier").value, 10) || 1;
    var has = function (vs) { return !!state.selectedVs[vs]; };
    var any = function (arr) { return arr.some(has); };
    v.pitch = has("F0 (STRAIGHT)") ? 1 : 0;
    v.formant = has("Formants (Snack)") ? 1 : 0;
    var ha = any(["H1, H2, H4", "A1, A2, A3", "2K, 5K"]);
    v.harmonicAmplitude = ha ? 1 : 0; v.harmonicAmplitudeUncorrected = ha ? 1 : 0;
    var sl = any(["H1*-H2*, H2*-H4*", "H1*-A1*, H1*-A2*, H1*-A3*", "H4*-2K*, 2K*-5K"]);
    v.slope = sl ? 1 : 0; v.slopeUncorrected = sl ? 1 : 0;
    v.intensity = has("Energy") ? 1 : 0;
    v.cpp = has("CPP") ? 1 : 0;
    v.hnr = has("HNR") ? 1 : 0;
    v.soe = has("SoE (epoch)") ? 1 : 0;
    v.shr = has("SHR") ? 1 : 0;
    v.cpps = has("CPPS (平滑 CPP)") ? 1 : 0;
    return v;
  }

  $("#exStart").addEventListener("click", function () {
    var msg = $("#exMsg"); msg.innerHTML = "";
    if (!state.currentDir) { msg.innerHTML = '<div class="errbox">请先选择音频目录（Browse...）。</div>'; return; }
    if (!state.selectedFiles.size) { msg.innerHTML = '<div class="errbox">没有选中的文件，请至少选中一个（默认全选，点击可取消）。</div>'; return; }
    var v = buildValues();
    state.outFile = $("#exOutFile").value.trim() || "out.tsv";
    v.outputFile = state.outFile;
    v.outputDir = state.outDir || state.currentDir;
    api("POST", "/api/validate", { values: v }).then(function (chk) {
      if (!chk.ok) {
        var items = (chk.errors || []).map(function (e) { return "· " + esc(e.msg); }).join("<br>");
        msg.innerHTML = '<div class="errbox"><b>运行前检查未通过：</b><br>' + items + "</div>";
        return;
      }
      if ((chk.warnings || []).length) {
        msg.innerHTML = '<div class="note">' + (chk.warnings || []).map(function (w) { return "· " + esc(w.msg); }).join("<br>") + "</div>";
      }
      api("POST", "/api/run", { values: v, files: Array.from(state.selectedFiles) }).then(function (r) {
        if (!r.ok) { msg.innerHTML = '<div class="errbox">' + esc(r.error) + "</div>"; return; }
        pollJob(r.jobId, function (res) {
          if (res.status === "done") {
            state.lastResultPath = res.resultPath;
            var d = (res.summary && res.summary.diagnostics) || [];
            var bad = d.filter(function (x) { return x.level === "error"; }).length;
            msg.innerHTML = '<div class="okbox">批量完成：' + (res.summary ? res.summary.rowCount : 0) +
              " 行结果 → " + esc(res.resultPath || "") + (bad ? '；<b style="color:#a33726">' + bad + " 项警示</b>" : "") +
              '。<br>可在「输出到文本」导出 CSV。</div>';
          } else if (res.status === "error") {
            msg.innerHTML = '<div class="errbox">' + esc(res.error || "运行失败") + "</div>";
          } else if (res.status === "cancelled") {
            msg.innerHTML = '<div class="note">已取消。</div>';
          }
        });
      });
    });
  });

  // -------------------------------------------------------------- 任务轮询
  function pollJob(id, cb) {
    var t = setInterval(function () {
      api("GET", "/api/job/" + id).then(function (r) {
        if (!r.ok) { clearInterval(t); cb(r); return; }
        var p = r.progress || {};
        if (p.total) $("#exStatus").textContent = "处理中 " + (p.done || 0) + "/" + p.total + (p.current ? "  " + p.current : "");
        if (r.status === "done" || r.status === "error" || r.status === "cancelled") {
          clearInterval(t);
          if (r.status === "done") $("#exStatus").textContent = "完成";
          cb(r);
        }
      });
    }, 800);
  }

  // -------------------------------------------------------------- 参数显示
  // 与「数据调整」同构：左上大画布 + 右上参数列表（点选叠加）；左下文件目录/列表；
  // 右下仅保留「显示语图」开关（去掉了 f0/formant 单选与保存按钮）。
  // 数据：右侧参数清单来自 /api/series-available（灰显未测项）；纵轴量程来自
  // /api/results/param-ranges（批内冻结量程）。绘制规则：共振峰 F1–F5 共用与语图一致的
  // 0–5500Hz 频率标尺（单一共享纵轴）；其余参数各自独立纵轴（左右交替彩轴）。单文件曲线来自 /api/file-series。
  function openDisplay() {
    openMask("mDisplay");
    var d = state.currentDir || "";
    $("#dpWavDir").value = d;
    DP.dir = d;
    DP.file = ""; DP.selected = []; DP.series = {}; DP.available = {}; DP.ranges = {};
    DP.showSpec = false; DP.specBuf = null;
    var sb = $("#dpShowSpec"); sb.checked = false;
    $("#dpStatus").textContent = "";
    $("#dpSrcNote").textContent = d ? ("数据自动从 " + d.replace(/[\\\/]+$/, "") + "/measure 读取") : "";
    renderDisplayFileList();
    dpLoadMeta(d);
    requestAnimationFrame(dpResizeCanvas);
  }
  // 目录级元数据：参数可用性（灰显未测）+ 全批冻结量程（各参数独立纵轴）
  function dpLoadMeta(dir) {
    if (!dir) { renderDpParamList(); return; }
    api("POST", "/api/series-available", { dir: dir, ext: state.soundExt }).then(function (r) {
      if (!r.ok) { $("#dpParamList").innerHTML = '<div style="color:#a33726">' + esc(r.error) + "</div>"; return; }
      DP.available = r.available || {};
      var cols = Object.keys(DP.available).filter(function (c) { return DP.available[c]; });
      renderDpParamList();
      // 自动勾选已测的基频/共振峰（F0、F1、F2、F3），方便一眼看主曲线
      ["F0", "F1", "F2", "F3"].forEach(function (c) { if (DP.available[c] && DP.selected.indexOf(c) < 0) DP.selected.push(c); });
      renderDpParamList();
      if (cols.length) {
        api("POST", "/api/results/param-ranges", { dir: dir, params: cols, ext: state.soundExt }).then(function (rr) {
          if (rr.ok) DP.ranges = rr.ranges || {};
          drawDpOverlay();
        });
      } else {
        drawDpOverlay();
      }
    });
  }
  function renderDisplayFileList() {
    var d = $("#dpWavDir").value.trim();
    DP.dir = d;
    if (!d) { $("#dpFileList").innerHTML = '<div style="color:#4b5563">请先选择 wav 目录</div>'; return; }
    api("POST", "/api/scan", { dir: d, ext: state.soundExt }).then(function (r) {
      if (!r.ok) { $("#dpFileList").innerHTML = '<div style="color:#a33726">' + esc(r.error) + "</div>"; return; }
      var files = (r.files || []).map(function (f) { return f.name; });
      if (!files.length) { $("#dpFileList").innerHTML = '<div style="color:#9aa4b2">本目录无音频</div>'; return; }
      $("#dpFileList").innerHTML = files.map(function (n) {
        return '<div data-name="' + esc(n) + '">' + esc(n) + "</div>";
      }).join("");
      $$("#dpFileList div").forEach(function (dv) {
        dv.addEventListener("click", function () {
          DP.file = dv.getAttribute("data-name");
          $$("#dpFileList div").forEach(function (x) { x.style.background = ""; });
          dv.style.background = "#d7e3f8";
          dpLoadFile();
        });
      });
      if (!DP.file && files.length) DP.file = files[0];
      if (DP.file) {
        var sel = $$('#dpFileList div[data-name="' + esc(DP.file) + '"]')[0];
        if (sel) sel.click();
      }
    });
  }
  function dpLoadFile() {
    var file = DP.file, dir = DP.dir;
    if (!file || !dir) { $("#dpStatus").textContent = "未选择文件"; return; }
    $("#dpStatus").textContent = "正在加载 " + file + " …";
    var cols = Object.keys(DP.available).filter(function (c) { return DP.available[c]; });
    api("POST", "/api/file-series", { dir: dir, name: file, params: cols, ext: state.soundExt }).then(function (r) {
      if (!r.ok) { $("#dpStatus").textContent = esc(r.error || "加载失败"); return; }
      DP.series = r.series || {};
      DP.duration = r.duration || 0;
      if (r.warnings && r.warnings.length) $("#dpStatus").textContent = r.warnings[0];
      else $("#dpStatus").textContent = "已加载 " + file + "（" + (r.duration ? r.duration.toFixed(3) + "s" : "时长未知") + "）";
      var wavPath = dir.replace(/[\\\/]+$/, "") + "/" + file;
      adjFetchWav(wavPath).then(function (buf) { DP.specBuf = buf; if (DP.showSpec) drawDpOverlay(); }).catch(function () { DP.specBuf = null; });
      drawDpOverlay();
    });
  }
  function dpToggleParam(col) {
    if (!DP.available[col]) return;           // 未测参数不可选
    var i = DP.selected.indexOf(col);
    if (i >= 0) DP.selected.splice(i, 1);
    else {
      if (DP.selected.length >= DP_MAX) {
        $("#dpStatus").textContent = "最多同时叠加 " + DP_MAX + " 条曲线；先点掉一个再添加。";
        return;
      }
      DP.selected.push(col);
    }
    renderDpParamList();
    drawDpOverlay();
  }
  function renderDpParamList() {
    var box = $("#dpParamList");
    var groups = (boot && boot.seriesGroups) || [];
    if (!DP.dir) { box.innerHTML = '<div style="color:#9aa4b2">请先在左侧选择 wav 目录。</div>'; return; }
    if (!groups.length) { box.innerHTML = '<div style="color:#a33726">无可用参数清单</div>'; return; }
    var html = "", totalOn = 0, totalAll = 0;
    groups.forEach(function (g) {
      var on = g.cols.filter(function (c) { return DP.available[c]; }).length;
      totalOn += on; totalAll += g.cols.length;
      html += '<div class="dp-group">';
      html += '<div class="dp-group-head"><span>' + esc(g.label) + '</span>' +
        '<span class="dp-count' + (on ? "" : " dim") + '">' + on + "/" + g.cols.length + "</span></div>";
      html += '<div class="dp-group-body">';
      html += g.cols.map(function (c) {
        var avail = !!DP.available[c];
        var sel = DP.selected.indexOf(c) >= 0;
        var dot = avail ? '<span class="dp-dot" style="background:' + dpColorFor(c) + '"></span>' : '<span class="dp-dot dim"></span>';
        return '<div class="dp-item' + (sel ? " on" : "") + (avail ? "" : " disabled") + '" data-col="' + esc(c) + '">' +
          dot + esc(c) + (avail ? "" : ' <i class="na">未测</i>') + "</div>";
      }).join("");
      html += "</div></div>";
    });
    html += '<div class="dp-foot">共振峰(F1–F5)共用与语图一致的 0–5500Hz 频率标尺；其余参数各自独立纵轴。色块即图中曲线颜色。</div>';
    box.innerHTML = html;
    $$("#dpParamList .dp-item").forEach(function (it) {
      if (it.classList.contains("disabled")) return;
      it.addEventListener("click", function () { dpToggleParam(it.getAttribute("data-col")); });
    });
  }
  // --------------------- 重叠绘制（参考向导「查看结果」文件详情：各参数独立纵轴、左右交替彩轴） ---------------------
  var DP_PALETTE = (function () {
    var base = ["#2f6fed", "#16a085", "#e67e22", "#9b59b6", "#c0392b", "#27ae60", "#2980b9", "#d35400"];
    for (var i = 0; i < 12; i++) {
      var h = (40 + i * 137.508) % 360;
      base.push("hsl(" + h.toFixed(0) + ", 62%, " + (i % 2 ? 42 : 58) + "%)");
    }
    return base;
  })();
  function dpFmtNum(v) {
    if (v == null || !isFinite(v)) return "–";
    var a = Math.abs(v);
    if (a >= 1000) return (v / 1000).toFixed(1) + "k";
    if (a >= 100) return v.toFixed(0);
    if (a >= 10) return v.toFixed(1);
    return v.toFixed(2);
  }
  function dpMapT(t, vr, x0, pw) { return x0 + (t - vr[0]) / ((vr[1] - vr[0]) || 1) * pw; }
  function dpAutoRange(col) {
    var pts = DP.series[col] || [];
    var vs = [];
    pts.forEach(function (p) { if (p[1] != null && isFinite(p[1])) vs.push(p[1]); });
    if (!vs.length) return [0, 1];
    var lo = Math.min.apply(null, vs), hi = Math.max.apply(null, vs);
    if (lo === hi) { lo -= 1; hi += 1; }
    var pad = (hi - lo) * 0.08;
    return [lo - pad, hi + pad];
  }
  function dpDrawAxis(ctx, x0, padT, ph, rng, color, right) {
    var lx = right ? (x0 + 2) : (x0 + DP_AXIS_W - 5);
    ctx.save();
    ctx.strokeStyle = color; ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(lx + 0.5, padT); ctx.lineTo(lx + 0.5, padT + ph); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color; ctx.font = "9px sans-serif";
    var vals = [rng[1], (rng[0] + rng[1]) / 2, rng[0]];
    var ys = [padT + 8, padT + ph / 2 + 3, padT + ph];
    for (var i = 0; i < 3; i++) {
      var txt = dpFmtNum(vals[i]);
      if (right) { ctx.textAlign = "left"; ctx.fillText(txt, lx + 4, ys[i]); }
      else { ctx.textAlign = "right"; ctx.fillText(txt, lx - 3, ys[i]); }
    }
    ctx.textAlign = "left";
    ctx.restore();
  }
  function dpDrawLine(ctx, pts, color, vr, padL, pw, padT, ph, rng) {
    var span = (rng[1] - rng[0]) || 1;
    ctx.strokeStyle = color; ctx.lineWidth = 2.0;
    ctx.beginPath();
    var started = false;
    pts.forEach(function (p) {
      var v = p[1];
      if (v == null || !isFinite(v)) { started = false; return; }
      var x = dpMapT(p[0], vr, padL, pw);
      var y = padT + (1 - (v - rng[0]) / span) * ph;
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  // 稳定的「参数→颜色」映射：同一参数颜色固定（与选择顺序无关），图例与参数清单色点长期一致。
  var DP_COLOR_MAP = {};
  function dpBuildColorMap() {
    if (Object.keys(DP_COLOR_MAP).length) return;
    var groups = (boot && boot.seriesGroups) || [];
    var idx = 0;
    groups.forEach(function (g) {
      (g.cols || []).forEach(function (c) {
        if (!(c in DP_COLOR_MAP)) { DP_COLOR_MAP[c] = DP_PALETTE[idx % DP_PALETTE.length]; idx++; }
      });
    });
  }
  function dpColorFor(col) {
    dpBuildColorMap();
    if (col in DP_COLOR_MAP) return DP_COLOR_MAP[col];
    var h = 0; for (var i = 0; i < col.length; i++) h = (h * 31 + col.charCodeAt(i)) >>> 0;
    return DP_PALETTE[h % DP_PALETTE.length];
  }
  function dpUnitFor(col) {
    if (/^(f0|F0)$/.test(col) || /^F[1-5]$/.test(col)) return "Hz";
    if (/^B[1-5]$/.test(col)) return "Hz";
    if (/hnr|HNR/i.test(col) || /intensity/i.test(col) || /CPP|cpp/i.test(col)) return "dB";
    if (/jitter|shimmer/i.test(col)) return "%";
    if (/^H\d/i.test(col)) return "dB";
    if (/dur/i.test(col)) return "s";
    return "";
  }
  function dpIsFormant(col) { return /^F[1-5]$/.test(col); }
  // 共振峰共享频率纵轴：与语图 0–fmax 一致，中性灰，标注 Hz
  function dpDrawFreqAxis(ctx, x0, padT, ph, rng) {
    var lx = x0 + DP_AXIS_W - 6;
    ctx.save();
    ctx.strokeStyle = "#8b94a6"; ctx.globalAlpha = 0.6; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(lx + 0.5, padT); ctx.lineTo(lx + 0.5, padT + ph); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#5b6577"; ctx.font = "9px sans-serif";
    var vals = [rng[1], (rng[0] + rng[1]) / 2, rng[0]];
    var ys = [padT + 8, padT + ph / 2 + 3, padT + ph];
    for (var i = 0; i < 3; i++) { ctx.textAlign = "right"; ctx.fillText(dpFmtNum(vals[i]), lx - 2, ys[i]); }
    ctx.textAlign = "left"; ctx.fillText("共振峰/Hz", x0, padT + ph + 12);
    ctx.restore();
  }
  // 图例：画布左上，色块 + 参数名（含单位），与参数清单色点同源
  function dpDrawLegend(ctx, pr, ps) {
    if (!ps.length) return;
    ctx.save();
    ctx.font = "11px sans-serif";
    var rowH = 15, sw = 14, pad = 6, gap = 6;
    var maxw = 10;
    ps.forEach(function (c) {
      var w = sw + gap + ctx.measureText(c + "  " + dpUnitFor(c)).width;
      if (w > maxw) maxw = w;
    });
    var bw = maxw + pad * 2, bh = ps.length * rowH + pad * 2 - 3;
    var x = pr.x + 6, y = pr.y + 5;
    if (x + bw > pr.x + pr.w) x = pr.x + pr.w - bw;
    if (y + bh > pr.y + pr.h) y = pr.y + pr.h - bh;
    ctx.fillStyle = "rgba(255,255,255,0.84)"; ctx.fillRect(x, y, bw, bh);
    ctx.strokeStyle = "#dde2ea"; ctx.lineWidth = 1; ctx.strokeRect(x, y, bw, bh);
    ps.forEach(function (c, i) {
      var cy = y + pad + i * rowH + rowH / 2;
      ctx.fillStyle = dpColorFor(c); ctx.fillRect(x + pad, cy - 4, sw, 8);
      ctx.fillStyle = "#374151"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(c + "  " + dpUnitFor(c), x + pad + sw + gap, cy);
    });
    ctx.textBaseline = "alphabetic"; ctx.restore();
  }
  function drawDpOverlay() {
    var canvas = $("#dpChart");
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fafbfc"; ctx.fillRect(0, 0, W, H);
    var ps = DP.selected;
    // 共振峰(F1–F5)共用与语图一致的 0–fmax 频率标尺；其余参数各自独立纵轴
    var formants = ps.filter(dpIsFormant);
    var others = ps.filter(function (c) { return !dpIsFormant(c); });
    var haveFormant = formants.length > 0;
    var fm = haveFormant || ps.some(function (c) { return /^B[1-5]$/.test(c); });
    var fmax = fm ? 5500 : 5000;
    var UF = [0, fmax];
    var nL = Math.floor(others.length / 2), nR = Math.ceil(others.length / 2);
    var padT = 10, padB = 16;
    var padL = 6 + (haveFormant ? DP_AXIS_W : 0) + nL * DP_AXIS_W;
    var padR = 6 + nR * DP_AXIS_W;
    var pw = Math.max(60, W - padL - padR);
    var ph = Math.max(40, H - padT - padB);
    var maxt = 0;
    ps.forEach(function (c) { (DP.series[c] || []).forEach(function (p) { if (p[0] != null && p[0] > maxt) maxt = p[0]; }); });
    var dur = (DP.duration > 0 ? DP.duration : (maxt || 1));
    var vr = [0, dur || 1];
    var pr = { x: padL, y: padT, w: pw, h: ph };
    if (DP.showSpec && DP.specBuf) {
      drawAdjSpectrogramBg(ctx, pr, fmax, 5, DP.specBuf);
    }
    ctx.strokeStyle = "#e2e6ee"; ctx.lineWidth = 1; ctx.strokeRect(padL, padT, pw, ph);
    if (haveFormant) dpDrawFreqAxis(ctx, 4, padT, ph, UF);
    others.forEach(function (c, i) {
      var rng = DP.ranges[c] || dpAutoRange(c);
      var color = dpColorFor(c);
      var right = (i % 2 === 0);
      var k = Math.floor(i / 2);
      var axX = right ? (padL + pw + 4 + k * DP_AXIS_W) : ((haveFormant ? DP_AXIS_W : 0) + 4 + k * DP_AXIS_W);
      dpDrawAxis(ctx, axX, padT, ph, rng, color, right);
      dpDrawLine(ctx, DP.series[c] || [], color, vr, padL, pw, padT, ph, rng);
    });
    formants.forEach(function (c) {
      dpDrawLine(ctx, DP.series[c] || [], dpColorFor(c), vr, padL, pw, padT, ph, UF);
    });
    ctx.fillStyle = "#8a93a6"; ctx.font = "9px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("0", padL, H - 4); ctx.textAlign = "right";
    ctx.fillText(vr[1].toFixed(2) + "s", padL + pw, H - 4); ctx.textAlign = "left";
    dpDrawLegend(ctx, pr, ps);
    if (!ps.length) {
      ctx.fillStyle = "#9aa4b2"; ctx.font = "13px sans-serif"; ctx.textAlign = "left";
      ctx.fillText(DP.file ? "点右侧参数列表选择要显示的测量项" : "请选择左侧文件", 12, H / 2);
    }
  }
  function dpResizeCanvas() {
    var c = $("#dpChart");
    if (!c || c.offsetParent === null) return;
    var r = c.getBoundingClientRect();
    var w = Math.max(280, Math.floor(r.width));
    var h = Math.max(160, Math.floor(r.height));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    drawDpOverlay();
  }
  $("#dpWavBrowse").addEventListener("click", function () {
    openPicker(DP.dir || state.currentDir, function (p) {
      $("#dpWavDir").value = p; DP.dir = p;
      $("#dpSrcNote").textContent = p ? ("数据自动从 " + p.replace(/[\\\/]+$/, "") + "/measure 读取") : "";
      DP.file = ""; DP.selected = []; DP.series = {}; DP.available = {}; DP.ranges = {}; DP.specBuf = null;
      renderDisplayFileList();
      dpLoadMeta(p);
    });
  });
  $("#dpLoad").addEventListener("click", renderDisplayFileList);
  (function () {
    var _t = null;
    $("#dpWavDir").addEventListener("input", function () {
      if (_t) clearTimeout(_t);
      _t = setTimeout(function () {
        DP.dir = $("#dpWavDir").value.trim();
        DP.file = ""; DP.selected = []; DP.series = {}; DP.available = {}; DP.ranges = {}; DP.specBuf = null;
        renderDisplayFileList();
        dpLoadMeta(DP.dir);
      }, 350);
    });
  })();
  $("#dpShowSpec").addEventListener("change", function () {
    DP.showSpec = $("#dpShowSpec").checked;
    drawDpOverlay();
  });

  // -------------------------------------------------------------- 输出到文本（导出逐点 CSV）
  // 与向导版「导出时间序列」同源：读取目录里实际测算的结果（measure/ 下的 .Pitch/.Formant
  // 对象 + 汇总表 out.tsv，两界面数据互通），只点亮「目录里确实测过」的参数，灰掉未测的。
  function openExport() {
    openMask("mExport");
    var dir = state.currentDir;
    var info = $("#exResultInfo");
    var grid = $("#exportGrid");
    if (!dir) {
      info.innerHTML = '<span style="color:#a33726">尚未选择音频目录。请先在「参数提取」选择目录。</span>';
      grid.innerHTML = "";
      $("#exDoExport").disabled = true;
      return;
    }
    info.innerHTML = "结果目录：<code>" + esc(dir) + "</code>（自动读取该目录已测算的结果）";
    $("#exDoExport").disabled = true;
    grid.innerHTML = '<div style="color:#9aa4b2">正在扫描已测参数…</div>';
    api("POST", "/api/series-available", { dir: dir, ext: state.soundExt }).then(function (r) {
      if (!r.ok) { grid.innerHTML = '<div style="color:#a33726">' + esc(r.error) + "</div>"; return; }
      renderExportGrid(r.available, r.warnings || []);
    });
  }
  function renderExportGrid(available, warnings) {
    var groups = (boot && boot.seriesGroups) || [];
    var grid = $("#exportGrid");
    if (!groups.length) { grid.innerHTML = '<div style="color:#a33726">无可用参数清单</div>'; return; }
    // 「能量与激励」及其之上的组默认展开；其下的组默认折叠（点击组标题可展开/折叠）
    var energyIdx = -1;
    groups.forEach(function (g, gi) { if (g.key === "energy") energyIdx = gi; });
    var totalAvail = 0, totalAll = 0, html = "";
    groups.forEach(function (g, gi) {
      var avail = g.cols.filter(function (c) { return available[c]; }).length;
      totalAvail += avail; totalAll += g.cols.length;
      var collapsed = energyIdx >= 0 && gi > energyIdx;
      html += '<div class="exp-group' + (collapsed ? " collapsed" : "") + '">';
      html += '<div class="exp-group-head" data-toggle="1"><span class="exp-caret">' +
        (collapsed ? "▸" : "▾") + '</span> ' + esc(g.label) + " " +
        '<span class="exp-gcount' + (avail ? "" : " dim") + '">' + avail + "/" + g.cols.length + "</span></div>";
      html += '<div class="exp-group-body">';
      html += g.cols.map(function (c) {
        var on = !!available[c];
        return '<label class="param-row' + (on ? "" : " disabled") + '"><input type="checkbox" data-col="' +
          esc(c) + '" ' + (on ? "checked" : "") + (on ? "" : " disabled") + ">" +
          "<span>" + esc(c) + (on ? "" : ' <i class="na">（该目录未测算）</i>') + "</span></label>";
      }).join("");
      html += "</div></div>";
    });
    html += '<div class="meta" style="grid-column:1/-1;margin-top:6px">已测算 ' + totalAvail + "/" + totalAll +
      ' 项；灰显项是该目录尚未产生的参数（点击组标题可展开/折叠）。</div>';
    if (warnings && warnings.length) {
      html += '<div class="meta" style="grid-column:1/-1;color:#a33726">' + esc(warnings[0]) + "</div>";
    }
    grid.innerHTML = html;
    $("#exDoExport").disabled = totalAvail === 0;
  }
  // 组标题点击 → 展开/折叠（事件委托，渲染多次也只绑一次）
  $("#exportGrid").addEventListener("click", function (e) {
    var head = e.target.closest(".exp-group-head");
    if (!head || !head.getAttribute("data-toggle")) return;
    var grp = head.parentNode;
    var collapsed = grp.classList.toggle("collapsed");
    var caret = head.querySelector(".exp-caret");
    if (caret) caret.textContent = collapsed ? "▸" : "▾";
  });
  $("#exDoExport").addEventListener("click", function () {
    var dir = state.currentDir;
    if (!dir) return;
    var params = $$('#exportGrid input[data-col]').filter(function (i) { return i.checked && !i.disabled; })
      .map(function (i) { return i.getAttribute("data-col"); });
    if (!params.length) { $("#exExportMsg").innerHTML = '<div class="errbox">请至少勾选一个已测算的参数。</div>'; return; }
    var layout = $("#exSingle").checked ? "single" : "per_audio";
    var outDir = state.outDir || dir;
    var base = outDir.replace(/\\/g, "/").replace(/\/$/, "");
    var outPath = layout === "per_audio" ? (base + "/逐音频序列") : null;
    var msg = $("#exExportMsg");
    msg.innerHTML = '<div class="note">正在导出 ' + params.length + " 项参数…</div>";
    api("POST", "/api/export-series", {
      dir: dir, params: params, method: "raw", layout: layout,
      outputDir: outDir, ext: state.soundExt, outPath: outPath, tgFilter: false
    }).then(function (r) {
      if (!r.ok) { msg.innerHTML = '<div class="errbox">' + esc(r.error) + "</div>"; return; }
      msg.innerHTML = '<div class="okbox">已导出 ' + r.files + " 个文件、" + r.rows + " 行 → <code>" + esc(r.path) + "</code></div>";
    });
  });

  // -------------------------------------------------------------- 数据调整：重抽并写盘 Pitch/Formant
  // 顶部图表 + 左下 wav 列表（保留）；右下重做为：单数据目录 + Pitch/Formant 单选 + 参数面板 + 语图。
  var ADJ = { method: "filtered", values: {}, measured: null, preview: null, formant: null, formantPreview: null,
              file: "", wavDir: "", mode: "pitch", showSpec: false, specBuf: null, _actx: null,
              nFormants: "5", timer: null, seq: 0, dirty: false };

  // F0 滑块定义（与向导详情窗一致：filtered = To Pitch (filtered autocorrelation)，raw = raw AC）
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
  function fmtPrevVal(v, d) {
    if (d.step >= 1) return String(Math.round(v));
    return v.toFixed(d.step >= 0.1 ? 1 : (d.step >= 0.01 ? 2 : 3));
  }
  function adjWavPath() {
    var d = ADJ.wavDir.replace(/[\\\/]+$/, "");
    return d ? d + "/" + ADJ.file : ADJ.file;
  }
  function adjParamsObj(useDefaults) {
    var vals = ADJ.values, defs = PREV_DEFS[ADJ.method];
    var o = { method: ADJ.method, pitchFloor: 75, timeStep: 0.005 };
    defs.forEach(function (d) { o[d.k] = useDefaults ? d.def : (vals[d.k] != null ? vals[d.k] : d.def); });
    return o;
  }
  function buildAdjSliders() {
    var box = $("#adjSliders");
    if (!box) return;
    box.innerHTML = "";
    PREV_DEFS[ADJ.method].forEach(function (d) {
      var v = ADJ.values[d.k];
      if (v == null || isNaN(v)) { v = d.def; ADJ.values[d.k] = v; }
      var row = document.createElement("div");
      row.className = "rg-slider-row";
      var lab = document.createElement("label");
      lab.textContent = d.label; lab.title = d.label;
      var rng = document.createElement("input");
      rng.type = "range"; rng.min = d.min; rng.max = d.max; rng.step = d.step; rng.value = v;
      var num = document.createElement("span");
      num.className = "rv"; num.textContent = fmtPrevVal(v, d);
      rng.oninput = function () {
        ADJ.values[d.k] = parseFloat(rng.value);
        ADJ.dirty = true;
        num.textContent = fmtPrevVal(ADJ.values[d.k], d);
        scheduleAdjPreview();
      };
      row.appendChild(lab); row.appendChild(rng); row.appendChild(num);
      box.appendChild(row);
    });
  }
  function syncAdjMethod() {
    $$("#adjMethod .seg-btn").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-m") === ADJ.method);
    });
  }
  function resetAdjSliders() {
    ADJ.values = {}; ADJ.dirty = false;
    if (ADJ.timer) clearTimeout(ADJ.timer);
    buildAdjSliders();
    var st = $("#adjPrevStatus"); if (st) st.textContent = "";
  }
  function scheduleAdjPreview() {
    var st = $("#adjPrevStatus");
    if (st) st.textContent = "参数已改动，计算中…";
    if (ADJ.timer) clearTimeout(ADJ.timer);
    ADJ.timer = setTimeout(runAdjPreview, 350);
  }
  function runAdjPreview() {
    if (ADJ.mode !== "pitch") return;
    var wavPath = adjWavPath();
    if (!wavPath) return;
    var seq = ++ADJ.seq;
    var params = adjParamsObj(false);
    api("POST", "/api/review/pitch-preview", { wavPath: wavPath, params: params }).then(function (r) {
      if (seq !== ADJ.seq) return;
      if (!r.ok) { $("#adjPrevStatus").textContent = (r.error || "预览失败"); return; }
      ADJ.preview = (r.points || []).map(function (p) { return { t: p.t, f0: (p.f0 > 0 ? p.f0 : null) }; });
      ADJ.dirty = false;
      $("#adjPrevStatus").textContent = "已更新：" + (r.count || 0) + " 帧";
      drawAdjChart();
    }).catch(function (e) {
      if (seq === ADJ.seq) $("#adjPrevStatus").textContent = String(e);
    });
  }
  function scheduleAdjFormantPreview() {
    if (ADJ.timer) clearTimeout(ADJ.timer);
    ADJ.timer = setTimeout(runAdjFormantPreview, 350);
  }
  function runAdjFormantPreview() {
    if (ADJ.mode !== "formant" || !ADJ.file) return;
    var wavPath = adjWavPath();
    if (!wavPath) return;
    var seq = ++ADJ.seq;
    var nf = parseInt(ADJ.nFormants, 10) || 5;
    var fc = parseFloat($("#adjMaxF").value) || 5500;
    api("POST", "/api/review/formant-preview", {
      wavPath: wavPath, params: { nFormants: nf, formantCeiling: fc }
    }).then(function (r) {
      if (seq !== ADJ.seq || ADJ.mode !== "formant") return;
      if (!r.ok) { ADJ.formantPreview = null; $("#adjStatus").textContent = "预览失败：" + (r.error || ""); drawAdjChart(); return; }
      ADJ.formantPreview = r.rows || [];
      $("#adjStatus").textContent = "实时预览：" + (r.count || 0) + " 帧 · " + nf + " 个 · 上限 " + Math.round(fc) + "Hz（保存后落盘）";
      drawAdjChart();
    }).catch(function (e) {
      if (seq === ADJ.seq) { ADJ.formantPreview = null; $("#adjStatus").textContent = String(e); drawAdjChart(); }
    });
  }
  function runAdjMeasured() {
    var wavPath = adjWavPath();
    if (!wavPath) return;
    api("POST", "/api/review/pitch-preview", { wavPath: wavPath, params: adjParamsObj(true) }).then(function (r) {
      if (!r.ok) { $("#adjStatus").textContent = "测得曲线失败：" + r.error; return; }
      ADJ.measured = (r.points || []).map(function (p) { return { t: p.t, f0: (p.f0 > 0 ? p.f0 : null) }; });
      drawAdjChart();
      $("#adjStatus").textContent = "已加载测得曲线：" + (r.count || 0) + " 帧";
    }).catch(function (e) { $("#adjStatus").textContent = String(e); });
  }
  function adjFetchWav(path) {
    return fetch("/api/review/wav?path=" + encodeURIComponent(path))
      .then(function (r) { if (!r.ok) throw new Error("wav " + r.status); return r.arrayBuffer(); })
      .then(function (ab) {
        if (!ADJ._actx) ADJ._actx = new (window.AudioContext || window.webkitAudioContext)();
        return ADJ._actx.decodeAudioData(ab);
      });
  }

  // --------------------- 浏览器实时 STFT 语图（复用向导详情窗算法） ---------------------
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
  function computeSpectrogram(audioBuffer, framesCol, freqBins, fmax, winMs, dynRange, tStart, tEnd, advanced) {
    var data = audioBuffer.getChannelData(0);
    var sr = audioBuffer.sampleRate;
    var len = data.length;
    var want = (winMs || 5) / 1000 * sr;
    var N = Math.pow(2, Math.round(Math.log(want) / Math.LN2));
    N = Math.max(64, Math.min(2048, N));
    while (N > 64 && len < N * 2) N = N / 2;
    var s0 = Math.max(0, Math.floor((tStart || 0) * sr));
    var s1 = Math.min(len, Math.ceil((tEnd || (len / sr)) * sr));
    var segLen = Math.max(1, s1 - s0);
    var hop = Math.max(1, Math.floor((segLen - N) / Math.max(1, framesCol - 1)));
    // Praat 风格：零填充把 FFT 放大到窗长约 8 倍（封顶 8192），频率分箱间隔由 sr/N 降到 sr/nFFT，
    // 共振峰带/谐波不再因分箱过粗而块状抖动。宽带用标准高斯窗(无旁瓣)，窄带仍用 Hann。
    var nFFT = Math.min(8192, Math.pow(2, Math.ceil(Math.log2(8 * N))));
    var win = new Float64Array(N);
    var windowssq = 0;
    if (winMs >= 20) {
      for (var wh = 0; wh < N; wh++) { win[wh] = 0.5 - 0.5 * Math.cos(2 * Math.PI * wh / (N - 1)); windowssq += win[wh] * win[wh]; }
    } else {
      var imid = 0.5 * (N + 1), edge = Math.exp(-12);
      for (var w = 0; w < N; w++) { var ph = (w - imid) / N; win[w] = (Math.exp(-48 * ph * ph) - edge) / (1 - edge); windowssq += win[w] * win[w]; }
    }
    var binHz = sr / nFFT;
    var maxBin = Math.round(fmax / binHz);
    maxBin = Math.max(1, Math.min(maxBin, Math.floor(nFFT / 2)));
    var nBin = maxBin + 1;
    var useMT = !!advanced && winMs < 20;
    var tapers = useMT ? getSineTapers(N, MT_K) : null;
    var wssq = useMT ? 1.0 : windowssq;   // 正弦锥已归一化（Σtp²≈1）
    var mag = new Float64Array(framesCol * nBin);
    var maxDB = -Infinity;
    var re = new Float64Array(nFFT), im = new Float64Array(nFFT);
    var accPow = useMT ? new Float64Array(nBin) : null;
    var invK = useMT ? (1 / tapers.length) : 0;
    for (var c = 0; c < framesCol; c++) {
      var start = s0 + Math.min(Math.max(0, segLen - N), c * hop);
      if (useMT) {
        for (var ak = 0; ak < nBin; ak++) accPow[ak] = 0;
        for (var tk = 0; tk < tapers.length; tk++) {
          var tp = tapers[tk];
          for (var i2 = 0; i2 < nFFT; i2++) re[i2] = (i2 < N ? (data[start + i2] || 0) * tp[i2] : 0);
          for (var z2 = 0; z2 < nFFT; z2++) im[z2] = 0;
          fft(re, im);
          for (var k2 = 0; k2 < nBin; k2++) accPow[k2] += (re[k2] * re[k2] + im[k2] * im[k2]);
        }
        for (var k3 = 0; k3 < nBin; k3++) {
          var db2 = 10 * Math.log10(accPow[k3] * invK / wssq + 1e-30);
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
    // nBin 已足够细（零填充过采样），不再做 3×3 模糊——那会抹掉分辨率。显示时按频段对功率(dB)取平均。
    var off = document.createElement("canvas");
    off.width = framesCol; off.height = freqBins;
    var octx = off.getContext("2d");
    var img = octx.createImageData(framesCol, freqBins);
    var DRANGE = dynRange || 40;
    var loDB = maxDB - DRANGE;
    for (var b = 0; b < freqBins; b++) {
      var k0 = Math.floor(b * nBin / freqBins);
      var k1 = Math.floor((b + 1) * nBin / freqBins);
      if (k1 <= k0) k1 = k0 + 1;
      if (k0 > maxBin) k0 = maxBin;
      if (k1 > nBin) k1 = nBin;
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

  // --------------------- 绘制 ---------------------
  function adjPlotRect(W, H) { return { x: 40, y: 18, w: W - 50, h: H - 40 }; }
  function adjGrid(ctx, p) {
    ctx.strokeStyle = "#eef1f5"; ctx.lineWidth = 1;
    for (var g = 0; g <= 4; g++) { var yy = p.y + g * p.h / 4; ctx.beginPath(); ctx.moveTo(p.x, yy); ctx.lineTo(p.x + p.w, yy); ctx.stroke(); }
  }
  function drawAdjSpectrogramBg(ctx, p, fmax, winMs, buf) {
    buf = buf || ADJ.specBuf;
    if (!buf) return false;
    var fc = Math.max(60, Math.round(p.w)), fb = Math.max(40, Math.round(p.h));
    var off = computeSpectrogram(buf, fc, fb, fmax, winMs, 45, 0, 0, false);
    if (!off) return false;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, p.x, p.y, p.w, p.h);
    return true;
  }
  function plotSeries(ctx, rows, key, X, Y, color) {
    ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.beginPath();
    var started = false;
    rows.forEach(function (r) {
      var v = r[key];
      if (v == null || r.t == null) { started = false; return; }
      var px = X(r.t), py = Y(v);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }
  function drawAdjChart() {
    var canvas = $("#adjChart");
    var ctx = canvas.getContext("2d");
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    if (ADJ.mode === "pitch") drawAdjPitch(ctx, W, H);
    else drawAdjFormant(ctx, W, H);
  }
  function adjResizeCanvas() {
    var c = $("#adjChart");
    if (!c || c.offsetParent === null) return;
    var r = c.getBoundingClientRect();
    var w = Math.max(280, Math.floor(r.width));
    var h = Math.max(160, Math.floor(r.height));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    drawAdjChart();
  }
  function drawAdjPitch(ctx, W, H) {
    var p = adjPlotRect(W, H);
    var measured = ADJ.measured || [], preview = ADJ.preview || [];
    if (!measured.length && !preview.length) { ctx.fillStyle = "#9aa4b2"; ctx.fillText("点击左侧文件加载曲线", 8, H / 2); return; }
    var specFmax = 2000; // F0 语图自有坐标（0..2000Hz），与 F0 曲线互不影响
    var ys = [];
    measured.forEach(function (r) { if (r.f0 != null) ys.push(r.f0); });
    preview.forEach(function (r) { if (r.f0 != null) ys.push(r.f0); });
    var ymin, ymax;
    if (!ys.length) { ymin = 0; ymax = 500; } else { ymin = Math.min.apply(null, ys); ymax = Math.max.apply(null, ys); }
    if (ymin === ymax) { ymin -= 1; ymax += 1; }
    var xs = measured.concat(preview).map(function (r) { return r.t; }).filter(function (t) { return t != null; });
    var tmin = xs.length ? Math.min.apply(null, xs) : 0, tmax = xs.length ? Math.max.apply(null, xs) : 1;
    function X(t) { return p.x + (t - tmin) / ((tmax - tmin) || 1) * p.w; }
    function Y(v) { return p.y + (1 - (v - ymin) / ((ymax - ymin) || 1)) * p.h; }
    if (ADJ.showSpec) drawAdjSpectrogramBg(ctx, p, specFmax, 25); // 语图按自己坐标画，曲线按下方 auto 坐标
    adjGrid(ctx, p);
    ctx.fillStyle = "#8a94a3"; ctx.font = "12px sans-serif";
    ctx.fillText(ymax.toFixed(0), 4, p.y + 12);
    ctx.fillText((ymin || 0).toFixed(0), 4, p.y + p.h);
    ctx.fillText("时间(s)", p.x + p.w - 50, p.y + p.h + 16);
    plotSeries(ctx, measured, "f0", X, Y, "#3b6ef0");
    plotSeries(ctx, preview, "f0", X, Y, "#e07b39");
  }
  function drawAdjFormant(ctx, W, H) {
    var p = adjPlotRect(W, H);
    var rows = ADJ.formantPreview || ADJ.formant || [];
    if (!rows.length) {
      ctx.fillStyle = "#9aa4b2";
      ctx.fillText(ADJ.mode === "formant" ? "该文件还没有 .Formant 对象（先点「保存 Formant」）" : "点击左侧文件加载", 8, H / 2);
      return;
    }
    var mf = parseFloat($("#adjMaxF").value) || 5500; // 共振峰曲线与语图共用此坐标
    var ymin, ymax;
    if (ADJ.showSpec) { ymin = 0; ymax = mf; } // 语图与共振峰曲线同一坐标（0..maxFormant）
    else {
      var ys = [];
      rows.forEach(function (r) { [1, 2, 3].forEach(function (k) { var v = r["F" + k]; if (v != null) ys.push(v); }); });
      if (!ys.length) { ymin = 0; ymax = mf; } else { ymin = Math.min.apply(null, ys); ymax = Math.max.apply(null, ys); }
      if (ymin === ymax) { ymin -= 50; ymax += 50; }
    }
    var xs = rows.map(function (r) { return r.t; });
    var tmin = Math.min.apply(null, xs), tmax = Math.max.apply(null, xs) || 1;
    function X(t) { return p.x + (t - tmin) / ((tmax - tmin) || 1) * p.w; }
    function Y(v) { return p.y + (1 - (v - ymin) / ((ymax - ymin) || 1)) * p.h; }
    if (ADJ.showSpec) drawAdjSpectrogramBg(ctx, p, ymax, 5); // fmax==maxFormant → 与曲线同坐标
    adjGrid(ctx, p);
    ctx.fillStyle = "#8a94a3"; ctx.font = "12px sans-serif";
    ctx.fillText(ymax.toFixed(0), 4, p.y + 12);
    ctx.fillText((ymin || 0).toFixed(0), 4, p.y + p.h);
    ctx.fillText("时间(s)", p.x + p.w - 50, p.y + p.h + 16);
    plotSeries(ctx, rows, "F1", X, Y, "#3b6ef0");
    plotSeries(ctx, rows, "F2", X, Y, "#3aa657");
    plotSeries(ctx, rows, "F3", X, Y, "#9b59b6");
  }
  function adjSetMode(mode) {
    ADJ.mode = mode;
    ADJ.formantPreview = null;   // 切模式时丢弃上一次的共振峰实时预览，避免残留
    $("#adjPitchPanel").classList.toggle("hidden", mode !== "pitch");
    $("#adjFormantPanel").classList.toggle("hidden", mode !== "formant");
    $("#adjApply").textContent = mode === "pitch" ? "保存 F0" : "保存 Formant";
    var leg = $("#adjChartLegend");
    if (mode === "pitch") leg.innerHTML = '<span class="dot blue"></span> 测得曲线 <span class="dot orange"></span> 当前参数预览';
    else leg.innerHTML = '<span class="dot blue"></span> F1 <span class="dot green"></span> F2 <span class="dot purple"></span> F3';
    if (ADJ.file) runAdjMeasured();
    drawAdjChart();
  }

  // --------------------- 文件列表 / 加载 ---------------------
  function openAdjust() {
    openMask("mAdjust");
    var d = state.currentDir || "";
    $("#adjWavDir").value = d;
    ADJ.wavDir = d;
    $("#adjDataDir").value = d ? (d.replace(/[\\\/]+$/, "") + "/measure") : "";
    ADJ.method = "filtered";
    syncAdjMethod();
    resetAdjSliders();
    ADJ.mode = "pitch";
    $("#adjPitchPanel").classList.remove("hidden");
    $("#adjFormantPanel").classList.add("hidden");
    $("#adjApply").textContent = "保存 F0";
    $("#adjChartLegend").innerHTML = '<span class="dot blue"></span> 测得曲线 <span class="dot orange"></span> 当前参数预览';
    ADJ.showSpec = false;
    var sb = $("#adjShowSpec"); sb.textContent = "显示语图"; sb.classList.remove("on");
    ADJ.measured = null; ADJ.preview = null; ADJ.formant = null; ADJ.formantPreview = null; ADJ.specBuf = null; ADJ.file = "";
    $("#adjStatus").textContent = "";
    renderAdjustFileList();
    requestAnimationFrame(adjResizeCanvas);
  }
  function renderAdjustFileList() {
    var d = $("#adjWavDir").value.trim();
    ADJ.wavDir = d;
    if (!d) { $("#adjFileList").innerHTML = '<div style="color:#9aa4b2">请先选择 wav 目录</div>'; return; }
    api("POST", "/api/scan", { dir: d, ext: state.soundExt }).then(function (r) {
      if (!r.ok) { $("#adjFileList").innerHTML = '<div style="color:#a33726">' + esc(r.error) + "</div>"; return; }
      var files = (r.files || []).map(function (f) { return f.name; });
      if (!files.length) { $("#adjFileList").innerHTML = '<div style="color:#9aa4b2">本目录无音频</div>'; return; }
      $("#adjFileList").innerHTML = files.map(function (n) {
        return '<div data-name="' + esc(n) + '">' + esc(n) + "</div>";
      }).join("");
      $$("#adjFileList div").forEach(function (d) {
        d.addEventListener("click", function () {
          ADJ.file = d.getAttribute("data-name");
          $$("#adjFileList div").forEach(function (x) { x.style.background = ""; });
          d.style.background = "#d7e3f8";
          loadAdjustCurves();
        });
      });
      if (!ADJ.file && files.length) ADJ.file = files[0];
      if (ADJ.file) {
        var sel = $$('#adjFileList div[data-name="' + esc(ADJ.file) + '"]')[0];
        if (sel) sel.click();
      }
    });
  }
  function loadAdjustCurves() {
    var file = ADJ.file, wavDir = $("#adjWavDir").value.trim();
    if (!file || !wavDir) { $("#adjStatus").textContent = "未选择文件"; return; }
    ADJ.wavDir = wavDir;
    var wavPath = adjWavPath();
    $("#adjStatus").textContent = "正在加载…";
    runAdjMeasured();
    var base = file.replace(/\.[^.]+$/, "");
    var fPath = wavDir.replace(/[\\\/]+$/, "") + "/measure/" + base + ".Formant";
    api("POST", "/api/read-object", { path: fPath, kind: "formant" }).then(function (r) {
      ADJ.formant = r.ok ? (r.rows || []) : [];
      drawAdjChart();
    });
    adjFetchWav(wavPath).then(function (buf) { ADJ.specBuf = buf; if (ADJ.showSpec) drawAdjChart(); }).catch(function () {});
  }
  $("#adjWavBrowse").addEventListener("click", function () {
    openPicker(state.currentDir, function (p) {
      $("#adjWavDir").value = p; ADJ.wavDir = p;
      $("#adjDataDir").value = p ? (p.replace(/[\\\/]+$/, "") + "/measure") : "";
      renderAdjustFileList();
    });
  });
  $("#adjDataBrowse").addEventListener("click", function () {
    openPicker($("#adjDataDir").value || state.currentDir, function (p) { $("#adjDataDir").value = p; });
  });
  $("#adjLoad").addEventListener("click", renderAdjustFileList);
  (function () {
    var _t = null;
    $("#adjWavDir").addEventListener("input", function () {
      if (_t) clearTimeout(_t);
      _t = setTimeout(renderAdjustFileList, 350);
    });
  })();
  $$("#adjMethod .seg-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      ADJ.method = b.getAttribute("data-m");
      syncAdjMethod();
      resetAdjSliders();
      runAdjMeasured();
      if (ADJ.mode === "pitch") scheduleAdjPreview();
    });
  });
  $$("#adjNFormants .seg-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      ADJ.nFormants = b.getAttribute("data-n");
      $$("#adjNFormants .seg-btn").forEach(function (x) { x.classList.toggle("active", x === b); });
      if (ADJ.mode === "formant") scheduleAdjFormantPreview();
    });
  });
  $("#adjMaxF").addEventListener("input", function () {
    if (ADJ.mode === "formant") scheduleAdjFormantPreview();
  });
  $$('input[name="adjDim"]').forEach(function (r) {
    r.addEventListener("change", function () { if (r.checked) adjSetMode(r.value); });
  });
  $("#adjShowSpec").addEventListener("click", function () {
    ADJ.showSpec = !ADJ.showSpec;
    this.textContent = ADJ.showSpec ? "隐藏语图" : "显示语图";
    this.classList.toggle("on", ADJ.showSpec);
    if (ADJ.showSpec && !ADJ.specBuf && ADJ.file) {
      adjFetchWav(adjWavPath()).then(function (b) { ADJ.specBuf = b; drawAdjChart(); }).catch(function () {});
    }
    drawAdjChart();
  });
  window.addEventListener("resize", adjResizeCanvas);
  window.addEventListener("resize", dpResizeCanvas);
  $("#adjSmooth").addEventListener("click", function () {
    if (!ADJ.file) { $("#adjStatus").textContent = "请先选择并加载一个音频文件"; return; }
    if (!ADJ.formant || !ADJ.formant.length) {
      $("#adjStatus").textContent = "还没有 .Formant，请先「保存 Formant」再平滑";
      return;
    }
    var wavPath = adjWavPath();
    $("#adjStatus").textContent = "正在对 .Formant 做 Track 平滑…";
    api("POST", "/api/review/track-imported", { path: wavPath, writeBack: true }).then(function (r) {
      if (!r.ok) { $("#adjStatus").textContent = "平滑失败：" + (r.error || "未知错误"); return; }
      var base = ADJ.file.replace(/\.[^.]+$/, "");
      var fPath = ADJ.wavDir.replace(/[\\\/]+$/, "") + "/measure/" + base + ".Formant";
      return api("POST", "/api/read-object", { path: fPath, kind: "formant" }).then(function (rr) {
        ADJ.formant = rr.ok ? rr.rows : [];
        drawAdjChart();
        var mf = parseFloat($("#adjMaxF").value) || 5500, nf = parseInt(ADJ.nFormants, 10) || 5;
        return api("POST", "/api/review/choice-save", {
          path: wavPath,
          choice: { formant: { id: mf + "-" + nf, label: mf + " Hz · " + nf + " 个" }, formantSmoothed: true }
        });
      });
    }).then(function () {
      $("#adjStatus").textContent = "已 Track 平滑并写回 .Formant（记为平滑权威结果）";
    }).catch(function (e) { $("#adjStatus").textContent = "平滑出错：" + e; });
  });
  (function () {
    var fn = $("#adjFootNote");
    if (fn) {
      var full = fn.getAttribute("data-full"), short = fn.getAttribute("data-short");
      fn.addEventListener("click", function () {
        if (fn.classList.contains("expanded")) { fn.textContent = short; fn.classList.remove("expanded"); }
        else { fn.textContent = full; fn.classList.add("expanded"); }
      });
    }
  })();
  $("#adjApply").addEventListener("click", function () {
    var wavPath = adjWavPath();
    if (!wavPath) { $("#adjStatus").textContent = "未选择文件"; return; }
    var choice;
    if (ADJ.mode === "pitch") {
      var p = adjParamsObj(false);
      choice = { pitch: { id: "custom",
        label: "自定义参数（" + (p.method === "filtered" ? "filtered AC" : "raw AC") + "·上限" + Math.round(p.ceiling) + "Hz)",
        method: p.method, params: p } };
    } else {
      var mf = parseFloat($("#adjMaxF").value) || 5500, nf = parseInt(ADJ.nFormants, 10) || 5;
      choice = { formant: { id: mf + "-" + nf, label: mf + " Hz · " + nf + " 个" } };
    }
    $("#adjStatus").textContent = "保存中…";
    api("POST", "/api/review/choice-save", { path: wavPath, choice: choice }).then(function (r) {
      if (!r.ok) { $("#adjStatus").textContent = "存盘失败：" + r.error; return; }
      api("POST", "/api/review/export", {
        path: wavPath, choice: r.choice,
        defaults: { pitchCeiling: 500, nFormants: 5, formantCeiling: 5500, pitchFloor: 75, timeStep: 0.005 },
        dims: ADJ.mode
      }).then(function (e) {
        if (!e.ok) { $("#adjStatus").textContent = "导出失败：" + (e.error || "未知原因"); return; }
        $("#adjStatus").textContent = "已保存" + (ADJ.mode === "pitch" ? " Pitch" : " Formant") + " → " + wavPath.split(/[\\/]/).pop();
        if (ADJ.mode === "pitch") runAdjMeasured();
        else {
          var base = ADJ.file.replace(/\.[^.]+$/, "");
          var fPath = ADJ.wavDir.replace(/[\\\/]+$/, "") + "/measure/" + base + ".Formant";
          api("POST", "/api/read-object", { path: fPath, kind: "formant" }).then(function (rr) {
            ADJ.formant = rr.ok ? rr.rows : []; ADJ.formantPreview = null; drawAdjChart();
          });
        }
      });
    }).catch(function (err) { $("#adjStatus").textContent = String(err); });
  });

  // -------------------------------------------------------------- 设置
  function openSettings() {
    openMask("mSettings");
    var s = (boot && boot.settings) || {};
    $("#setPraat").value = s.praatExe || "";
    $("#setTier").value = (s.tier === "expert" ? "advanced" : (s.tier || "novice"));
    $("#setF0min").value = (state.values.f0min != null ? state.values.f0min : (s.f0min || 50));
    $("#setF0max").value = (state.values.f0max != null ? state.values.f0max : (s.f0max || 400));
    $("#setMaxF").value = (state.values.maxFormantHz != null ? state.values.maxFormantHz : (s.maxFormantHz || 5000));
    $("#setPraatMsg").textContent = ""; $("#setMsg").textContent = "";
  }
  function pickFile(inputId, title) { openPicker("", function (p) { $("#" + inputId).value = p; }); }
  $("#setPraatPick").addEventListener("click", function () { pickFile("setPraat"); });
  $("#setPraatTest").addEventListener("click", function () {
    var exe = $("#setPraat").value.trim();
    api("POST", "/api/test-praat", { exe: exe }).then(function (r) {
      $("#setPraatMsg").textContent = r.ok ? ("✓ 检测到 Praat " + r.version) : "✗ 未找到或无法运行";
      $("#setPraatMsg").style.color = r.ok ? "#2e7a3f" : "#a33726";
    });
  });
  $("#setSave").addEventListener("click", function () {
    var payload = {
      praatExe: $("#setPraat").value.trim(),
      tier: $("#setTier").value,
      f0min: parseFloat($("#setF0min").value) || 50,
      f0max: parseFloat($("#setF0max").value) || 400,
      maxFormantHz: parseFloat($("#setMaxF").value) || 5000
    };
    state.values.f0min = payload.f0min; state.values.f0max = payload.f0max; state.values.maxFormantHz = payload.maxFormantHz;
    api("POST", "/api/settings", payload).then(function () {
      $("#setMsg").textContent = "✓ 已保存"; $("#setMsg").style.color = "#2e7a3f";
      setTimeout(function () { closeMask($("#mSettings")); }, 600);
    });
  });

})();
