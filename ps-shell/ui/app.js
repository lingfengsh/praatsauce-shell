/* PraatSauce 助手 —— 前端逻辑（无框架、无外部依赖，离线可用） */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const state = {
  boot: null,
  values: {},
  tier: "novice",
  step: 1,
  voiceRoute: null,     // 嗓音预设分流：null=未分流 / "review"=先审 F0+共振峰 / "full"=直接全开
  showParamMore: false,  // 第二步「更多高级设置」折叠区是否展开（进阶专享）
  showChosenMore: false,  // 第二步「已选测量项」展开全部可测量项目（进阶专享）
  reviewState: null,    // 最近的审核状态 {total, reviewed, missing}（第三步提示 + 批量分支用）
  files: [],
  selectedFiles: new Set(),   // 第一步文件清单的勾选状态（默认全选，点击切换）
  previewFile: null,
  previewAudio: "",   // 在第三步（批量运行）「运行前检查」里直接挑选的绝对路径测试音频（优先于 previewFile）
  preview: null,      // 试跑结果
  runJobId: null,
  result: null,       // 批量结果
  chart: "f0",
  polling: null,
  health: null,      // 最近一次体检结果（W5）
  tgProposal: null,  // 最近一次 TG 配对方案（W5）
};
// 暴露给其它模块（review-grid-ui / syllable-grid-ui 等），便于读取第一步已选目录等
window.state = state;

const CHART_SERIES = {
  f0:   { title: "基频 F0", unit: "Hz", cols: [["f0", "#2563eb", "F0"]] },
  fmt:  { title: "共振峰 F1 / F2 / F3", unit: "Hz",
          cols: [["F1", "#2563eb", "F1"], ["F2", "#16a34a", "F2"], ["F3", "#d97706", "F3"]] },
  voice:{ title: "嗓音指标", unit: "dB / 比值",
          cols: [["CPP", "#7c3aed", "CPP"], ["HNR05", "#0891b2", "HNR05"], ["H1H2c", "#db2777", "H1-H2c"]] },
};

/* ---------------------------------------------------------------- 工具 */

// 参数名 → 帮助条目 key（help.js 里维护对照表）。help.js 没加载时退化为 param:xxx，
// 届时点击会显示该参数 schema 里的 help 文本。
function helpKey(name) {
  return (window.PSHelp && window.PSHelp.keyForParam)
    ? window.PSHelp.keyForParam(name)
    : ('param:' + name);
}

/* 轻提示。2026-10-18：提示本身也要能复制（用户要把它贴到聊天里说明问题），
   所以点一下就把整条文字放进剪贴板；鼠标停在上面时不消失，留出点击时间。 */
function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = msg;
  el.title = "点一下复制这条提示（鼠标悬停时不会消失）";
  let hideT = 0, killT = 0;
  const arm = () => {
    clearTimeout(hideT); clearTimeout(killT);
    hideT = setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; }, 4200);
    killT = setTimeout(() => el.remove(), 4800);
  };
  el.addEventListener("mouseenter", () => {
    clearTimeout(hideT); clearTimeout(killT);
    el.style.opacity = "1";
  });
  el.addEventListener("mouseleave", arm);
  el.addEventListener("click", () => { copyText(msg, "已复制这条提示"); el.remove(); });
  arm();
  $("#toastWrap").appendChild(el);
}

/* ---------------------------------------------------------------- 按钮镜像（上下双保存按钮）
   2026-10-18 用户要求：编辑窗口的「保存」上下各放一个，长内容往下翻时不用先滚回底部。
   做一个只读镜像：文字/禁用态/悬停提示都跟着源按钮走，点击等于点源按钮；
   这样后端各处对源按钮的赋值（disabled / textContent / title）都不用改第二遍。
   opts.keepLabel = true 时保留目标按钮自己的短文案（只同步禁用态与提示）。 */
function mirrorButton(srcId, dstId, opts) {
  opts = opts || {};
  const src = document.getElementById(srcId);
  const dst = document.getElementById(dstId);
  if (!src || !dst) return;
  const sync = () => {
    if (!opts.keepLabel) dst.textContent = src.textContent;
    dst.disabled = src.disabled;
    if (src.title) dst.title = src.title;
  };
  sync();
  dst.addEventListener("click", (e) => {
    e.preventDefault();
    if (!src.disabled) src.click();
  });
  new MutationObserver(sync).observe(src, {
    attributes: true, attributeFilter: ["disabled", "title"],
    childList: true, characterData: true, subtree: true,
  });
}

async function api(path, data) {
  if (data) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return await r.json();
  }
  const r = await fetch(path);
  return await r.json();
}

/* ---------------------------------------------------------------- 音频试听（九宫格 / 详情共用）
   同一时刻只放一条：点别的会先停掉上一条；再点同一条 = 停止。
   用 fetch + decodeAudioData 而不是 <audio src>，因为后端 /api/review/wav 是整文件响应、不支持
   Range 请求，Web Audio 这条路更稳（也让播放与语图共用同一份 wav 字节）。 */
let _playCtx = null, _playSrc = null, _playBtn = null, _playToken = 0;

function stopPlayback() {
  if (_playSrc) { try { _playSrc.stop(); } catch (e) { /* 已自然结束 */ } }
  _playSrc = null;
  if (_playBtn) { _playBtn.textContent = _playBtn.dataset.idle || "▶"; _playBtn = null; }
}

async function togglePlayback(path, btn) {
  if (_playBtn === btn) { stopPlayback(); return; }
  stopPlayback();
  if (!btn.dataset.idle) btn.dataset.idle = btn.textContent || "▶";
  const idle = btn.dataset.idle;
  btn.textContent = "…";
  const token = ++_playToken;          // 用户连点不同格子时，只让最后一次生效
  try {
    const r = await fetch("/api/review/wav?path=" + encodeURIComponent(path));
    if (!r.ok) throw new Error("HTTP " + r.status);
    const ab = await r.arrayBuffer();
    if (!_playCtx) _playCtx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await _playCtx.decodeAudioData(ab);
    if (token !== _playToken) return;
    const src = _playCtx.createBufferSource();
    src.buffer = buf;
    src.connect(_playCtx.destination);
    src.onended = () => { if (_playBtn === btn) stopPlayback(); };
    _playSrc = src; _playBtn = btn; btn.textContent = "⏸";
    src.start();
  } catch (e) {
    if (token === _playToken) { btn.textContent = idle; toast("播放失败：" + e.message, "error"); }
  }
}

const fmtNum = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v)) ? "—" : Number(v).toFixed(d);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function fmtDuration(sec) {
  if (sec === null || sec === undefined) return "—";
  if (sec < 60) return sec.toFixed(2) + " 秒";
  const m = Math.floor(sec / 60);
  return `${m} 分 ${(sec - m * 60).toFixed(1)} 秒`;
}
function fmtSize(n) {
  if (n === null || n === undefined) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

/* ---------------------------------------------------------------- 启动 */

async function init() {
  let boot;
  try {
    boot = await api("/api/bootstrap");
  } catch (e) {
    // 后端没起来（或窗口里残留着上次会话的页面）：不解释的话页面看着正常、
    // 点什么都没反应（bind 还没执行）——2026-09-26 用户踩坑"第一步点选择路径无反应"。
    document.body.insertAdjacentHTML("afterbegin",
      '<div style="position:fixed;left:0;right:0;bottom:0;z-index:9999;' +
      'background:#b91c1c;color:#fff;padding:10px 16px;font-size:13px">' +
      '无法连接后端服务（' + esc(String(e && e.message || e)) +
      '）。请先启动 app.py（双击或命令行），再把本页面刷新（F5）。</div>');
    return;
  }
  state.boot = boot;
  state.values = Object.assign({}, boot.defaults);
  syncIntervalMode();   // 旧档没有 intervalMode：等分点数>0 就视为等分方式
  normalizeFormants(state.values);   // 旧档 formant/bw 总开关 → F1–F5 / B1–B3 独立勾选
  const _rawTier = boot.settings.tier;
  state.tier = _rawTier === "expert" ? "advanced" : (_rawTier || "novice");
  if (state.tier === "novice") (state.boot.params || []).forEach(p => {
    // 中间文件保存/复用是基础设施开关（落盘即权威），不随档位降级清零
    if (["pitchSave", "pitchRead", "formantSave", "formantRead"].includes(p.name)) return;
    // 只清零「进阶档的布尔开关」（带宽 B1/B2/B3、CPPS、SHR 等可选项）；
    // 不碰数值/下拉类进阶参数（间隔 intervalFixed、窗长 windowLength、声道 channel 等）：
    // 它们有合理默认值且流水线必须有效，清零成 0 反而触发校验报错、卡住整个流程。
    if (p.tier === "advanced" && p.type === "bool") state.values[p.name] = 0;
  });  // 新手不默认勾进阶档参数（如带宽 B1/B2/B3）
  if (!boot.settings.preset) setReviewDefaults();   // 未选预设时默认走「先审 F0 / 共振峰」

  renderEnv();
  renderTierSwitch();
  renderPresets();
  renderSpeakers();
  renderParams();
  renderMeasurePicker();
  initOnboard();
  bind();
  // 支持 #step=2 这样的地址，刷新后停留在当前步骤
  const m = (location.hash || "").match(/step=(\d)/);
  setStep(m ? Math.min(5, Math.max(1, +m[1])) : 1);

  // 还原上次用过的目录
  if (boot.settings.lastInputDir) {
    $("#inputDir").value = boot.settings.lastInputDir;
    await scanInput(true);
  }
  if (boot.settings.lastOutputDir) $("#outputDir").value = boot.settings.lastOutputDir;

  fetch("/api/ping");
  // 心跳：每 10s 打一次 /api/ping，后端据此判断页面是否还开着——
  // 关闭标签页超过 60s 后端会自动退出进程（关闭页面即关闭程序，不留孤儿进程）。
  setInterval(function () {
    try { fetch("/api/ping"); } catch (e) {}
  }, 10000);
}

function renderEnv() {
  const e = state.boot.env;
  const line = $("#envLine");
  if (!e.praatOk) {
    line.innerHTML = '<span style="color:var(--err)">未找到 Praat，请到设置里指定</span>';
  } else if (!e.scriptOk) {
    line.innerHTML = '<span style="color:var(--err)">找不到 praatSauce.praat</span>';
  } else {
    line.textContent = `Praat ${e.praatVersion || ""} · 就绪`;
  }
}

/* ---------------------------------------------------------------- 第五步 · 导出参数分组 */

/* 导出参数表格（2026-09-26 用户出示例后拍板）：照用户示例的八列版式铺——
   列 = 分组，行 = 组内第 n 个参数；列标题点一下 = 整列全选/取消；
   第五列起默认折叠，点列标题才展开。
   列与组序都来自后端 seriesGroups（= backend/series_export.py 的 GROUPS），
   前端不硬编码列名，后端加列自动跟随。
   flag = 「本次测量涉及」的判定键（state.values 里的批量测量开关），
   用来给未涉及的列加提示（不影响勾选）。 */
const EXP_FLAG_BY_COL = {
  F0: "pitch",
  F1: "formant1", F2: "formant2", F3: "formant3", F4: "formant4", F5: "formant5",
  B1: "bw1", B2: "bw2", B3: "bw3", B4: "formant4", B5: "formant5",
};
// 前几列默认展开（用户示例：第五列起折叠）
const EXP_OPEN_COLS = 4;

/* 某列是否「本次测量涉及」：组内任一个参数在 state.values 里开着就算。
   全部没开 → 该列标「未涉及」（灰显提示），但仍可勾选（用户可能只想先看列名）。 */
function expColInvolved(cols, values) {
  return cols.some(c => {
    const f = EXP_FLAG_BY_COL[c];
    return f ? !!values[f] : true;   // 没有 flag 映射的列（谐波/噪声类）默认算涉及
  });
}

/* 渲染第五步「选择要导出的参数」表格。 */
function renderExpParams() {
  const box = $("#expParams");
  if (!box) return;
  const groups = (state.boot && state.boot.seriesGroups) || [];
  if (!groups.length) { box.innerHTML = ""; return; }
  const maxRows = Math.max(...groups.map(g => g.cols.length));

  let html = '<table class="exp-tbl"><thead><tr>';
  groups.forEach((g, gi) => {
    const inv = expColInvolved(g.cols, state.values);
    html += `<th class="exp-th${gi >= EXP_OPEN_COLS ? " folded" : ""}${inv ? "" : " not-involved"}`
          + `" data-gi="${gi}" title="点一下：全选 / 取消这一列${inv ? "" : "（本次测量没勾这些参数，可能导不出数据）"}">`
          + `<span class="exp-th-box"></span><span class="exp-th-label">${esc(g.label)}</span>`
          + `<span class="exp-th-caret">${gi >= EXP_OPEN_COLS ? "▸" : "▾"}</span></th>`;
  });
  html += '</tr></thead><tbody>';
  for (let r = 0; r < maxRows; r++) {
    html += "<tr>";
    groups.forEach((g, gi) => {
      const col = g.cols[r];
      html += `<td class="exp-td${gi >= EXP_OPEN_COLS ? " folded" : ""}">`;
      if (col) {
        html += `<label class="exp-p" title="${esc(col)}"><input type="checkbox" data-param="${esc(col)}">`
              + `<span>${esc(col)}</span></label>`;
      }
      html += "</td>";
    });
    html += "</tr>";
  }
  html += "</tbody></table>";
  box.innerHTML = html;

  // 列标题：点击 = 整列全选 / 取消；折叠列首次点击同时展开
  $$("#expParams .exp-th").forEach(th => {
    const gi = +th.dataset.gi;
    const g = groups[gi];
    const colEls = () => $$(`#expParams td:nth-child(${gi + 1}) input[data-param]`);
    th.onclick = () => {
      const cls = th.classList;
      if (cls.contains("folded")) {          // 首次点击：展开该列
        cls.remove("folded");
        $$(`#expParams td:nth-child(${gi + 1})`).forEach(td => td.classList.remove("folded"));
        th.querySelector(".exp-th-caret").textContent = "▾";
        return;
      }
      const inputs = colEls();
      const on = !inputs.every(i => i.checked);
      inputs.forEach(i => { i.checked = on; });
      syncExpColHead(th, g);
    };
    syncExpColHead(th, g);
  });
  // 表头对勾状态随列内勾选变化
  $$("#expParams .exp-p input[data-param]").forEach(inp => inp.onchange = () => {
    const td = inp.closest("td");
    const gi = Array.from(td.parentNode.children).indexOf(td);
    const th = box.querySelector(`.exp-th[data-gi="${gi}"]`);
    if (th) syncExpColHead(th, groups[gi]);
  });
}

/* 同步列标题的对勾/半选状态（列内全勾→勾、部分勾→半选） */
function syncExpColHead(th, g) {
  const gi = +th.dataset.gi;
  const inputs = $$(`#expParams td:nth-child(${gi + 1}) input[data-param]`);
  const box = th.querySelector(".exp-th-box");
  if (!box) return;
  const n = inputs.filter(i => i.checked).length;
  box.textContent = n === 0 ? "" : (n === inputs.length ? "✓" : "−");
  box.classList.toggle("partial", n > 0 && n < inputs.length);
}

/* 进第五步时刷新：每次重渲染一次表格（勾选状态保留在 DOM，重渲染会清空 →
   所以只渲一次；需要重渲再调 renderExpParams）。 */
async function refreshExpParams() {
  renderExpParams();
  const hint = $("#expParamHint");
  if (hint) {
    hint.innerHTML = '列 <b>F0/F1–F5</b> 取自每个音频目录 <code>measure/</code> 子目录里的 <code>.Pitch</code>/<code>.Formant</code>；'
      + '其余列（谐波差、噪音水平、能量与激励、谐波振幅）取自第三步的汇总表 <code>out.tsv</code>。'
      + '两类可以任意混选，导在同一张表里。缺哪一类，那几列就是空的。';
  }
}

/* ---------------------------------------------------------------- 步骤 */

function setStep(n) {
  state.step = n;
  if (("#" + (location.hash || "")).indexOf("step=" + n) === -1) {
    try { history.replaceState(null, "", "#step=" + n); } catch (e) {}
  }
  $$(".step-panel").forEach(p => p.classList.toggle("hidden", +p.dataset.panel !== n));
  $$("#steps li").forEach(li => {
    const s = +li.dataset.step;
    li.classList.toggle("active", s === n);
    li.classList.toggle("done", s < n);
  });
  const tp = $("#topPrev"), tn = $("#topNext");
  if (tp) { tp.dataset.goto = n - 1; tp.classList.toggle("hidden", n <= 1); }
  if (tn) { tn.dataset.goto = n + 1; tn.classList.toggle("hidden", n >= 5); }
  const tl = $("#topStepLabel"); if (tl) tl.textContent = "第 " + n + " 步 / 共 5 步";
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (n === 2) renderPresets(), renderParams(), renderMeasurePicker();
  if (n === 3) fillPreviewFiles();
  if (n === 3) { runPrecheck(); renderRouteSwitch(); refreshReviewState(); }
  // 第四步的结果网格实现在 review-grid-ui.js（window.refreshResultsGrid），
  // 这里只负责在切到该步时触发一次取数；脚本没加载就静默跳过。
  if (n === 4 && window.refreshResultsGrid) window.refreshResultsGrid();
  if (n === 5) refreshExpParams();
  renderVoiceHint();
}

/* ---------------------------------------------------------------- 层级 */

function renderTierSwitch() {
  const box = $("#tierSwitch");
  box.innerHTML = "";
  state.boot.tiers.forEach(t => {
    const b = document.createElement("button");
    b.textContent = t.name;
    b.title = t.desc;
    b.className = t.id === state.tier ? "active" : "";
    b.onclick = () => { state.tier = t.id; api("/api/settings", { settings: { tier: t.id } }); renderTierSwitch(); renderPresets(); renderParams(); renderMeasurePicker(); window.dispatchEvent(new CustomEvent("pstierchange")); };
    box.appendChild(b);
  });
  $("#tierHint").textContent = state.boot.tiers.find(t => t.id === state.tier).desc;
}

/* ---------------------------------------------------------------- 预设 */

function renderPresets() {
  applyTierLayout();
  const box = $("#presetGrid");
  if (state.tier === "advanced") { box.innerHTML = ""; return; }  // 进阶不显示研究目标，直接用下方分类方格
  box.innerHTML = "";
  state.boot.presets.forEach(p => {
    if (p.id === "all") return;  // 新手不显示「全部参数」（用户 2026-09-26：第四个不用）
    const b = document.createElement("button");
    b.className = "preset" + (state.boot.settings.preset === p.id ? " active" : "");
    b.title = p.desc;  // 鼠标悬停看简介
    b.innerHTML = `<div class="pt"><span class="dot"></span>${esc(p.name)}</div>
                   <div class="pdesc">${esc(p.desc)}</div>
                   <div class="ptag">${esc(p.tagline)}</div>`;
    b.onclick = () => applyPreset(p);
    box.appendChild(b);
  });
}

// 下方「参数」列表的勾选 ↔ 顶部「研究目标」预设 双向联动：
// 当前测量组合恰好等于某个预设则高亮它；否则清掉高亮（视为自定义）。
// 只比对预设定义的键（测量项+带宽等），发音人/基频范围不在预设键内，不破坏已匹配的预设高亮。
function syncPresetHighlight() {
  const grid = $("#presetGrid");
  if (!grid) return;
  let matchId = null;
  for (const p of state.boot.presets) {
    let ok = true;
    for (const k in p.values) {
      if (String(state.values[k]) !== String(p.values[k])) { ok = false; break; }
    }
    if (ok) { matchId = p.id; break; }
  }
  state.boot.settings.preset = matchId;
  $$("#presetGrid .preset").forEach((el, i) => el.classList.toggle("active", state.boot.presets[i].id === matchId));
}

function applyPreset(p) {
  Object.assign(state.values, p.values);
  $$("#presetGrid .preset").forEach((el, i) => el.classList.toggle("active", state.boot.presets[i].id === p.id));
  api("/api/settings", { settings: { preset: p.id } });
  // 嗓音预设走「先审 F0 / 共振峰」路线（第二步的先算/先审弹窗已移除，相关功能在第三步实现）
  state.voiceRoute = (p.id === "phonation") ? "review" : null;
  renderParams();
  renderMeasurePicker();
  renderVoiceHint();
  toast(`已套用「${p.name}」的参数组合`);
}

/* ---------------------------------------------------------------- 嗓音预设：先审 F0/共振峰 再算其余
   第二步的「先算 / 先审」弹窗已移除（用户 2026-09-26：相关功能在第三步实现）。
   点「嗓音 / 发声态」预设直接套用整套参数并进入「先审 F0 / 共振峰」路线（voiceRoute="review"），
   第三步据此提示「继续算其余嗓音参数」。 */
let phonationPreset = null;

// 默认「先审 F0 / 共振峰」路线：只开 F0 + 共振峰，其余嗓音参数关掉，留待审核后补算
function setReviewDefaults() {
  const p = state.boot.presets.find(x => x.id === "phonation");
  if (p) {
    const v = Object.assign({}, p.values);
    ["ha_h1c", "ha_h2c", "ha_h4c", "ha_a1c", "ha_a2c", "ha_a3c",
     "hau_h1u", "hau_h2u", "hau_h4u", "hau_a1u", "hau_a2u", "hau_a3u", "hau_h2ku", "hau_h5ku",
     "sl_h1h2c", "sl_h2h4c", "sl_h1a1c", "sl_h1a2c", "sl_h1a3c", "sl_h42ku",
     "slu_h1h2u", "slu_h2h4u", "slu_h1a1u", "slu_h1a2u", "slu_h1a3u", "slu_h2kh5ku",
     "hnr_05", "hnr_15", "hnr_25", "hnr_35", "hnr_38", "cpp", "intensity", "soe", "shr", "cpps"].forEach(k => v[k] = 0);
    Object.assign(state.values, v);
  }
  state.voiceRoute = "review";
}

// 把「其余嗓音参数」补进当前勾选（合并 phonation 预设整套，F0/共振峰保持开启）。
// 返回预设名（没找到预设返回 null）。第三步「路线 B」按钮、第三步「已审核后批量」共用。
function mergeRestVoiceParams() {
  const p = phonationPreset || state.boot.presets.find(x => x.id === "phonation");
  if (!p) return null;
  Object.assign(state.values, p.values);
  state.voiceRoute = null;
  renderParams(); renderMeasurePicker(); renderVoiceHint(); renderRouteSwitch();
  return p.name;
}

function continueVoiceRest() {
  const name = mergeRestVoiceParams();
  if (!name) return;
  toast(`已补算其余嗓音参数（${name} 全套）`, "ok");
}

function renderVoiceHint() {
  const show = state.voiceRoute === "review";
  $$("[data-voice-hint]").forEach(el => el.classList.toggle("hidden", !show));
}

// 第三步的「测量路线」块：**一个入口按钮**（先全量审查 F0/共振峰）+ 审核状态提示。
// 这里只刷上面那两行说明文字，**不碰任何按钮的显隐**——曾经按 voiceRoute 把按钮
// `display:none` 掉，而第三步初始 voiceRoute 本就是 null，结果一进来只剩一个按钮
// （2026-09-22 用户反馈「怎能只剩一个了」）。按钮的显隐与路线无关。
function renderRouteSwitch() {
  const box = $("#routeSwitch");
  if (!box) return;
  const review = state.voiceRoute === "review";
  $("#routeLabel").textContent = review ? "先审 F0 / 共振峰" : "按当前勾选直接算";
  $("#routeDesc").textContent = review
    ? "已只算 F0 + 共振峰。点这个框（或右侧按钮）进九宫格：在文件详情页点「保存」才算审过——F0 与共振峰分开算，存了基频不代表存了共振峰。无需逐个审的文件，整批点「审核完成」即标记全部过关。审完回来点「开始批量处理」不再重算已审部分。"
    : "按当前勾选的参数直接批量。若 F0/共振峰已审过（详情页点过「保存」、或九宫格「审核完成」），点「开始批量处理」时不会重算它们。";
}

/* ---------------- 审核状态（第三步提示 + 「开始批量处理」的分支依据） ----------------
 *
 * 「已审核」判定的粒度是**文件**：该 wav 旁边存在审查导出的 <主名>.Pitch 与
 * <主名>.Formant，就算这个文件审核过（后端 review_export.reviewed_state）。
 *
 * 为什么用文件判定，而不是记「哪个文件被改过」：实际工作里只修有问题的少数文件，
 * 没改过的文件占多数，靠"改过没有"当判据会把绝大多数文件误判成没审核。
 * 九宫格的「审核完成」会给目录里**全部** wav 落盘（没改过的用当前参数），
 * 所以「文件在 = 这批审过了」是成立的，而且是个不依赖记忆的事实判断。
 */

async function refreshReviewState() {
  const dir = (state.values.inputDir || "").trim();
  if (!dir) { state.reviewState = null; renderReviewState(); return; }
  try {
    const r = await api("/api/review/reviewed", { dir });
    state.reviewState = (r && r.ok) ? r : null;
  } catch (e) {
    state.reviewState = null;
  }
  renderReviewState();
}

function renderReviewState() {
  const el = $("#reviewState");
  if (!el) return;
  const r = state.reviewState;
  if (!r || !r.total) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  const pr = r.pitch_reviewed || 0, fr = r.formant_reviewed || 0, tot = r.total;
  if (pr >= tot && fr >= tot) {
    el.textContent = `已全量审核 F0/共振峰（F0 ${pr}/${tot} · 共振峰 ${fr}/${tot}）`;
    el.className = "review-state ok";
  } else {
    const missF0 = tot - pr, missFm = tot - fr;
    el.textContent = `F0 已审 ${pr}/${tot}，共振峰 ${fr}/${tot}` +
      (missF0 || missFm ? `（还差 F0 ${missF0} · 共振峰 ${missFm}）` : "");
    el.className = "review-state warn";
  }
}

// 有文件没审核（F0 / 共振峰两维没都审过）时点「开始批量处理」的确认框。
// resolve(true) = 不经审核直接算；resolve(false) = 退回（顺手打开九宫格方便补审）。
function askReviewSkip(info) {
  return new Promise((resolve) => {
    const modal = $("#reviewAskModal");
    if (!modal) { resolve(true); return; }
    const total = (info && info.total) || 0;
    const pr = (info && info.pitch_reviewed) || 0;
    const fr = (info && info.formant_reviewed) || 0;
    const reviewed = (info && info.reviewed) || 0;
    $("#reviewAskText").textContent =
      `目录里 ${total} 个文件，目前 F0 已审 ${pr}/${total}、共振峰已审 ${fr}/${total}` +
      `（两维都审过才算全部完成）。还有 ${total - reviewed} 个文件没完成共振峰和基频审核。`;
    const mp = (info && info.missing_pitch) || [];
    const mf = (info && info.missing_formant) || [];
    const sub = [];
    if (mp.length) sub.push(
      `<div class="review-ask-sub"><b>缺基频（F0）</b>：${mp.slice(0, 8).map(n => `<span class="review-ask-chip">${esc(n)}</span>`).join("")}` +
      (mp.length > 8 ? ` <span class="muted small">…等 ${mp.length} 个</span>` : "") + `</div>`);
    if (mf.length) sub.push(
      `<div class="review-ask-sub"><b>缺共振峰</b>：${mf.slice(0, 8).map(n => `<span class="review-ask-chip">${esc(n)}</span>`).join("")}` +
      (mf.length > 8 ? ` <span class="muted small">…等 ${mf.length} 个</span>` : "") + `</div>`);
    $("#reviewAskList").innerHTML = sub.join("");
    modal.classList.remove("hidden");
    const done = (v) => { modal.classList.add("hidden"); resolve(v); };
    $("#reviewAskGo").onclick = () => done(true);
    // 「退回完成审核」：直接打开九宫格，方便去把剩下的文件审了（F0 页/共振峰页各自保存，
    // 或整批点「审核完成」标记过关）。
    $("#reviewAskCancel").onclick = () => { if (window.openGrid) window.openGrid(); done(false); };
    $("#reviewAskClose").onclick = () => done(false);
    // 点背景 = 取消。必须在这里覆盖 init 里那条「只关闭不回调」的通用绑定，
    // 否则点了背景关闭后 Promise 永远不 resolve，按钮就卡在禁用状态。
    modal.onclick = (e) => { if (e.target === modal) done(false); };
  });
}

// 「开始批量处理」的前置判断，返回 { proceed, values, note }。
//   全部已审核 → 注入 pitchRead/formantRead（读审查导出的对象，不重算），
//                并（若还在 review 路线）把其余嗓音参数一并勾上再算
//   有未审核的 → 先把清单摆出来问一句；点「不经审核，直接计算」才照常全量算
async function decideReviewForRun() {
  const dir = (state.values.inputDir || "").trim();
  if (!dir) return { proceed: true, values: state.values, note: "" };
  await refreshReviewState();
  const r = state.reviewState;
  if (!r || !r.total) return { proceed: true, values: state.values, note: "" };

  if (r.reviewed >= r.total) {
    let note = `已审核 F0/共振峰 ${r.reviewed}/${r.total}：直接读取审查结果，本次不重算。`;
    if (state.voiceRoute === "review") {
      const name = mergeRestVoiceParams();
      if (name) note += "其余嗓音参数（谐波、CPP、HNR 等）已一并勾上。";
    }
    return {
      proceed: true,
      note,
      values: Object.assign({}, state.values, {
        // 目录留空：后端 _prepare 会补成「已解析的工作目录」（选了父目录时是 Resample/）。
        // 之前这里硬塞 state.values.inputDir（用户选的原始目录），批量读对象会去
        // 原始目录的 measure/ 找 —— 读不到审核时写在 Resample/measure/ 的那份，
        // 于是重算并用「单个标注段的片段对象」覆盖整段 .Pitch（2026-10-18 事故根因）。
        pitchRead: 1, pitchReadDir: "",
        formantRead: 1, formantReadDir: "",
      }),
    };
  }

  const go = await askReviewSkip(r);
  if (!go) return { proceed: false, values: state.values, note: "" };
  return {
    proceed: true, values: state.values,
    note: `有 ${r.total - r.reviewed} 个文件未审核 F0/共振峰，本次全部照常计算。`,
  };
}

window.refreshReviewState = refreshReviewState;

function renderSpeakers() {
  const row = $("#speakerRow");
  row.className = "speaker-grid";
  row.innerHTML = "";
  state.boot.speakers.forEach(s => {
    const b = document.createElement("button");
    b.className = "chip" + (state.boot.settings.speaker === s.id ? " active" : "");
    b.textContent = s.name;
    b.onclick = () => applySpeaker(s);
    row.appendChild(b);
  });
  const f = $("#speakerFields");
  f.innerHTML = "";
  ["f0min", "f0max", "maxFormantHz"].forEach(name => {
    const p = state.boot.params.find(x => x.name === name);
    f.appendChild(paramControl(p, true));
  });
}

function applySpeaker(s) {
  if (s.id !== "custom") {
    state.values.f0min = s.f0min;
    state.values.f0max = s.f0max;
    state.values.maxFormantHz = s.maxFormantHz;
    // 同步默认层（2026-10-18）：否则「恢复默认参数」会用启动时那个发音人的值，
    // 出现「界面高亮成年女声、恢复默认后上限却是 300」的错位。
    // 有「我的默认」override 的字段不动——用户自己存过的值优先。
    const ov = state.boot.overrides || {};
    ["f0min", "f0max", "maxFormantHz"].forEach(k => {
      if (ov[k] == null && state.boot.defaults) state.boot.defaults[k] = s[k];
    });
  }
  state.boot.settings.speaker = s.id;  // 本地同步，使高亮立即跟随所选（api 写盘不回填本地）
  $$("#speakerRow .chip").forEach((el, i) => el.classList.toggle("active", state.boot.speakers[i].id === s.id));
  api("/api/settings", { settings: { speaker: s.id } });
  renderSpeakers();
  renderParams();
  toast(`${s.name}：基频 ${state.values.f0min}–${state.values.f0max} Hz，共振峰上限 ${state.values.maxFormantHz} Hz`);
}

/* ---------------------------------------------------------------- 参数渲染 */

// 参数按功能族分类（借鉴 VoiceSauce 文献 2.1–2.4：基础参数 / 谐波 / 噪音 / 激励）。
// 用于第二步「参数」卡片的紧凑方格布局，1–2 排即可排完；鼠标悬停方框看简介。纯前端，刷新即生效。
// 第二步「参数」卡片的分类方框：仅作快速勾选的分组，紧凑、只放标签，不塞长段注释
// （各项说明见下方「高级设置」折叠区里的小字）。纯前端，刷新即生效。
const PARAM_CATS = [
  { label: "基频相关", params: ["pitch"] },
  { label: "共振峰相关", params: ["formant1", "formant2", "formant3", "formant4", "formant5", "bw1", "bw2", "bw3"] },
  { label: "谐波幅度（已校正）", params: ["ha_h1c", "ha_h2c", "ha_h4c", "ha_a1c", "ha_a2c", "ha_a3c"] },
  { label: "谐波幅度（未校正）", params: ["hau_h1u", "hau_h2u", "hau_h4u", "hau_a1u", "hau_a2u", "hau_a3u", "hau_h2ku", "hau_h5ku"] },
  { label: "频谱斜率（已校正）", params: ["sl_h1h2c", "sl_h2h4c", "sl_h1a1c", "sl_h1a2c", "sl_h1a3c", "sl_h42ku"] },
  { label: "频谱斜率（未校正）", params: ["slu_h1h2u", "slu_h2h4u", "slu_h1a1u", "slu_h1a2u", "slu_h1a3u", "slu_h2kh5ku"] },
  { label: "噪音水平", params: ["hnr_05", "hnr_15", "hnr_25", "hnr_35", "hnr_38", "shr", "cpp", "cpps"] },
  { label: "能量与激励", params: ["intensity", "soe"] },
];

// 快捷框：每个测量一个组按钮（共振峰组 = F1–F5/B1–B3）。点组按钮整体开关该测量；
// 展开「测量项」详情里再逐列拆开单独勾选。两者共用同一组原子参数，天然双向联动。
const MEASURE_GROUPS = [
  { label: "基频 F0", params: ["pitch"], help: "param:pitch" },
  { label: "共振峰", params: ["formant1", "formant2", "formant3", "formant4", "formant5", "bw1", "bw2", "bw3"], help: "formant-group" },
  { label: "谐波幅度（已校正）", params: ["ha_h1c", "ha_h2c", "ha_h4c", "ha_a1c", "ha_a2c", "ha_a3c"], help: "harmonic-corrected" },
  { label: "谐波幅度（未校正）", params: ["hau_h1u", "hau_h2u", "hau_h4u", "hau_a1u", "hau_a2u", "hau_a3u", "hau_h2ku", "hau_h5ku"], help: "harmonic-uncorrected" },
  { label: "频谱斜率（已校正）", params: ["sl_h1h2c", "sl_h2h4c", "sl_h1a1c", "sl_h1a2c", "sl_h1a3c", "sl_h42ku"], help: "h1h2" },
  { label: "频谱斜率（未校正）", params: ["slu_h1h2u", "slu_h2h4u", "slu_h1a1u", "slu_h1a2u", "slu_h1a3u", "slu_h2kh5ku"], help: "h1h2" },
  { label: "HNR 谐噪比", params: ["hnr_05", "hnr_15", "hnr_25", "hnr_35", "hnr_38"], help: "hnr" },
  { label: "CPP", params: ["cpp"], help: "cpp" },
  { label: "CPPS", params: ["cpps"], help: "cpps" },
  { label: "SHR", params: ["shr"], help: "shr" },
  { label: "强度（RMS）", params: ["intensity"], help: "intensity" },
  { label: "SoE", params: ["soe"], help: "soe" },
];

// 「更多高级设置」里未进方框的参数，按主题分组（相关的放一起），用最普通的横排呈现。
const MORE_GROUPS = [
  { label: "测量节奏与采样", params: ["channel", "intervalFixed", "intervalEquidistant", "resample16kHz", "pitchSynchronous"] },
  { label: "中间文件（Pitch / Formant 复用）", params: ["pitchSave", "pitchSaveDir", "pitchRead", "pitchReadDir", "formantSave", "formantSaveDir", "formantRead", "formantReadDir"] },
  { label: "基频算法与窗", params: ["windowLength", "pitchMethod", "pitchWindowShape", "pitchMaxNoCandidates", "silenceThreshold", "voicingThreshold", "octaveCost", "octaveJumpCost", "voicedUnvoicedCost", "killOctaveJumps", "preEmphFrom"] },
  { label: "共振峰参考与带宽", params: ["bwHawksMiller", "f1ref", "f2ref", "f3ref"] },
  { label: "CPP 设置", params: ["cppTrendType", "cppFast"] },
  { label: "文件筛选与日志", params: ["filelist", "includeTheseLabels", "verbose"] },
];

function renderParams() {
  const box = $("#paramGroups");
  box.innerHTML = "";
  const order = { novice: 0, advanced: 1 };
  const limit = order[state.tier] ?? 0;
  const byName = {};
  state.boot.params.forEach(p => byName[p.name] = p);

  const chipHtml = (p) => {
    const on = truthy(state.values[p.name]);
    return '<button type="button" class="pchip' + (on ? " on" : "") +
      '" data-param="' + esc(p.name) + '" data-help="' + esc(helpKey(p.name)) +
      '" title="' + esc(p.label) + '">' +
      esc(p.label) + '</button>';
  };

  // 快捷框：每个测量一个组按钮（含「共振峰」组 F1–F5/B1–B3）；点按钮整体开关该测量，
  // 展开「测量项」详情里再逐列拆开单独勾选。
  const boxSet = new Set();
  MEASURE_GROUPS.forEach(g => {
    const items = g.params.map(n => byName[n]).filter(p => p && (order[p.tier] ?? 0) <= limit);
    if (!items.length) return;
    items.forEach(p => boxSet.add(p.name));
    const onCount = items.filter(p => truthy(state.values[p.name])).length;
    const div = document.createElement("div");
    div.className = "pcat" + (onCount === items.length ? " full" : onCount > 0 ? " partial" : "");
    div.dataset.group = g.label;
    const hkey = g.help ? ' data-help="' + esc(g.help) + '"' : '';
    div.innerHTML = '<div class="pcat-head"><span>' + esc(g.label) + '</span><span class="pcat-count"></span></div>' +
                    '<div class="pcat-chips"><button type="button" class="pchip group' + (onCount > 0 ? " on" : "") +
                    '" data-params="' + g.params.join(",") + '"' + hkey + ' title="' + esc(g.label) + '：点一下整体开关">'
                    + esc(g.label) + '</button></div>';
    box.appendChild(div);
  });

  // 已选测量项：折叠显示已选标签，展开「更多」显示全部可测量项（与上方方框双向联动）。
  renderChosen();

  // 更多高级设置：进阶默认收起，点「更多高级设置」才展开，按主题分组列出全部
  // 未进方框的参数。每项用最普通的横排（左标签+浅色小字说明，右控件）。
  const moreBtn = $("#btnParamMore"), moreBox = $("#paramMore");
  if (moreBtn) moreBtn.classList.toggle("hidden", state.tier !== "advanced");
  if (moreBox) {
    if (state.tier === "advanced" && state.showParamMore) {
      moreBox.innerHTML = "";
      const covered = new Set();
      MORE_GROUPS.forEach(g => {
        const items = g.params.map(n => byName[n]).filter(p => p && (order[p.tier] ?? 0) <= limit);
        if (!items.length) return;
        items.forEach(p => covered.add(p.name));
        const sec = document.createElement("div");
        sec.className = "pmore-group";
        sec.innerHTML = '<div class="pmore-group-head">' + esc(g.label) + '</div>';
        const grid = document.createElement("div");
        grid.className = "pmore-grid";
        items.forEach(p => grid.appendChild(paramControl(p, false)));
        sec.appendChild(grid);
        moreBox.appendChild(sec);
      });
      // 兜底：未被分组的剩余参数归到「其他」
      const left = state.boot.params.filter(p => !boxSet.has(p.name) && !covered.has(p.name) && !p.internal && p.name !== "formant" && p.name !== "bw" && (order[p.tier] ?? 0) <= limit);
      if (left.length) {
        const sec = document.createElement("div");
        sec.className = "pmore-group";
        sec.innerHTML = '<div class="pmore-group-head">其他</div>';
        const grid = document.createElement("div");
        grid.className = "pmore-grid";
        left.forEach(p => grid.appendChild(paramControl(p, false)));
        sec.appendChild(grid);
        moreBox.appendChild(sec);
      }
      moreBox.classList.remove("hidden");
      moreBtn.textContent = "收起高级设置 ▲";
    } else {
      moreBox.classList.add("hidden");
      if (moreBtn) moreBtn.textContent = "更多高级设置（窗长 · 算法 · 阈值 · 中间文件…）▾";
    }
  }

  $$("#paramGroups .pchip").forEach(b => {
    b.onclick = () => {
      const grp = b.dataset.params;
      if (grp) {
        // 组按钮：整体开关该测量（共振峰 = F1–F5/B1–B3 等）
        const names = grp.split(",");
        const allOn = names.every(n => truthy(state.values[n]));
        const want = allOn ? 0 : 1;
        names.forEach(n => { state.values[n] = want; });
        onParamChange();
        syncParamViews();
        return;
      }
      const name = b.dataset.param;
      const want = !truthy(state.values[name]);
      if (!want) {
        const blk = measureDepBlocked(name);   // 关基础项被依赖项挡下
        if (blk) { toast(blk, "warn"); return; }
      } else {
        enableRequires(name);                   // 开派生项级联开基础项
      }
      state.values[name] = want ? 1 : 0;
      onParamChange();
      syncParamViews();   // 双向联动：同步大框 chip 与下方参数列表（不重建 DOM，保护「更多高级设置」输入）
    };
  });
  applyTierLayout();
}

// 已选测量项：折叠时显示已选标签（可点掉），展开「更多」显示全部可测量项（按分类分组、
// 每项悬停出说明）。与上方方框双向联动。说明不常驻，避免占位置。
function renderChosenPreview() {
  const chosenBox = $("#paramChosen");
  if (!chosenBox) return;
  const byName = {};
  state.boot.params.forEach(p => byName[p.name] = p);
  const names = [];
  PARAM_CATS.forEach(c => c.params.forEach(n => { if (!names.includes(n)) names.push(n); }));
  const sel = names.map(n => byName[n]).filter(p => p && truthy(state.values[p.name]));
  chosenBox.innerHTML = sel.length
    ? sel.map(p => '<span class="ctag on" data-param="' + esc(p.name) + '" data-help="' + esc(helpKey(p.name)) + '" title="' + esc(p.help || "") + '">' + esc(p.label) + '</span>').join("")
    : '<span class="muted small">（还没有选择任何测量项）</span>';
  $$("#paramChosen .ctag").forEach(t => {
    t.onclick = () => {
      const name = t.dataset.param;
      const blk = measureDepBlocked(name);
      if (blk) { toast(blk, "warn"); return; }
      state.values[name] = 0;
      onParamChange();
      renderChosenPreview();
    };
  });
}
function renderChosenCatalog() {
  const catBox = $("#paramCatalog"), chosenBtn = $("#btnChosenMore");
  if (!catBox) return;
  const order = { novice: 0, advanced: 1 };
  const limit = order[state.tier] ?? 0;
  const byName = {};
  state.boot.params.forEach(p => byName[p.name] = p);
  if (state.tier === "advanced" && state.showChosenMore) {
    catBox.innerHTML = "";
    PARAM_CATS.forEach(cat => {
      const items = cat.params.map(n => byName[n]).filter(p => p && (order[p.tier] ?? 0) <= limit);
      if (!items.length) return;
      const sec = document.createElement("div");
      sec.className = "pmore-group";
      sec.innerHTML = '<div class="pmore-group-head">' + esc(cat.label) + '</div>';
      const grid = document.createElement("div");
      grid.className = "pcat-grid";
      items.forEach(p => {
        const on = truthy(state.values[p.name]);
        const b = document.createElement("button");
        b.type = "button";
        b.className = "pchip" + (on ? " on" : "");
        b.dataset.param = p.name;
        b.textContent = p.label;
        b.title = p.help || "";
        b.onclick = () => {
          const blk = measureDepBlocked(p.name);
          if (blk && truthy(state.values[p.name])) { toast(blk, "warn"); return; }
          state.values[p.name] = truthy(state.values[p.name]) ? 0 : 1;
          onParamChange();
          b.classList.toggle("on", truthy(state.values[p.name]));
          syncParamViews();   // 与上方分类框双向联动
        };
        grid.appendChild(b);
      });
      sec.appendChild(grid);
      catBox.appendChild(sec);
    });
    catBox.classList.remove("hidden");
    if (chosenBtn) chosenBtn.textContent = "收起 ▲";
  } else {
    catBox.classList.add("hidden");
    if (chosenBtn) chosenBtn.textContent = "展开更多 ▾";
  }
}
function renderChosen() { renderChosenPreview(); renderChosenCatalog(); }

// 按层级切换两张卡片的显隐：新手看「研究目标」+ 结果预览（参数方格隐藏，保持简单）；
// 进阶隐藏「研究目标」，直接用下方分类方格选参数。
function applyTierLayout() {
  const adv = state.tier === "advanced";
  const pc = $("#presetCard"), gc = $("#paramCard");
  // 新手看「研究目标」+ 结果预览；进阶隐藏这两张，直接进分类方格
  if (pc) pc.classList.toggle("hidden", adv);
  // 顶部「已选测量项预览」仅新手显示；进阶那个在 paramCard 内已有，避免重复
  if ($("#previewCard")) $("#previewCard").classList.toggle("hidden", adv);
  if (!gc) return;
  // paramCard 始终可见：它承载「发音人」，两层级都要选发音人；仅按层级显隐其内部进阶区块
  gc.classList.remove("hidden");
  const head = gc.querySelector("#paramCardHead");
  if (head) head.classList.toggle("hidden", !adv);
  const groups = gc.querySelector("#paramGroups"); if (groups) groups.classList.toggle("hidden", !adv);
  const chosen = gc.querySelector(".chosen-wrap"); if (chosen) chosen.classList.toggle("hidden", !adv);
  const pfull = gc.querySelector(".pfull"); if (pfull) pfull.classList.toggle("hidden", !adv);
  const foot = gc.querySelector(".card-foot"); if (foot) foot.classList.toggle("hidden", !adv);
  // 发音人两层级都显示
  const spk = gc.querySelector("#speakerCard"); if (spk) spk.classList.remove("hidden");
}

function paramControl(p, inlineLabel = false) {
  const wrap = document.createElement("div");
  wrap.className = "pitem";
  wrap.dataset.name = p.name;
  // 点击式帮助：整行都算同一个参数的说明；没写条目的参数退回 schema 的 help 文本
  wrap.dataset.help = helpKey(p.name);
  wrap.dataset.helpFallback = p.help || p.label;

  const info = document.createElement("div");
  info.className = "pinfo";
  info.innerHTML = `<div class="pname">${esc(p.label)}</div><div class="phelp">${esc(p.help || "")}</div>`;

  const ctrl = document.createElement("div");
  ctrl.className = "pctrl";

  const v = state.values[p.name];

  if (p.type === "bool") {
    const lab = document.createElement("label");
    lab.className = "switch-row";
    lab.innerHTML = `<input type="checkbox" ${v ? "checked" : ""}><span class="switch"></span>`;
    const cb = lab.querySelector("input");
    cb.onchange = () => {
      const want = cb.checked ? 1 : 0;
      // 测量项依赖联动：关基础项被依赖项挡下；开派生项级联开基础项。
      if (p.cols) {
        if (!want) {
          const blk = measureDepBlocked(p.name);
          if (blk) { cb.checked = true; toast(blk, "warn"); return; }
        } else {
          enableRequires(p.name);
        }
      }
      state.values[p.name] = want;
      onParamChange();
    };
    ctrl.appendChild(lab);
  } else if (p.type === "choice") {
    const sel = document.createElement("select");
    sel.innerHTML = p.choices.map(c => `<option value="${c[0]}" ${String(c[0]) === String(v) ? "selected" : ""}>${esc(c[1])}</option>`).join("");
    sel.onchange = () => { state.values[p.name] = parseInt(sel.value, 10); onParamChange(); };
    ctrl.appendChild(sel);
  } else if (p.type === "dir") {
    const row = document.createElement("div");
    row.className = "row";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = v || "";
    inp.placeholder = "留空或粘贴路径";
    inp.onchange = () => { state.values[p.name] = inp.value.trim(); onParamChange(); };
    const btn = document.createElement("button");
    btn.className = "btn tiny ghost";
    btn.textContent = "浏览";
    btn.onclick = (e) => { e.preventDefault(); openPicker(inp.value || "", path => { inp.value = path; state.values[p.name] = path; onParamChange(); }); };
    row.append(inp, btn);
    ctrl.appendChild(row);
  } else if (p.type === "file") {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = v || "";
    inp.onchange = () => { state.values[p.name] = inp.value.trim(); onParamChange(); };
    ctrl.appendChild(inp);
  } else if (p.type === "int" || p.type === "number") {
    const inp = document.createElement("input");
    inp.type = "number";
    inp.value = v;
    if (p.min !== undefined) inp.min = p.min;
    if (p.max !== undefined) inp.max = p.max;
    if (p.step !== undefined) inp.step = p.step;
    inp.onchange = () => {
      let val = p.type === "int" ? parseInt(inp.value, 10) : parseFloat(inp.value);
      if (Number.isNaN(val)) val = p.default;
      state.values[p.name] = val;
      onParamChange();
    };
    ctrl.appendChild(inp);
    if (p.unit) {
      const u = document.createElement("span");
      u.className = "unit";
      u.textContent = p.unit;
      ctrl.appendChild(u);
    }
  } else {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = v || "";
    inp.onchange = () => { state.values[p.name] = inp.value; onParamChange(); };
    ctrl.appendChild(inp);
  }

  if (inlineLabel) {
    wrap.appendChild(ctrl);
    wrap.appendChild(info);
    wrap.style.alignItems = "center";
  } else {
    wrap.appendChild(info);
    wrap.appendChild(ctrl);
  }

  if (p.depends_on) {
    wrap.dataset.dep = p.depends_on;
    applyDep(wrap);
  }
  return wrap;
}

// 依赖显隐："formantRead"（真值判断）或 "intervalMode:0"（值精确匹配，字符串比较）。
function depSatisfied(expr) {
  if (expr.includes(":")) {
    const i = expr.indexOf(":");
    return String(state.values[expr.slice(0, i)]) === expr.slice(i + 1);
  }
  return !!state.values[expr];
}
function applyDep(el) {
  el.classList.toggle("dim", !depSatisfied(el.dataset.dep));
}

// 测量间隔二选一的旧档兼容：存量值里等分点数 >0 而没选方式时，视为「等分点数」方式。
function syncIntervalMode() {
  const ie = Number(state.values.intervalEquidistant) || 0;
  if (ie > 0 && !state.values.intervalMode) state.values.intervalMode = 1;
}

function onParamChange() {
  // 依赖项的启用/禁用
  $$("#paramGroups .pitem[data-dep]").forEach(applyDep);
  renderMeasurePicker();
  syncPresetHighlight();
  if (state.step === 3) runPrecheck();
  syncParamViews();
}

// 第二步「参数」卡片：上方大框（功能分类方框）与下方参数列表的双向联动。
// 仅做 DOM 状态同步（勾选态 / 计数 / 整组高亮），不重建 DOM，
// 以免破坏「更多高级设置」里正在输入的文本框。
function syncParamViews() {
  const sel = n => !!truthy(state.values[n]);
  $$("#paramGroups .pchip").forEach(b => { if (b.dataset.params) return; b.classList.toggle("on", sel(b.dataset.param)); });
  $$("#paramCatalog .pchip").forEach(b => b.classList.toggle("on", sel(b.dataset.param)));
  $$("#paramMore .pitem").forEach(el => {
    const cb = el.querySelector("input[type=checkbox]");
    if (cb) cb.checked = sel(el.dataset.name);
  });
  renderChosenPreview();   // 已选测量项标签随勾选实时刷新
  $$("#paramGroups .pcat").forEach(cat => {
    const grp = cat.dataset.group;
    let total, on;
    if (grp) {
      const names = grp.split(",");
      total = names.length;
      on = names.filter(n => truthy(state.values[n])).length;
      const btn = cat.querySelector(".pchip.group");
      if (btn) btn.classList.toggle("on", on > 0);
    } else {
      const chips = cat.querySelectorAll(".pchip");
      total = chips.length;
      on = [].filter.call(chips, c => c.classList.contains("on")).length;
    }
    const cnt = cat.querySelector(".pcat-count");
    if (cnt) cnt.textContent = on === 0 ? "" : (on === total ? "全选" : "已选 " + on + "/" + total);
    cat.classList.toggle("full", total > 0 && on === total);
    cat.classList.toggle("partial", on > 0 && on < total);
  });
}

/* 第二步测量项交互
   上方「功能框」快速选择已移除（用户 2026-09-26：顶部「研究目标」预设已覆盖场景，
   具体测量项直接在下方「参数」列表勾选，两者双向联动）。这里只保留「结果行」——
   逐列按钮，点一下即把该列从结果表（含导出 CSV）里真正剔除（skipCols）。

   测量项之间存在依赖（MEASURE_REQUIRES）：派生项必须在其基础项已选时才可测量。
   例：频谱斜率（谐波差）依赖谐波幅度——勾选「频谱斜率」会自动勾上「谐波幅度」；
   反过来，若「频谱斜率」还开着，不能单独关掉「谐波幅度」（否则算不出）。
   基础项算出来了，输出时仍可在「结果行」单独去掉它的列（不影响计算）。 */

const STRUCTURAL = new Set(["file", "t", "label", "intervalID"]);  // 结构列，不可单独剔除

// 派生测量项 → 其必须同时开启的基础测量项。纯前端定义，刷新即生效、不必重启 server。
// 派生测量项 → 其必须同时开启的基础测量项（原子列级）。
// 频谱斜率 = 相邻谐波幅度之差，开启任一斜率列即级联开启它依赖的谐波幅度列；
// 关闭某谐波幅度列时若仍有依赖它的斜率列开着，则拦截（见 measureDepBlocked）。
const MEASURE_REQUIRES = {
  sl_h1h2c: ["ha_h1c", "ha_h2c"],
  sl_h2h4c: ["ha_h2c", "ha_h4c"],
  sl_h1a1c: ["ha_h1c", "ha_a1c"],
  sl_h1a2c: ["ha_h1c", "ha_a2c"],
  sl_h1a3c: ["ha_h1c", "ha_a3c"],
  slu_h1h2u: ["hau_h1u", "hau_h2u"],
  slu_h2h4u: ["hau_h2u", "hau_h4u"],
  slu_h1a1u: ["hau_h1u", "hau_a1u"],
  slu_h1a2u: ["hau_h1u", "hau_a2u"],
  slu_h1a3u: ["hau_h1u", "hau_a3u"],
  slu_h2kh5ku: ["hau_h2ku", "hau_h5ku"],
  sl_h42ku: ["hau_h4u", "hau_h2ku"],
};

// 关闭某测量项时，若有其它已开测量项以它为依赖基础，则禁止单独关闭。
function measureDepBlocked(name) {
  const me = state.boot.params.find(x => x.name === name);
  if (!me || !me.cols) return null;            // 仅测量项之间相互约束
  const dependents = state.boot.params.filter(
    x => x.cols && (MEASURE_REQUIRES[x.name] || []).includes(name) && truthy(state.values[x.name])
  );
  if (dependents.length) {
    return `「${me.label}」被「${dependents.map(d => d.label).join("、")}」依赖，无法单独关闭；请先关掉依赖项。`;
  }
  return null;
}

// 开启某测量项时，级联勾上它的前置依赖。
function enableRequires(name) {
  (MEASURE_REQUIRES[name] || []).forEach(r => {
    if (!truthy(state.values[r])) {
      state.values[r] = 1;
      const dep = state.boot.params.find(x => x.name === r);
      if (dep) toast(`已自动开启前置项：「${dep.label}」`, "ok");
    }
  });
}

function colToMeasure(col) {
  for (const p of state.boot.params) {
    if (p.cols && p.cols.indexOf(col) >= 0) return p.name;
  }
  return null;
}

function skipSet() {
  return new Set(String(state.values.skipCols || "").split(",").map(s => s.trim()).filter(Boolean));
}

// 当前被勾选测量项产出的全部列（含结构列）
function producedColumns() {
  const cols = ["file", "t"];
  state.boot.params.forEach(p => {
    if (p.cols && truthy(state.values[p.name])) cols.push(...p.cols);
  });
  if (truthy(state.values.useTextGrid)) cols.push("label", "intervalID");
  return cols;
}

function renderMeasurePicker() {
  // 第二步上方的「功能框」快速选择已移除（用户 2026-09-26：顶部「研究目标」预设已覆盖场景，
  // 具体测量项在下方「参数」列表勾选，两者联动）。这里只渲染「结果表将包含 N 列」预览。
  const box = $("#measurePicker");
  if (box) box.innerHTML = "";
  renderResultLine();
  bindColButtons();
}

/* 底部「结果行」：同样一批逐列按钮，点一下即剔除/加回该列 */
function renderResultLine() {
  const line = $("#colPreviewLine");
  if (!line) return;
  const skip = skipSet();
  const cols = producedColumns().filter(c => !STRUCTURAL.has(c) && !/u/i.test(c));
  if (!cols.length) {
    line.innerHTML = '<span class="muted">还没选任何测量项</span>';
    return;
  }
  const chips = cols.map(c => {
    const skipped = skip.has(c);
    return '<button type="button" class="col-btn' + (skipped ? " skipped" : " active") +
      '" data-col="' + esc(c) + '" title="点一下' + (skipped ? "加回" : "去掉") + '这一列">' + esc(c) + '</button>';
  }).join("");
  line.innerHTML = '<span class="muted small">结果表将包含 ' + cols.length + ' 列（点按钮可去掉/加回）：</span>' + chips;
}

/* 给页面上所有 .col-btn（要测哪些 + 结果行）绑定逐列开关 */
function bindColButtons() {
  $$(".col-btn").forEach(b => { b.onclick = () => toggleCol(b.dataset.col); });
}

/* 点某个输出列 → 开关它；若该列所属测量项还没开，则先打开测量项 */
function toggleCol(col) {
  const measure = colToMeasure(col);
  const skip = skipSet();
  if (measure && !truthy(state.values[measure])) {
    state.values[measure] = 1;   // 先打开所属测量项
    skip.delete(col);            // 并把这一列纳入
  } else if (skip.has(col)) {
    skip.delete(col);
  } else {
    skip.add(col);
  }
  state.values.skipCols = Array.from(skip).join(",");
  onParamChange();
}

/* 点测量项整体按钮 → 开关整个测量项，并同步下方「参数」栏同名开关 */
/* toggleMeasure 已随第二步功能框移除而废弃：测量项现在只在下方「参数」列表里勾选。 */



function truthy(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return v !== undefined && v !== null && String(v).trim() !== "" && String(v) !== "0";
}

// 旧版用 formant / bw 总开关；迁移到 F1–F5 / B1–B3 独立勾选。
// 仅在缺少 per-formant 键时生效，不覆盖已有选择。供 boot 初始化与预设应用前调用。
function normalizeFormants(values) {
  if (values.formant1 === undefined && values.formant !== undefined) {
    const fv = truthy(values.formant) ? 1 : 0;
    [1, 2, 3, 4, 5].forEach(n => { if (values["formant" + n] === undefined) values["formant" + n] = fv; });
  }
  if (values.bw1 === undefined && values.bw !== undefined) {
    const bv = truthy(values.bw) ? 1 : 0;
    [1, 2, 3].forEach(n => { if (values["bw" + n] === undefined) values["bw" + n] = bv; });
  }
}

/* ---------------------------------------------------------------- 文件扫描 */

async function scanInput(silent = false) {
  const dir = $("#inputDir").value.trim();
  state.values.inputDir = dir;
  const ext = $("#soundExt").value.trim() || "wav";
  state.values.soundExt = ext;
  if (!dir) return;

  const res = await api("/api/scan", { dir, ext });
  const box = $("#inputSummary");
  const list = $("#fileList");

  if (!res.ok) {
    box.classList.remove("hidden");
    box.innerHTML = `<span style="color:var(--err)">${esc(res.error)}</span>`;
    list.classList.add("hidden");
    state.files = [];
    $("#step1Msg").textContent = res.error;
    return;
  }
  state.files = res.files.map(f => f.name);
  state.selectedFiles = new Set(state.files);   // 默认全选
  api("/api/settings", { settings: { lastInputDir: dir, soundExt: ext } });

  const rates = res.sampleRates.map(r => `<span class="badge${r.rate !== 16000 ? " warn" : ""}">${r.rate} Hz × ${r.count}</span>`).join("");
  box.classList.remove("hidden");
  box.innerHTML = `
    <div class="kv"><span>文件数</span><b>${res.count} 个 .${esc(ext)} 文件</b></div>
    <div class="kv"><span>总时长</span><b>${fmtDuration(res.totalDuration)}</b></div>
    <div class="kv"><span>采样率</span><b>${rates || "—"}</b></div>
    ${res.sampleRates.some(r => r.rate > 16000) ? '<div class="kv"><span>提示</span><b style="color:var(--warn)">采样率高于 16 kHz，可在进阶里勾选降采样</b></div>' : ""}
    <div class="kv" style="align-items:center">
      <span>预处理</span>
      <span style="display:flex;align-items:center;gap:10px;text-align:right">
        <b style="font-weight:400;color:var(--muted)">可提前预处理：把所有音频重采样为 16 kHz，并存入 Resample 目录</b>
        <button class="btn tiny ghost" id="btnPreprocess">预处理</button>
      </span>
    </div>
  `;
  // 示例/调查数据常按发音人或批次分在下一层子目录里，而扫描是单层的。
  // 这里直接把「该选哪一层」说出来，省得用户对着 0 个文件发懵（2026-10-18）。
  if (!res.count) {
    box.innerHTML += `<div class="kv"><span>提示</span><b style="color:var(--warn)">`
      + `这个目录里没有 .${esc(ext)} 文件。如果它下面还有 <code>1</code>、<code>2</code> 这样的子目录，`
      + `请直接选到子目录（或点「浏览…」进去）。</b></div>`;
  }
  list.classList.remove("hidden");
  const show = res.files.slice(0, 10);
  list.innerHTML = show.map(f => `
    <div class="frow fsel${state.selectedFiles.has(f.name) ? " on" : ""}" data-file="${esc(f.name)}">
      <span class="ck">${state.selectedFiles.has(f.name) ? "✓" : ""}</span>
      <span class="fname">${esc(f.name)}</span>
      <span>${fmtDuration(f.duration)}</span>
      <span>${f.sampleRate ? f.sampleRate + " Hz" : ""}</span>
      <span>${f.channels ? f.channels + " 声道" : ""}</span>
    </div>`).join("") + (res.count > 10 ? `<div class="more">…还有 ${res.count - 10} 个文件（已默认选中）</div>` : "");

  // 行点击 = 切换选中；底部状态同步「选中 n/m」
  $$('#fileList .fsel').forEach(row => {
    row.addEventListener('click', () => {
      const f = row.getAttribute('data-file');
      const on = state.selectedFiles.has(f);
      if (on) state.selectedFiles.delete(f); else state.selectedFiles.add(f);
      row.classList.toggle('on', !on);
      row.querySelector('.ck').textContent = on ? '' : '✓';
      updateFileSelCount();
    });
  });
  updateFileSelCount();

  if (truthy(state.values.useTextGrid)) checkTextGrids();
  renderHealth();
  if (!silent) $("#step1Msg").textContent = `找到 ${res.count} 个文件`;
}

async function checkTextGrids() {
  const box = $("#tgSummary");
  const makeBlock = $("#tgMakeBlock");
  // 还没选目录 / 没扫到文件：不显示任何标注信息，也不弹制作按钮
  if (!state.files.length) {
    box.classList.add("hidden");
    makeBlock.classList.add("hidden");
    return;
  }
  const tg = $("#tgDir").value.trim();
  state.values.tgDir = tg;
  const rep = await api("/api/textgrid", { wavFiles: state.files, tgDir: tg || state.values.inputDir });
  box.classList.remove("hidden");
  if (!rep.ok) {
    box.innerHTML = `<span style="color:var(--err)">${esc(rep.error)}</span>`;
    makeBlock.classList.add("hidden");
    return;
  }
  const bad = rep.matched !== state.files.length;
  box.innerHTML = `
    <div class="kv"><span>TextGrid 文件</span><b>${rep.count} 个${rep.tiers ? "（" + rep.tiers + " 层）" : ""}</b></div>
    <div class="kv"><span>与声音文件对应</span><b class="${bad ? "bad" : ""}">${rep.matched} / ${state.files.length}</b></div>
    ${rep.missing.length ? `<div class="kv"><span>缺少标注</span><b class="bad">${esc(rep.missing.slice(0, 5).join("、"))}${rep.missing.length > 5 ? " …" : ""}</b></div>` : ""}
  `;
  // 一个标注都没有：红色提示 + 直接露出「自动制作 Textgrid」按钮
  const noTg = rep.matched === 0;
  if (noTg) {
    box.insertAdjacentHTML("beforeend", `<div class="tg-warn">还没有做好音段标注</div>`);
  }
  makeBlock.classList.toggle("hidden", !noTg);
}

function updateFileSelCount() {
  const m = state.files.length, n = state.selectedFiles.size;
  const el = $("#fileListStatus");
  if (el) {
    el.textContent = m ? `选中 ${n}/${m}` : "";
    el.classList.toggle("empty", n === 0);
  }
}

/* ---------------------------------------------------------------- TextGrid 策略（三选一） */

function applyTgStrategy(strategy) {
  state.values.tgStrategy = strategy;
  // 高亮选中的 .tg-opt
  $$(".tg-opt").forEach((o) => {
    const inp = o.querySelector('input[type="radio"]');
    o.classList.toggle("active", inp && inp.value === strategy);
  });
  // 两项：利用 Textgrid（existing）→ 用；不限制（none）→ 无视 TextGrid
  const useTg = strategy !== "none";
  state.values.useTextGrid = useTg ? 1 : 0;
  $("#useTextGrid").checked = useTg;
  $("#tgFields").classList.toggle("hidden", !useTg);
  renderMeasurePicker();
  if (useTg) checkTextGrids();
  else $("#tgMakeBlock").classList.add("hidden");
}

async function autoSegment() {
  const dir = $("#inputDir").value.trim();
  if (!dir) { toast("请先在第一步选好声音目录", "error"); return; }
  state.values.inputDir = dir;
  const minSil = (parseInt($("#tgMinSil").value, 10) || 100) / 1000;
  const minSyl = (parseInt($("#tgMinSyl").value, 10) || 100) / 1000;
  const thresh = parseFloat($("#tgThresh").value) || -25;
  const ext = state.values.soundExt || "wav";
  const msg = $("#tgAutoMsg");
  msg.classList.remove("hidden");
  msg.textContent = "正在为整个目录自动切分并生成 TextGrid（文件多时请稍候）…";
  $("#btnAutoSegment").disabled = true;
  try {
    // scope:"all" —— 整个目录（含子目录）全部音频一起做，不只是当前这 9 个
    const r = await api("/api/syllables/grid", {
      dir, page: 0, size: 9, minSilence: minSil, minSyllable: minSyl,
      thresholdDb: thresh, ext, force: 1, scope: "all",
    });
    if (!r.ok) { msg.textContent = r.error || "自动制作失败"; return; }
    // 写回主流程使用的 tg 设置：tg 已写在 wav 同目录，层名 syllables → 第 1 层
    state.values.useTextGrid = 1;
    $("#useTextGrid").checked = true;
    state.values.tgDir = dir;
    state.values.intervalTier = 1;
    $("#tgDir").value = dir;
    $("#intervalTier").value = 1;
    checkTextGrids();
    const errTail = r.errors ? "，失败 " + r.errors + " 个" : "";
    msg.textContent = "已为整个目录 " + (r.scanned != null ? r.scanned : r.total) + " 个音频生成 TextGrid（新写出 " +
      (r.written != null ? r.written : r.files.length) + " 个" + errTail +
      "）。下方九宫格里检查：点格子→在放大窗口里可直接点波形加/删/拖动边界、点标签芯片切换 sil↔音节，改完点「保存 TextGrid」；想用专业编辑器再点「在 Praat 中打开」。翻页时读的是刚生成的文件，不会再重切。";
    // 打开音节九宫格（后续翻页由 syllable-grid-ui.js 用相同参数自取）
    window.syllableSegmentParams = { dir, minSilence: minSil, minSyllable: minSyl, thresholdDb: thresh, ext };
    if (typeof window.openSyllableGrid === "function") window.openSyllableGrid(r);
  } finally {
    $("#btnAutoSegment").disabled = false;
  }
}

/* 「用现成 TextGrid」下打开九宫格查看 / 修改标注。
   不传 force：服务端读 wav 同目录已有的 TextGrid（保留手工精修），只有缺文件的才自动补切。 */
async function viewExistingTgGrid() {
  const dir = $("#inputDir").value.trim();
  if (!dir) { toast("请先在第一步选好声音目录", "error"); return; }
  const ext = state.values.soundExt || "wav";
  const size = parseInt($("#sySize").value, 10) || 9;
  const btn = $("#btnViewTgGrid");
  btn.disabled = true;
  try {
    const r = await api("/api/syllables/grid", { dir, page: 0, size, ext });
    if (!r.ok) { toast(r.error || "读取 TextGrid 失败", "error"); return; }
    window.syllableSegmentParams = { dir, ext, minSilence: 0.1, minSyllable: 0.1, thresholdDb: -25 };
    if (typeof window.openSyllableGrid === "function") window.openSyllableGrid(r);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------------------------------------------------------- 试跑 */

/* 把后端返回的结构化报错渲染成「在这里补一下 →」链接：点开原地补，不用回退。
   第 3 步试跑 / 第 4 步批量失败共用；没有结构化 errors 时退化为纯文本错误。 */
function renderFixableErrors(container, res, onDone) {
  const errs = (res && res.errors) || [];
  if (!errs.length) {
    container.innerHTML = `<span style="color:var(--err)">${esc((res && res.error) || "出错了")}</span>`;
    return;
  }
  container.innerHTML = errs.map(e => `
    <div style="margin:3px 0">
      <span style="color:var(--err)">${esc(e.msg)}</span>
      <a class="fixlink" data-field="${esc(e.field)}" href="javascript:void(0)">在这里补一下 →</a>
    </div>`).join("")
    + `<div style="margin-top:6px"><button type="button" class="btn tiny ghost" data-copy-err>复制这些错误</button></div>`;
  container.querySelectorAll(".fixlink").forEach(a => {
    a.onclick = () => quickFix(a.dataset.field, onDone);
  });
  const cb = container.querySelector("[data-copy-err]");
  if (cb) cb.onclick = () => copyText(errs.map(e => e.msg).join("\n"), "已复制这些错误");
}

function fillPreviewFiles() {
  const sel = $("#previewFile");
  const files = state.files;
  if (!files.length) {
    sel.innerHTML = `<option>（请先回到第一步选择文件）</option>`;
    return;
  }
  sel.innerHTML = files.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join("");
  // 默认选中时长居中的文件更有代表性，这里简单取中间那个
  sel.selectedIndex = Math.floor(files.length / 2);
}

async function startPreview() {
  // 优先用第三步独立挑选的绝对路径音频，其次才是第一步文件夹的下拉框
  const file = state.previewAudio || $("#previewFile").value;
  if (!file) { toast("先选一个文件", "error"); return; }
  const btn = $("#btnPreview");
  btn.disabled = true;
  btn.textContent = "正在试跑…";
  const st = $("#previewStatus");
  st.classList.remove("hidden");
  st.innerHTML = `<span class="muted">正在用 Praat 分析 <code>${esc(file)}</code>，通常几秒钟…</span>`;

  const res = await api("/api/preview", { values: state.values, file });
  if (!res.ok) {
    // 报错尽量在当前页就地补，别让用户回退到第 1/2 步去改
    renderFixableErrors(st, res, () => {
      st.innerHTML = '<span class="muted">已补好，点「开始试跑」再跑一次。</span>';
    });
    btn.disabled = false; btn.textContent = "试跑一个样本";
    return;
  }
  pollJob(res.jobId, {
    onLog: (line) => { st.innerHTML = `<code>${esc(line)}</code>`; },
    onDone: (job) => {
      btn.disabled = false; btn.textContent = "重新试跑";
      if (job.status === "error") {
        st.innerHTML = `<span style="color:var(--err)">${esc(job.error || "出错了")}</span>`;
        return;
      }
      st.innerHTML = `<span style="color:var(--ok)">试跑完成，用时 ${job.elapsed} 秒</span>`;
      state.preview = job.summary;
      const pr = $("#previewResult");
      pr.classList.remove("hidden");
      pr.open = true;   // 试跑结果默认展开；用户可点 summary 折叠
      renderCharts();
      renderDiag("#previewDiag", job.summary.diagnostics);
      renderStats("#previewStats", job.summary);
      $("#step3Msg").textContent = "曲线看着对吗？不对就回去改参数。";
    },
  });
}

/* ---------------------------------------------------------------- 图表 */

function renderCharts() {
  const p = state.preview;
  if (!p) return;

  // 系列切换按钮
  const tg = $("#chartToggle");
  tg.innerHTML = "";
  Object.entries(CHART_SERIES).forEach(([key, cfg]) => {
    const b = document.createElement("button");
    b.className = "chip" + (state.chart === key ? " active" : "");
    b.textContent = cfg.title;
    b.onclick = () => { state.chart = key; renderCharts(); };
    tg.appendChild(b);
  });

  const cfg = CHART_SERIES[state.chart];
  const box = $("#charts");
  const idx = {};
  p.columns.forEach((c, i) => idx[c] = i);
  const ti = idx["t"];

  const series = cfg.cols
    .filter(([col]) => idx[col] !== undefined)
    .map(([col, color, name]) => {
      const pts = [];
      p.rows.forEach(r => {
        const t = parseFloat(r[ti]);
        const y = parseFloat(r[idx[col]]);
        pts.push({ x: t, y: (Number.isFinite(y) && y !== 0) ? y : null });
      });
      return { name, color, pts };
    });

  if (!series.length) {
    box.innerHTML = `<p class="muted">这次没有测到 ${cfg.title} 的数据，可以在第二步勾选对应参数。</p>`;
    return;
  }
  box.innerHTML = `<div class="chart-box">${lineChart(series, cfg)}</div>
    <div class="chart-legend">${series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}
    <span class="muted">共 ${p.rows.length} 帧 · 断点表示这一帧没测出来</span></div>`;
}

function lineChart(series, cfg) {
  const W = 900, H = 240, PL = 56, PR = 16, PT = 14, PB = 30;
  const all = series.flatMap(s => s.pts).filter(p => p.y !== null);
  if (!all.length) return `<p class="muted">没有可绘制的数据点。</p>`;

  let xmin = Math.min(...all.map(p => p.x));
  let xmax = Math.max(...all.map(p => p.x));
  let ymin = Math.min(...all.map(p => p.y));
  let ymax = Math.max(...all.map(p => p.y));
  if (xmax - xmin < 1e-6) xmax = xmin + 1;
  if (ymax - ymin < 1e-6) { ymax += 1; ymin -= 1; }
  const padY = (ymax - ymin) * 0.08;
  ymin -= padY; ymax += padY;

  const sx = (x) => PL + (x - xmin) / (xmax - xmin) * (W - PL - PR);
  const sy = (y) => PT + (1 - (y - ymin) / (ymax - ymin)) * (H - PT - PB);

  // y 轴刻度
  const ticks = 4;
  let grid = "";
  for (let i = 0; i <= ticks; i++) {
    const yv = ymin + (ymax - ymin) * i / ticks;
    const y = sy(yv);
    grid += `<line x1="${PL}" y1="${y.toFixed(1)}" x2="${W - PR}" y2="${y.toFixed(1)}" stroke="#eef0f3" stroke-width="1"/>
             <text x="${PL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#9ca3af">${fmtNum(yv, yv > 100 ? 0 : 1)}</text>`;
  }
  // x 轴刻度
  let xt = "";
  for (let i = 0; i <= 5; i++) {
    const xv = xmin + (xmax - xmin) * i / 5;
    const x = sx(xv);
    xt += `<text x="${x.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#9ca3af">${xv.toFixed(2)}</text>`;
  }

  let paths = "";
  series.forEach(s => {
    // 把有效点按连续性分段，缺失处断开
    let seg = [];
    const flush = () => {
      if (seg.length > 1) {
        paths += `<polyline fill="none" stroke="${s.color}" stroke-width="1.8" stroke-linejoin="round"
                   points="${seg.map(p => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ")}"/>`;
      } else if (seg.length === 1) {
        paths += `<circle cx="${sx(seg[0].x).toFixed(1)}" cy="${sy(seg[0].y).toFixed(1)}" r="2" fill="${s.color}"/>`;
      }
      seg = [];
    };
    s.pts.forEach(p => { if (p.y === null) flush(); else seg.push(p); });
    flush();
  });

  return `<svg viewBox="0 0 ${W} ${H}" role="img">
    <rect x="${PL}" y="${PT}" width="${W - PL - PR}" height="${H - PT - PB}" fill="#fcfdff" stroke="#eef0f3"/>
    ${grid}${xt}${paths}
    <text x="${PL}" y="${PT - 2}" font-size="11" fill="#9ca3af">${esc(cfg.unit)}</text>
  </svg>`;
}

/* ---------------------------------------------------------------- 诊断与统计 */

function renderDiag(sel, diags) {
  const box = $(sel);
  if (!diags || !diags.length) {
    box.innerHTML = `<p class="muted">没有发现问题。</p>`;
    return;
  }
  const icons = {
    ok: `<svg class="dicon" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="m8 12 3 3 5-6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    warn: `<svg class="dicon" viewBox="0 0 24 24" fill="none"><path d="M12 4 2.5 20h19L12 4z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17.4" r="1" fill="currentColor"/></svg>`,
    error: `<svg class="dicon" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M15 9l-6 6m0-6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  };
  box.innerHTML = diags.map(d => `
    <div class="diag ${d.level}">
      ${icons[d.level] || icons.warn}
      <div>
        <div class="dtitle">${esc(d.title)}</div>
        <div class="dbody">${esc(d.detail)}</div>
        ${d.suggestion ? `<div class="dsug">💡 ${esc(d.suggestion)}</div>` : ""}
      </div>
    </div>`).join("");
}

function renderStats(sel, summary) {
  const s = summary.stats || {};
  const pick = (col, label, unit = "", digits = 1) => {
    const v = s[col];
    if (!v) return "";
    const ratio = v.ratio !== undefined ? `检出率 ${(v.ratio * 100).toFixed(0)}%` : "";
    return `<div class="stat"><div class="slabel">${esc(label)}</div>
      <div class="svalue">${fmtNum(v.median, digits)}<span style="font-size:12px;color:var(--muted)"> ${esc(unit)}</span></div>
      <div class="ssub">中位数 · ${ratio}</div></div>`;
  };
  const html = [
    `<div class="stat"><div class="slabel">帧数</div><div class="svalue">${summary.rowCount}</div><div class="ssub">${summary.fileCount || 1} 个文件</div></div>`,
    pick("f0", "基频 F0", "Hz", 1),
    pick("F1", "F1", "Hz", 0),
    pick("F2", "F2", "Hz", 0),
    pick("CPP", "CPP", "dB", 1),
    pick("HNR05", "HNR05", "dB", 1),
    pick("H1H2c", "H1-H2c", "dB", 2),
  ].join("");
  $(sel).innerHTML = html;
}

/* ---------------------------------------------------------------- 体检卡 / 配对（W5） */

async function renderHealth() {
  const dir = state.values.inputDir;
  const ext = state.values.soundExt || "wav";
  const box = $("#healthCard");
  if (!dir) { box.classList.add("hidden"); return; }
  const useTg = truthy(state.values.useTextGrid);
  const res = await api("/api/healthcheck", {
    dir, ext,
    tgDir: useTg ? (state.values.tgDir || dir) : null,
    useTextGrid: useTg,
  });
  if (!res || !res.items) { box.classList.add("hidden"); return; }
  state.health = res;
  box.classList.remove("hidden");
  const actLabel = { transcode: "转换成 wav", tgmatch: "自动配对标注" };
  box.innerHTML = res.items.map(it => `
    <div class="health-item">
      <span class="health-dot ${it.level}"></span>
      <span class="health-msg">${esc(it.msg)}</span>
      ${it.action && it.action !== "none"
        ? `<button class="btn tiny health-act" data-act="${it.action}">${actLabel[it.action] || "处理"}</button>`
        : ""}
    </div>`).join("");
  $$("#healthCard .health-act").forEach(b => {
    b.onclick = () => { if (b.dataset.act === "transcode") doTranscode(); else doTgMatch(); };
  });
}

async function doTranscode() {
  const h = state.health;
  const dir = state.values.inputDir;
  if (!h || !h.items || !dir) return;
  const files = [];
  h.items.forEach(it => { if (it.action === "transcode" && it.data && it.data.files) files.push(...it.data.files); });
  if (!files.length) { toast("没有需要转换的文件", "error"); return; }
  const r = await api("/api/transcode", { dir, files, mono: true });
  if (!r.ok) { toast(r.error || "转码失败", "error"); return; }
  const okN = r.converted.filter(c => !c.error).length;
  const failN = (r.failed || []).length;
  toast(`已转换 ${okN} 个文件${failN ? "，" + failN + " 个失败" : ""}`, failN ? "error" : "ok");
  if (confirm(`已转成 wav，放在：\n${r.outDir}\n改用这个转换后的目录吗？`)) {
    $("#inputDir").value = r.outDir;
    await scanInput();
  }
}

// 预处理：带通 30–8000 Hz → 重采样 16 kHz → 存进 <当前目录>/Resample/。
// 跑完把工作目录切到 Resample（用户拍板「以后工作目录也默认在这个目录中」），所以不再弹
// 像 doTranscode 那样的 confirm；想回原目录自己改路径即可。
async function runPreprocess() {
  const dir = $("#inputDir").value.trim();
  if (!dir) { toast("请先在第一步选好声音目录", "error"); return; }
  const ext = state.values.soundExt || "wav";
  const btn = $("#btnPreprocess");
  if (btn) { btn.disabled = true; btn.textContent = "预处理中…"; }
  const msg = $("#step1Msg");
  msg.textContent = "正在预处理（带通 30–8000 Hz → 16 kHz），文件多时要等一会儿…";
  let r;
  try {
    r = await api("/api/preprocess", { dir, ext });
  } finally {
    const b = $("#btnPreprocess");
    if (b) { b.disabled = false; b.textContent = "预处理"; }
  }
  if (!r || !r.ok) {
    toast((r && r.error) || "预处理失败", "error");
    msg.textContent = (r && r.error) || "";
    return;
  }
  const okN = r.converted.length;
  const failN = r.failed.length;
  if (!okN) {
    toast("预处理失败：一个都没成功", "error");
    msg.textContent = failN ? `全部失败，例如 ${r.failed[0].source}：${r.failed[0].error}` : "没有可处理的文件";
    return;
  }
  $("#inputDir").value = r.outDir;
  state.values.inputDir = r.outDir;
  await scanInput(true);      // 重扫 Resample：这里全都是 16 kHz，采样率提示自然消失
  const from = (r.srcRates || []).join("/") || "?";
  let tail = `已预处理 ${okN} 个（${from} Hz → 16 kHz），工作目录已切到 Resample 目录`;
  if (failN) tail += `；${failN} 个失败：${r.failed.slice(0, 3).map(f => f.source).join("、")}${failN > 3 ? " …" : ""}`;
  if (r.tgInSource) tail += `。注意：原目录的 ${r.tgInSource} 个 TextGrid 没有复制过来，要用标注得手动搬或重新切分`;
  msg.textContent = tail;
  toast(failN ? `预处理完成：成功 ${okN}、失败 ${failN}` : `预处理完成：${okN} 个音频已重采样为 16 kHz`,
        failN ? "error" : "ok");
}

async function doTgMatch() {
  const dir = state.values.inputDir;
  const ext = state.values.soundExt || "wav";
  const tg = state.values.tgDir || dir;
  const r = await api("/api/tgmatch-proposal", { dir, ext, tgDir: tg });
  if (!r.ok) { toast(r.error || "配对失败", "error"); return; }
  state.tgProposal = r;
  const box = $("#tgMatchBox");
  box.classList.remove("hidden");
  const exact = (r.exact || []).map(p => `<div class="frow"><span class="badge">精确</span><span class="fname">${esc(p[0])}</span><span>↔</span><span class="fname">${esc(p[1])}</span></div>`).join("");
  const fuzzy = (r.fuzzy || []).map(p =>
    `<label class="frow tgrow"><input type="checkbox" data-w="${esc(p[0])}" data-t="${esc(p[1])}" checked>
      <span class="badge warn">模糊</span><span class="fname">${esc(p[0])}</span><span>↔</span><span class="fname">${esc(p[1])}</span></label>`).join("");
  const amb = (r.ambiguous || []).map(a =>
    `<div class="frow amb"><span class="badge bad">歧义</span><span class="fname">${esc(a.wav)}</span>
      <span>匹配到 ${a.candidates.length} 个标注，需手动确认</span></div>`).join("");
  box.innerHTML = `
    <div class="card-head"><h2>自动配对预览</h2></div>
    <p class="hint">精确 ${r.exact.length} 对 · 模糊 ${r.fuzzy.length} 对 · 未匹配 ${(r.unmatchedWav || []).length} 声音 / ${(r.unmatchedTg || []).length} 标注 · 歧义 ${r.ambiguous.length} 组</p>
    ${amb}${exact}${fuzzy}
    <div class="row" style="margin-top:10px">
      <button class="btn primary" id="btnTgApply">确认应用（${r.exact.length + r.fuzzy.length} 对）</button>
      <button class="btn ghost" id="btnTgCancel">关闭</button>
    </div>`;
  $("#btnTgApply").onclick = () => doTgMatchApply(dir, ext, tg);
  $("#btnTgCancel").onclick = () => box.classList.add("hidden");
}

async function doTgMatchApply(dir, ext, tg) {
  const r = state.tgProposal;
  if (!r) return;
  const pairs = [];
  (r.exact || []).forEach(p => pairs.push([p[0], p[1]]));
  $$("#tgMatchBox .tgrow input:checked").forEach(cb => pairs.push([cb.dataset.w, cb.dataset.t]));
  if (!pairs.length) { toast("没有可应用的配对", "error"); return; }
  const res = await api("/api/tgmatch-apply", { dir, ext, tgDir: tg, pairs });
  if (!res.ok) { toast(res.error || "应用失败", "error"); return; }
  toast(`已配对 ${res.pairs} 对（暂存目录）`, "ok");
  state.values.tgDir = res.tgDir;
  state.values.filelist = res.filelist;
  if (!truthy(state.values.useTextGrid)) {
    applyTgStrategy("existing");   // 切到「用现成 TextGrid」并展开目录/层数面板
  }
  $("#tgMatchBox").classList.add("hidden");
  await scanInput(true);
  // 卡要求：应用成功后 #tgSummary 显示「已配对 n 对（暂存目录）」
  const tgb = $("#tgSummary");
  if (tgb) {
    tgb.classList.remove("hidden");
    tgb.innerHTML = `<div class="kv"><span>TextGrid 配对</span><b>已配对 ${res.pairs} 对（暂存目录）</b></div>`;
  }
}

/* ---------------------------------------------------------------- 预检 / 批量 */

/* 提醒条目：能就地处理的（后端带 fix 线索）后面挂一个动作链接。
   链接文字要说清「点了会发生什么」，不要写笼统的「补一下」——
   用户 2026-10-18 反馈：TextGrid 那条写「补一下」却弹出文件夹选择器，完全对不上。 */
function warnHtml(w) {
  const acts = {
    "tg-make": ["自动制作 TextGrid", "tg-make"],
    "tg-match": ["自动配对标注", "tg-match"],
  };
  const a = w.fix && acts[w.fix]
    ? ` <a class="fixlink" data-fix="${esc(acts[w.fix][1])}" href="javascript:void(0)">${esc(acts[w.fix][0])} →</a>`
    : "";
  return `<div class="diag warn"><div><div class="dtitle">提醒</div>`
    + `<div class="dbody">${esc(w.msg)}${a}</div></div></div>`;
}

function wireWarnActions(root) {
  $$((root || "#precheck") + " [data-fix]").forEach(a => {
    a.onclick = () => {
      if (a.dataset.fix === "tg-make") openTgAssist();
      else if (a.dataset.fix === "tg-match") openTgMatch();
    };
  });
}

/* TextGrid 助手：「自动制作 TextGrid」这条动作的唯一入口。
   用户 2026-10-18 反馈：这里原来写「补一下」，点了却弹文件夹选择器——选个目录解决不了
   「一个标注都没有」。所以这里就地给三件事：说清现状 → 可选自动切分（不覆盖已有标注）
   → 打开九宫格检视，全程不回第一步。 */
async function openTgAssist(onDone) {
  const after = typeof onDone === "function" ? onDone : runPrecheck;
  const dir = (state.values.inputDir || "").trim();
  if (!dir) { toast("请先在第一步选好声音目录", "error"); return; }
  const total = (state.files || []).length;
  let rep = null;
  try {
    rep = await api("/api/textgrid", { wavFiles: state.files || [], tgDir: state.values.tgDir || dir });
  } catch (e) { rep = null; }
  const have = rep && rep.ok ? rep.count : 0;
  const matched = rep && rep.ok ? rep.matched : 0;
  const extra = have > matched ? have - matched : 0;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = '<div class="modal"><div class="modal-head"><h3>'
    + (have ? "TextGrid 还差 " + (total - matched) + " 个文件" : "这批文件还没有 TextGrid")
    + '</h3><button class="icon-btn" id="taClose">✕</button></div>'
    + '<div class="modal-body" id="taBody">'
    + '<p>共 <b>' + total + "</b> 个声音文件，其中 <b>" + matched + "</b> 个有同名 TextGrid"
    + (extra ? "（标注目录里另有 " + extra + " 个名字对不上的）" : "") + "。</p>"
    + '<p class="muted small">TextGrid 不是必需的：<b>有同名标注的文件只测标注段，没有的测整段</b>，'
    + "数量对不上不影响出结果。</p>"
    + "<p>自动切分会按能量与静音给每个文件分出音节段；<b>已有 TextGrid 的文件只读取、不覆盖</b>，"
    + "所以手工精修过的标注不会丢。生成后打开九宫格，可以逐格在波形上改边界。</p>"
    + "</div>"
    + '<div class="modal-foot">'
    + '<button class="btn ghost" id="taSkip">先不管，按整段测</button>'
    + '<button class="btn primary" id="taGo">自动切分补齐</button>'
    + "</div></div>";
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.querySelector("#taClose").onclick = close;
  backdrop.addEventListener("click", e => { if (e.target === backdrop) close(); });
  backdrop.querySelector("#taSkip").onclick = () => { close(); after(); };
  backdrop.querySelector("#taGo").onclick = async () => {
    const body = backdrop.querySelector("#taBody");
    const go = backdrop.querySelector("#taGo");
    const skip = backdrop.querySelector("#taSkip");
    go.disabled = true; skip.disabled = true;
    body.innerHTML = '<p id="taProg">正在为整个目录切分并写出 TextGrid（共 ' + total
      + " 个文件，文件多时请稍候）…</p>";
    // 参数取第一步「自动制作」那三个滑块（默认 100ms / 100ms / -25dB）；控件不在时用默认值
    const _val = (sel, dv) => { const el = $(sel); return el ? el.value : dv; };
    const minSil = (parseInt(_val("#tgMinSil", 100), 10) || 100) / 1000;
    const minSyl = (parseInt(_val("#tgMinSyl", 100), 10) || 100) / 1000;
    const thresh = parseFloat(_val("#tgThresh", -25)) || -25;
    const ext = state.values.soundExt || "wav";
    try {
      // scope:"all" = 整个目录（含子目录）一次做完；force 不传（=0）→ 已有的只读取不覆盖。
      // 「自动制作」按钮走的是 force=1 覆盖式全量重做，和这里的安全语义不同，别混用。
      const r = await api("/api/syllables/grid", {
        dir, page: 0, size: 9, minSilence: minSil, minSyllable: minSyl,
        thresholdDb: thresh, ext, scope: "all",
      });
      if (!r.ok) { body.innerHTML = '<p style="color:var(--err)">' + esc(r.error || "自动切分失败") + "</p>"; go.disabled = false; skip.disabled = false; return; }
      // 写回主流程：标注就放在 wav 同目录，层名默认第 1 层。
      // applyTgStrategy("existing") 会同步 state/勾选框，并触发 checkTextGrids 刷新第一步摘要。
      state.values.tgDir = dir;
      state.values.intervalTier = 1;
      const _td = $("#tgDir"); if (_td) _td.value = dir;
      const _it = $("#intervalTier"); if (_it) _it.value = 1;
      applyTgStrategy("existing");
      close();
      // 九宫格关掉后再刷预检：这时 TextGrid 已经存在，提醒自然消失
      document.addEventListener("ps:tg-grid-closed", function once() {
        document.removeEventListener("ps:tg-grid-closed", once);
        after();
      });
      window.syllableSegmentParams = { dir, minSilence: minSil, minSyllable: minSyl, thresholdDb: thresh, ext };
      if (typeof window.openSyllableGrid === "function") window.openSyllableGrid(r);
      toast("已生成 " + (r.scanned != null ? r.scanned : total) + " 个文件的 TextGrid（新写出 "
        + (r.written != null ? r.written : 0) + " 个）", "ok");
    } catch (e) {
      body.innerHTML = '<p style="color:var(--err)">' + esc(String(e && e.message || e)) + "</p>";
      go.disabled = false; skip.disabled = false;
    }
  };
}

/* 文件名对不上时，就地跳到第一步的「自动配对」面板（配对是第一步的活，硬留在第四步
   反而做不了）。只切步骤，不重开选择器。 */
function openTgMatch() {
  if (!truthy(state.values.useTextGrid)) applyTgStrategy("existing");
  setStep(1);
  setTimeout(() => {
    const box = $("#tgMatchBox");
    if (box) box.scrollIntoView({ block: "center", behavior: "smooth" });
    doTgMatch();
  }, 90);
  toast("已切到第一步：下面会列出能自动配上的标注", "ok");
}

async function runPrecheck() {
  const box = $("#precheck");
  box.innerHTML = `<p class="muted">检查中…</p>`;
  // 顶部先放体检摘要（只读复用第一步逻辑，提示回第一步处理）
  let head = "";
  const h = await api("/api/healthcheck", {
    dir: state.values.inputDir,
    ext: state.values.soundExt || "wav",
    tgDir: truthy(state.values.useTextGrid) ? (state.values.tgDir || state.values.inputDir) : null,
    useTextGrid: truthy(state.values.useTextGrid),
  });
  if (h && h.items) {
    // TextGrid 的数量/名字对不上已由 validate 的提醒接管（带「自动制作」动作），
    // 这里再报一遍就是同一件事说两遍，反而让人以为有两处问题。
    const dupTg = { TG_COUNT: 1, TG_NAME: 1 };
    const probs = h.items.filter(i => i.level !== "ok" && !dupTg[i.code]);
    if (probs.length) {
      head = `<div class="diag warn"><div>
        <div class="dtitle">体检提示（可在第一步处理）</div>
        <div class="dbody">${probs.map(i => esc(i.msg)).join("；")}</div>
        </div></div>`;
    }
  }
  const res = await api("/api/validate", { values: state.values });
  if (res.errors && res.errors.length) {
    box.innerHTML = head + res.errors.map(e => `
      <div class="diag error">
        <svg class="dicon" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M15 9l-6 6m0-6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <div><div class="dtitle">${esc(e.msg)}</div>
        <div class="dsug">不用回去，<a class="fixlink" data-field="${esc(e.field)}" href="javascript:void(0)">在这里补一下 →</a></div></div>
      </div>`).join("") + (res.warnings || []).map(warnHtml).join("");
    $$("#precheck .fixlink[data-field]").forEach(a => a.onclick = () => quickFix(a.dataset.field));
    wireWarnActions();
    syncRunButtons(true);
    $("#step3Msg").textContent = "有 " + res.errors.length + " 个问题要先解决";
  } else {
    const warns = (res.warnings || []).length
      ? res.warnings.map(warnHtml).join("")
      : "";
    box.innerHTML = head + `<div class="diag ok">
      <svg class="dicon" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="m8 12 3 3 5-6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      <div><div class="dtitle">检查通过</div><div class="dbody">参数没问题，可以开始批量处理了。</div></div>
      </div>` + warns;
    wireWarnActions();
    syncRunButtons(false);
    $("#step3Msg").textContent = "";
  }
}

/* 预检/试跑报错的「临时链接」：原地弹出补填，不切回前面的面板 */
function quickFix(field, onDone) {
  // onDone：补完后要做的事。默认刷新第 4 步预检；第 3 步试跑会传入自己的「可再跑一次」提示。
  const after = typeof onDone === "function" ? onDone : runPrecheck;
  const folderFields = { inputDir: "#inputDir", outputDir: "#outputDir", tgDir: "#tgDir" };
  if (Object.prototype.hasOwnProperty.call(folderFields, field)) {
    const inpId = folderFields[field];
    openPicker(state.values[field] || "", p => {
      state.values[field] = p;
      const inp = $(inpId); if (inp) inp.value = p;
      if (field === "inputDir") scanInput();
      after();
      toast("已更新「" + field + "」", "ok");
    });
    return;
  }
  if (field === "praatExe") {
    openSettings();
    toast("请在设置里补全 Praat 程序", "error");
    return;
  }
  // 具体参数（数值/下拉/文本等）：只要在参数表里，就地弹编辑器改，不回第二步。
  // 不再维护手工白名单——白名单漏一个 field，链接就会"点了毫无反应"。
  const known = (state.boot.params || []).some(p => p.name === field && !p.internal);
  if (known) { openParamFix(field, onDone); return; }
  if (field === "measures") { openMeasuresFix(onDone); return; }
  // 兜底：不认识的字段也绝不能静默无反应——跳到第二步参数面板并说明
  toast("请回到第二步参数面板修改（" + field + "）", "warn");
  setStep(2);
}

/* measures 缺省时，原地弹一个勾选框，不用回第二步 */
function openMeasuresFix(onDone) {
  const after = typeof onDone === "function" ? onDone : runPrecheck;
  const names = ["pitch", "formant1", "formant2", "formant3", "formant4", "formant5",
    "ha_h1c", "ha_h2c", "ha_h4c", "ha_a1c", "ha_a2c", "ha_a3c",
    "hau_h1u", "hau_h2u", "hau_h4u", "hau_a1u", "hau_a2u", "hau_a3u", "hau_h2ku", "hau_h5ku",
    "sl_h1h2c", "sl_h2h4c", "sl_h1a1c", "sl_h1a2c", "sl_h1a3c", "sl_h42ku",
    "slu_h1h2u", "slu_h2h4u", "slu_h1a1u", "slu_h1a2u", "slu_h1a3u", "slu_h2kh5ku",
    "bw1", "bw2", "bw3", "cpp",
    "hnr_05", "hnr_15", "hnr_25", "hnr_35", "hnr_38",
    "intensity", "soe", "shr", "cpps"];
  const labels = {};
  state.boot.params.forEach(p => { labels[p.name] = p.label || p.name; });
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = '<div class="modal"><div class="modal-head"><h3>勾选要测量的参数</h3>'
    + '<button class="icon-btn" id="mfClose">✕</button></div>'
    + '<div class="modal-body"><div class="speaker-grid">' + names.map(n => {
        const on = truthy(state.values[n]);
        return '<button class="chip ' + (on ? "active" : "") + '" data-m="' + n + '">' + esc(labels[n] || n) + "</button>";
      }).join("") + "</div></div>"
    + '<div class="modal-foot"><button class="btn primary" id="mfOk">完成，重新检查</button></div></div>';
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.querySelector("#mfClose").onclick = close;
  backdrop.addEventListener("click", e => { if (e.target === backdrop) close(); });
  backdrop.querySelectorAll("[data-m]").forEach(b => b.onclick = () => {
    const n = b.dataset.m;
    state.values[n] = truthy(state.values[n]) ? 0 : 1;
    b.classList.toggle("active", truthy(state.values[n]));
  });
  backdrop.querySelector("#mfOk").onclick = () => { close(); after(); };
}

/* 单个参数报错的「在这里补一下」：原地弹极简编辑器，不切回前面的面板。
   field 是后端报错参数名；interval（二选一）/ f0 上下限这类成对的，一起列出来改。
   复用 paramControl 渲染控件，改动即时写回 state.values，关掉后再刷新一遍预检。 */
function openParamFix(field, onDone) {
  const after = typeof onDone === "function" ? onDone : runPrecheck;
  // 哪些参数要一起改：interval 二选一错误须连方式一起看；f0 上下限一起看
  const group = {
    intervalFixed: ["intervalMode", "intervalFixed", "intervalEquidistant"],
    intervalEquidistant: ["intervalMode", "intervalFixed", "intervalEquidistant"],
    f0min: ["f0min", "f0max"],
    f0max: ["f0min", "f0max"],
  };
  const names = group[field] || [field];
  const byName = {};
  state.boot.params.forEach(p => { byName[p.name] = p; });
  const fields = names.map(n => byName[n]).filter(Boolean);
  if (!fields.length) { toast("该参数无法在此直接修改，请回前面的步骤检查", "warn"); return; }

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = '<div class="modal"><div class="modal-head"><h3>补一下：'
    + esc(fields.map(p => p.label).join(" / "))
    + '</h3><button class="icon-btn" id="pfClose">✕</button></div>'
    + '<div class="modal-body" id="pfBody"></div>'
    + '<div class="modal-foot"><button class="btn primary" id="pfOk">完成，重新检查</button></div></div>';
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.querySelector("#pfClose").onclick = close;
  backdrop.addEventListener("click", e => { if (e.target === backdrop) close(); });
  const pfBody = backdrop.querySelector("#pfBody");
  fields.forEach(p => pfBody.appendChild(paramControl(p, true)));
  backdrop.querySelector("#pfOk").onclick = () => { close(); after(); };
}

// 第三步有两枚「开始批量处理」（顶部 + 底部），统一同步禁用/启用状态。
function syncRunButtons(disabled) {
  const b1 = $("#btnRun"), b2 = $("#btnRunTop");
  if (b1) b1.disabled = disabled;
  if (b2) b2.disabled = disabled;
}

/* TextGrid 配对确认弹窗：返回 "whole"（没配上的整段测）| "matched"（只测配对的）| "cancel" */
function askTgConfirm(rep, total) {
  return new Promise((resolve) => {
    const missing = rep.missing || [];
    const shown = missing.slice(0, 10);
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = '<div class="modal"><div class="modal-head"><h3>有 ' + missing.length
      + " 个文件没配到 TextGrid</h3></div>"
      + '<div class="modal-body"><p>共 ' + total + " 个文件，其中 <b>" + rep.matched
      + "</b> 个有同名 TextGrid、<b class=\"bad\">" + missing.length + "</b> 个没有：</p>"
      + '<p class="muted small">' + esc(shown.join("、")) + (missing.length > shown.length ? " …" : "") + "</p>"
      + "<p>没配上的文件怎么处理？</p></div>"
      + '<div class="modal-foot">'
      + '<button class="btn ghost" id="tgCancel">取消，先去补标注</button>'
      + '<button class="btn" id="tgMatched">只测配对的 ' + rep.matched + " 个</button>"
      + '<button class="btn primary" id="tgWhole">没配上的整段测</button>'
      + "</div></div>";
    document.body.appendChild(backdrop);
    const done = (v) => { backdrop.remove(); resolve(v); };
    backdrop.querySelector("#tgCancel").onclick = () => done("cancel");
    backdrop.querySelector("#tgMatched").onclick = () => done("matched");
    backdrop.querySelector("#tgWhole").onclick = () => done("whole");
  });
}

async function startRun() {
  // 先决定这次要不要重算 F0/共振峰（已审核 → 读审查导出的对象；没审核 → 先问一句）。
  // 放在 validate 之前：用户若选了「先去审核」就直接返回，什么都不用做。
  const decision = await decideReviewForRun();
  if (!decision.proceed) return;

  const chk = await api("/api/validate", { values: decision.values });
  if (chk.errors && chk.errors.length) {
    toast("还有 " + chk.errors.length + " 个问题没解决", "error");
    runPrecheck();
    return;
  }

  // TextGrid 配对闸（2026-09-29）：开了 TextGrid 但有文件没配到同名标注时，
  // 先列出缺谁，三选一：未配对的整段测 / 只测配对的 / 取消去补标注。
  // 选「整段测」时靠 Praat 侧逐文件回退（get_times.praat），不再整体报错。
  let runFiles = state.selectedFiles && state.selectedFiles.size
    ? Array.from(state.selectedFiles) : undefined;
  let tgNote = "";
  if (truthy(decision.values.useTextGrid)) {
    const files = runFiles || state.files || [];
    const rep = await api("/api/textgrid", {
      wavFiles: files, tgDir: decision.values.tgDir || decision.values.inputDir,
    });
    if (rep.ok && files.length && rep.matched < files.length) {
      if (!rep.count) {
        // 目录里一个 TextGrid 都没有：这时弹窗里没有真正的选择（「只测配对的」＝一个都不测），
        // 再拦一道只是白点一下。直接按整段测，并在日志里留一句说明。
        // 名字对不上（rep.count > 0 但 matched 少）仍要弹，那种情况确实有得选。
        tgNote = "目录里没有 TextGrid，本批按整段测量（每个文件全时长）。";
      } else {
        const choice = await askTgConfirm(rep, files.length);
        if (choice === "cancel") return;
        if (choice === "matched") {
          const paired = new Set(rep.paired || []);
          runFiles = files.filter(f => paired.has(String(f).replace(/\.[^.]+$/, "")));
          if (!runFiles.length) { toast("没有配对上的文件可测", "error"); return; }
        }
      }
    }
  }

  syncRunButtons(true);
  $("#btnCancel").disabled = false;
  $("#progressWrap").classList.remove("hidden");
  $("#logBox").classList.remove("hidden");
  $("#logBox").innerHTML = "";
  const _cl = $("#btnCopyLog");
  if (_cl) _cl.classList.add("hidden");   // 新一轮开始，先藏起「复制日志」，有内容再出现
  $("#resultCard").classList.add("hidden");
  $("#runMeta").textContent = "开始处理…";
  if (decision.note) appendLog(decision.note);
  if (tgNote) appendLog(tgNote);

  const res = await api("/api/run", {
    values: decision.values,
    files: runFiles,
  });
  if (!res.ok) {
    toast(res.error, "error");
    // 批量启动失败同样给出「就地补」链接，不用回退；runMeta 文字可选中复制
    if (res.errors && res.errors.length) {
      renderFixableErrors($("#runMeta"), res, () => { runPrecheck(); });
    } else {
      $("#runMeta").textContent = res.error;
    }
    syncRunButtons(false);
    $("#btnCancel").disabled = true;
    return;
  }
  state.runJobId = res.jobId;
  pollJob(res.jobId, {
    onLog: appendLog,
    onProgress: (job) => {
      const pr = job.progress;
      const pct = pr.total ? Math.min(100, Math.round(pr.done / pr.total * 100)) : 0;
      $("#progressBar").style.width = pct + "%";
      $("#progressText").textContent = `${pr.done} / ${pr.total} 个文件`
        + (pr.done >= pr.total ? " · 正在汇总写出结果…"
          : pr.current ? ` · 正在处理 ${pr.current}` : "");
      $("#runMeta").textContent = `已用 ${job.elapsed} 秒`;
    },
    onDone: async (job) => {
      syncRunButtons(false);
      $("#btnCancel").disabled = true;
      if (job.status === "error") {
        let html = `<span style="color:var(--err)">${esc(job.error || "运行失败")}</span>`;
        html += ` <button class="btn tiny ghost" id="btnCopyErr">复制报错</button>`;
        if (job.errorFile) {
          html += ` <button class="btn tiny ghost" id="btnOpenErr">打开日志文件</button>`;
          html += ` <span class="muted small">${esc(job.errorFile)}</span>`;
        }
        $("#runMeta").innerHTML = html;
        const copyBtn = $("#btnCopyErr");
        if (copyBtn) copyBtn.onclick = () => {
          const txt = (job.error || "").trim()
            || (($("#logBox") && $("#logBox").textContent) || "").trim();
          if (!txt) { toast("没有可复制的报错内容", "warn"); return; }
          copyText(txt, job.error ? "已复制报错" : "已复制日志");
        };
        const openBtn = $("#btnOpenErr");
        if (openBtn) openBtn.onclick = () => api("/api/open", { path: job.errorFile });
        return;
      }
      if (job.status === "cancelled") {
        $("#runMeta").textContent = "已取消";
        return;
      }
      $("#runMeta").innerHTML = `<span style="color:var(--ok)">完成！用时 ${job.elapsed} 秒</span>`;
      const r = await api("/api/result?path=" + encodeURIComponent(job.resultPath));
      state.result = r;
      $("#resultCard").classList.remove("hidden");
      renderStats("#resultSummary", r);
      renderDiag("#resultDiag", r.diagnostics);
      // 逐行结果表已按用户要求去掉（2026-09-26）：只留统计概览 / 体检 / 问题文件
      if (r.perFile && r.perFile.length) renderProblemFiles(r.perFile);
      toast("处理完成，结果已保存", "ok");
    },
  });
}

function copyText(text, okMsg) {
  const done = () => toast(okMsg || "已复制，可直接粘贴", "ok");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, okMsg));
  } else {
    fallbackCopy(text, okMsg);
  }
}

function fallbackCopy(text, okMsg) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    toast(okMsg || "已复制，可直接粘贴", "ok");
  } catch (e) {
    toast("复制失败，请手动选中文本后 Ctrl+C", "error");
  }
}

/* ---------------------------------------------------------------- 提示 / 报错复制
   2026-10-18 用户要求：界面上所有提示信息与报错信息都要能整段复制，
   不必用鼠标一点一点拖选。做法是给每张 .diag 卡片自动挂一个「复制」按钮，
   点击时按 DOM 拼出「级别 + 标题 + 正文 + 建议」的纯文本。
   卡片由各处 innerHTML 动态生成，所以用 MutationObserver 自动补按钮，
   新增的诊断卡（预检 / 试跑 / 批量结果 / 九宫格）无需逐个改渲染代码。 */

function diagLevelName(el) {
  if (el.classList.contains("error")) return "错误";
  if (el.classList.contains("warn")) return "提醒";
  if (el.classList.contains("ok")) return "通过";
  return "提示";
}

function diagPlainText(el) {
  // 复制前先克隆：按钮和「在这里补一下 →」这类界面动作不属于提示内容，
  // 贴给别人看只会造成困惑（用户 2026-10-18：复制出来带一串 "不用回去，"）。
  const clone = el.cloneNode(true);
  clone.querySelectorAll(".diag-copy, .fixlink, button, a").forEach(n => n.remove());
  const q = sel => {
    const n = clone.querySelector(sel);
    return n ? n.textContent.replace(/\s+/g, " ").trim() : "";
  };
  const out = [`【${diagLevelName(el)}】${q(".dtitle") || "提示"}`];
  const body = q(".dbody");
  if (body) out.push(body);
  let sug = q(".dsug").replace(/^💡\s*/, "");
  sug = sug.replace(/不用回去[，,]\s*/g, "").replace(/[，,、；;：:\-—\s]+$/, "").trim();
  if (sug) out.push("建议：" + sug);
  return out.join("\n");
}

/** 某个容器里所有诊断卡片的纯文本（用于「复制全部提示」）。 */
function diagListText(sel, header) {
  const els = $$(sel + " .diag");
  if (!els.length) return "";
  return (header ? header + "\n\n" : "") + els.map(diagPlainText).join("\n\n");
}

function enhanceDiagCopy(root) {
  const r = (root && root.querySelectorAll) ? root : document;
  $$(".diag:not([data-copy-ready])", r).forEach(el => {
    el.dataset.copyReady = "1";
    const b = document.createElement("button");
    b.type = "button";
    b.className = "diag-copy";
    b.textContent = "复制";
    b.title = "复制这条提示的完整文字";
    el.appendChild(b);
  });
}

/** 单条复制（事件委托，卡片重建后依然有效）。 */
document.addEventListener("click", e => {
  const b = e.target.closest && e.target.closest(".diag-copy");
  if (!b) return;
  const card = b.closest(".diag");
  if (card) copyText(diagPlainText(card), "已复制这条提示");
});

// 新卡片一出现就补上复制按钮；顺带处理首次加载已有的卡片。
document.addEventListener("DOMContentLoaded", () => {
  enhanceDiagCopy(document);
  const mo = new MutationObserver(muts => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1) enhanceDiagCopy(n.parentNode || document);
      }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
});

function appendLog(line, tag) {
  const box = $("#logBox");
  const d = document.createElement("div");
  d.className = tag === "err" ? "l-err" : (line.startsWith("$") ? "l-sys" : "");
  d.textContent = line;
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
  const cb = $("#btnCopyLog");
  if (cb) cb.classList.remove("hidden");
}

function renderProblemFiles(perFile) {
  // 判据与后端诊断保持一致（<35%）。旧的 50% 会把「静音多但浊音段很干净」的
  // 正常文件也列出来，用户会以为审核过的数据又出了问题。
  const bad = perFile.filter(p => p.f0Ratio !== null && p.f0Ratio < 0.35).slice(0, 12);
  const old = $("#problemFiles");
  if (old) old.remove();
  if (!bad.length) return;
  const box = document.createElement("div");
  box.id = "problemFiles";
  box.innerHTML = `<div class="card-head" style="margin-top:18px"><h2>需要注意的样本</h2></div>
    <div class="file-list">${bad.map(p => `
      <div class="frow">
        <span class="fname">${esc(p.file)}</span>
        <span>${p.frames} 帧</span>
        <span class="badge ${p.f0Ratio < 0.3 ? "bad" : "warn"}">基频检出 ${(p.f0Ratio * 100).toFixed(0)}%</span>
        <span></span>
      </div>`).join("")}</div>`;
  $("#resultCard").appendChild(box);
}

/* ---------------------------------------------------------------- 任务轮询 */

function pollJob(id, handlers) {
  let offset = 0;
  if (state.polling) clearInterval(state.polling);
  state.polling = setInterval(async () => {
    let job;
    try {
      job = await api(`/api/job/${id}?offset=${offset}`);
    } catch (e) { return; }
    if (!job || !job.ok) return;
    offset = job.logOffset || offset;
    (job.log || []).forEach(l => handlers.onLog && handlers.onLog(l.text, l.tag));
    if (handlers.onProgress) handlers.onProgress(job);
    if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
      clearInterval(state.polling);
      state.polling = null;
      handlers.onDone && handlers.onDone(job);
    }
  }, 500);
}

/* ---------------------------------------------------------------- 文件夹选择器
   统一选择器见 ui/picker.js（主程序向导与 VoiceSauce 共用，自包含 DOM+样式，
   含面包屑正确路径 / 加载反馈 / 防重入 / 滚动归顶 / Esc·Enter / 新建文件夹）。
   这里只保留一个转发函数，历史调用方（含 review-grid-ui.js）无需改动。 */

function openPicker(startPath, cb, opts) {
  if (window.openFolderPicker) window.openFolderPicker(startPath, cb, opts);
}

/* ---------------------------------------------------------------- 设置 */

function openSettings() {
  const s = state.boot.settings;
  $("#setPraatExe").value = s.praatExe || "";
  renderSelfCheck(state.boot.env && state.boot.env.selfCheck);
  $("#setTier").value = (s.tier === "expert" ? "advanced" : (s.tier || "novice"));
  refreshParamsText();
  $("#settingsModal").classList.remove("hidden");
}

function refreshParamsText() {
  const lines = ["variable,input,comment"];
  state.boot.params.forEach(p => {
    lines.push(`${p.name},${csvCell(state.values[p.name])},${csvCell(p.help || "")}`);
  });
  $("#paramsRaw").value = lines.join("\n");
}

function csvCell(v) {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// 「恢复默认」：把 Praat 路径 / 脚本目录一键重置回程序自身目录（相对默认，
// 由后端 settings.path_defaults() 计算，绝不写死机器绝对路径）。立即写盘生效，
// 不用再点「保存设置」。which = "praatExe" | "scriptDir" | "both"。
async function resetPath(which, inputId) {
  const r = await api("/api/reset-paths", { which });
  if (!r.ok) { toast("恢复默认失败", "error"); return; }
  state.boot.settings = r.settings;
  const inp = $(inputId);
  if (inp) inp.value = r.settings.praatExe || "";
  if (r.env) { Object.assign(state.boot.env, r.env); renderEnv(); }
  toast("已恢复默认：Praat 路径", "ok");
}

// ---- 运行状态自检 ----------------------------------------------------------
// 脚本目录已由程序结构决定、不再让用户配置；这里把「Praat 是否真的能执行」
// 「Praat 脚本是否齐全/版本是否匹配」「界面资源是否到位」一次查清，
// 出问题时用户可直接把结论或日志回传。
function renderSelfCheck(data) {
  const box = $("#selfCheckList");
  if (!box) return;
  if (!data || !data.items) { box.innerHTML = ""; return; }
  const rows = data.items.map(it =>
    '<div style="display:flex;gap:8px;margin:2px 0">' +
    '<span style="color:' + (it.ok ? "#15803d" : "#b91c1c") + '">' + (it.ok ? "✓" : "✗") + '</span>' +
    '<span><b>' + esc(it.name) + '</b>：' + esc(it.detail) + '</span></div>').join("");
  const head = data.ok
    ? '<p class="hint" style="color:#15803d">自检通过</p>'
    : '<p class="hint" style="color:#b91c1c">存在问题，见下面 ✗ 项</p>';
  const log = data.logPath ? '<p class="hint">日志：' + esc(data.logPath) + '</p>' : "";
  box.innerHTML = head + rows + log;
}

async function runSelfCheck() {
  const box = $("#selfCheckList");
  if (box) box.innerHTML = '<p class="hint">自检中…</p>';
  try {
    const r = await fetch("/api/selfcheck").then(x => x.json());
    renderSelfCheck(r);
    if (!r.ok) toast("自检发现问题，请查看下面的 ✗ 项", "error");
    else toast("自检通过", "ok");
  } catch (e) {
    if (box) box.innerHTML = '<p class="hint">自检请求失败</p>';
    toast("自检请求失败", "error");
  }
}

async function importParams() {
  const text = $("#paramsRaw").value;
  if (!text.trim()) { toast("文本框是空的", "error"); return; }
  const res = await api("/api/import-params", { text });
  if (!res.ok) {
    toast(res.error || "导入失败", "error");
    return;
  }
  Object.assign(state.values, res.values);
  renderParams();
  renderMeasurePicker();
  const msgs = (res.warnings || []).map(w => w.msg).filter(Boolean);
  if (msgs.length) {
    toast("已导入；提示：" + msgs.join("；"), "error");
  } else {
    toast("已导入参数", "ok");
  }
}

/* ---------------------------------------------------------------- 事件绑定 */

function bind() {
  // 步骤跳转（末位的「关于本软件」是普通 li，没有 data-step，不能当步骤点）
  $$("#steps li").forEach(li => {
    if (li.dataset.step) li.onclick = () => setStep(+li.dataset.step);
  });
  $$("[data-goto]").forEach(b => b.onclick = () => {
    const n = +b.dataset.goto;
    if (n === 2 && !state.files.length) {
      $("#step1Msg").textContent = "先在第一步选择文件夹";
      scanInput();
      return;
    }
    if (n === 3) runPrecheck();
    setStep(n);
  });

  // 输入目录
  $("#dropInput").onclick = () => openPicker($("#inputDir").value || state.boot.settings.lastInputDir, p => {
    $("#inputDir").value = p;
    scanInput();
  });
  $("#inputDir").onchange = () => scanInput();
  $("#soundExt").onchange = () => scanInput();
  // 「预处理」按钮在 #inputSummary 里，而那段 HTML 每次扫描都被重写 → 用事件委托，
  // 否则每次都得重新绑定（漏一次按钮就点不动了）。
  $("#inputSummary").addEventListener("click", e => {
    if (e.target && e.target.id === "btnPreprocess") runPreprocess();
  });

  $("#dropInput").addEventListener("dragover", e => { e.preventDefault(); $("#dropInput").classList.add("over"); });
  $("#dropInput").addEventListener("dragleave", () => $("#dropInput").classList.remove("over"));
  $("#dropInput").addEventListener("drop", e => {
    e.preventDefault();
    $("#dropInput").classList.remove("over");
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && f.path) { $("#inputDir").value = f.path; scanInput(); }
    else toast("请把整个文件夹拖进来（浏览器安全限制，无法读取完整路径时可手动粘贴路径）");
  });

  $("#outputDir").onchange = () => {
    state.values.outputDir = $("#outputDir").value.trim();
    api("/api/settings", { settings: { lastOutputDir: state.values.outputDir } });
  };
  $("#outputFile").onchange = () => { state.values.outputFile = $("#outputFile").value.trim() || "out.tsv"; };

  $$("[data-pick]").forEach(b => b.onclick = () => {
    const id = b.dataset.pick;
    openPicker($( "#" + id).value, p => { $("#" + id).value = p; $("#" + id).dispatchEvent(new Event("change")); });
  });

  // TextGrid 策略（三选一：不限制 / 用现成 / 自动制作）
  $$('input[name="tgStrategy"]').forEach((r) => {
    r.onchange = (e) => { if (e.target.checked) applyTgStrategy(e.target.value); };
  });
  $("#useTextGrid").onchange = (e) => {
    state.values.useTextGrid = e.target.checked ? 1 : 0;
    renderMeasurePicker();
  };
  $("#tgDir").onchange = () => checkTextGrids();
  $("#intervalTier").onchange = (e) => { state.values.intervalTier = parseInt(e.target.value, 10) || 1; };
  // 自动制作：难度 + 灵敏度滑块 + 触发
  $$("#tgAutoLevel .seg-btn").forEach((b) => {
    b.onclick = () => {
      state.values.tgAutoLevel = b.dataset.level;
      $$("#tgAutoLevel .seg-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      $("#tgAutoSliders").classList.toggle("hidden", b.dataset.level === "novice");
    };
  });
  $("#tgMinSil").oninput = (e) => { $("#tgMinSilVal").textContent = e.target.value + " ms"; };
  $("#tgMinSyl").oninput = (e) => { $("#tgMinSylVal").textContent = e.target.value + " ms"; };
  $("#tgThresh").oninput = (e) => { $("#tgThreshVal").textContent = e.target.value + " dB"; };
  $("#btnAutoSegment").onclick = autoSegment;
  $("#btnViewTgGrid").onclick = viewExistingTgGrid;

  // TextGrid 默认「利用 Textgrid」（HTML 里该 radio 已 checked）：初始化状态、展开字段、按当前目录检查标注
  applyTgStrategy("existing");

  // 试跑
  $("#btnPreview").onclick = startPreview;
  // 第三步独立挑选测试音频（任意文件，不必先选文件夹）
  $("#btnPickAudio").onclick = () => openPicker(
    state.boot.settings.lastInputDir || "",
    p => { state.previewAudio = p; $("#previewAudioPath").value = p; },
    { mode: "file", ext: "wav", title: "选择测试音频", confirmLabel: "选择此文件" }
  );
  $("#btnClearAudio").onclick = () => { state.previewAudio = ""; $("#previewAudioPath").value = ""; };

  // 路线 B 提示横幅（「先审 F0 / 共振峰」入口在第三步；第二步的发声态弹窗已移除）
  $$(".btnVoiceContinue").forEach(b => b.onclick = continueVoiceRest);

  // 批量
  const rvBox = $("#roundValues");
  if (rvBox) {
    // 默认开：新会话 state.values 里没有这个键时也按开启处理
    rvBox.checked = truthy(state.values.roundValues === undefined ? 1 : state.values.roundValues);
    rvBox.onchange = () => { state.values.roundValues = rvBox.checked ? 1 : 0; };
    state.values.roundValues = rvBox.checked ? 1 : 0;
  }
  $("#btnRun").onclick = startRun;
  $("#btnRunTop").onclick = startRun;   // 第三步顶部的「开始批量处理」，与底部同一处理函数
  // 第三步「测量路线」框：任意位置点击都进审核九宫格（里面的按钮本身已绑定 openGrid，
  // 点按钮时让它自己处理、避免重复开九宫格）。
  const routeBox = $("#routeSwitch");
  if (routeBox) {
    routeBox.onclick = function (e) {
      if (e.target.closest("button")) return;   // 按钮有自己的 openGrid 绑定
      if (window.openGrid) window.openGrid();
    };
    routeBox.style.cursor = "pointer";
  }
  $("#btnRecheck").onclick = runPrecheck;

  // 「复制检查结果 / 复制全部提示 / 复制日志」：把所有提示与报错整段捞成纯文本，
  // 方便用户直接贴到聊天里说明问题（2026-10-18 要求）。
  const _btnPre = $("#btnCopyPrecheck");
  if (_btnPre) _btnPre.onclick = () => {
    const txt = diagListText("#precheck", "PraatSauce 助手 · 运行前检查：" + (state.values.inputDir || "（未选目录）"));
    if (!txt) { toast("当前没有检查结果可复制", "warn"); return; }
    copyText(txt, "已复制检查结果");
  };
  const _btnDiag = $("#btnCopyDiag");
  if (_btnDiag) _btnDiag.onclick = () => {
    const r = state.result || {};
    const head = `PraatSauce 助手 · 批量结果提示\n结果文件：${r.path || "—"}\n文件数：${r.fileCount || 0}　帧数：${r.rowCount || 0}`;
    const txt = diagListText("#resultDiag", head);
    if (!txt) { toast("当前没有结果提示可复制", "warn"); return; }
    copyText(txt, "已复制全部提示");
  };
  const _btnLog = $("#btnCopyLog");
  if (_btnLog) _btnLog.onclick = () => {
    const box = $("#logBox");
    const txt = box ? box.textContent.trim() : "";
    if (!txt) { toast("日志还是空的", "warn"); return; }
    copyText(txt, "已复制完整日志");
  };

  $("#btnCancel").onclick = async () => {
    if (state.runJobId) await api("/api/cancel", { jobId: state.runJobId });
  };
  $("#btnOpenOutDir").onclick = () => {
    const od = state.values.outputDir || state.values.inputDir;
    if (!od) { toast("还没有设置输出目录或声音目录", "error"); return; }
    api("/api/open", { path: od });
  };
  $("#btnExportCsv").onclick = async () => {
    const p = state.result && state.result.path;
    if (!p) { toast("还没有结果", "error"); return; }
    const r = await api("/api/export", { path: p });
    if (r.ok) { toast("已导出：" + r.path, "ok"); api("/api/open", { path: r.path }); }
    else toast(r.error || "导出失败", "error");
  };

  // 第五步：导出时间序列（逐点 CSV，三种重采样方式）
  function syncExpMethod() {
    const m = (document.querySelector('input[name="expMethod"]:checked') || {}).value || "raw";
    $("#expOptN").classList.toggle("hidden", m !== "smooth");
    $("#expOptI").classList.toggle("hidden", m !== "interval");
  }

  // 文件布局（2026-09-26 拍板：单文件长表默认保留 + 每音频/每参数/Excel 新增）
  const EXP_LAYOUT_LABEL = { single: "单文件长表", per_audio: "每音频一个文件",
                             per_param: "每参数一个文件", xlsx: "Excel 工作簿" };
  function expLayoutSel() {
    return (document.querySelector('input[name="expLayout"]:checked') || {}).value || "single";
  }
  function syncExpLayout() {
    const L = expLayoutSel();
    const dirLayout = L === "per_audio" || L === "per_param";
    $("#expFilename").disabled = dirLayout;
    $("#expOutHint").innerHTML = dirLayout
      ? `按布局自动写入输出目录的「${L === "per_audio" ? "逐音频序列" : "分参数序列"}」子目录（同名文件直接覆盖），文件名不用填。`
      : (L === "xlsx"
        ? `输出为一个 .xlsx 工作簿：每个参数一页（file, time_s, 值）+「说明」页。需要已安装 openpyxl。`
        : `输出为长表：每行一个时间点，列为 <code>file, time_s, 勾选的参数…</code>，多个文件顺序堆叠。UTF-8 带 BOM，Excel 双击即可打开。`);
    $("#btnExportSeries").textContent = L === "single" ? "导出时间序列 CSV"
      : (L === "xlsx" ? "导出 Excel 工作簿"
        : (L === "per_audio" ? "导出（每音频一个文件）" : "导出（每参数一个文件）"));
  }

  async function exportSeries() {
    const dir = state.values.inputDir;
    if (!dir) { toast("还没有选择声音目录（第一步）", "error"); return; }
    const ext = (state.values.soundExt || "wav").trim().replace(/^\./, "") || "wav";
    const params = $$('#expParams .exp-p input[data-param]').filter(i => i.checked).map(i => i.dataset.param);
    if (!params.length) { toast("至少勾选一个要导出的参数", "error"); return; }
    const method = (document.querySelector('input[name="expMethod"]:checked') || {}).value || "raw";
    const n = method === "smooth" ? (parseInt($("#expNPoints").value, 10) || 100) : null;
    const interval = method === "interval" ? (parseFloat($("#expInterval").value) || 0.01) : null;
    const outDir = state.values.outputDir || dir;
    const base = outDir.replace(/\\/g, "/").replace(/\/$/, "");
    const layout = expLayoutSel();
    let outPath;
    if (layout === "per_audio" || layout === "per_param") {
      // 目录型布局：文件名输入不适用，直接指向输出目录下的布局子目录
      outPath = base + "/" + (layout === "per_audio" ? "逐音频序列" : "分参数序列");
    } else {
      let fname = ($("#expFilename").value || "").trim();
      const want = layout === "xlsx" ? ".xlsx" : ".csv";
      if (!fname) {
        // 默认文件名跟随勾选的参数（2026-09-27 用户拍板）：F0_F1_F2.csv 之类；
        // 参数太多拼出来过长时回退通用名。
        fname = params.join("_") + want;
        if (fname.length > 60) fname = "praatsauce_series" + want;
      }
      fname = fname.replace(/\.(csv|xlsx)$/i, "") + want;
      outPath = base + "/" + fname;
    }
    $("#expStatus").textContent = "导出中…";
    const r = await api("/api/export-series", {
      dir: dir, params: params, method: method, n: n, interval: interval,
      ext: ext, layout: layout, outPath: outPath, outputDir: outDir,
      tgFilter: $("#expTgFilter").checked,
      skipLabels: ($("#expTgSkip").value || "").trim(),
    });
    if (!r.ok) {
      $("#expStatus").textContent = "";
      toast(r.error || "导出失败", "error");
      return;
    }
    $("#expStatus").textContent = "已导出 " + r.files + " 个文件、" + r.rows + " 行 → " + r.path;
    let html = `<div class="diag ok"><div><div class="dtitle">导出成功</div>
      <div class="dbody">${r.files} 个文件、${r.rows} 行（布局：${EXP_LAYOUT_LABEL[layout] || layout}；方式：${r.method}）。${r.kind === "dir" ? "目录" : "文件"}：${esc(r.path)}</div></div></div>`;
    if (r.skipped && r.skipped.length) {
      html += `<div class="diag warn"><div><div class="dtitle">跳过 ${r.skipped.length} 个文件</div>
        <div class="dbody">这些音频的 measure/ 子目录里没有 .Pitch/.Formant 对象文件（先批量运行或审核完成）：
        ${esc(r.skipped.slice(0, 12).join("、"))}${r.skipped.length > 12 ? "…" : ""}</div></div></div>`;
    }
    if ($("#expTgFilter").checked && r.tgMissing && r.tgMissing.length) {
      html += `<div class="diag warn"><div><div class="dtitle">${r.tgMissing.length} 个文件没找到 TextGrid（未过滤，整文件导出）</div>
        <div class="dbody">${esc(r.tgMissing.slice(0, 12).join("、"))}${r.tgMissing.length > 12 ? "…" : ""}</div></div></div>`;
    }
    const box = $("#expResult");
    box.innerHTML = html;
    box.classList.remove("hidden");
    api("/api/open", { path: r.path });
  }

  // 第五步：导出时间序列。参数分组与勾选联动在 renderExpParams()（进面板时按
  // 本次测量设置动态渲染，事件跟着每次渲染重挂），这里只挂导出按钮与目录。
  $("#btnExportSeries").onclick = exportSeries;
  $("#expOpenDir").onclick = () => {
    const od = state.values.outputDir || state.values.inputDir;
    if (!od) { toast("还没有设置输出目录或声音目录", "error"); return; }
    api("/api/open", { path: od });
  };
  $$('input[name="expMethod"]').forEach(r => r.onchange = syncExpMethod);
  syncExpMethod();
  $$('input[name="expLayout"]').forEach(r => r.onchange = syncExpLayout);
  syncExpLayout();

  // 设置
  $("#btnSettings").onclick = openSettings;
  $("#settingsClose").onclick = () => $("#settingsModal").classList.add("hidden");
  // 关于本软件（版本号从 feedback.js 的常量读取，集中一处维护）
  const _ver = window.PRAATSAUCE_VERSION || "向导界面 1.2";
  const _verEl = document.getElementById("appVer");
  if (_verEl) _verEl.textContent = _ver;
  $("#btnAbout").onclick = () => $("#aboutModal").classList.remove("hidden");
  // 反馈
  $("#btnFeedback").onclick = () => openFeedback();
  $("#aboutClose").onclick = () => $("#aboutModal").classList.add("hidden");
  $("#aboutOk").onclick = () => $("#aboutModal").classList.add("hidden");
  $("#aboutModal").onclick = e => { if (e.target === $("#aboutModal")) $("#aboutModal").classList.add("hidden"); };
  $("#btnPickPraat").onclick = () => openPicker("", p => { $("#setPraatExe").value = p + (p.toLowerCase().endsWith(".exe") ? "" : ""); });
  $("#btnResetPraat").onclick = () => resetPath("praatExe", "#setPraatExe");
  $("#btnSelfCheck").onclick = () => runSelfCheck();
  $("#btnTestPraat").onclick = async () => {
    const msg = $("#praatTestMsg");
    msg.textContent = "测试中…";
    const r = await api("/api/test-praat", { exe: $("#setPraatExe").value.trim() });
    if (r.ok) {
      msg.innerHTML = `<span style="color:var(--ok)">可用：${esc(r.version)}</span>`;
      state.boot.env.praatVersion = r.version;
      renderEnv();
    } else {
      msg.innerHTML = `<span style="color:var(--err)">这个路径跑不起来，换一个试试</span>`;
    }
  };
  $("#btnSaveSettings").onclick = async () => {
    const s = await api("/api/settings", {
      settings: {
        praatExe: $("#setPraatExe").value.trim(),
        tier: $("#setTier").value,
      },
    });
    state.boot.settings = s.settings;
    state.tier = (s.settings.tier === "expert" ? "advanced" : (s.settings.tier || "novice"));
    renderTierSwitch();
    renderParams();
    renderEnv();
    $("#settingsMsg").textContent = "已保存";
    setTimeout(() => { $("#settingsMsg").textContent = ""; }, 2000);
  };
  $("#btnRefreshParams").onclick = refreshParamsText;
  $("#btnLoadParams").onclick = importParams;
  $("#btnCopyParams").onclick = () => {
    const ta = $("#paramsRaw");
    ta.select();
    document.execCommand("copy");
    toast("已复制", "ok");
  };

  // 选择器（弹窗 DOM/样式/交互均在 ui/picker.js 内自包含，此处无需再绑）
  $$(".modal-backdrop").forEach(b => b.onclick = (e) => { if (e.target === b) b.classList.add("hidden"); });
  $("#btnResetParams").onclick = () => {
    state.values = Object.assign({}, state.boot.defaults);
    syncIntervalMode();
    if (state.tier === "novice") (state.boot.params || []).forEach(p => { if (p.tier === "advanced" && p.type === "bool") state.values[p.name] = 0; });  // 新手恢复默认也不勾进阶档参数（只清布尔开关，保留数值类默认）
    // 保留目录类设置
    state.values.inputDir = $("#inputDir").value.trim();
    state.values.outputDir = $("#outputDir").value.trim();
    state.values.outputFile = $("#outputFile").value.trim() || "out.tsv";
    state.values.soundExt = $("#soundExt").value.trim() || "wav";
    state.values.skipCols = "";   // 列选择也随参数一起复位
    state.voiceRoute = null;    // 退出嗓音分流路线
    renderParams();
    renderMeasurePicker();
    renderVoiceHint();
    toast("已恢复默认参数");
  };

  // ===== 参数默认值三层（出厂 / 我的默认 override / 当前值）=====
  // 「恢复默认值」回到 boot.defaults（= 出厂 + 用户 override 合并，后端下发）；
  // 「存为我的默认」把当前值 diff 写入后端 param_overrides.json；
  // 「恢复出厂默认」清空 override 文件。路径类键由后端 _NO_DEFAULT_KEYS 兜底剔除。
  function applyBootDefaults(d) {
    state.boot.defaults = d.defaults;
    state.boot.overrides = d.overrides || {};
    state.boot.factory = d.factory || {};
  }
  $("#btnSaveDefaults").onclick = async () => {
    const vals = Object.assign({}, state.values);
    ["inputDir", "outputDir", "tgDir", "filelist", "skipCols"].forEach(k => delete vals[k]);
    const d = await api("/api/param-defaults", { values: vals });
    applyBootDefaults(d);
    const n = Object.keys(d.overrides || {}).length;
    toast(n ? "已存为我的默认（" + n + " 项与出厂不同）" : "当前与出厂默认一致，未保存任何差异项");
  };
  $("#btnFactoryDefaults").onclick = async () => {
    const n = Object.keys(state.boot.overrides || {}).length;
    if (n && !confirm("将清除已保存的 " + n + " 项自定义默认值，回到软件出厂设置。确定？")) return;
    const d = await api("/api/param-defaults", { reset: 1 });
    applyBootDefaults(d);
    state.values = Object.assign({}, d.defaults);
    syncIntervalMode();
    state.values.inputDir = $("#inputDir").value.trim();
    state.values.outputDir = $("#outputDir").value.trim();
    state.values.outputFile = $("#outputFile").value.trim() || "out.tsv";
    state.values.soundExt = $("#soundExt").value.trim() || "wav";
    state.voiceRoute = null;
    renderParams();
    renderMeasurePicker();
    renderVoiceHint();
    toast("已恢复出厂默认");
  };

  // 第二步「更多高级设置」展开/收起（进阶专享）：仅切换折叠区，不重渲染整张参数卡
  const moreBtn = $("#btnParamMore");
  if (moreBtn) moreBtn.onclick = () => {
    state.showParamMore = !state.showParamMore;
    renderParams();
  };

  // 第二步「已选测量项」展开/收起：切换「展开更多」折叠区
  const chosenBtn = $("#btnChosenMore");
  if (chosenBtn) chosenBtn.onclick = () => {
    state.showChosenMore = !state.showChosenMore;
    renderChosen();
  };

  // 三问起步 / 示例向导 / 档案库（W3+W4）
  $("#onboardSkip").onclick = async () => {
    await api("/api/settings", { settings: { firstRunDone: true } });
    state.boot.settings.firstRunDone = true;
    $("#onboardCard").classList.add("hidden");
  };
  $("#btnManageProfiles").onclick = openProfileManager;
  $("#profileClose").onclick = () => $("#profileModal").classList.add("hidden");
  $("#btnNewProfile").onclick = newProfileFromCurrent;
  $("#profileModal").addEventListener("click", (e) => { if (e.target.id === "profileModal") $("#profileModal").classList.add("hidden"); });
}

/* ---------------------------------------------------------------- 三问起步 / 探针 / 示例向导 (W3+W4) */

let onboardStep = 0;

function initOnboard() {
  const need = !state.boot.settings.firstRunDone && !state.boot.settings.lastInputDir;
  const card = $("#onboardCard");
  if (!need) { card.classList.add("hidden"); return; }
  onboardStep = 0;
  card.classList.remove("hidden");
  renderOnboard();
}

function tierName(t) { const x = state.boot.tiers.find(z => z.id === t); return x ? x.name : t; }

function renderOnboard() {
  const b = $("#onboardBody");
  if (onboardStep === 0) {
    b.innerHTML =
      '<p class="ob-q">① 录音文件在哪个文件夹？</p>' +
      '<p class="hint">程序会处理这个文件夹里所有指定扩展名的音频。</p>' +
      '<div class="row"><button class="btn" id="obPickDir">选择文件夹</button>' +
      '<button class="btn ghost" id="obExample">用示例数据带我走一遍</button></div>' +
      '<p class="muted small" id="obDir">当前：' + esc(state.values.inputDir || "（未选择）") + '</p>';
    $("#obPickDir").onclick = () => openPicker(state.values.inputDir, p => {
      $("#inputDir").value = p; scanInput();
      $("#obDir").textContent = "当前：" + p;
      onboardStep = 1; renderOnboard();
    });
    $("#obExample").onclick = startExampleWizard;
  } else if (onboardStep === 1) {
    const chips = state.boot.speakers.map((s, i) =>
      '<button class="chip" data-i="' + i + '">' + esc(s.name) + "</button>").join("") +
      '<button class="chip" id="obNewProfile">＋ 新建档案…</button>';
    b.innerHTML =
      '<p class="ob-q">② 发音人是？</p>' +
      '<div class="speaker-grid">' + chips + "</div>" +
      '<div class="row" style="margin-top:8px">' +
      '<button class="btn ghost" id="obProbe">用第一段音频自动测基频范围</button>' +
      '<button class="btn tiny ghost" id="obBack1">上一步</button></div>';
    $$("#onboardBody .chip[data-i]").forEach(el => el.onclick = () => {
      applySpeaker(state.boot.speakers[+el.dataset.i]);
      onboardStep = 2; renderOnboard();
    });
    $("#obNewProfile").onclick = openProfileManager;
    $("#obProbe").onclick = runProbe;
    $("#obBack1").onclick = () => { onboardStep = 0; renderOnboard(); };
  } else if (onboardStep === 2) {
    const presets = state.boot.presets.map((p, i) =>
      '<button class="preset" data-i="' + i + '"><div class="pt"><span class="dot"></span>' +
      esc(p.name) + '</div><div class="pdesc">' + esc(p.desc) + "</div></button>").join("");
    b.innerHTML =
      '<p class="ob-q">③ 主要想看什么？</p>' +
      '<div class="preset-grid">' + presets + "</div>" +
      '<div class="row" style="margin-top:8px"><button class="btn tiny ghost" id="obBack2">上一步</button></div>';
    $$("#onboardBody .preset[data-i]").forEach(el => el.onclick = () => {
      applyPreset(state.boot.presets[+el.dataset.i]);
      onboardStep = 3; renderOnboard();
    });
    $("#obBack2").onclick = () => { onboardStep = 1; renderOnboard(); };
  } else {
    const sp = state.boot.speakers.find(s => s.id === state.boot.settings.speaker) || {};
    const pr = state.boot.presets.find(p => p.id === state.boot.settings.preset) || {};
    b.innerHTML =
      '<details open class="ob-sum"><summary>本次为你配置了这些</summary>' +
      '<div class="kv"><span>输入目录</span><b>' + esc(state.values.inputDir || "—") + "</b></div>" +
      '<div class="kv"><span>发音人</span><b>' + esc(sp.name || "—") + "（" + state.values.f0min + "–" + state.values.f0max + " Hz）</b></div>" +
      '<div class="kv"><span>预设</span><b>' + esc(pr.name || "—") + "</b></div>" +
      '<div class="kv"><span>档位</span><b>' + esc(tierName(state.tier)) + "</b></div></details>" +
      '<button class="btn primary" id="obDone">完成，开始使用</button>';
    $("#obDone").onclick = finishOnboard;
  }
}

async function finishOnboard() {
  await api("/api/settings", { settings: { firstRunDone: true } });
  state.boot.settings.firstRunDone = true;
  $("#onboardCard").classList.add("hidden");
  toast("配置完成，下次不再弹出起步卡", "ok");
}

async function runProbe() {
  const dir = state.values.inputDir;
  if (!dir) { toast("请先选择音频文件夹", "error"); return; }
  const r = await api("/api/probe-f0", { dir, ext: state.values.soundExt || "wav" });
  if (!r.ok) { toast(r.error || "探测失败", "error"); return; }
  state.values.f0min = r.f0min; state.values.f0max = r.f0max;
  renderSpeakers(); renderParams();
  toast("已根据 " + r.file + " 建议基频范围 " + r.f0min + "–" + r.f0max + " Hz", "ok");
}

async function startExampleWizard() {
  const sd = state.boot.env.sampleDir;
  if (!sd) { toast("找不到示例目录", "error"); return; }
  $("#inputDir").value = sd;
  await scanInput(true);
  // samples 按发音人分了子目录：1 = 女声、2 = 男声（默认示例指到 1）。
  // 旧包文件名里带「女声/男声」时仍按文件名兜底。
  const isMale = /[\\/]2$/.test(sd) || state.files.some(n => n.includes("男声"));
  applySpeaker(state.boot.speakers.find(s => s.id === (isMale ? "male" : "female")));
  state.values.outputDir = state.boot.env.workDir + "\\示例输出";
  $("#outputDir").value = state.values.outputDir;
  await api("/api/settings", { settings: { firstRunDone: true } });
  state.boot.settings.firstRunDone = true;
  $("#onboardCard").classList.add("hidden");
  toast(isMale ? "已载入男声示例（samples/2）→ 点下一步看参数" : "已载入女声示例（samples/1）→ 点下一步看参数", "ok");
  setStep(2);
}

// 发音人档案库（PS-FT3 profile-manager）逻辑已移至 ui/profiles-ui.js：
//   openProfileManager / renderProfileList / newProfileFromCurrent / refreshSpeakers

document.addEventListener("DOMContentLoaded", init);
