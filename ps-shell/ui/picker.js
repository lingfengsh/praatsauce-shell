/* 统一文件夹/文件选择器：主程序(向导)与 VoiceSauce 共用，避免两套不一致的浏览组件。
   自包含：首次调用时往 <body> 注入弹窗 DOM 与样式（作用域 #fbPickerModal），
   不依赖任何页面的 styles.css / vs.css。
   后端接口：GET /api/fs?path=&mode=&ext=   POST /api/mkdir
   用法：window.openFolderPicker(startPath, cb, opts)
         opts = { title, confirmLabel, mode: 'dir'|'file', ext } */
(function () {
  "use strict";

  var MODAL_ID = "fbPickerModal";
  var styleInjected = false;
  var busy = false;
  var cb = null;        // 确认回调
  var mode = "dir";
  var ext = "";
  var selFile = "";
  var navTimer = null;  // 目录「单击进入」的延时句柄，用来和双击区分

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // 自包含样式（作用域到 #fbPickerModal），两套页面都不必改 CSS
  var CSS =
    "#" + MODAL_ID + "{z-index:60}" +
    "#" + MODAL_ID + ".modal-backdrop{position:fixed;inset:0;z-index:60;background:rgba(15,23,42,.45);" +
      "display:grid;place-items:center;padding:24px}" +
    "#" + MODAL_ID + " .modal{width:min(680px,100%);max-height:86vh;display:flex;flex-direction:column;" +
      "background:#fff;border-radius:14px;box-shadow:0 20px 60px rgba(15,23,42,.25);overflow:hidden}" +
    "#" + MODAL_ID + " .modal-head{display:flex;align-items:center;justify-content:space-between;" +
      "padding:16px 20px;border-bottom:1px solid #eef0f3}" +
    "#" + MODAL_ID + " .modal-head h3{margin:0;font-size:16px}" +
    "#" + MODAL_ID + " .icon-btn{border:0;background:transparent;font-size:18px;cursor:pointer;" +
      "color:#9aa4b2;line-height:1;padding:2px 6px}" +
    "#" + MODAL_ID + " .icon-btn:hover{color:#333}" +
    "#" + MODAL_ID + " .picker-bar{display:flex;align-items:center;gap:10px;padding:10px 20px;" +
      "border-bottom:1px solid #eef0f3;background:#fafbfc}" +
    "#" + MODAL_ID + " .crumbs{display:flex;gap:4px;flex-wrap:wrap;font-size:12px;color:#9aa4b2;overflow:hidden}" +
    "#" + MODAL_ID + " .crumbs button{border:0;background:transparent;color:#2e7af6;cursor:pointer;" +
      "font-size:12px;padding:2px 4px;font-family:inherit}" +
    "#" + MODAL_ID + " .picker-list{flex:1;overflow:auto;min-height:260px;padding:6px 0}" +
    "#" + MODAL_ID + " .pitem-row{display:flex;align-items:center;gap:10px;padding:8px 20px;cursor:pointer;font-size:13.5px}" +
    "#" + MODAL_ID + " .pitem-row:hover{background:#f3f6ff}" +
    "#" + MODAL_ID + " .pitem-row.selected{background:#eaf6ec}" +
    "#" + MODAL_ID + " .pitem-row .picon{color:#2e7af6;flex:none}" +
    "#" + MODAL_ID + " .empty{padding:30px;text-align:center;color:#9aa4b2;font-size:13px}" +
    "#" + MODAL_ID + " .modal-foot{display:flex;align-items:center;gap:10px;justify-content:flex-end;" +
      "padding:14px 20px;border-top:1px solid #eef0f3;background:#fafbfc}" +
    "#" + MODAL_ID + " .modal-foot input[type=text]{flex:1}" +
    "#" + MODAL_ID + " .btn{border:1px solid #d7dce3;background:#fff;color:#222;border-radius:8px;" +
      "padding:7px 14px;font-size:13px;cursor:pointer;font-family:inherit}" +
    "#" + MODAL_ID + " .btn:hover{background:#f3f6ff}" +
    "#" + MODAL_ID + " .btn.ghost{background:#fff}" +
    "#" + MODAL_ID + " .btn.primary{background:#2e7af6;border-color:#2e7af6;color:#fff}" +
    "#" + MODAL_ID + " .btn.primary:hover{background:#2467d6}" +
    "#" + MODAL_ID + " .btn.tiny{padding:4px 10px;font-size:12px}";

  function toast(msg, type) {
    if (window.toast) { window.toast(msg, type); return; }
    // 无外部 toast 时的极简兜底（VoiceSauce 页无 toast）
    var box = document.getElementById("fbToast");
    if (!box) {
      box = document.createElement("div");
      box.id = "fbToast";
      box.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:90;" +
        "display:flex;flex-direction:column;gap:8px;font-family:inherit";
      document.body.appendChild(box);
    }
    var el = document.createElement("div");
    el.textContent = msg;
    el.style.cssText = "padding:10px 14px;border-radius:8px;color:#fff;font-size:13px;box-shadow:0 6px 20px rgba(0,0,0,.18);" +
      (type === "error" ? "background:#e5484d" : "background:#2e7af6");
    box.appendChild(el);
    setTimeout(function () { el.style.transition = "opacity .3s"; el.style.opacity = "0"; }, 2600);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 3000);
  }

  function ensureDom() {
    if (document.getElementById(MODAL_ID)) return;
    if (!styleInjected) {
      var st = document.createElement("style");
      st.id = MODAL_ID + "Style";
      st.textContent = CSS;
      document.head.appendChild(st);
      styleInjected = true;
    }
    var backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop hidden";
    backdrop.id = MODAL_ID;
    // 帮助模式：点弹窗任意处显示选择器的用法（help.js 里的 picker 条目）
    backdrop.setAttribute("data-help-scope", "picker");
    backdrop.innerHTML =
      '<div class="modal">' +
        '<div class="modal-head"><h3 id="fbPickerTitle">选择文件夹</h3>' +
        '<button class="icon-btn" id="fbPickerClose" type="button">✕</button></div>' +
        '<div class="picker-bar">' +
          '<button class="btn tiny ghost" id="fbPickerUp" type="button">↑ 上级</button>' +
          '<div class="crumbs" id="fbPickerCrumbs"></div>' +
        '</div>' +
        '<div class="picker-list" id="fbPickerList"></div>' +
        '<div class="modal-foot">' +
          '<input type="text" id="fbPickerCurrent" placeholder="当前路径">' +
          '<button class="btn ghost" id="fbPickerNew" type="button">新建文件夹</button>' +
          '<button class="btn primary" id="fbPickerOk" type="button">选择此文件夹</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(backdrop);

    backdrop.addEventListener("click", function (e) { if (e.target === backdrop) hide(); });
    document.getElementById("fbPickerClose").onclick = hide;
    document.getElementById("fbPickerOk").onclick = function () { confirmPath(); };
    document.getElementById("fbPickerNew").onclick = onNewFolder;
    backdrop.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { hide(); }
      else if (e.key === "Enter") { e.preventDefault(); confirmPath(); }
    });
  }

  function hide() { var m = document.getElementById(MODAL_ID); if (m) m.classList.add("hidden"); }
  function show() { document.getElementById(MODAL_ID).classList.remove("hidden"); }

  function apiFs(path) {
    var qs = "path=" + encodeURIComponent(path || "") +
             "&mode=" + encodeURIComponent(mode) +
             "&ext=" + encodeURIComponent(ext || "");
    return fetch("/api/fs?" + qs)
      .then(function (r) { return r.json(); })
      .catch(function (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; });
  }

  function browse(path) {
    if (busy) return;
    busy = true;
    var list = document.getElementById("fbPickerList");
    var crumbs = document.getElementById("fbPickerCrumbs");
    list.innerHTML = '<div class="empty">正在加载…</div>';
    apiFs(path).then(function (res) {
      document.getElementById("fbPickerCurrent").value = res.path || "";
      if (!res.ok) {
        busy = false;
        crumbs.innerHTML = "";
        list.innerHTML = '<div class="empty">' + esc(res.error || "无法访问该路径") + '</div>';
        document.getElementById("fbPickerUp").onclick = function () { browse(""); };
        return;
      }
      // 面包屑：逐级可点。盘符特判 C:\，修复旧版把 C: 拼成 C::\\ 的畸形路径
      crumbs.innerHTML = "";
      var root = document.createElement("button");
      root.type = "button";
      root.textContent = "此电脑";
      root.onclick = function () { browse(""); };
      crumbs.appendChild(root);
      var parts = (res.path || "").split(/[\\/]/).filter(Boolean);
      parts.forEach(function (p, i) {
        var isDrive = i === 0 && /:$/.test(p);
        var target = isDrive ? (p + ":\\") : parts.slice(0, i + 1).join("\\");
        var b = document.createElement("button");
        b.type = "button";
        b.textContent = p;
        b.onclick = function () { browse(target); };
        crumbs.appendChild(document.createTextNode(" › "));
        crumbs.appendChild(b);
      });
      var isFileMode = mode === "file";
      list.innerHTML = res.entries.length
        ? res.entries.map(function (e) {
            var icon = e.type === "file"
              ? '<path d="M6 2h8l4 4v16H6V2z" stroke="currentColor" stroke-width="1.6"/><path d="M14 2v4h4" stroke="currentColor" stroke-width="1.6"/>'
              : '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" stroke="currentColor" stroke-width="1.6"/>';
            return '<div class="pitem-row ' + (e.type === "file" ? "pitem-file" : "") +
              '" data-path="' + esc(e.path) + '" data-type="' + esc(e.type) + '">' +
              '<svg class="picon" width="16" height="16" viewBox="0 0 24 24" fill="none">' + icon + '</svg>' +
              '<span>' + esc(e.name) + '</span></div>';
          }).join("")
        : '<div class="empty">这个文件夹里没有' + (isFileMode ? "文件" : "子文件夹") + '</div>';
      // 重新定位到顶部：新列表比旧列表短时，旧滚动位置会停在空白/底部，造成「点了没展开、跑到下面」的错觉
      list.scrollTop = 0;
      Array.prototype.slice.call(list.querySelectorAll(".pitem-row")).forEach(function (row) {
        var t = row.getAttribute("data-type");
        var p = row.getAttribute("data-path");
        if (t === "file") {
          row.onclick = function () {
            selFile = p;
            Array.prototype.slice.call(list.querySelectorAll(".pitem-row")).forEach(function (x) { x.classList.remove("selected"); });
            row.classList.add("selected");
          };
          row.ondblclick = function () { confirmPath(p); };
          return;
        }
        /* 目录、盘符（后端 type="drive"）以及任何非文件条目：单击进入，双击＝选定这一级。
           2026-10-18 修复：旧代码只认 type==="dir"，而「此电脑」首屏的 C:/D:/E: 是
           type="drive"，于是盘符被当成文件——单击只高亮不进入，双击反而把「C:\」当文件
           交回去并关闭弹窗。用户看到的就是「第一次怎么点都打不开，双击一下弹窗没了，
           再打开就正常了」（再打开时已经在真实目录里，条目都是 dir，所以能用）。
           单击加 180ms 延时，是为了给双击留出判定窗口：否则双击会先进入该目录、
           第二次点击落到新列表上，可能误选里面的子目录。 */
        row.onclick = function () {
          clearTimeout(navTimer);
          navTimer = setTimeout(function () { browse(p); }, 180);
        };
        row.ondblclick = function () {
          clearTimeout(navTimer);
          confirmPath(p);
        };
      });
      document.getElementById("fbPickerUp").onclick = function () { browse(res.parent || ""); };
      busy = false;
    });
  }

  function confirmPath(p) {
    var cur = document.getElementById("fbPickerCurrent").value.trim();
    var path = (p && p.trim()) || selFile || cur;
    if (mode === "file") {
      // 必须是具体文件；没选中文件却点确认（当前仍是目录）则拦截
      if (!selFile && (!p || p === cur)) { toast("请选择一个文件", "error"); return; }
    } else {
      if (!path) { toast("先选一个文件夹", "error"); return; }
    }
    hide();
    if (cb) cb(path);
  }

  function onNewFolder() {
    var base = document.getElementById("fbPickerCurrent").value.trim();
    var name = window.prompt ? window.prompt("新文件夹名称：", "results") : null;
    if (!name) return;
    var p = base ? base.replace(/[\\/]+$/, "") + "\\" + name : name;
    fetch("/api/mkdir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: p }) })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (r.ok) { browse(base); toast("已创建 " + p, "ok"); }
        else toast(r.error || "创建失败", "error");
      })
      .catch(function (e) { toast(String(e), "error"); });
  }

  function openFolderPicker(startPath, callback, opts) {
    ensureDom();
    cb = callback;
    mode = (opts && opts.mode) || "dir";
    ext = (opts && opts.ext) || "";
    selFile = "";
    busy = false;
    document.getElementById("fbPickerTitle").textContent = (opts && opts.title) || "选择文件夹";
    document.getElementById("fbPickerOk").textContent = (opts && opts.confirmLabel) || "选择此文件夹";
    show();
    document.getElementById("fbPickerCurrent").focus();   // 焦点进入弹窗，Esc/Enter 才生效
    browse(startPath || "");
  }

  window.openFolderPicker = openFolderPicker;
})();
