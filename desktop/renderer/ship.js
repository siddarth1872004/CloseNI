/*
 * The Ship panel: GitHub (sign-in, repositories, Actions), a repository taken
 * as reference, and the plain git buttons.
 */
// A repository chosen as reference. Folded into the plan prompt so the model
// designs against how a real project of that kind is laid out. Nothing is
// written to the workspace, so there is no licence question on this path.
let repoReference = null;

async function useAsReference(r) {
  const parsed = window.CNGit ? window.CNGit.parseRepoUrl(r.url) : null;
  if (!parsed) { toast("Not a GitHub repository", "err"); return; }
  const readme = await window.api.ghCall("getReadme", [parsed.owner, parsed.repo]);
  const tree = await window.api.ghCall("getTree", [parsed.owner, parsed.repo]);
  if (!readme.ok && !tree.ok) {
    toast(readme.error || tree.error || "Could not read that repository", "err");
    return;
  }
  repoReference = {
    name: parsed.owner + "/" + parsed.repo,
    readme: (readme.ok ? readme.result : "").slice(0, 3000),
    files: (tree.ok ? tree.result : []).slice(0, 120),
  };
  toast("Referencing " + repoReference.name + " in the next plan");
  log("reference set: " + repoReference.name, "ok");
}

async function cloneRepo(r) {
  if (!workspace) { toast("Pick a workspace", "err"); return; }
  const parsed = window.CNGit ? window.CNGit.parseRepoUrl(r.url) : null;
  if (!parsed) { toast("Not a GitHub repository", "err"); return; }
  // The licence is the user's to accept, so it goes in front of them rather
  // than into a doc they will not read.
  const licence = r.license || "an unknown licence";
  const ok = confirm("Clone " + parsed.owner + "/" + parsed.repo + " into your workspace?\n\n" +
    "It carries " + licence + ", and the AI will go on to edit code it did not write.");
  if (!ok) return;
  setStatus("cloning");
  const res = await window.api.ghClone({ url: r.url, workspace: workspace });
  setStatus("idle");
  if (res && res.ok) toast("Cloned into " + res.into);
  else toast((res && res.error) || "Clone failed", "err");
}

// GitHub. The renderer never holds the token - it asks the main process to make
// calls on its behalf, and no getter for it exists on window.api.
async function refreshGitHub() {
  const st = await window.api.ghStatus().catch(function () { return { signedIn: false }; });
  const out = $("gh-signed-out");
  const inn = $("gh-signed-in");
  if (!out || !inn) return;
  out.classList.toggle("is-hidden", !!st.signedIn);
  inn.classList.toggle("is-hidden", !st.signedIn);

  const note = $("gh-storage-note");
  if (note) {
    // Said plainly rather than discovered next launch when the token is gone.
    note.textContent = st.encryptionAvailable
      ? "Stored encrypted on this machine."
      : "This system offers no secure storage, so the token is kept in memory only and must be re-entered next launch.";
  }
  if (!st.signedIn) return;

  $("gh-login").textContent = st.login ? "@" + st.login : "signed in";
  const r = await window.api.ghCall("listRepos", []);
  const sel = $("gh-repo");
  sel.innerHTML = "";
  if (!r || !r.ok) { log("github: " + ((r && r.error) || "could not list repositories"), "err"); return; }
  (r.result || []).forEach(function (repo) {
    const o = document.createElement("option");
    o.value = repo.clone_url || ("https://github.com/" + repo.full_name + ".git");
    o.textContent = repo.full_name + (repo.private ? " (private)" : "");
    sel.appendChild(o);
  });
  sel.onchange = function () { $("remote-url").value = sel.value; };
  if (sel.value) $("remote-url").value = sel.value;
  await refreshRuns();
}

$("gh-open-tokens").onclick = function () {
  // Scopes pre-selected, so the user grants exactly what is needed and can see
  // what that is before agreeing to it.
  window.open("https://github.com/settings/tokens/new?scopes=repo,workflow&description=CloseNI", "_blank");
};

$("gh-sign-in").onclick = async function () {
  const box = $("gh-token");
  const token = box.value.trim();
  if (!token) { toast("Paste a token first", "err"); return; }
  const r = await window.api.ghSignIn(token);
  box.value = "";                      // never leave a credential in the DOM
  if (r && r.ok) {
    toast("Signed in as @" + (r.login || "?"));
    if (!r.persisted) toast("Token kept in memory only - see the note", "err");
    await refreshGitHub();
  } else {
    toast((r && r.error) || "Sign-in failed", "err");
  }
};

$("gh-sign-out").onclick = async function () {
  await window.api.ghSignOut();
  toast("Signed out");
  await refreshGitHub();
};

$("gh-create-repo").onclick = async function () {
  const name = $("gh-new-repo").value.trim();
  if (!name) { toast("Name it first", "err"); return; }
  const r = await window.api.ghCall("createRepo", [name, true]);
  if (r && r.ok) { toast("Created " + name); $("gh-new-repo").value = ""; await refreshGitHub(); }
  else toast((r && r.error) || "Could not create it", "err");
};

function currentRepo() {
  const sel = $("gh-repo");
  const url = (sel && sel.value) || $("remote-url").value;
  return window.CNGit ? window.CNGit.parseRepoUrl(url) : null;
}

async function refreshRuns() {
  const box = $("gh-runs");
  const repo = currentRepo();
  if (!box || !repo) return;
  const r = await window.api.ghCall("listRuns", [repo.owner, repo.repo]);
  box.innerHTML = "";
  if (!r || !r.ok) { box.textContent = (r && r.error) || "Could not list runs."; return; }
  (r.result || []).forEach(function (run) {
    const el = document.createElement("div");
    // in_progress carries no conclusion yet, so status is what to colour by.
    const state = run.status === "completed" ? (run.conclusion || "unknown") : "running";
    el.className = "gh-run " + state;
    el.innerHTML = '<span class="name">' + escapeHtml(run.name || "workflow") + "</span>" +
      '<span class="verdict">' + escapeHtml(state) + "</span>";
    box.appendChild(el);
  });
  if (!(r.result || []).length) box.textContent = "No runs yet.";
}

$("gh-refresh-runs").onclick = refreshRuns;

$("gh-dispatch").onclick = async function () {
  const repo = currentRepo();
  const wf = $("gh-workflow").value.trim();
  if (!repo) { toast("Pick a repository first", "err"); return; }
  if (!wf) { toast("Name the workflow file", "err"); return; }
  const r = await window.api.ghCall("dispatchWorkflow", [repo.owner, repo.repo, wf, "main"]);
  // A missing `workflow` scope arrives as a 403, and the client already says
  // that is usually a scope problem rather than a generic refusal.
  if (r && r.ok) { toast("Triggered " + wf); setTimeout(refreshRuns, 3000); }
  else toast((r && r.error) || "Could not trigger it", "err");
};

async function g(args) { return await window.api.git({ args: args, cwd: workspace }); }
$("git-init").onclick = async function () { if (workspace) await g(["init", "-b", "main"]); else toast("Pick a workspace", "err"); };
$("git-status").onclick = async function () { if (workspace) await g(["status", "--short"]); else toast("Pick a workspace", "err"); };
$("git-commit").onclick = async function () {
  if (!workspace) { toast("Pick a workspace", "err"); return; }
  const msg = $("commit-msg").value.trim() || "AI: automated changes";
  await g(["add", "-A"]);
  await g(["commit", "-m", msg]);
};
$("git-push").onclick = async function () {
  if (!workspace) { toast("Pick a workspace", "err"); return; }
  const remote = $("remote-url").value.trim();
  if (remote) { await g(["remote", "remove", "origin"]); await g(["remote", "add", "origin", remote]); }
  const r = await g(["push", "-u", "origin", "main"]);
  if (r && r.success) { flowSeen.shipped = true; refreshFlow(); }
};
