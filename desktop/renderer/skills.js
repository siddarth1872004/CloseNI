
/**
 * The persona and skills the user has ticked.
 *
 * Selections live in localStorage; the files on disk are the source of truth,
 * so a skill deleted outside the app simply stops being read rather than
 * leaving a dangling reference.
 */
let selectedSkills = [];
try { selectedSkills = JSON.parse(localStorage.getItem("closeni.skills") || "[]") || []; } catch (e) {}
let selectedPersona = "";
try { selectedPersona = localStorage.getItem("closeni.persona") || ""; } catch (e) {}

async function refreshSkills() {
  if (!window.api.listSkills) return;
  const r = await window.api.listSkills().catch(function () { return null; });
  if (!r || !r.ok) return;

  const sel = $("persona-select");
  sel.innerHTML = '<option value="">(none)</option>';
  r.personas.forEach(function (n) {
    const o = document.createElement("option");
    o.value = n; o.textContent = n; o.selected = n === selectedPersona;
    sel.appendChild(o);
  });
  sel.onchange = function () {
    selectedPersona = sel.value;
    try { localStorage.setItem("closeni.persona", selectedPersona); } catch (e) {}
  };

  const list = $("skill-list");
  list.innerHTML = "";
  if (!r.skills.length) {
    list.innerHTML = '<div class="hint">No skills yet. Create one below, or import from GitHub.</div>';
  }
  r.skills.forEach(function (n) {
    const row = document.createElement("div");
    row.className = "settings-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = "skill-cb-" + n;
    cb.checked = selectedSkills.indexOf(n) !== -1;
    cb.onchange = function () {
      selectedSkills = cb.checked
        ? selectedSkills.concat([n])
        : selectedSkills.filter(function (x) { return x !== n; });
      try { localStorage.setItem("closeni.skills", JSON.stringify(selectedSkills)); } catch (e) {}
    };
    const name = document.createElement("label");
    name.setAttribute("for", cb.id);
    name.textContent = n;
    // Clicking the name opens it, which is what people reach for; the label's
    // own "for" still toggles the box, so both gestures do something.
    name.ondblclick = async function () {
      const got = await window.api.readSkill("skill", n);
      if (got && got.ok) { $("skill-editor").value = got.text; $("skill-editor").dataset.name = n; }
    };
    const edit = document.createElement("button");
    edit.className = "btn btn-sm";
    edit.textContent = "edit";
    edit.onclick = async function () {
      const got = await window.api.readSkill("skill", n);
      if (got && got.ok) { $("skill-editor").value = got.text; $("skill-editor").dataset.name = n; }
    };
    row.appendChild(cb); row.appendChild(name); row.appendChild(edit);
    list.appendChild(row);
  });

  const mcp = await window.api.readMcpConfig().catch(function () { return null; });
  if (mcp && mcp.ok) $("mcp-config").value = mcp.text || "";
}

$("skill-new").onclick = async function () {
  const name = $("skill-new-name").value.trim();
  if (!name) { toast("Name it first", "err"); return; }
  const r = await window.api.writeSkill("skill", name, "");
  if (!r.ok) { toast(r.error, "err"); return; }
  $("skill-new-name").value = "";
  $("skill-editor").value = "";
  $("skill-editor").dataset.name = name;
  await refreshSkills();
};

$("skill-save").onclick = async function () {
  const name = $("skill-editor").dataset.name;
  if (!name) { toast("Select a skill first", "err"); return; }
  const r = await window.api.writeSkill("skill", name, $("skill-editor").value);
  toast(r.ok ? "Saved " + name : (r.error || "Could not save"), r.ok ? "" : "err");
};

$("skill-delete").onclick = async function () {
  const name = $("skill-editor").dataset.name;
  if (!name) return;
  if (!confirm("Delete the skill \"" + name + "\"? The file is removed from disk.")) return;
  await window.api.deleteSkill("skill", name);
  $("skill-editor").value = "";
  delete $("skill-editor").dataset.name;
  selectedSkills = selectedSkills.filter(function (x) { return x !== name; });
  try { localStorage.setItem("closeni.skills", JSON.stringify(selectedSkills)); } catch (e) {}
  await refreshSkills();
};

$("skill-import-go").onclick = async function () {
  const raw = $("skill-import").value.trim();
  const m = raw.match(/^([^/]+)\/([^/]+)\/(.+\.md)$/i);
  if (!m) { toast("Use owner/repo/path/to/file.md", "err"); return; }
  const r = await window.api.importSkill({ owner: m[1], repo: m[2], path: m[3], kind: "skill" });
  if (!r.ok) { toast(r.error || "Import failed", "err"); log("skill import failed: " + r.error, "err"); return; }
  $("skill-import").value = "";
  log("imported skill: " + r.name, "ok");
  await refreshSkills();
};

$("mcp-save").onclick = async function () {
  const text = $("mcp-config").value;
  // Parsed here so a typo is caught now rather than by a build that depends on it.
  if (text.trim()) {
    try { JSON.parse(text); }
    catch (e) { toast("That is not valid JSON", "err"); return; }
  }
  const r = await window.api.writeMcpConfig(text);
  toast(r.ok ? "MCP configuration saved" : (r.error || "Could not save"), r.ok ? "" : "err");
};

/**
 * Everything the model should be told before the task, for this run.
 *
 * MCP tools run here - once, before the run - rather than per step. A tool
 * whose answer changes mid-build is therefore read once, which is recorded in
 * the design as the known cost of not paying a browser round-trip per call.
 */
async function buildPreamble() {
  const parts = {};
  try {
    if (selectedPersona) {
      const p = await window.api.readSkill("persona", selectedPersona);
      if (p && p.ok && p.text.trim()) parts.persona = p.text;
    }
    const skills = [];
    for (const n of selectedSkills) {
      const s = await window.api.readSkill("skill", n);
      if (s && s.ok && s.text.trim()) skills.push(s.text);
    }
    if (skills.length) parts.skills = skills;

    const mcp = await window.api.gatherMcpContext();
    if (mcp && mcp.texts && mcp.texts.length) parts.mcpContext = mcp.texts;
    (mcp && mcp.notes ? mcp.notes : []).forEach(function (n) { log("mcp: " + n, "err"); });
  } catch (e) {
    // A preamble that cannot be assembled means the behaviour before any of
    // this was configured, which is a working run.
    log("preamble unavailable: " + String(e), "err");
    return {};
  }
  return parts;
}
