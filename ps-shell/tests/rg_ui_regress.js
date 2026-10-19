/* PS-RV1 前端逻辑回归 —— 审查九宫格的抽取参数 / 纵轴上限 / 导出 defaults。

本机没有可用的浏览器自动化工具，所以用 node 的 vm 加载**真实源文件**
`ui/review-grid-ui.js`（只在 IIFE 末尾注入一行导出钩子，不改任何逻辑），
DOM / canvas / api 全部打桩。断言集中在 5 处：
  1. reviewParams() 把用户设置映射成抽取参数（含 intervalFixed → timeStep）
  2. 缺项 / 非数值 / 0 / 负数一律丢弃（不能拿 0 当频率上限）
  3. fetchPage 的请求体带上了这些参数，且原有字段（dir/page/size/formantOpt）没丢
  4. FMAX_FORMANT 跟随后端回显的 formantCeiling（语图与共振峰线同轴的前提）
  5. 「审核完成」与单文件重导都带 defaults；pickBaseCand 精确命中 / 就近命中 / 越界
  6. [12]/[13] app.js 第四步导出参数表：expColInvolved 判定 + renderExpParams
     表格版式（八列、前四列展开、第五列起折叠、45 个参数全铺、未涉及列标注）

运行：
    node tests/rg_ui_regress.js
（Python 侧的配套用例见 tests/test_rv1.py。）
*/
"use strict";
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const SRC = path.join(__dirname, "..", "ui", "review-grid-ui.js");
const HOOK = `
  window.__T = {
    reviewParams: reviewParams, pickCand: pickCand, pickBaseCand: pickBaseCand,
    mergedF0Points: mergedF0Points,
    fetchPage: fetchPage, finishReview: finishReview, reexportFile: reexportFile,
    doSaveChoice: doSaveChoice, sliderParams: sliderParams,
    drawFormantDetail: drawFormantDetail,
    resetCandDefaults: resetCandDefaults, trackDetail: trackDetail,
    bindCandEvents: bindCandEvents,
    smoothTarget: smoothTarget, updateSmoothAvail: updateSmoothAvail,
    f0DetailRange: f0DetailRange,
    // 详情窗显隐逻辑（2026-09-27 新增：改F0 / 清手工点 在 formant / 新手 下必须收起）
    setTab: setTab, drawDetail: drawDetail, rdSetUI: rdSetUI,
    state: state, getFmax: function () { return FMAX_FORMANT; },
    getFmaxSpec: function () { return FMAX_SPEC; },
    // 第四步「查看测量结果」的内嵌结果网格（2026-09-26 新增）
    rvInit: rvInit, rvFetch: rvFetch, rvParams: rvParams,
    rvComputeRanges: rvComputeRanges, rvDrawCell: rvDrawCell,
    rvOpenDetail: rvOpenDetail, rv: function () { return rv; },
    // 第四步详情窗的多参数叠加（2026-09-27 新增）
    rdState: function () { return rd; }, rdRenderPick: rdRenderPick, rdAdd: rdAdd,
    rdRemove: rdRemove, rdRenderChips: rdRenderChips, rdRanges: rdRanges,
    openResultsDetail: openResultsDetail, drawResultsDetail: drawResultsDetail,
    rdNav: rdNav, rdTitle: rdTitle,
    fmtNum: fmtNum
  };
`;
let code = fs.readFileSync(SRC, "utf8");
const anchor = "  init();";
if (code.indexOf(anchor) < 0) throw new Error("导出钩子的锚点没找到");
code = code.replace(anchor, HOOK + anchor);

/* ---------------- 打桩 ---------------- */
const calls = [];          // 记录所有 api(path, data)
let apiReply = {};         // 下一次 api() 返回什么

const els = {};
function fakeCtx() {
  const real = {
    canvas: { width: 800, height: 300 },
    createImageData: function (w, h) {
      const n = Math.max(1, ((w | 0) * (h | 0)) || 1);
      return { width: w, height: h, data: new Uint8ClampedArray(n * 4) };
    },
    getImageData: function (x, y, w, h) { return this.createImageData(w, h); },
    measureText: function () { return { width: 0 }; },
  };
  return new Proxy(real, {
    get: function (t, k) { return (k in t) ? t[k] : function () {}; },
    set: function (t, k, v) { t[k] = v; return true; },
  });
}
function fakeEl(sel) {
  const el = {
    __sel: sel, style: {}, dataset: {}, children: [], className: "",
    innerHTML: "", textContent: "", value: "", checked: false, disabled: false,
    width: 0, height: 0, tagName: "DIV",
    // classList 真的落到 className 上（结果网格的「第 5 组起折叠 / 点按钮展开」
    // 就是靠 toggle("folded") 实现的，桩不落地就断言不了）
    classList: {
      contains: function (c) { return String(el.className || "").split(/\s+/).indexOf(c) >= 0; },
      add: function (c) { if (!this.contains(c)) el.className = (el.className ? el.className + " " : "") + c; },
      remove: function (c) {
        el.className = String(el.className || "").split(/\s+/).filter(x => x && x !== c).join(" ");
      },
      toggle: function (c, force) {
        const on = (force === undefined) ? !this.contains(c) : !!force;
        if (on) this.add(c); else this.remove(c);
        return on;
      },
    },
    appendChild: function (c) { el.children.push(c); return c; },
    // innerHTML 赋值要真的清空子节点：结果网格 / 详情参数表都是「innerHTML='' 再 append」
    // 重渲染，桩不清空的话 children 会越攒越多（断言列数会数错）。
    removeChild: function () {}, remove: function () {},
    addEventListener: function () {}, removeEventListener: function () {},
    setAttribute: function () {}, getAttribute: function () { return null; },
    getBoundingClientRect: function () {
      return { width: 800, height: 300, left: 0, top: 0, right: 800, bottom: 300 };
    },
    getContext: function () { return fakeCtx(); },
    querySelector: function (s) { return elFor(sel + " " + s); },
    querySelectorAll: function () { return []; },
    focus: function () {}, blur: function () {}, click: function () {},
    insertBefore: function (c) { return c; }, cloneNode: function () { return el; },
  };
  let _html = "";
  Object.defineProperty(el, "innerHTML", {
    get: function () { return _html; },
    set: function (v) { _html = String(v); el.children.length = 0; },
  });
  return el;
}
function elFor(sel) {
  if (!els[sel]) els[sel] = fakeEl(sel);
  return els[sel];
}

const DIR = "/data/nowhere";
els["#rgDir"] = fakeEl("#rgDir");
els["#rgDir"].value = DIR;

const sandbox = {
  console: console,
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  document: {
    getElementById: function (id) { return elFor("#" + id); },
    querySelector: function (s) { return elFor(s); },
    querySelectorAll: function () { return []; },
    createElement: function (t) { return fakeEl("<" + t + ">"); },
    addEventListener: function () {}, body: fakeEl("body"),
  },
  $: function (s) { return elFor(s); },
  $$: function (s) {
    if (s === ".btnReviewGrid") return [fakeEl(".btnReviewGrid")];
    // 结果网格的八组下拉：返回真实 append 进去的那些，才能断言折叠/展开
    if (s === "#rvSelects .rv-sel") return (els["#rvSelects"] && els["#rvSelects"].children) || [];
    // 第四步详情窗的参数表（八组列，createElement + appendChild 建出来的）
    if (s === "#rgResCols .rg-res-col") return (els["#rgResCols"] && els["#rgResCols"].children) || [];
    if (s === "#rgResChips .rg-res-chip") return [];   // 已选栏是 innerHTML 拼的，断言看字符串
    return [];
  },
  api: function (path, data) {
    calls.push({ path: path, data: data });
    return Promise.resolve(apiReply);
  },
  esc: function (s) { return String(s == null ? "" : s); },
  toast: function () {},
  openPicker: function () {},
  togglePlayback: function () {}, stopPlayback: function () {},
  fetch: function () { return Promise.resolve({ ok: true, arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(8)); } }); },
  FileReader: function () {},
  requestAnimationFrame: function (f) { return setTimeout(f, 0); },
  alert: function () {}, confirm: function () { return true; },
  // 档位切换联动（review-grid-ui.js 内 window.addEventListener("pstierchange")）
  addEventListener: function () {}, removeEventListener: function () {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

process.on("unhandledRejection", function () { /* 打桩下的渲染异常不计入 */ });

vm.runInContext(code, sandbox);
const T = sandbox.window.__T;
if (!T) throw new Error("导出钩子没生效");

/* ---------------- 断言 ---------------- */
let ok = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { ok++; console.log("  \u2713 " + label); }
  else { fail++; console.log("  \u2717 " + label + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
}
function tick() { return new Promise(function (r) { setTimeout(r, 60); }); }
function lastCall(path, pred) {
  for (let i = calls.length - 1; i >= 0; i--)
    if (calls[i].path === path && (!pred || pred(calls[i]))) return calls[i];
  return null;
}

(async function () {
  console.log("\n[1] reviewParams() —— 从用户设置映射抽取参数");
  sandbox.state = undefined;   // 占位，真正的全局 state 走 window.state
  sandbox.window.state = { values: { f0min: 50, f0max: 300, maxFormantHz: 5000,
                                    maxNumFormants: 5, intervalFixed: 0.005 } };
  let p = T.reviewParams();
  check("pitchFloor ← f0min", p.pitchFloor === 50, p);
  check("pitchCeiling ← f0max", p.pitchCeiling === 300, p);
  check("formantCeiling ← maxFormantHz", p.formantCeiling === 5000, p);
  check("nFormants ← maxNumFormants", p.nFormants === 5, p);
  check("timeStep ← intervalFixed", p.timeStep === 0.005, p);

  console.log("\n[2] reviewParams() —— 缺项 / 坏值 / 越界");
  sandbox.window.state = { values: { f0min: 60, f0max: "abc", maxFormantHz: 0, intervalFixed: -1 } };
  p = T.reviewParams();
  check("合法项保留", p.pitchFloor === 60, p);
  check("非数值项丢弃", p.pitchCeiling === undefined, p);
  check("0 丢弃（不能拿 0 当上限）", p.formantCeiling === undefined, p);
  check("负数丢弃", p.timeStep === undefined, p);
  sandbox.window.state = {};
  check("没有 state.values → 空对象", Object.keys(T.reviewParams()).length === 0, T.reviewParams());
  sandbox.window.state = { values: {} };
  check("values 为空 → 空对象", Object.keys(T.reviewParams()).length === 0, T.reviewParams());

  console.log("\n[3] fetchPage 的请求体带上了这些参数");
  sandbox.window.state = { values: { f0min: 50, f0max: 300, maxFormantHz: 5000,
                                    maxNumFormants: 5, intervalFixed: 0.005 } };
  calls.length = 0;
  apiReply = { ok: true, files: [], tg: {}, total: 0, pages: 0,
               formantCeiling: 5000, nFormants: 5, warnings: [] };
  T.fetchPage();
  await tick();
  let c = lastCall("/api/review/grid");
  check("发了 grid 请求", !!c);
  check("带 pitchFloor=50", c && c.data.pitchFloor === 50, c && c.data);
  check("带 pitchCeiling=300", c && c.data.pitchCeiling === 300, c && c.data);
  check("带 formantCeiling=5000", c && c.data.formantCeiling === 5000, c && c.data);
  check("带 nFormants=5", c && c.data.nFormants === 5, c && c.data);
  check("原有字段仍在（dir/page/size/formantOpt）",
        c && c.data.dir !== undefined && c.data.page === 0 && c.data.size === 16 &&
        c.data.formantOpt !== undefined, c && c.data);

  console.log("\n[4] FMAX_FORMANT 跟着后端回显走（语图与共振峰线同轴的前提）");
  await tick();
  check("取数后 FMAX_FORMANT = 5000", T.getFmax() === 5000, T.getFmax());
  apiReply = { ok: true, files: [], tg: {}, total: 0, pages: 0,
               formantCeiling: 5500, nFormants: 5, warnings: [] };
  T.fetchPage();
  await tick();
  check("再取一次 → 跟着变回 5500", T.getFmax() === 5500, T.getFmax());

  console.log("\n[5] 导出请求带 defaults");
  sandbox.window.state = { values: { f0min: 50, f0max: 300, maxFormantHz: 5000,
                                    maxNumFormants: 5, intervalFixed: 0.005 } };
  calls.length = 0;
  els["#rgDir"].value = DIR;
  apiReply = { ok: true, total: 2, done: 2, failed: [], elapsed: 1 };
  T.state.dir = DIR;
  T.finishReview();
  await tick();
  c = lastCall("/api/review/export");
  check("「审核完成」发出导出请求", !!c);
  check("带 dir", c && c.data.dir === DIR, c && c.data);
  check("带 defaults.pitchFloor", c && c.data.defaults && c.data.defaults.pitchFloor === 50, c && c.data);
  check("带 defaults.timeStep", c && c.data.defaults && c.data.defaults.timeStep === 0.005, c && c.data);

  calls.length = 0;
  apiReply = { ok: true, path: "x.Pitch", manualFrames: 0 };
  T.reexportFile({ path: DIR + "/11.wav", name: "11.wav", choice: null });
  await tick();
  c = lastCall("/api/review/export");
  check("单文件重导也带 defaults",
        c && c.data.path && c.data.defaults && c.data.defaults.formantCeiling === 5000, c && c.data);

  console.log("\n[6] pickBaseCand —— 精确命中 / 就近命中 / 越界");
  const fm = [
    { id: "4503-4", ceiling: 4503, nFormants: 4 }, { id: "4503-5", ceiling: 4503, nFormants: 5 },
    { id: "4976-5", ceiling: 4976, nFormants: 5 }, { id: "5500-5", ceiling: 5500, nFormants: 5 },
    { id: "6718-5", ceiling: 6718, nFormants: 5 }, { id: "5500-6", ceiling: 5500, nFormants: 6 },
    { id: "4976-6", ceiling: 4976, nFormants: 6 },
  ];
  check("精确命中 5500-5", (T.pickBaseCand(fm, 5500, 5) || {}).id === "5500-5");
  check("5000（候选里没有）→ 就近取 4976-5",
        (T.pickBaseCand(fm, 5000, 5) || {}).id === "4976-5", T.pickBaseCand(fm, 5000, 5));
  check("4900 → 就近取 4976-5", (T.pickBaseCand(fm, 4900, 5) || {}).id === "4976-5");
  check("6600 → 就近取 6718-5", (T.pickBaseCand(fm, 6600, 5) || {}).id === "6718-5");
  check("数量 6 只在 6 个那组里找", (T.pickBaseCand(fm, 5400, 6) || {}).id === "5500-6",
        T.pickBaseCand(fm, 5400, 6));
  check("数量 9 没有候选 → null", T.pickBaseCand(fm, 5500, 9) === null);
  check("空列表 → null", T.pickBaseCand([], 5500, 5) === null);
  check("pickCand 仍是精确匹配（不能被近似匹配污染）", T.pickCand(fm, "5000-5") === null);
  check("pickCand 精确仍正常", (T.pickCand(fm, "4976-5") || {}).id === "4976-5");

  console.log("\n[7] mergedF0Points —— 逐点编辑语义（2026-09-26 用户拍板：加点只改最近帧，绝不抹掉中间原数据）");
  // 帧网格：0.100s 起、dx=0.010、f0 全 200
  const frames = [];
  for (let i = 0; i < 21; i++) frames.push({ t: +(0.1 + i * 0.01).toFixed(3), f0: 200 });
  // 单点 t=0.123（不在帧上）：吸附最近帧 0.120 → 260，**相邻帧一律不动**
  const f1 = { pitch: frames, _manual: [{ t: 0.123, f0: 260 }] };
  const m1 = T.mergedF0Points(f1);
  const at = function (arr, t) {
    return arr.filter(function (p) { return Math.abs(p.t - t) < 1e-6; })[0];
  };
  check("单点吸附最近帧：0.120 帧被替换成 260", at(m1, 0.12).f0 === 260, at(m1, 0.12));
  check("相邻帧 0.130 保持原值 200（不整段替换）", at(m1, 0.13).f0 === 200, at(m1, 0.13));
  check("远处帧保持原值", at(m1, 0.2).f0 === 200);
  // 两个离得很远的手工点：中间的原始数据必须原样保留（旧语义会抹成一条插值线——用户实测否决）
  const f2 = { pitch: frames, _manual: [{ t: 0.12, f0: 260 }, { t: 0.26, f0: 180 }] };
  const m2 = T.mergedF0Points(f2);
  check("远距两点：0.120→260", at(m2, 0.12).f0 === 260);
  check("远距两点：0.260→180", at(m2, 0.26).f0 === 180);
  check("远距两点：中间帧 0.190 保持 200（不再被删）", at(m2, 0.19).f0 === 200, at(m2, 0.19));
  // 删帧 → 桥接：手工锚 0.120→260，删掉相邻帧 0.130 → 桥接值在 200 与 260 之间
  const f3 = { pitch: frames, _manual: [{ t: 0.12, f0: 260 }], _deleted: [0.13] };
  const m3 = T.mergedF0Points(f3);
  const v3 = at(m3, 0.13).f0;
  check("删帧被桥接：0.130 ∈ (200, 260)", v3 > 200 && v3 < 260, v3);
  check("未删帧不受影响：0.140 = 200", at(m3, 0.14).f0 === 200);
  // 同一帧既删又加点 = 改值（手工点优先）
  const f4 = { pitch: frames, _manual: [{ t: 0.12, f0: 260 }], _deleted: [0.12] };
  check("同帧既删又加点：手工值优先 → 260", at(T.mergedF0Points(f4), 0.12).f0 === 260);
  // 没有任何编辑 → 原曲线原样返回
  check("无编辑 → 原曲线", T.mergedF0Points({ pitch: frames, _manual: [], _deleted: [] }) === frames);

  console.log("\n[8] 预览曲线编辑 + 远距点平滑连接（2026-09-26 用户反馈：蓝绿线要与点图编辑连通、不许孤立点）");
  // 预览曲线（青线）：0.10–0.20 全 230，其中 0.16–0.18 是无声段（f0=0）
  const prevPts = [];
  for (let i = 0; i < 21; i++) {
    const t = +(0.1 + i * 0.01).toFixed(3);
    prevPts.push({ t: t, f0: (t >= 0.16 && t <= 0.18) ? 0 : 230 });
  }
  // 有预览：编辑作用在预览网格上——单点 0.12→300 只替换预览那一帧，原曲线不动
  const p1 = { pitch: frames, _preview: { points: prevPts }, _manual: [{ t: 0.12, f0: 300 }] };
  const mp1 = T.mergedF0Points(p1);
  check("有预览：0.120 取手工值 300（作用在预览上）", at(mp1, 0.12).f0 === 300, at(mp1, 0.12));
  check("有预览：相邻帧 0.130 保持预览值 230（不是橙线的 200）", at(mp1, 0.13).f0 === 230);
  check("有预览：原曲线 f.pitch 未被改动", at(p1.pitch, 0.12).f0 === 200);
  // 跨无声段：曲线 0.15 后无声（0.16–0.18），在 0.19 加点 → 中间无声帧被 PCHIP 桥接，不再孤立
  const p2 = { pitch: frames, _preview: { points: prevPts }, _manual: [{ t: 0.19, f0: 260 }] };
  const mp2 = T.mergedF0Points(p2);
  check("跨无声段：0.160 被桥接（∈ (230, 260)）",
        at(mp2, 0.16).f0 > 230 && at(mp2, 0.16).f0 < 260, at(mp2, 0.16));
  check("跨无声段：0.180 被桥接（∈ (230, 260)）",
        at(mp2, 0.18).f0 > 230 && at(mp2, 0.18).f0 < 260, at(mp2, 0.18));
  check("跨无声段：手工点帧 0.190 取点值 260", at(mp2, 0.19).f0 === 260);
  // 无声段外的有效帧不受牵连：0.11 保持预览值 230
  check("远端有效帧不受影响：0.110 = 230", at(mp2, 0.11).f0 === 230);
  // 手工点本身就是输出采样点：输出序列里必须有 t=0.19、f0=260 的点（折线穿过它）
  check("输出包含手工点采样（折线必过点）", mp2.some(function (p) {
    return Math.abs(p.t - 0.19) < 1e-6 && p.f0 === 260;
  }));

  console.log("\n[9] doSaveChoice —— 防抖内保存 WYSIWYG（2026-09-26 21.wav 二次踩坑：滑块动过、预览没回来，" +
              "兜底却写了批量默认 300Hz）");
  sandbox.window.state = { values: { f0min: 50, f0max: 300, maxFormantHz: 5000,
                                    maxNumFormants: 5, intervalFixed: 0.005 } };
  apiReply = { ok: true, choice: {}, path: "21.Pitch" };
  function saveScenario(name, file, prevOverrides) {
    T.state.detailFile = file;
    T.state.tab = "pitch";
    T.state.prev = Object.assign({ method: "filtered", values: {}, timer: null, seq: 0, dirty: false },
                                 prevOverrides || {});
    calls.length = 0;
    T.doSaveChoice();
    return lastCall("/api/review/choice-save");
  }
  const PREV_VALS = { ceiling: 500, silence: 0.09, voicing: 0.5, octave: 0.055,
                      octaveJump: 0.35, vuv: 0.14, attenuation: 0.03 };
  // (a) 滑块动过（dirty）、预览没回来 → 直接取滑块值，绝不写批量默认
  let c9 = saveScenario("a", { path: DIR + "/21.wav", name: "21.wav", choice: null, _manual: [], _deleted: [] },
                        { values: PREV_VALS, dirty: true });
  check("脏滑块+无预览：存 ceiling=500（滑块值）",
        c9 && c9.data.choice.pitch.params.ceiling === 500, c9 && c9.data.choice.pitch);
  check("脏滑块+无预览：label 带 500Hz 而非「默认·300」",
        c9 && /上限500Hz/.test(c9.data.choice.pitch.label) && !/默认/.test(c9.data.choice.pitch.label),
        c9 && c9.data.choice.pitch.label);
  // (b) 滑块动过、_preview 还是旧参数（ceiling 300）→ 脏滑块优先，不信旧预览
  c9 = saveScenario("b", { path: DIR + "/21.wav", name: "21.wav", choice: null,
                           _preview: { points: [], params: { method: "filtered", ceiling: 300 } },
                           _manual: [], _deleted: [] },
                    { values: PREV_VALS, dirty: true });
  check("脏滑块+旧预览：仍取滑块 500（不信旧预览 300）",
        c9 && c9.data.choice.pitch.params.ceiling === 500, c9 && c9.data.choice.pitch);
  // (c) 没动滑块、预览在 → 用预览参数（原 WYSIWYG 行为不回归）
  c9 = saveScenario("c", { path: DIR + "/21.wav", name: "21.wav", choice: null,
                           _preview: { points: [], params: { method: "filtered", ceiling: 450 } },
                           _manual: [], _deleted: [] }, {});
  check("干净滑块+预览：取预览 450",
        c9 && c9.data.choice.pitch.params.ceiling === 450, c9 && c9.data.choice.pitch);
  // (d) 没动滑块、没预览、已有自定义记录 → 沿用已存的，不覆盖回默认
  c9 = saveScenario("d", { path: DIR + "/21.wav", name: "21.wav",
                           choice: { pitch: { id: "custom", method: "filtered",
                                              params: { ceiling: 500 } } },
                           _manual: [], _deleted: [] }, {});
  check("干净+无预览+已有自定义：沿用 500",
        c9 && c9.data.choice.pitch.params.ceiling === 500, c9 && c9.data.choice.pitch);
  // (e) 啥都没有 → 才轮到批量默认兜底
  c9 = saveScenario("e", { path: DIR + "/21.wav", name: "21.wav", choice: null, _manual: [], _deleted: [] }, {});
  check("全无 → 兜底批量默认 300",
        c9 && c9.data.choice.pitch.params.ceiling === 300, c9 && c9.data.choice.pitch);
  // (f) 脏分支与预览请求的参数对象逐字段一致（共用 sliderParams 的前提）
  T.state.prev = { method: "filtered", values: PREV_VALS, timer: null, seq: 0, dirty: true };
  const sp = T.sliderParams();
  const rp = T.reviewParams();
  check("sliderParams 与存盘分支同源：floor/timeStep 来自 reviewParams",
        sp.pitchFloor === rp.pitchFloor && sp.timeStep === rp.timeStep, sp);

  console.log("\n[10] drawFormantDetail —— 平滑与候选共存（2026-09-26 回归修复：_smoothed 有值时早期 return 吞掉候选叠加）");
  // 录制型 canvas：记录每次 stroke 的样式特征（颜色/宽度/alpha/线型），按特征断言画了哪些线。
  // 语图底走异步 fetchWav（同步阶段只有 clearRect/fillRect），不干扰同步 stroke 记录。
  function recCanvasPair() {
    const strokes = [];
    const st = { strokeStyle: "#000", lineWidth: 1, globalAlpha: 1, fillStyle: "#000" };
    let dash = null;
    const real = {
      canvas: { width: 800, height: 300 },
      createImageData: function (w, h) {
        const n = Math.max(1, ((w | 0) * (h | 0)) || 1);
        return { width: w, height: h, data: new Uint8ClampedArray(n * 4) };
      },
      getImageData: function (x, y, w, h) { return this.createImageData(w, h); },
      measureText: function () { return { width: 0 }; },
    };
    const px = new Proxy(real, {
      get: function (t, k) {
        if (k in t) return t[k];
        if (k === "stroke") return function () {
          strokes.push({ color: st.strokeStyle, width: st.lineWidth,
                         alpha: st.globalAlpha, dash: dash });
        };
        if (k === "setLineDash") return function (d) { dash = d && d.length ? d.slice() : null; };
        if (k in st) return st[k];
        return function () {};
      },
      set: function (t, k, v) { st[k] = v; return true; },
    });
    return { ctx: px, strokes: strokes };
  }
  function fmFixture() {
    const pts = [];
    for (let i = 0; i < 10; i++) pts.push({ t: 0.02 + i * 0.01, F1: 500, F2: 1500, F3: 2500 });
    const mk = function (id, nf) {
      return { id: id, ceiling: 5500, nFormants: nf,
               points: pts.map(function (p) {
                 return { t: p.t, F1: p.F1 + 10, F2: p.F2 + 10, F3: p.F3 + 10 };
               }) };
    };
    return {
      path: "x.wav", name: "x.wav", duration: 0.15,
      formant: pts, _smoothed: null,
      _cands: { pitch: null, formant: [mk("5500-5", 5), mk("5500-6", 6)] },
      _vis: { pitch: {}, formant: {} },
      _acc: { pitch: null, formant: null },
      choice: null,
    };
  }
  // FORMANT_STYLE_DETAIL 三维样式（review-grid-ui.js 顶部定义）：平滑线/基础线的宽度特征
  const DETAIL_W = [3.4, 2.8, 2.2];
  function count10(s, pred) { return s.filter(pred).length; }
  function draw10(f) {
    const pair = recCanvasPair();
    const cv = { width: 800, height: 300, getContext: function () { return pair.ctx; } };
    T.drawFormantDetail(cv, f);
    return pair.strokes;
  }
  // (a) 勾 1 条候选 + 平滑有值：候选淡线（alpha 0.3）与平滑线共存——本次回归的核心断言
  let f10 = fmFixture();
  f10._vis.formant["5500-5"] = true;
  f10._smoothed = fmFixture().formant;
  let s10 = draw10(f10);
  const faint = count10(s10, function (x) { return x.alpha === 0.3; });
  check("(a) 勾选候选以淡线叠加：alpha=0.3 恰 3 条（F1/F2/F3）", faint === 3, s10.length);
  check("(a) 淡线就是勾选候选：width 2.4 + 点线 [2,4]",
        faint === 3 && s10.every(function (x) {
          return x.alpha !== 0.3 || (x.width === 2.4 && x.dash && x.dash[0] === 2 && x.dash[1] === 4);
        }));
  check("(a) 平滑线仍叠在其上：DETAIL 宽度×3（实线、不透明）",
        count10(s10, function (x) {
          return x.alpha === 1 && x.dash === null && DETAIL_W.indexOf(x.width) >= 0;
        }) === 3);

  // (b) 没生成候选 + 平滑：基础原始灰线 + Track 彩线（原行为不回归）
  f10 = fmFixture();
  f10._cands.formant = [];            // 关键：没生成过候选
  f10._smoothed = f10.formant;
  s10 = draw10(f10);
  check("(b) 没生成候选时画原始灰线：3 条",
        count10(s10, function (x) { return /^rgba\(105,115,135/.test(x.color); }) === 3);
  check("(b) 没生成候选时平滑线照画：DETAIL 宽度×3",
        count10(s10, function (x) {
          return x.alpha === 1 && x.dash === null && DETAIL_W.indexOf(x.width) >= 0;
        }) === 3);
  check("(b) 没生成候选时无淡线",
        count10(s10, function (x) { return x.alpha === 0.3; }) === 0);

  // (b2) 生成过候选但全没勾 + 平滑残留 → 纯语图（2026-09-26 用户拍板：
  //      「点了生成候选又全没选 → 只能有没叠加共振峰的语图，不应该有别的东西」）
  f10 = fmFixture();
  f10._smoothed = f10.formant;        // 防御场景：残留平滑也不画
  s10 = draw10(f10);
  check("(b2) 候选全没勾：不画任何共振峰线（纯语图）",
        count10(s10, function (x) {
          return (x.alpha === 1 && x.dash === null && DETAIL_W.indexOf(x.width) >= 0) ||
                 /^rgba\(105,115,135/.test(x.color) || x.alpha === 0.55 || x.alpha === 0.3;
        }) === 0, s10.length);

  // (c) 没生成候选 + 无平滑：只画基础曲线
  f10 = fmFixture();
  f10._cands.formant = [];
  s10 = draw10(f10);
  check("(c) 无平滑无候选：灰线不出现",
        count10(s10, function (x) { return /^rgba\(105,115,135/.test(x.color); }) === 0);
  check("(c) 无平滑无候选：基础曲线 DETAIL 宽度×3",
        count10(s10, function (x) { return DETAIL_W.indexOf(x.width) >= 0; }) === 3);

  // (c2) 生成过候选 + 全没勾 + 无平滑 → 纯语图（连基础曲线也不画）
  f10 = fmFixture();
  s10 = draw10(f10);
  check("(c2) 生成候选全没勾无平滑：不画基础曲线（纯语图）",
        count10(s10, function (x) { return DETAIL_W.indexOf(x.width) >= 0; }) === 0 &&
        count10(s10, function (x) { return x.alpha === 0.55; }) === 0,
        s10.length);

  // (d) 勾 2 条 + 平滑残留（防御场景）：候选对比照画、平滑线不得出现
  f10 = fmFixture();
  f10._vis.formant["5500-5"] = true;
  f10._vis.formant["5500-6"] = true;
  f10._smoothed = f10.formant;
  s10 = draw10(f10);
  check("(d) 勾 2 条：两候选半透明叠加（alpha=0.55 恰 6 条）",
        count10(s10, function (x) { return x.alpha === 0.55; }) === 6);
  check("(d) 勾 2 条：平滑线不画（DETAIL 宽度+实线+不透明 = 0 条）",
        count10(s10, function (x) {
          return x.alpha === 1 && x.dash === null && DETAIL_W.indexOf(x.width) >= 0;
        }) === 0);
  check("(d) 勾 2 条：线型按数量区分（点线×3 + 虚线×3）",
        count10(s10, function (x) { return x.dash && x.dash.length === 2 && x.dash[0] === 2; }) === 3 &&
        count10(s10, function (x) { return x.dash && x.dash.length === 2 && x.dash[0] === 9; }) === 3);

  // (e)「恢复默认」：撤平滑叠加线（清 _smoothed + 取消勾选）——用户 2026-09-26 遗漏需求
  f10 = fmFixture();
  f10._vis.formant["5500-5"] = true;
  f10._acc.formant = "5500-5";
  f10._smoothed = f10.formant;
  T.state.detailFile = f10;
  els["#rgSmooth"].checked = true;
  let e10 = true;
  try { T.resetCandDefaults(); } catch (err) { e10 = false; console.log("   [reset 异常] " + err); }
  check("(e) resetCandDefaults 在打桩 DOM 下跑通", e10);
  check("(e) 撤掉平滑叠加线：_smoothed 清空", f10._smoothed === null, f10._smoothed);
  check("(e) 平滑勾选取消", els["#rgSmooth"].checked === false, els["#rgSmooth"].checked);
  check("(e) 候选勾选清空", !Object.keys(f10._vis.formant).length, f10._vis.formant);

  // (f) trackDetail 防御分支：勾 ≥2 条时取消平滑、清掉残留 _smoothed、不发 Praat 请求
  f10 = fmFixture();
  f10._vis.formant["5500-5"] = true;
  f10._vis.formant["5500-6"] = true;
  f10._smoothed = f10.formant;
  T.state.detailFile = f10;
  T.state.tab = "formant";
  els["#rgSmooth"].checked = true;
  const callsBefore = calls.length;
  e10 = true;
  try { T.trackDetail(f10); } catch (err) { e10 = false; console.log("   [track 异常] " + err); }
  check("(f) trackDetail 防御分支跑通", e10);
  check("(f) 清掉残留 _smoothed", f10._smoothed === null, f10._smoothed);
  check("(f) 取消平滑勾选", els["#rgSmooth"].checked === false, els["#rgSmooth"].checked);
  check("(f) 不发 /api/review/track 请求", calls.length === callsBefore);

  // (g) 勾选切换 × 平滑耦合（bindCandEvents）：平滑开着时勾选变了 = 作用对象变了 → 自动重跑
  T.state.tab = "formant";
  // (g1) 平滑开着 + 勾 1 条（共 2 条候选）→ 点掉它 → 剩 ≥2 条没勾 = 灰掉态
  //      →（2026-09-26 第二次拍板）防御取消平滑，不再退回平滑基础曲线
  f10 = fmFixture();
  f10._vis.formant["5500-5"] = true;
  f10._smoothed = f10.formant;
  T.state.detailFile = f10;
  els["#rgSmooth"].checked = true;
  const b1 = { dataset: { role: "vis", kind: "formant", id: "5500-5" }, onclick: null };
  T.bindCandEvents({ querySelectorAll: function () { return [b1]; } }, f10);
  calls.length = 0;
  apiReply = { ok: true, tracked: true, points: [] };
  b1.onclick();
  await tick();
  check("(g1) 平滑开着点掉唯一候选（剩多条没勾）→ 平滑自动取消（灰掉态）",
        els["#rgSmooth"].checked === false && f10._smoothed === null,
        { checked: els["#rgSmooth"].checked, smoothed: !!f10._smoothed });
  check("(g1) 灰掉态不发 /api/review/track 请求", !lastCall("/api/review/track"));

  // (g1b) 平滑开着 + 勾 1 条（候选只有 1 条）→ 点掉它 → 唯一候选没勾也算它
  //       （2026-09-26 第二次拍板：「如果只有一个就平滑这个对象」）→ 仍发请求、参数不变
  f10 = fmFixture();
  f10._cands.formant = [f10._cands.formant[0]];   // 只留 1 条候选
  f10._vis.formant["5500-5"] = true;
  f10._smoothed = f10.formant;
  T.state.detailFile = f10;
  els["#rgSmooth"].checked = true;
  const b1b = { dataset: { role: "vis", kind: "formant", id: "5500-5" }, onclick: null };
  T.bindCandEvents({ querySelectorAll: function () { return [b1b]; } }, f10);
  calls.length = 0;
  b1b.onclick();
  await tick();
  let tk = lastCall("/api/review/track");
  check("(g1b) 唯一候选点掉勾选 → 仍自动重跑（作用对象还是它）", !!tk);
  check("(g1b) 请求仍用该候选参数（5500/5）",
        tk && tk.data.formantCeiling === 5500 && tk.data.nFormants === 5, tk && tk.data);

  // (g2) 平滑开着 + 没勾 → 点候选勾上 → 用它的参数重跑（5500/5）
  f10 = fmFixture();
  T.state.detailFile = f10;
  els["#rgSmooth"].checked = true;
  const b2 = { dataset: { role: "vis", kind: "formant", id: "5500-5" }, onclick: null };
  T.bindCandEvents({ querySelectorAll: function () { return [b2]; } }, f10);
  calls.length = 0;
  b2.onclick();
  await tick();
  tk = lastCall("/api/review/track");
  check("(g2) 平滑开着勾上候选 → 用该候选的参数重跑",
        !!tk && tk.data.formantCeiling === 5500 && tk.data.nFormants === 5, tk && tk.data);

  // (g4) smoothTarget 核心场景：没勾 + 只生成 1 条候选 → 直接点平滑就作用在它身上
  //      （用户 2026-09-26 第二次拍板的原始措辞：「如果只有一个就平滑这个对象」）
  f10 = fmFixture();
  f10._cands.formant = [f10._cands.formant[0]];
  f10._vis.formant = {};                 // 关键：没勾
  T.state.detailFile = f10;
  T.state.tab = "formant";
  els["#rgSmooth"].checked = true;
  calls.length = 0;
  T.trackDetail(f10);
  await tick();
  tk = lastCall("/api/review/track");
  check("(g4) 没勾 + 唯一候选 → 平滑直接作用在它身上（发请求）", !!tk);
  check("(g4) 请求用唯一候选的参数（5500/5）",
        tk && tk.data.formantCeiling === 5500 && tk.data.nFormants === 5, tk && tk.data);

  // (g5) updateSmoothAvail 状态机（2026-09-26 第二次拍板：判定基准 = 候选个数 + 勾选）
  const mkAvail = function (nc, nv) {
    const ff = fmFixture();
    ff._cands.formant = fmFixture()._cands.formant.slice(0, nc);
    ff._vis.formant = {};
    const visIds = ["5500-5", "5500-6"];
    for (let i = 0; i < nv; i++) ff._vis.formant[visIds[i]] = true;
    T.updateSmoothAvail(ff);
    return els["#rgSmooth"].disabled;
  };
  check("(g5) 没候选 → 启用（平滑基础曲线）", mkAvail(0, 0) === false);
  check("(g5) 唯一候选没勾 → 启用（平滑它，不用勾）", mkAvail(1, 0) === false);
  check("(g5) 唯一候选已勾 → 启用", mkAvail(1, 1) === false);
  check("(g5) 多条候选没勾 → 灰掉（先勾一条）", mkAvail(2, 0) === true);
  check("(g5) 多条候选勾 1 条 → 启用", mkAvail(2, 1) === false);
  check("(g5) 多条候选勾 2 条 → 灰掉（先取消到一条）", mkAvail(2, 2) === true);

  // (g3) 平滑没开：点格只重画，不发请求
  f10 = fmFixture();
  f10._vis.formant["5500-5"] = true;
  T.state.detailFile = f10;
  els["#rgSmooth"].checked = false;
  const b3 = { dataset: { role: "vis", kind: "formant", id: "5500-5" }, onclick: null };
  T.bindCandEvents({ querySelectorAll: function () { return [b3]; } }, f10);
  calls.length = 0;
  b3.onclick();
  await tick();
  check("(g3) 平滑没开：点格不发 track 请求", !lastCall("/api/review/track"));

  console.log("\n[11] F0 编辑显示（2026-09-26 用户反馈：点看不见 / 延长线颜色 / 纵轴随意）");
  // (a) mergedF0Points：手工点与被覆盖帧带 _m 标记（紫色分段绘制的依据）
  const f11 = { pitch: [], _preview: null, _manual: [], _deleted: [] };
  for (let i = 0; i < 10; i++) f11.pitch.push({ t: 0.02 + i * 0.01, f0: 200 });
  f11._manual = [{ t: 0.045, f0: 300 }];   // 吸附到帧 0.05（覆盖），点本身 t=0.045
  const m11 = T.mergedF0Points(f11);
  check("(a) 手工点本身带 _m 标记", !!m11.find(function (p) { return p.t === 0.045 && p._m && p.f0 === 300; }));
  check("(a) 被覆盖帧带 _m 标记", !!m11.find(function (p) { return p.t === 0.05 && p._m && p.f0 === 300; }));
  check("(a) 普通帧不带 _m", !!m11.find(function (p) { return p.t === 0.03 && !p._m && p.f0 === 200; }));

  // (b) f0DetailRange：性别默认（男 50–250 / 女 100–350）+ 上下限输入覆盖 + 手工点罩入
  // f11b 无手工点（f11 带 300 Hz 手工点，会被罩入逻辑抬上限，见最后两条）
  const f11b = { pitch: [], _preview: null, _manual: [], _deleted: [] };
  for (let i = 0; i < 10; i++) f11b.pitch.push({ t: 0.02 + i * 0.01, f0: 200 });
  T.state.f0Top = 0; T.state.f0Bottom = 0;
  els["#rgGender"].value = "";
  check("(b) 性别未知 → 默认 50–250",
        JSON.stringify(T.f0DetailRange(f11b)) === "[50,250]", T.f0DetailRange(f11b));
  els["#rgGender"].value = "male";
  check("(b) 男 → 50–250",
        JSON.stringify(T.f0DetailRange(f11b)) === "[50,250]", T.f0DetailRange(f11b));
  els["#rgGender"].value = "female";
  check("(b) 女 → 100–350",
        JSON.stringify(T.f0DetailRange(f11b)) === "[100,350]", T.f0DetailRange(f11b));
  els["#rgGender"].value = "male";
  T.state.f0Top = 400; T.state.f0Bottom = 0;
  check("(b) 上限输入覆盖 → 50–400",
        JSON.stringify(T.f0DetailRange(f11b)) === "[50,400]", T.f0DetailRange(f11b));
  T.state.f0Bottom = 80;
  check("(b) 下限输入覆盖 → 80–400",
        JSON.stringify(T.f0DetailRange(f11b)) === "[80,400]", T.f0DetailRange(f11b));
  T.state.f0Top = 0; T.state.f0Bottom = 0;
  f11._manual = [{ t: 0.045, f0: 600 }];   // 手工点在范围外 → 自动罩进来
  check("(b) 手工点 600 Hz 在默认范围外 → 罩到 50–600",
        JSON.stringify(T.f0DetailRange(f11)) === "[50,600]", T.f0DetailRange(f11));
  T.state.f0Top = 500; T.state.f0Bottom = 500;   // 防呆：上限必须高于下限
  check("(b) 下限 ≥ 上限 → 防呆不倒挂",
        T.f0DetailRange(f11)[1] > T.f0DetailRange(f11)[0], T.f0DetailRange(f11));

  // (c) 性别切换显式联动（2026-09-26 用户反馈：切性别框里数字必须跟着变）
  T.state.detailFile = null;   // 不触发重绘，纯看联动赋值
  T.state.f0Top = 0; T.state.f0Bottom = 0;
  els["#rgGender"].value = "female";
  els["#rgGender"].onchange();
  check("(c) 切女 → state 变 100–350",
        T.state.f0Bottom === 100 && T.state.f0Top === 350, T.state.f0Top);
  check("(c) 切女 → 框里填 100/350",
        els["#rgF0Bottom"].value === "100" && els["#rgF0Top"].value === "350");
  els["#rgGender"].value = "male";
  els["#rgGender"].onchange();
  check("(c) 切男 → 框里填 50/250",
        els["#rgF0Bottom"].value === "50" && els["#rgF0Top"].value === "250");

  console.log("\n[12] app.js 第四步导出分组 —— expGroupMeta（纯函数）");
  // app.js 不是 IIFE：function 声明会挂到沙箱全局对象上，可直接调；
  // state 经 window.state = state 暴露（app.js 第 28 行）。
  const appCalls = [];
  let appApiReply = {};
  const appEls = {};
  function appEl(sel) {
    if (appEls[sel]) return appEls[sel];
    const el = {
      __sel: sel, style: {}, dataset: {}, className: "", innerHTML: "", textContent: "",
      value: "", checked: false, disabled: false, tagName: "DIV",
      classList: { _s: new Set(),
        contains: function (c) { return this._s.has(c); },
        add: function (c) { this._s.add(c); },
        remove: function (c) { this._s.delete(c); },
        toggle: function (c) { if (this._s.has(c)) this._s.delete(c); else this._s.add(c); } },
      querySelector: function (s) { return appEl(sel + " " + s); },
      querySelectorAll: function () { return []; },
      closest: function () { return null; },
      addEventListener: function () {}, removeEventListener: function () {},
      appendChild: function (c) { return c; }, click: function () {},
      getBoundingClientRect: function () { return { width: 800, height: 300, left: 0, top: 0 }; },
      getContext: function () { return fakeCtx(); },
    };
    appEls[sel] = el;
    return el;
  }
  const appBox = appEl("#expParams");
  const appSandbox = {
    console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
    document: {
      getElementById: function (id) { return appEl("#" + id); },
      querySelector: function (s) { return appEl(s); },
      querySelectorAll: function () { return []; },
      createElement: function (t) { return appEl("<" + t + ">"); },
      addEventListener: function () {}, body: appEl("body"),
    },
    api: function (path, data) { appCalls.push({ path: path, data: data }); return Promise.resolve(appApiReply); },
    esc: function (s) { return String(s == null ? "" : s); },
    toast: function () {}, openPicker: function () {},
    togglePlayback: function () {}, stopPlayback: function () {},
    fetch: function () { return Promise.resolve({ ok: true, arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(8)); } }); },
    alert: function () {}, confirm: function () { return true; },
    addEventListener: function () {}, removeEventListener: function () {},
    requestAnimationFrame: function (f) { return setTimeout(f, 0); },
    location: { hash: "" }, history: { replaceState: function () {} },
    scrollTo: function () {},
    setInterval: function () { return 0; },
  };
  appSandbox.window = appSandbox;
  appSandbox.globalThis = appSandbox;
  vm.createContext(appSandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "ui", "app.js"), "utf8"), appSandbox);
  // ⚠ app.js 自带顶层 `async function api()`（走 fetch 的封装），vm 加载时会把
  // 沙箱里的 api 桩覆盖掉——必须在加载之后重挂，refreshExpParams 才打到桩上。
  appSandbox.api = function (path, data) {
    appCalls.push({ path: path, data: data });
    return Promise.resolve(appApiReply);
  };
  const S = appSandbox.state;   // app.js: window.state = state
  // 八组定义照后端 series_export.GROUPS 铺（列顺序与用户示例一致）
  const EXP_GROUPS = [
    { key: "pitch_formant", label: "基频/共振峰", cols: ["F0", "F1", "F2", "F3", "F4", "F5"] },
    { key: "slope", label: "谐波差", cols: ["H1H2c", "H2H4c", "H1A1c", "H1A2c", "H1A3c", "H2KH5Ku"] },
    { key: "noise", label: "噪音水平", cols: ["HNR05", "HNR15", "HNR25", "HNR35", "CPP", "CPPS", "SHR"] },
    { key: "energy", label: "能量与激励", cols: ["intensity", "soe"] },
    { key: "harmonic", label: "谐波振幅", cols: ["H1c", "H2c", "H4c", "A1c", "A2c", "A3c", "H2Ku", "H5Ku"] },
    { key: "bandwidth", label: "共振峰带宽", cols: ["B1", "B2", "B3", "B4", "B5"] },
    { key: "harmonic_u", label: "谐波振幅（未校）", cols: ["H1u", "H2u", "H4u", "A1u", "A2u", "A3u"] },
    { key: "slope_u", label: "谐波差（未校）", cols: ["H1H2u", "H2H4u", "H1A1u", "H1A2u", "H1A3u"] },
  ];
  S.boot = { seriesGroups: EXP_GROUPS,
             seriesParams: EXP_GROUPS.reduce((a, g) => a.concat(g.cols), []),
             params: [], tiers: [], presets: [], speakers: [], settings: {}, env: {} };
  S.values = { pitch: 1, formant1: 1, formant2: 1, formant3: 1, formant4: 0, formant5: 0,
               bw1: 0, bw2: 0, bw3: 0, inputDir: "/data/nowhere" };

  console.log("\n[12] app.js expColInvolved —— 列是否「本次测量涉及」");
  check("(m) 基频列 pitch=1 → 涉及",
        appSandbox.expColInvolved(["F0"], { pitch: 1 }) === true);
  check("(m) 基频列 pitch=0 → 未涉及",
        appSandbox.expColInvolved(["F0"], { pitch: 0 }) === false);
  check("(m) 共振峰列 F1–F3 全开 → 涉及",
        appSandbox.expColInvolved(["F1", "F2", "F3"], { formant1: 1, formant2: 1, formant3: 1 }) === true);
  check("(m) 共振峰列里有 F4 没开 → 仍算涉及（组内任一开即算）",
        appSandbox.expColInvolved(["F1", "F4"], { formant1: 1, formant4: 0 }) === true);
  check("(m) 谐波列（无 flag 映射）默认算涉及",
        appSandbox.expColInvolved(["H1H2c", "HNR05"], {}) === true);

  console.log("\n[13] app.js renderExpParams —— 表格版式（列标题全选 / 折叠 / 勾选）");
  // app.js 的 renderExpParams 用 innerHTML + $$ 铺表；沙箱里的 querySelectorAll 桩
  // 返回空数组（事件挂载不生效），因此这里断言的是「生成的 HTML 结构」，
  // 事件绑定逻辑用 [12] 的纯函数 + 结构断言共同锁定。
  appSandbox.renderExpParams();
  const html = appBox.innerHTML;
  check("(A) 生成了表格", html.indexOf('<table class="exp-tbl">') >= 0, html.slice(0, 80));
  check("(A) 八列表头齐全",
        EXP_GROUPS.every(g => html.indexOf(">" + g.label + "<") >= 0), html.slice(0, 200));
  check("(A) 前四列展开、第五列起折叠",
        (html.match(/<th class="exp-th"/g) || []).length === 4 &&
        (html.match(/<th class="exp-th folded/g) || []).length === 4,
        (html.match(/<th class="exp-th[^"]*"/g) || []).join(" "));
  check("(A) 每列带 caret（展开 ▾ / 折叠 ▸）",
        html.indexOf('<span class="exp-th-caret">▾</span>') >= 0 &&
        html.indexOf('<span class="exp-th-caret">▸</span>') >= 0);
  check("(A) 全部 45 个参数都铺出来了",
        S.boot.seriesParams.every(c => html.indexOf('data-param="' + c + '"') >= 0));
  check("(A) 折叠列的正文字段带 folded 类",
        html.indexOf('<td class="exp-td folded">') >= 0);
  check("(A) 未涉及的列（带宽，bw1/2/3 全 0）标 not-involved",
        html.indexOf('class="exp-th folded not-involved"') >= 0, html.slice(0, 300));
  check("(A) 未涉及的列标题带提示",
        html.indexOf("本次测量没勾这些参数") >= 0);
  check("(A) 单元格用 F0/F1 这样的列名（照用户示例，不写中文长标签）",
        html.indexOf('<span>F0</span>') >= 0 && html.indexOf('<span>H1H2c</span>') >= 0);

  console.log("\n[14] 第四步「查看测量结果」结果网格 —— 八组下拉 / 折叠 / 取数 / 点格子开详情");
  // 结果网格用的就是九宫格那套全局：目录取第一步输入框，分组取 boot.seriesGroups
  els["#inputDir"] = fakeEl("#inputDir");
  els["#inputDir"].value = DIR;
  els["#outputDir"] = fakeEl("#outputDir");
  els["#outputDir"].value = DIR;
  els["#rvSelects"] = fakeEl("#rvSelects");
  els["#rvMoreCols"] = fakeEl("#rvMoreCols");
  sandbox.window.state = {
    boot: { seriesGroups: EXP_GROUPS },
    values: { inputDir: DIR, outputDir: DIR },
    step: 4,
  };
  calls.length = 0;
  T.rvInit();
  const rvSel = els["#rvSelects"].children || [];
  check("(B) 铺出八组下拉", rvSel.length === 8, rvSel.length);
  check("(B) 前四组常驻、第五组起折叠",
        rvSel.filter(w => String(w.className).indexOf("folded") < 0).length === 4,
        rvSel.map(w => w.className).join(" | "));
  if (els["#rvMoreCols"].onclick) els["#rvMoreCols"].onclick();
  check("(B) 点「更多参数组」全部展开",
        rvSel.every(w => String(w.className).indexOf("folded") < 0),
        rvSel.map(w => w.className).join(" | "));
  check("(B) 默认选中第一组第一个参数（F0）", T.rvParams().join(",") === "F0", T.rvParams());

  // 换参数 → 重新取数，且请求体带齐 dir/size/params/outputDir
  const sel0 = rvSel[2].children[1];           // 第三组（噪音水平）的 select
  const opt = (sel0.children || []).filter(c => c.value === "HNR05")[0];
  check("(B) 下拉里能选到组内参数", !!opt, (sel0.children || []).map(c => c.value).join(","));
  sel0.value = "HNR05";
  if (sel0.onchange) sel0.onchange();
  check("(B) 换参数自动回到第一页并重取", T.rv().page === 0);
  let rc = lastCall("/api/results/grid");
  check("(B) 请求带 dir / size / params / outputDir",
        rc && rc.data.dir === DIR && rc.data.size === 16 &&
        rc.data.params.join(",") === "F0,HNR05" && rc.data.outputDir === DIR, rc && rc.data);
  check("(B) 顺序按组（F0 在 HNR05 前）",
        rc && rc.data.params[0] === "F0" && rc.data.params[1] === "HNR05");

  // 没选任何参数 → 不发请求，只给提示
  await tick();               // 先让上面那次取数落地（否则 busy 挡住，断言读到的是上一条状态）
  calls.length = 0;
  T.rv().sel = {};
  T.rvFetch();
  check("(B) 一个参数都没选 → 不发请求", lastCall("/api/results/grid") === null);
  check("(B) 一个参数都没选 → 提示先挑参数",
        String(els["#rvStatus"].textContent).indexOf("挑至少一个参数") >= 0,
        els["#rvStatus"].textContent);

  // 纵轴范围按「本页全部文件」算（每参数一根轴，格子之间才能横向比）
  T.rv().sel = { pitch_formant: "F0", noise: "HNR05" };
  T.rv().params = ["F0", "HNR05"];
  T.rv().data = { ok: true, page: 0, pages: 1, total: 2, files: [
    { name: "a.wav", index: 0, duration: 1, intervals: [],
      series: { F0: [[0, 100], [0.1, 200], [0.2, null]], HNR05: [[0, 10], [0.1, 20]] } },
    { name: "b.wav", index: 1, duration: 1, intervals: [],
      series: { F0: [[0, 150]], HNR05: [] } },
  ] };
  T.rvComputeRanges();
  const R = T.rv().ranges;
  check("(C) F0 轴跨本页两个文件（100–200，含余量）",
        R.F0[0] < 100 && R.F0[1] > 200, R.F0);
  check("(C) HNR05 轴只看自己那一条（10–20）",
        R.HNR05[0] < 10 && R.HNR05[1] > 20, R.HNR05);
  check("(C) 空序列不污染范围（b 的 HNR05 为空）", isFinite(R.HNR05[0]) && isFinite(R.HNR05[1]));

  // 点格子 → 用全局序号 index 精确取该文件 → 复用详情窗
  // 点格子 → 直接开「多参数叠加」版详情：曲线本页已经取回来了，不再跑一次 Praat
  calls.length = 0;
  T.rvOpenDetail(T.rv().data.files[1]);
  await tick();
  check("(D) 点格子不另跑 Praat 取数（数据本页已有）",
        lastCall("/api/review/grid") === null);
  check("(D) 进的是多参数叠加版详情（记下 index 供补取用）",
        T.rdState().on === true && T.rdState().index === 1,
        T.rdState().index);

  // 画格子：语图勾选与否都不该抛（canvas 全打桩，只验证不崩 + 断线逻辑不报错）
  T.rv().specBg = true;
  let drew = true;
  try {
    T.rvDrawCell(fakeEl("<canvas>"), T.rv().data.files[0]);
    T.rv().specBg = false;
    T.rvDrawCell(fakeEl("<canvas>"), T.rv().data.files[0]);
  } catch (e) { drew = false; console.log("    drawCell 抛错：" + (e && e.stack || e)); }
  check("(E) 画格子（含语图背景开关）不抛异常", drew);

  console.log("\n[15] 第四步详情窗 —— 参数表点选 / 最多 6 条 / 每条一根彩色纵轴");
  els["#rgResCols"] = fakeEl("#rgResCols");
  els["#rgResChips"] = fakeEl("#rgResChips");
  const fileA = { name: "a.wav", path: DIR + "/a.wav", index: 0, duration: 1.2, intervals: [],
                  series: { F0: [[0, 100], [0.5, 180], [1.0, 150]],
                            HNR05: [[0.2, 8], [0.6, 22]] } };
  calls.length = 0;
  T.openResultsDetail(fileA, DIR, 0);
  await tick();
  check("(A) 开详情不跑 Praat（曲线沿用本页数据）", lastCall("/api/review/grid") === null);
  check("(A) 分组下拉 / 显示方式 / 已选栏显示、原版控件收起",
        !els["#rgGroupDDs"].classList.contains("hidden") &&
        !els["#rgResModeWrap"].classList.contains("hidden") &&
        !els["#rgResPanel"].classList.contains("hidden") &&
        els["#rgDetailTabs"].classList.contains("hidden") &&
        els["#rgPreviewPanel"].classList.contains("hidden") &&
        els["#rgFormantPanel"].classList.contains("hidden") &&
        els["#rgDetailSave"].classList.contains("hidden") &&
        els["#rgImportGroup"].classList.contains("hidden"));
  check("(A) 语图参数保留（窗长 / 对比度 / 谱上限）",
        !elFor("#rgBandWrap").classList.contains("hidden") &&
        !elFor("#rgDynWrap").classList.contains("hidden") &&
        !elFor("#rgSpecTopWrap").classList.contains("hidden"));
  check("(A) 只显示结果版说明、隐掉 F0 / 共振峰说明",
        !els["#rgDetailHelpRes"].classList.contains("hidden") &&
        els["#rgDetailHelpF0"].classList.contains("hidden") &&
        els["#rgDetailHelpFm"].classList.contains("hidden"));

  let ddHtml = String(els["#rgGroupDDs"].innerHTML);
  let nBtn = (ddHtml.match(/rg-gbtn/g) || []).length;
  check("(B) 顶栏默认直显前 4 个常用组按钮 + 更多折叠钮",
        nBtn === 4 && ddHtml.indexOf("rgMoreGroups") >= 0, nBtn);
  check("(B) 直显组含基频/共振峰与噪音水平，未展开时无谐波振幅（未校正）",
        ddHtml.indexOf("基频/共振峰") >= 0 && ddHtml.indexOf("噪音水平") >= 0 &&
        ddHtml.indexOf("谐波振幅（未校正）") < 0, "groups");
  els["#rgMoreGroups"].onclick();   // 展开 → 8 组按钮全出（app 的 $ 单例桩，onclick 绑在这上面）
  ddHtml = String(els["#rgGroupDDs"].innerHTML);
  nBtn = (ddHtml.match(/rg-gbtn/g) || []).length;
  check("(B) 点「更多」展开后铺出全部 8 个分组按钮", nBtn === 8, nBtn);
  els["#rgMoreGroups"].onclick();   // 收起还原，供后续用例沿用默认态
  await tick();

  // 加一个本页没取过的参数 → 按同一个文件补取（page = 全局 index、size = 1）
  const rdS = T.rdState();
  calls.length = 0;
  apiReply = { ok: true, files: [{ name: "a.wav", duration: 1.2, series: {
    F0: [[0, 100], [0.5, 180]], HNR05: [[0.2, 8], [0.6, 22]],
    F1: [[0.1, 500], [0.5, 900]] } }] };
  T.rdAdd("F1");
  await tick();
  const fc = lastCall("/api/results/grid");
  check("(C) 新参数按 index 补取单文件（size=1）",
        fc && fc.data.page === 0 && fc.data.size === 1 &&
        fc.data.params.join(",") === "F0,HNR05,F1", fc && fc.data);
  check("(C) 补回后 F1 有点、F0 仍在",
        (rdS.series.F1 || []).length === 2 && (rdS.series.F0 || []).length === 2);

  // 叠加上限 6 条：第 7 条被拒
  ["F2", "F3", "B1"].forEach(c => { rdS.series[c] = [[0.1, 1200], [0.5, 2400]]; T.rdAdd(c); });
  check("(D) 叠到 6 条", rdS.params.length === 6, rdS.params.join(","));
  rdS.series.CPP = [[0.1, 20]];
  T.rdAdd("CPP");
  check("(D) 第 7 条被拒（最多 6 条）",
        rdS.params.length === 6 && rdS.params.indexOf("CPP") < 0, rdS.params.join(","));
  T.rdRemove("F1"); T.rdAdd("CPP");
  check("(D) 去掉一条后能再加进来",
        rdS.params.length === 6 && rdS.params.indexOf("CPP") >= 0, rdS.params.join(","));

  // 堆叠 → 重叠：超过 6 条的队尾变灰排队，去掉一个按顺序替补一个（2026-09-27 用户定案）
  rdS.mode = "strip";   // 切到堆叠（这里直接改状态模拟），补 3 条超编的
  ["SHR", "intensity", "soe"].forEach(c => { rdS.series[c] = [[0.1, 1], [0.4, 2]]; T.rdAdd(c); });
  check("(D2) 堆叠模式 9 条全上图（不设上限）", rdS.params.length === 9, rdS.params.length);
  els["#rgModeOverlay"].onclick();   // 切回重叠 → 队尾 3 条灰
  await tick();
  const chipsHtml = () => String(els["#rgResChips"].innerHTML);
  const nOff = () => (chipsHtml().match(/rg-res-chip off/g) || []).length;
  check("(D2) 切回重叠：队尾 3 条变灰排队",
        nOff() === 3 && chipsHtml().indexOf("rg-res-chip off") > 0, nOff());
  T.rdRemove("F2");                  // 去掉一个 → 按顺序替补一个（SHR 转正进前 6）
  check("(D2) 去掉一个后按顺序替补（灰的少一条、SHR 进前 6）",
        nOff() === 2 && rdS.params.slice(0, 6).indexOf("SHR") === 5, nOff() + " " + rdS.params.join(","));
  els["#rgModeStrip"].onclick();     // 回到堆叠，灰的全部复活
  await tick();
  check("(D2) 切回堆叠：排队参数全部恢复",
        (els["#rgResChips"].innerHTML.match(/rg-res-chip off/g) || []).length === 0,
        els["#rgResChips"].innerHTML.slice(0, 120));

  // 各参数各按自己的范围（F0 是 Hz、HNR05 是 dB，绝不共用一根轴）
  check("(E) 每条参数一根自己的纵轴（F0 与 HNR05 不混）",
        rdS.ranges.F0[0] < 100 && rdS.ranges.F0[1] > 180 &&
        rdS.ranges.HNR05[1] > 22 && rdS.ranges.HNR05[1] < 100,
        JSON.stringify(rdS.ranges));
  check("(E) 已选栏列出参数名与范围",
        String(els["#rgResChips"].innerHTML).indexOf("HNR05") >= 0 &&
        String(els["#rgResChips"].innerHTML).indexOf("F0") >= 0,
        els["#rgResChips"].innerHTML.slice(0, 80));
  // 左栏统计量：口径必须和图上那条线一致（只算非 null + 音节段内的点）
  check("(E) 均值 / 中位数按画出来的点算（F0 100&180 → 140，HNR05 8&22 → 15）",
        Math.abs(rdS.stats.F0.mean - 140) < 1e-9 && rdS.stats.F0.median === 140 &&
        rdS.stats.F0.n === 2 &&
        Math.abs(rdS.stats.HNR05.mean - 15) < 1e-9 && rdS.stats.HNR05.median === 15,
        JSON.stringify(rdS.stats));
  check("(E) 已选栏写出均值 / 中位 / 点数",
        String(els["#rgResChips"].innerHTML).indexOf("均值") >= 0 &&
        String(els["#rgResChips"].innerHTML).indexOf("中位") >= 0 &&
        String(els["#rgResChips"].innerHTML).indexOf("点）") >= 0,
        els["#rgResChips"].innerHTML.slice(0, 120));
  // 空参数（一个有效点都没有）不能崩，也不能拿 0 当均值
  rdS.series.EMPTY = [[0.1, null], [0.2, null]];
  T.rdRemove("CPP"); T.rdAdd("EMPTY");   // 先腾位置，否则撞 6 条上限
  check("(E) 全空参数：范围退化为 [0,1]、均值 / 中位显示 —",
        rdS.ranges.EMPTY[0] === 0 && rdS.ranges.EMPTY[1] === 1 &&
        rdS.stats.EMPTY.n === 0 && rdS.stats.EMPTY.mean === null);
  // D2 之后队列 8 条且在堆叠模式 → 计数 8 / 8；切回重叠 → 6 / 6（+2 排队）
  check("(E) 计数显示 n / 6（堆叠模式全量）",
        String(els["#rgResCount"].textContent) === "8 / 8",
        els["#rgResCount"].textContent);
  els["#rgModeOverlay"].onclick(); await tick();
  check("(E) 重叠模式计数 6 / 6（+2 排队）",
        String(els["#rgResCount"].textContent) === "6 / 6（+2 排队）",
        els["#rgResCount"].textContent);
  check("(E) 小数不被四舍五入成 0（soe 这类 0.4 的值）",
        T.fmtNum(0.4) === "0.40" && T.fmtNum(1800) === "1.8k",
        T.fmtNum(0.4) + " / " + T.fmtNum(1800));

  // 六条曲线 + 六根彩色纵轴（画布 / 语图全打桩，只验证不崩）
  let drew2 = true;
  try {
    T.drawResultsDetail(fakeEl("<canvas>"), fileA);
    rdS.params.length = 0;                      // 一条都不选时也不能崩
    T.drawResultsDetail(fakeEl("<canvas>"), fileA);
  } catch (e) { drew2 = false; console.log("    drawResultsDetail 抛错：" + (e && e.stack || e)); }
  check("(F) 画多参数叠加详情（6 条 / 0 条）不抛异常", drew2);

  // (G) 标题栏前后翻文件：不回九宫格，按全局序号单取一个文件
  const rd = T.rdState();
  rd.params = ["F0"]; rd.series = { F0: [[0, 100], [0.5, 180]] };
  rd.total = 3; rd.index = 0; rd.busy = false;
  T.rdTitle();
  check("(G) 第一个文件：导航条显示、上一个禁用",
        !els["#rgDetailNav"].classList.contains("hidden") &&
        els["#rgDetailPrev"].disabled === true &&
        els["#rgDetailNext"].disabled === false &&
        String(els["#rgDetailPos"].textContent) === "1 / 3",
        els["#rgDetailPos"].textContent);
  calls.length = 0;
  apiReply = { ok: true, total: 3, files: [{ name: "b.wav", path: DIR + "/b.wav",
                duration: 0.9, series: { F0: [[0, 120], [0.4, 200]] } }] };
  T.rdNav(1);
  await tick();
  // 翻页请求 = page=1 且只带已选参数（后面那次全参数补取是 rdEnsureSeries 的，别混）
  const nc = lastCall("/api/results/grid",
                      c => c.data.page === 1 && c.data.params.join(",") === "F0");
  check("(G) 下一个：按 index+1 单取（size=1，只带已选参数）",
        nc && nc.data.page === 1 && nc.data.size === 1 &&
        nc.data.params.join(",") === "F0", nc && nc.data);
  check("(G) 换文件后名字 / 位置 / 曲线都跟着换",
        String(els["#rgDetailName"].textContent) === "b.wav" &&
        String(els["#rgDetailPos"].textContent) === "2 / 3" &&
        rd.series.F0[1][1] === 200 &&
        rd.ranges.F0[1] > 200 &&
        els["#rgDetailPrev"].disabled === false,
        rd.index + " " + rd.series.F0[1][1]);
  rd.index = 2; T.rdTitle();
  check("(G) 最后一个文件：下一个禁用",
        els["#rgDetailNext"].disabled === true &&
        String(els["#rgDetailPos"].textContent) === "3 / 3");
  calls.length = 0;
  T.rdNav(1);
  await tick();
  check("(G) 越界不请求（已在最后一个）", lastCall("/api/results/grid") === null && rd.index === 2);
  // 结果版把编辑类入口收干净：底部整条 + 画布右上角「Praat」
  check("(G) 编辑类按钮收起：底部整条 + Praat 按钮",
        els["#rgDetailFoot"].classList.contains("hidden") &&
        els["#rgDetailOpenPraat"].classList.contains("hidden"));
  check("(G) 试听按钮保留（只听不改）",
        !els["#rgDetailPlay"].classList.contains("hidden"));

  console.log("\n[16] 详情窗显隐 —— 新手档 / 共振峰页 必须收起「改F0」「清手工点」（2026-09-27 修复）");
  // 前置：关掉多参数叠加版（rd.on=true 时 drawDetail 走结果分支，碰不到按钮逻辑）
  T.rdState().on = false;
  // 最小文件：带 1 个手工点，用来触发「清手工点」的出现条件
  const fVis = {
    path: DIR + "/vis.wav", name: "vis.wav", duration: 1, intervals: [],
    pitch: [{ t: 0.1, f0: 120 }, { t: 0.5, f0: 150 }],
    _manual: [{ t: 0.2, f0: 180 }], _deleted: [],
  };
  const editHidden = () => elFor("#rgEditWrap").classList.contains("hidden");
  const clearHidden = () => elFor("#rgManualClear").classList.contains("hidden");

  // (a) 共振峰页：openDetail 的调用序列是 setTab("formant") 紧接 rdSetUI(false)。
  //     修复前 rdSetUI(false) 用 toggle("hidden", false) 把 #rgEditWrap 的 hidden 摘掉，
  //     导致「改F0」在共振峰页错误出现（点 F0 再回 formant 才会被 setTab 重新藏起）。
  T.state.tab = "formant";
  sandbox.window.state = { tier: "advanced", mode: "formant" };
  T.setTab("formant");
  T.rdSetUI(false);
  check("(a) 共振峰页：改F0 收起", editHidden());
  // 切到 F0（进阶档）→ 改F0 出现；再回 formant → 又收起（与「点 f0 再回 formant 才消失」一致）
  T.setTab("f0");
  check("(a) F0 页（进阶）：改F0 出现", !editHidden());
  T.setTab("formant");
  check("(a) 回到共振峰页：改F0 收起", editHidden());

  // (b) 新手档：改F0 与 清手工点 一起收起（两者都按档位 + 标签页判定）
  T.state.tab = "f0";
  sandbox.window.state = { tier: "novice", mode: "f0" };
  T.setTab("f0");
  T.rdSetUI(false);
  T.drawDetail(fVis);
  check("(b) 新手 F0 页：改F0 收起", editHidden());
  check("(b) 新手 F0 页：清手工点 一并收起", clearHidden());
  // 进阶档同文件：两者都应出现（清手工点 依赖 drawDetail 的 novice 判定）
  sandbox.window.state = { tier: "advanced", mode: "f0" };
  T.setTab("f0");
  T.rdSetUI(false);
  T.drawDetail(fVis);
  check("(b) 进阶 F0 页：改F0 出现", !editHidden());
  check("(b) 进阶 F0 页：清手工点 出现", !clearHidden());
  // 新手 + 共振峰页：两者收起
  sandbox.window.state = { tier: "novice", mode: "formant" };
  T.state.tab = "formant";
  T.setTab("formant");
  T.rdSetUI(false);
  T.drawDetail(fVis);
  check("(b) 新手共振峰页：改F0 收起", editHidden());
  check("(b) 新手共振峰页：清手工点 收起", clearHidden());

  // [17] 语图背景：F0 页=窄带 2kHz、共振峰页=宽带（跟随抽取上限），两页不混
  check("[17] F0 页语图窗长默认窄带 25 ms", T.state.bandF0 === 25, T.state.bandF0);
  check("[17] 共振峰页语图窗长默认宽带 5 ms", T.state.bandFormant === 5, T.state.bandFormant);
  check("[17] F0 页语图显示上限默认 2 kHz（state.specTop）", T.state.specTop === 2000, T.state.specTop);
  check("[17] F0 页谱常量 FMAX_SPEC = 2000（窄带语图用）", T.getFmaxSpec() === 2000, T.getFmaxSpec());
  check("[17] 共振峰谱常量 FMAX_FORMANT = 5500（独立于 F0 的 2000，不混）",
        T.getFmax() === 5500 && T.getFmax() !== T.getFmaxSpec(), [T.getFmax(), T.getFmaxSpec()]);

  console.log("\n================ %d 通过 / %d 失败 ================", ok, fail);
  process.exit(fail ? 1 : 0);
})();
