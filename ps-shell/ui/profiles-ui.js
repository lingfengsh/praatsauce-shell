// 发音人档案库（PS-FT3 profile-manager）
// 本文件从 ui/app.js 拆出，作为独立模块，单一职责：管理发音人档案（新建/列出/删除/刷新）。
// 依赖 app.js 提供的全局：state / $ / $$ / api / toast / esc / renderSpeakers
// 这些函数以 classic <script> 全局声明，app.js 的 init() 在 DOMContentLoaded 时仍可直接引用。

async function openProfileManager() {
  await renderProfileList();
  $("#profileModal").classList.remove("hidden");
}

async function renderProfileList() {
  const r = await api("/api/profiles/list");
  const list = r.profiles || [];
  $("#profileList").innerHTML = list.length
    ? list.map(p =>
        '<div class="frow"><span class="fname">' + esc(p.name) + "</span>" +
        "<span>" + p.f0min + "–" + p.f0max + " Hz</span>" +
        '<button class="btn tiny ghost" data-del="' + p.id + '">删除</button></div>').join("")
    : '<p class="muted">还没有档案，用下方输入框从当前参数新建。</p>';
  $$("#profileList [data-del]").forEach(b => b.onclick = async () => {
    await api("/api/profiles/delete", { id: b.dataset.del });
    await renderProfileList(); await refreshSpeakers();
  });
}

async function newProfileFromCurrent() {
  const name = $("#profileNewName").value.trim();
  if (!name) { toast("请填写档案名称", "error"); return; }
  const r = await api("/api/profiles/save", {
    name, f0min: state.values.f0min, f0max: state.values.f0max, maxFormantHz: state.values.maxFormantHz,
  });
  if (!r.ok) { toast(r.error || "新建失败", "error"); return; }
  $("#profileNewName").value = "";
  toast("已新建档案：" + name, "ok");
  await renderProfileList(); await refreshSpeakers();
}

async function refreshSpeakers() {
  const boot = await api("/api/bootstrap");
  state.boot.speakers = boot.speakers;
  renderSpeakers();
}
