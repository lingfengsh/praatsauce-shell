/* syllable-grid-ui.js —— 音节自动切分 · 九宫格检查（独立功能，复用 /api/syllables/grid）

 * 与 review-grid-ui.js（F0 / 共振峰审查）互补：
 *   - 这里是「切分结果过一遍」：一页 N 个文件（默认 3×3=9），每个格子画一条
 *     该文件的【波形 + 切分标记】（竖线标边界，静音段标 sil、音节段用文件名标注）。
 *   - 点格子调起单文件详情：大波形 + 切分信息条 + 浏览器内直接编辑 + 「保存 TextGrid」
 *     + 「在 Praat 中打开（含 TextGrid）」（后端用 GUI Praat 载入 wav + 同名 TextGrid，
 *       beginPause 提供「保存并退出」写回）。
 *
 * 浏览器内编辑（推荐，无需 Praat）：
 *   - 点波形空白处 → 在该时间点插入一个边界，把当前段一分为二；
 *   - 点已有的边界竖线 → 删除它（合并相邻两段）；
 *   - 按住边界拖动 → 微调边界位置（拖到重合也会删除）；
 *   - 下方段标签芯片点一下 → 在「sil ↔ 文件名」之间切换。
 *   改完点「保存 TextGrid」即把结果写回同目录同名文件（/api/syllables/save）。
 *
 * 依赖 app.js 全局： $, $$, api, esc, toast, fmtDuration
 */

(function () {
  "use strict";

  var state = { dir: "", params: null, size: 16, page: 0, data: null, busy: false, detailFile: null,
    // 当前勾选参与「重切分」的文件 name 集合；「重切分」只作用于当前页这些文件
    selected: new Set() };
  // 每种每页数量对应的列数（格子是扁方块，列多于行更省竖向空间）
  var COLS = { 4: 2, 6: 3, 9: 3, 12: 4, 16: 4, 20: 5, 24: 6, 25: 5, 30: 6, 36: 6 };
  var _audioCtx = null;
  var dragIdx = -1;   // 正在拖动/点选的边界索引（指向 intervals[i].t1）
  var dragOrigT = 0;  // 按下时边界的原始时间，用于区分"点选删除"与"拖动改位"
  var chipTimer = null;   // 芯片单击切换的延时器（用于与双击改文字区分）

  // 文件名（去扩展名），用作音节段默认标签
  function baseName(f) {
    var n = f.name || (f.path || "");
    return n.replace(/\.[^.]+$/, "");
  }

  // clientX -> canvas 内部像素坐标
  function canvasX(e) {
    var cv = $("#syDetailCanvas");
    var rect = cv.getBoundingClientRect();
    return (e.clientX - rect.left) * (cv.width / (rect.width || cv.width));
  }

  // 找距点击时间最近的边界；容差按"时间"算（默认 ±15ms，更宽容，便于点删/拖动）
  function boundaryAt(f, x) {
    var cv = $("#syDetailCanvas");
    var dur = f.duration || 1, W = cv.width;
    var clickT = (x / W) * dur;             // 点击对应的时间（秒）
    var tolT = 0.015;                        // 15ms：左右各 15ms 内点击都算命中该边界
    var ivs = f.intervals || [];
    for (var i = 0; i < ivs.length - 1; i++) {
      var bt = ivs[i].t1;                    // 边界时间（与 i+1 共享）
      if (Math.abs(bt - clickT) <= tolT) return i;
    }
    return -1;
  }

  // ----------------------------- 初始化 -----------------------------
  function init() {
    $("#syllableGridClose").onclick = closeGrid;
    $("#syllableGridModal").addEventListener("click", function (e) {
      if (e.target === $("#syllableGridModal")) closeGrid();
    });
    $("#syPrev").onclick = function () { if (state.page > 0) { state.page--; render(); } };
    $("#syNext").onclick = function () {
      if (state.data && state.page < state.data.pages - 1) { state.page++; render(); }
    };
    $("#sySize").onchange = function () {
      state.size = parseInt(this.value, 10) || 16; state.page = 0; buildPage();
    };
    // 重新读取本页 TextGrid（不带 force：保留手工/Praat 精修，只补缺的文件），
    // 用于「在 Praat 里改完边界/标签并存盘后回到网页」把结果拉回九宫格。
    $("#syRefresh").onclick = function () { fetchPage("正在重新读取本页 TextGrid…"); };
    // 「重切分」：对勾选文件用新参数覆盖式重做 TextGrid（先弹参数框，确认后再执行）
    $("#syRerun").onclick = openRerun;
    $("#sySelectAll").onchange = function () {
      var all = state.data && state.data.files
        ? state.data.files.map(function (f) { return f.name; }) : [];
      if (this.checked) all.forEach(function (n) { state.selected.add(n); });
      else state.selected.clear();
      renderCells();     // 刷新各格勾选框状态
    };
    // 重切分参数弹窗
    $("#syRerunClose").onclick = closeRerun;
    $("#syRerunModal").addEventListener("click", function (e) {
      if (e.target === $("#syRerunModal")) closeRerun();
    });
    $("#syRerunCancel").onclick = closeRerun;
    $("#syRerunStart").onclick = startRerun;
    $("#syllableDetailClose").onclick = closeDetail;
    $("#syllableDetailModal").addEventListener("click", function (e) {
      if (e.target === $("#syllableDetailModal")) closeDetail();
    });
    $("#syDetailPlay").onclick = function () {
      if (state.detailFile) togglePlayback(state.detailFile.path, this);
    };
    $("#syDetailOpenPraat").onclick = openPraat;
    $("#syDetailRefresh").onclick = refreshDetail;
    $("#syDetailReload").onclick = reloadDetail;
    $("#syDetailSave").onclick = saveDetail;
    // 标题栏也放一个保存按钮（上下各一个，用户 2026-10-18 要求）：只镜像禁用态与提示，
    // 顶部用短文案「保存 TextGrid」，底部保留原完整文案。点它等于点底部按钮。
    if (window.mirrorButton) window.mirrorButton("syDetailSave", "syDetailSaveTop", { keepLabel: true });
    // 浏览器内直接编辑切分：点空白加边界、点边界删除、拖动边界移动
    var cv = $("#syDetailCanvas");
    cv.addEventListener("pointerdown", onCanvasDown);
    cv.addEventListener("pointermove", onCanvasMove);
    cv.addEventListener("pointerup", onCanvasUp);
    cv.addEventListener("pointercancel", function () { dragIdx = -1; });
    // 段标签芯片：单击切换 sil / 音节，双击直接改标注文字
    $("#syDetailInfo").onclick = onChipClick;
    $("#syDetailInfo").ondblclick = onChipDblClick;
  }

  // 由 app.js（autoSegment）调用：传入第一页 grid JSON，直接渲染并展开九宫格
  function openSyllableGrid(initial) {
    $("#syllableGridModal").classList.remove("hidden");
    state.params = window.syllableSegmentParams || null;
    state.dir = (initial && initial.dir) || (state.params && state.params.dir) || "";
    $("#syDir").value = state.dir;
    // 单一变量（2026-10-02 用户定案）：目录框改动回流到全局 inputDir，
    // 九宫格不另立工作目录。
    $("#syDir").addEventListener("change", function () {
      var v = this.value.trim();
      var id = $("#inputDir"); if (id) { id.value = v; }
      if (window.state && window.state.values) { window.state.values.inputDir = v; }
    });
    // 每页数量：以实际拿到的数据为准（从「用现成 TextGrid」进来时可能是 16/24/25），
    // 并回写下拉框，避免"下拉显示 25、格子只有 9 个"的不一致。
    state.size = (initial && initial.size) || parseInt($("#sySize").value, 10) || 16;
    $("#sySize").value = state.size;
    state.page = 0;
    if (initial) {
      state.data = initial;
      setStatus("本页 " + initial.files.length + " 个文件（共 " + initial.total +
                " 个，第 1 / " + initial.pages + " 页）", false);
      renderPager(); renderCells();
    } else {
      buildPage();
    }
  }
  function closeGrid() {
    stopPlayback();
    $("#syllableGridModal").classList.add("hidden");
    // 通知外面：第 3/4 步的「TextGrid 助手」在九宫格关掉后要重算预检
    // （生成标注前会挂一次性监听，见 app.js openTgAssist）。
    document.dispatchEvent(new CustomEvent("ps:tg-grid-closed"));
  }

  function setStatus(msg, isErr) {
    var el = $("#syStatus");
    el.classList.remove("hidden");
    el.style.color = isErr ? "var(--err)" : "var(--muted)";
    el.textContent = msg;
  }

  // --------------------------- 取数据 ---------------------------
  function buildPage() {
    if (!state.dir) { toast("声音目录未知", "error"); return; }
    state.page = 0; state.data = null;
    fetchPage("正在加载第 1 页…");
  }

  function render() {
    var d = state.data;
    if (!d || d.page !== state.page || d.size !== state.size || d.dir !== state.dir) {
      return fetchPage("正在加载第 " + (state.page + 1) + " 页…");
    }
    renderPager(); renderCells();
  }

  function fetchPage(statusMsg) {
    if (state.busy) return;
    state.busy = true;
    if (statusMsg) setStatus(statusMsg, false);
    var p = state.params || {};
    api("/api/syllables/grid", {
      dir: state.dir, page: state.page, size: state.size,
      minSilence: p.minSilence != null ? p.minSilence : 0.1,
      minSyllable: p.minSyllable != null ? p.minSyllable : 0.1,
      thresholdDb: p.thresholdDb != null ? p.thresholdDb : -25,
      ext: p.ext || "wav",
    }).then(function (r) {
      state.busy = false;
      if (!r.ok) { setStatus(r.error || "失败", true); return; }
      state.data = r;
      // 后端可能把工作目录切到 Resample/（重采样后），把目录标签同步成实际工作副本，
      // 避免界面显示父目录、实际却读 Resample/ 同名文件的「目录读取混乱」。
      if (r.dir) {
        state.dir = r.dir;
        var _sd = $("#syDir"); if (_sd) _sd.value = r.dir;
      }
      setStatus("本页 " + r.files.length + " 个文件（共 " + r.total +
                " 个，第 " + (r.page + 1) + " / " + r.pages + " 页）", false);
      renderPager(); renderCells();
    }).catch(function (e) { state.busy = false; setStatus(String(e), true); });
  }

  function renderPager() {
    var d = state.data;
    $("#syPageInfo").textContent = d ? ("第 " + (d.page + 1) + " / " + d.pages + " 页") : "—";
    $("#syPrev").disabled = !d || d.page <= 0;
    $("#syNext").disabled = !d || d.page >= d.pages - 1;
  }

  function renderCells() {
    var box = $("#syCells");
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
    d.files.forEach(function (f) {
      var cell = document.createElement("div");
      cell.className = "rg-cell";
      var name = document.createElement("div");
      name.className = "rg-name";
      name.textContent = f.name;
      name.title = f.path;
      var cv = document.createElement("canvas");
      cv.className = "rg-canvas";
      cv.width = 300; cv.height = 120;
      cell.appendChild(name);
      cell.appendChild(cv);
      // 勾选框（右上角）：勾选后参与「重切分」。点它不触发打开详情
      var chk = document.createElement("input");
      chk.type = "checkbox";
      chk.className = "rg-check";
      chk.checked = state.selected.has(f.name);
      chk.title = "勾选后参与「重切分」";
      chk.onclick = function (e) {
        e.stopPropagation();
        if (this.checked) state.selected.add(f.name);
        else state.selected.delete(f.name);
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
      drawCell(cv, f);
    });
    // 全选框状态：仅当本页所有文件都被勾选时才打勾
    var allNames = d.files.map(function (f) { return f.name; });
    $("#sySelectAll").checked =
      allNames.length > 0 && allNames.every(function (n) { return state.selected.has(n); });
  }

  // --------------------------- 批量重切分（覆盖式） ---------------------------
  // 流程：点「重切分」→ 弹参数框（进阶 TextGrid 参数）→ 开始：后端用新参数重做并覆盖同名 TextGrid。
  var syRerunNames = [];   // 本次参与重切分的候选文件名（当前页已勾选）

  function currentPageSelectedNames() {
    var all = state.data && state.data.files
      ? state.data.files.map(function (f) { return f.name; }) : [];
    return all.filter(function (n) { return state.selected.has(n); });
  }

  function openRerun() {
    var names = currentPageSelectedNames();
    if (!names.length) {
      toast("先勾选要重切分的文件（点每格右上角的框）", "error");
      return;
    }
    syRerunNames = names;
    // 参数预填：优先当前参数，其次默认
    var p = state.params || {};
    $("#syRerunMinSilence").value = p.minSilence != null ? p.minSilence : 0.1;
    $("#syRerunMinSyllable").value = p.minSyllable != null ? p.minSyllable : 0.1;
    $("#syRerunThresh").value = p.thresholdDb != null ? p.thresholdDb : -25;
    $("#syRerunModal").classList.remove("hidden");
  }

  function closeRerun() { $("#syRerunModal").classList.add("hidden"); }

  function startRerun() {
    var names = syRerunNames;
    if (!names.length) { toast("没有要重切分的文件", "error"); return; }
    var req = {
      dir: state.dir,
      names: names,
      minSilence: parseFloat($("#syRerunMinSilence").value) || 0.1,
      minSyllable: parseFloat($("#syRerunMinSyllable").value) || 0.1,
      thresholdDb: parseFloat($("#syRerunThresh").value) != null
        ? parseFloat($("#syRerunThresh").value) : -25,
      ext: (state.params && state.params.ext) || "wav",
    };
    closeRerun();
    setStatus("正在用新参数重切分 " + names.length + " 个文件…", false);
    api("/api/syllables/resegment", req).then(function (r) {
      if (!r.ok) { setStatus(r.error || "失败", true); return; }
      var msg = "重切分完成：" + (r.done || []).length + " 个覆盖写入";
      if (r.errors && r.errors.length) msg += "，" + r.errors.length + " 个失败";
      setStatus(msg, !!(r.errors && r.errors.length));
      state.selected.clear();
      fetchPage(null);   // 重新读取展示新切分
      toast(msg, (r.errors && r.errors.length) ? "error" : "ok");
    }).catch(function (e) { setStatus(String(e), true); });
  }

  // ------------------------------ 绘制 ------------------------------
  function drawCell(cv, f) { drawSyllable(cv, f); }

  function drawSyllable(cv, f) {
    drawWaveform(cv, f);
    if (!f._buf && !f._bufBusy) {
      f._bufBusy = true;
      fetchWav(f.path).then(function (buf) {
        f._buf = buf; f._bufBusy = false;
        drawWaveform(cv, f);
        if (state.detailFile === f) drawDetail(f);
      }).catch(function () { f._bufBusy = false; });
    }
  }

  // 波形 + 切分标记：竖线标边界，静音段标 sil、音节段用文件名标注
  function drawWaveform(cv, f) {
    var ctx = cv.getContext("2d");
    var W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fafbfc"; ctx.fillRect(0, 0, W, H);
    var dur = (f.duration || 1) || 1;
    var mid = H / 2;

    // 波形包络
    var buf = f._buf;
    if (buf) {
      var data = buf.getChannelData(0);
      var len = data.length;
      ctx.strokeStyle = "rgba(60,80,120,0.55)"; ctx.lineWidth = 1; ctx.beginPath();
      for (var x = 0; x < W; x++) {
        var s = Math.floor(x / W * len);
        var e = Math.max(s + 1, Math.floor((x + 1) / W * len));
        var mn = 1e9, mx = -1e9;
        for (var i = s; i < e; i++) { var v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
        if (mn > 1e8) continue;
        var y1 = mid - mx * mid * 0.92;
        var y2 = mid - mn * mid * 0.92;
        ctx.moveTo(x + 0.5, y1); ctx.lineTo(x + 0.5, y2);
      }
      ctx.stroke();
    }

    // 切分区间：底色 + 边界竖线
    var ivs = f.intervals || [];
    ivs.forEach(function (iv) {
      var x0 = (iv.t0 / dur) * W;
      var x1 = (iv.t1 / dur) * W;
      var isSil = iv.label === "sil";
      ctx.fillStyle = isSil ? "rgba(0,0,0,0.05)" : "rgba(47,111,237,0.08)";
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), H);
      ctx.strokeStyle = "rgba(17,24,39,0.35)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0 + 0.5, 0); ctx.lineTo(x0 + 0.5, H); ctx.stroke();
    });

    // 段标签（沿顶部）
    ctx.font = "9px sans-serif"; ctx.textBaseline = "top";
    ivs.forEach(function (iv) {
      var x0 = (iv.t0 / dur) * W;
      var x1 = (iv.t1 / dur) * W;
      var isSil = iv.label === "sil";
      ctx.fillStyle = isSil ? "rgba(120,130,150,0.95)" : "rgba(37,99,235,0.95)";
      var txt = isSil ? "sil" : iv.label;
      while (txt.length > 1 && ctx.measureText(txt).width > (x1 - x0 - 4)) txt = txt.slice(0, -1);
      if (txt) ctx.fillText(txt, x0 + 2, 2);
    });
  }

  function fetchWav(path) {
    return fetch("/api/review/wav?path=" + encodeURIComponent(path))
      .then(function (r) { if (!r.ok) throw new Error("wav " + r.status); return r.arrayBuffer(); })
      .then(function (ab) {
        if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        return _audioCtx.decodeAudioData(ab);
      });
  }

  // --------------------------- 单格详情 ---------------------------
  function openDetail(f) {
    state.detailFile = f;
    f._dirty = false;
    $("#syDetailName").textContent = f.name;
    $("#syDetailPath").value = f.path;
    $("#syDetailSave").disabled = true;
    $("#syllableDetailModal").classList.remove("hidden");
    renderDetailInfo(f);
    drawDetail(f);
  }

  function closeDetail() {
    stopPlayback();
    $("#syllableDetailModal").classList.add("hidden");
    state.detailFile = null;
  }

  function renderDetailInfo(f) {
    var ivs = f.intervals || [];
    var syl = ivs.filter(function (iv) { return iv.label !== "sil"; });
    var sil = ivs.length - syl.length;
    var chips = ivs.map(function (iv, idx) {
      var isSil = iv.label === "sil";
      var d = (iv.t1 - iv.t0);
      return '<span class="seg-chip ' + (isSil ? "sil" : "syl") + '" data-idx="' + idx +
        '" title="单击切换 sil / 音节；双击改标注文字">' +
        (isSil ? "sil" : esc(iv.label)) + " " + d.toFixed(2) + "s</span>";
    }).join("");
    $("#syDetailInfo").innerHTML =
      '<div>时长 ' + fmtDuration(f.duration) + " · 切分 " + ivs.length +
      " 段（音节 " + syl.length + " · 静音 " + sil + "）· TextGrid：" + esc(f.tgPath || "") + "</div>" +
      '<div class="seg-row">' + chips + "</div>";
  }

  function drawDetail(f) {
    var cv = $("#syDetailCanvas");
    drawWaveform(cv, f);
    if (!f._buf && !f._bufBusy) {
      f._bufBusy = true;
      fetchWav(f.path).then(function (buf) {
        f._buf = buf; f._bufBusy = false; drawWaveform(cv, f);
      }).catch(function () { f._bufBusy = false; });
    }
  }

  function openPraat() {
    var f = state.detailFile;
    if (!f) return;
    var btn = $("#syDetailOpenPraat");
    btn.disabled = true;
    api("/api/syllables/open-praat", { path: f.path }).then(function (r) {
      btn.disabled = false;
      if (!r.ok) toast(r.error || "打开失败", "error");
      else toast("已用 Praat 打开：「" + f.name + "—— 在编辑器改完边界/标签后，点 Praat 里的「保存并退出」写回文件，再点本页「刷新（从文件读取）」拉回网页", "ok");
    }).catch(function (e) { btn.disabled = false; toast(String(e), "error"); });
  }

  // 按当前灵敏度参数重切该文件：后端 force 重切并覆盖写回该文件同目录的 TextGrid；
  // 若此前已手工精修过，此操作会覆盖那份手工结果 —— 仅在你确认想用自动切分替换时使用。
  function reloadDetail() {
    var f = state.detailFile;
    if (!f) return;
    var p = state.params || {};
    api("/api/syllables/grid", {
      dir: state.dir, page: state.page, size: state.size,
      minSilence: p.minSilence != null ? p.minSilence : 0.1,
      minSyllable: p.minSyllable != null ? p.minSyllable : 0.1,
      thresholdDb: p.thresholdDb != null ? p.thresholdDb : -25,
      ext: p.ext || "wav",
      force: 1,
    }).then(function (r) {
      if (!r.ok) { toast(r.error || "失败", "error"); return; }
      var rec = (r.files || []).filter(function (x) { return x.name === f.name; })[0];
      if (rec) {
        Object.assign(f, rec);
        f._dirty = false;
        $("#syDetailSave").disabled = true;
        f._buf = null;           // 波形不依赖切分，保留；仅刷新区间与信息条
        renderDetailInfo(f);
        drawDetail(f);
        renderCells();           // 详情里的 f 就是九宫格那一格的对象，重绘即同步
        toast("已按当前参数重新切分：「" + f.name + "」（" + (f.intervals || []).length + " 段）", "ok");
      } else {
        toast("当前页找不到该文件", "error");
      }
    }).catch(function (e) { toast(String(e), "error"); });
  }

  // 从磁盘重新读取该文件最新 TextGrid（不重新切分，保留手工/Praat 精修）；用于 Praat 编辑后把结果拉回网页
  function refreshDetail() {
    var f = state.detailFile;
    if (!f) return;
    var p = state.params || {};
    api("/api/syllables/grid", {
      dir: state.dir, page: state.page, size: state.size,
      minSilence: p.minSilence != null ? p.minSilence : 0.1,
      minSyllable: p.minSyllable != null ? p.minSyllable : 0.1,
      thresholdDb: p.thresholdDb != null ? p.thresholdDb : -25,
      ext: p.ext || "wav",
      // 不传 force → 服务端读取磁盘已有 TextGrid（保留精修），不重新切分
    }).then(function (r) {
      if (!r.ok) { toast(r.error || "失败", "error"); return; }
      var rec = (r.files || []).filter(function (x) { return x.name === f.name; })[0];
      if (rec) {
        if (rec.intervals) f.intervals = rec.intervals;
        if (rec.duration) f.duration = rec.duration;
        f._dirty = false;
        $("#syDetailSave").disabled = true;
        renderDetailInfo(f);
        drawDetail(f);
        renderCells();           // 同步九宫格该格（Praat 里改完存盘后，回网格就能看到新边界）
        toast("已从文件重新读取：" + f.name + "（" + (f.intervals || []).length + " 段）", "ok");
      } else {
        toast("当前页找不到该文件", "error");
      }
    }).catch(function (e) { toast(String(e), "error"); });
  }

  // --------------------------- 浏览器内编辑 ---------------------------
  function markDirty() {
    if (state.detailFile) state.detailFile._dirty = true;
    var b = $("#syDetailSave");
    if (b) b.disabled = false;
  }

  function onCanvasDown(e) {
    var f = state.detailFile;
    if (!f) return;
    var cv = $("#syDetailCanvas");
    try { cv.setPointerCapture(e.pointerId); } catch (_) {}
    dragIdx = boundaryAt(f, canvasX(e));
    dragOrigT = (dragIdx >= 0) ? f.intervals[dragIdx].t1 : 0;
  }

  function onCanvasMove(e) {
    var f = state.detailFile;
    if (!f || dragIdx < 0) return;
    var x = canvasX(e);
    var cv = $("#syDetailCanvas"), dur = f.duration || 1, W = cv.width;
    var t = (x / W) * dur;
    var lo = f.intervals[dragIdx].t0 + 0.005;
    var hi = f.intervals[dragIdx + 1].t1 - 0.005;
    if (t < lo) t = lo;
    if (t > hi) t = hi;
    f.intervals[dragIdx].t1 = t;
    f.intervals[dragIdx + 1].t0 = t;
    drawDetail(f);
  }

  function onCanvasUp(e) {
    var f = state.detailFile;
    if (!f) { dragIdx = -1; return; }
    var cv = $("#syDetailCanvas"), dur = f.duration || 1, W = cv.width;
    if (dragIdx >= 0) {
      var i = dragIdx;
      var moved = Math.abs(f.intervals[i].t1 - dragOrigT);   // 相比按下时移动了多少
      var leftW = f.intervals[i].t1 - f.intervals[i].t0;
      var rightW = f.intervals[i + 1].t1 - f.intervals[i + 1].t0;
      if (moved < 0.004 || leftW < 0.012 || rightW < 0.012) {
        // 几乎没动（视为点选删除）/ 拖动到重合（任一侧 < 12ms）→ 删除该边界，合并相邻两段
        var merged = { t0: f.intervals[i].t0, t1: f.intervals[i + 1].t1, label: f.intervals[i].label };
        f.intervals.splice(i, 2, merged);
      }
      // 否则保留拖动结果（已在 onCanvasMove 中更新边界位置）
      drawDetail(f);
      renderDetailInfo(f); markDirty();
      dragIdx = -1;
    } else {
      // 空白处点击 = 在该时间点插入边界，把所在区间一分为二
      var t = (canvasX(e) / W) * dur;
      var ivs = f.intervals, added = false;
      for (var k = 0; k < ivs.length; k++) {
        if (t > ivs[k].t0 + 1e-3 && t < ivs[k].t1 - 1e-3) {
          var left = { t0: ivs[k].t0, t1: t, label: ivs[k].label };
          var right = { t0: t, t1: ivs[k].t1, label: ivs[k].label };
          ivs.splice(k, 1, left, right);
          added = true; break;
        }
      }
      if (added) { drawDetail(f); renderDetailInfo(f); markDirty(); }
    }
  }

  // 双击芯片 → 就地换成输入框改标注文字（Enter 或失焦提交，Esc 取消，留空即 sil）
  function onChipDblClick(e) {
    if (chipTimer) { clearTimeout(chipTimer); chipTimer = null; }  // 取消单击切换
    var el = e.target && e.target.closest ? e.target.closest(".seg-chip") : null;
    if (!el) return;
    var idx = parseInt(el.getAttribute("data-idx"), 10);
    var f = state.detailFile;
    if (!f || !f.intervals[idx]) return;
    var cur = f.intervals[idx].label || "";
    var inp = document.createElement("input");
    inp.className = "seg-chip-edit";
    inp.type = "text";
    inp.value = (cur === "sil") ? "" : cur;
    inp.placeholder = "sil";
    inp.dataset.idx = String(idx);
    el.replaceWith(inp);
    inp.focus(); inp.select();
    inp.onkeydown = function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); commitLabelEdit(inp); }
      else if (ev.key === "Escape") { inp._done = true; renderDetailInfo(f); }
    };
    inp.onblur = function () { commitLabelEdit(inp); };
  }

  function commitLabelEdit(inp) {
    if (inp._done) return;
    inp._done = true;              // 提交后 renderDetailInfo 会移除输入框并触发 blur，避免二次提交
    var f = state.detailFile;
    if (!f) return;
    var idx = parseInt(inp.dataset.idx, 10);
    if (!f.intervals[idx]) return;
    var v = (inp.value || "").trim();
    f.intervals[idx].label = (v === "") ? "sil" : v;
    renderDetailInfo(f); drawDetail(f); markDirty();
  }

  // 单击切换（延时 220ms 生效）：双击的第一下会先触发一次 click，若立刻重绘
  // 芯片行会因文字宽度变化而错位、第二下点到的就是别的芯片了 —— 用延时把两次区分开。
  function onChipClick(e) {
    var el = e.target && e.target.closest ? e.target.closest(".seg-chip") : null;
    if (!el) return;
    var idx = parseInt(el.getAttribute("data-idx"), 10);
    if (chipTimer) { clearTimeout(chipTimer); chipTimer = null; return; }
    chipTimer = setTimeout(function () {
      chipTimer = null;
      var f = state.detailFile;
      if (!f || !f.intervals[idx]) return;
      toggleChip(f, idx);
      drawDetail(f); renderDetailInfo(f); markDirty();
    }, 220);
  }

  // sil ↔ 音节 切换。记住切走前的文字（_lastLabel），切回来时还原——
  // 否则「自定义标注 → sil → 再切回」会变成文件名，双击编辑前的两次单击也会把文字弄丢。
  function toggleChip(f, idx) {
    var iv = f.intervals[idx];
    if (iv.label === "sil") iv.label = iv._lastLabel || baseName(f);
    else { iv._lastLabel = iv.label; iv.label = "sil"; }
  }

  function saveDetail() {
    var f = state.detailFile;
    if (!f) return;
    var btn = $("#syDetailSave");
    btn.disabled = true;
    api("/api/syllables/save", { path: f.path, intervals: f.intervals }).then(function (r) {
      btn.disabled = false;
      if (!r.ok) { toast(r.error || "保存失败", "error"); return; }
      f._dirty = false;
      f.tgPath = r.path || f.tgPath;
      toast("已保存 TextGrid：「" + f.name + "」（" + f.intervals.length + " 段）", "ok");
      fetchPage(null);   // 同步九宫格该页（读已有 TG，安全不覆盖）
      // TextGrid 变了 → 全量审查九宫格的段底色 / 静音遮罩也要跟着更新（若它正开着）
      if (window.refreshReviewGrid) window.refreshReviewGrid();
    }).catch(function (e) { btn.disabled = false; toast(String(e), "error"); });
  }

  init();
  window.openSyllableGrid = openSyllableGrid;   // 暴露给 app.js 的 autoSegment 调用
})();
