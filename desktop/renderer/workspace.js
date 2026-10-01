/*
 * Opening a project: the recent list, Browse, and the one path both go through.
 */
/**
 * Switch to a workspace.
 *
 * The one path both Browse and the recent list go through, so a project opened
 * either way is opened identically - restoreBuild brings back its plan and
 * statuses, and nothing runs until the user asks. That is the same rule the
 * resume work established this morning: a restart is as often a crash as a
 * tidy shutdown.
 */
let recentWorkspaces = [];
try {
  recentWorkspaces = window.CNRecent.parse(localStorage.getItem("closeni.recent-workspaces"));
} catch (e) { recentWorkspaces = []; }

function saveRecent() {
  try { localStorage.setItem("closeni.recent-workspaces", JSON.stringify(recentWorkspaces)); } catch (e) {}
}

async function renderRecent() {
  const box = $("recent-list");
  if (!box || !window.CNRecent) return;
  box.innerHTML = "";
  if (!recentWorkspaces.length) return;

  // One call for the whole list: the rail redraws on every switch, and eight
  // round-trips to render eight lines is waste.
  let progress = {};
  try {
    const r = await window.api.workspaceProgress(recentWorkspaces);
    if (r && r.ok) progress = r.progress || {};
  } catch (e) { /* the list still renders, just without the numbers */ }

  recentWorkspaces.forEach(function (p) {
    const row = document.createElement("div");
    row.className = "recent-row" + (p === workspace ? " active" : "");
    const name = document.createElement("span");
    name.className = "recent-path";
    // The tail is what distinguishes two projects; the head is usually the
    // same for all of them and would push the useful part off the rail.
    name.textContent = p.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
    name.title = p;
    const state = document.createElement("span");
    state.className = "recent-state";
    state.textContent = window.CNRecent.describe(progress[p]);
    const drop = document.createElement("button");
    drop.className = "recent-forget";
    drop.textContent = "x";
    drop.title = "Forget this workspace (the folder is not touched)";
    drop.onclick = function (ev) {
      ev.stopPropagation();
      recentWorkspaces = window.CNRecent.forget(recentWorkspaces, p);
      saveRecent();
      renderRecent();
    };
    row.appendChild(name); row.appendChild(state); row.appendChild(drop);
    row.onclick = function () { if (p !== workspace) openWorkspace(p); };
    box.appendChild(row);
  });
}

async function openWorkspace(folder) {
  if (!folder) return;
  workspace = folder;
  // A different project has not been run or shipped from here yet.
  flowSeen.tested = false; flowSeen.shipped = false;
  if (window.CN && window.CN.onWorkspaceChange) window.CN.onWorkspaceChange();
  // Truncated in the rail, so the full path lives in the tooltip.
  $("workspace-label").textContent = folder;
  $("workspace-label").title = folder;
  log("workspace: " + folder, "ok");
  recentWorkspaces = window.CNRecent.remember(recentWorkspaces, folder);
  saveRecent();
  loadChatsForWorkspace();
  // A build left unfinished in this folder comes back with it. Restoring
  // only - nothing runs until the user presses Build.
  if (window.CN && window.CN.restoreBuild) {
    const restored = await window.CN.restoreBuild(folder);
    // Replaces whatever plan was in memory: the plan and the step list have to
    // describe the same build, and the step list has just been replaced.
    if (restored) { currentPlan = restored; renderPlanDocument(restored, { keepBuild: true }); }
  }
  renderRecent();
  renderOnboarding();
}

$("browse-btn").onclick = async function () {
  const f = await window.api.selectFolder();
  if (f) await openWorkspace(f);
};
