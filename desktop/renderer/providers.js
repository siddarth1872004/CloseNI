/*
 * The provider picker's controls: which model and options each provider
 * offers, and what the user chose. The picker itself is filled at launch, in
 * startup.js.
 */
// The picker lists whatever is enabled in local-agent/config/providers, so
// adding a provider is a JSON file rather than a markup edit.
let providerList = [];

/** Where a provider's chosen settings live. Per provider: a model name means
 *  nothing to a different one. */
function controlsKey(id) { return "closeni.controls." + id; }

function savedControls(id) {
  try { return JSON.parse(localStorage.getItem(controlsKey(id)) || "{}") || {}; } catch (e) { return {}; }
}

/**
 * What to ask the provider for on the next run: the user's saved choices,
 * validated against what the provider still declares, with defaults filling the
 * gaps. Empty for a provider with no controls, which the agent reads as
 * "change nothing".
 */
function desiredControls() {
  const p = providerList.find(function (x) { return x.id === provider; });
  if (!p || !p.controls || !p.controls.length) return {};
  return window.CNControls.resolveControls(p.controls, savedControls(provider));
}

/**
 * Build the sidebar panel from whatever the selected provider declares.
 *
 * The user chooses and the agent applies. Deciding a model per task would be an
 * invisible decision - the kind you only discover by reading a log.
 */
/**
 * Draw the selected provider's controls.
 *
 * Rendered twice - once in Settings and once in the rail - because switching
 * model or turning deep thinking off is something people do between prompts,
 * and burying it two tabs deep meant it never got used. Both copies write to
 * the same stored value and are redrawn together, so they cannot disagree.
 */
function renderProviderControls(hostId, compact) {
  const host = $(hostId || "provider-controls");
  if (!host) return;
  host.innerHTML = "";
  const p = providerList.find(function (x) { return x.id === provider; });
  if (!p || !p.controls || !p.controls.length) return;

  const current = desiredControls();
  // Ids must be unique across both copies or the labels point at each other.
  const idPrefix = "ctl-" + (compact ? "rail-" : "set-");
  // No heading in the rail: every control already carries its own label, and
  // "Model" sitting directly above "Mode" read as a mislabelled field.
  if (!compact) {
    const head = document.createElement("div");
    head.className = "micro";
    head.style.marginTop = "14px";
    head.textContent = "Provider settings";
    host.appendChild(head);
  }

  function save(id, value) {
    const next = savedControls(provider);
    next[id] = value;
    try { localStorage.setItem(controlsKey(provider), JSON.stringify(next)); } catch (e) {}
    // Redraw the other copy so the two never drift apart.
    renderAllProviderControls();
  }

  p.controls.forEach(function (c) {
    if (c.kind === "select") {
      const label = document.createElement("div");
      label.className = "micro";
      label.style.marginTop = "8px";
      label.textContent = c.label;
      host.appendChild(label);

      const s = document.createElement("select");
      (c.options || []).forEach(function (o) {
        const opt = document.createElement("option");
        opt.value = o.value;
        opt.textContent = o.label || o.value;
        s.appendChild(opt);
      });
      if (current[c.id] !== undefined) s.value = current[c.id];
      s.onchange = function () { save(c.id, s.value); };
      host.appendChild(s);
      return;
    }

    if (c.kind === "toggle") {
      const row = document.createElement("div");
      row.className = compact ? "rail-toggle" : "";
      if (!compact) row.style.cssText = "display:flex;align-items:center;gap:6px;margin-top:8px;";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.id = idPrefix + c.id;
      box.style.cssText = "width:auto;flex:none;accent-color:var(--txt);";
      box.checked = current[c.id] === true;
      box.onchange = function () { save(c.id, box.checked); };
      const lab = document.createElement("label");
      lab.setAttribute("for", box.id);
      lab.style.cssText = "font-size:11px;color:var(--dim);cursor:pointer;";
      lab.textContent = c.label;
      row.appendChild(box); row.appendChild(lab);
      host.appendChild(row);
    }
  });
}

function renderAllProviderControls() {
  renderProviderControls("provider-controls", false);
  renderProviderControls("rail-controls", true);
}
