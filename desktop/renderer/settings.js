/*
 * The Settings panel: the permission policy, section switching, the theme
 * picker, extraction and "show the welcome again".
 */
// Persist the permission policy: a setting that resets on restart is a nuisance.
(function () {
  const sel = $("autonomy-select");
  if (!sel) return;
  try { const saved = localStorage.getItem("closeni.autonomy"); if (saved) sel.value = saved; } catch (e) {}
  sel.onchange = function () { try { localStorage.setItem("closeni.autonomy", sel.value); } catch (e) {} };
})();

// Settings section switching. Same shape as switchTab, scoped to the panel.
document.querySelectorAll(".settings-tab").forEach(function (tab) {
  tab.onclick = function () {
    const want = tab.dataset.section;
    document.querySelectorAll(".settings-tab").forEach(function (t) {
      t.classList.toggle("active", t.dataset.section === want);
    });
    document.querySelectorAll(".settings-section").forEach(function (s) {
      s.classList.toggle("active", s.dataset.section === want);
    });
  };
});

/**
 * The theme picker.
 *
 * A theme is one attribute on <html>; the styling is entirely CSS. The
 * attribute is also written by an inline script in <head>, so the app never
 * paints Midnight for a frame before switching.
 */
(function () {
  const grid = $("theme-grid");
  if (!grid || !window.CNTheme) return;
  const T = window.CNTheme;

  function saved(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; }
  }
  let current = T.resolveTheme(saved(T.THEME_KEY, null));

  function apply(id) {
    current = T.resolveTheme(id);
    document.documentElement.setAttribute("data-theme", current);
    try { localStorage.setItem(T.THEME_KEY, current); } catch (e) {}
    grid.querySelectorAll(".theme-swatch").forEach(function (s) {
      s.classList.toggle("active", s.dataset.theme === current);
    });
    // The decoration toggle is meaningless on a theme with no texture.
    const meta = T.THEMES.find(function (t) { return t.id === current; });
    const row = $("decor-row");
    if (row) row.style.display = meta && meta.decor ? "" : "none";
  }

  T.THEMES.forEach(function (t) {
    const s = document.createElement("button");
    s.className = "theme-swatch";
    s.dataset.theme = t.id;
    s.title = t.name;
    // The swatch carries the attribute itself, so the tokens inside it resolve
    // to the theme it selects rather than the one currently applied - each
    // swatch previews its own palette.
    s.setAttribute("data-theme", t.id);
    const chip = document.createElement("span");
    chip.className = "theme-swatch-chip";
    const name = document.createElement("span");
    name.className = "theme-swatch-name";
    name.textContent = t.name;
    s.appendChild(chip); s.appendChild(name);
    s.onclick = function () { apply(t.id); };
    grid.appendChild(s);
  });

  const decor = $("theme-decor");
  if (decor) {
    decor.checked = saved(T.DECOR_KEY, "on") !== "off";
    document.documentElement.setAttribute("data-decor", decor.checked ? "on" : "off");
    decor.onchange = function () {
      document.documentElement.setAttribute("data-decor", decor.checked ? "on" : "off");
      try { localStorage.setItem(T.DECOR_KEY, decor.checked ? "on" : "off"); } catch (e) {}
    };
  }

  apply(current);
})();

/**
 * Extraction settings. Saved to a file the main process reads at every agent
 * spawn; Check and Download test what is typed, before it is saved, so a wrong
 * interpreter path is found here rather than in the middle of a plan.
 */
(function () {
  const X = window.CNExtraction;
  const status = $("extract-status");
  function read() {
    return X.normalize({
      backend: $("extract-backend").value,
      python: $("extract-python").value,
      weights: $("extract-weights").value,
      minConfidence: $("extract-confidence").value,
    });
  }
  function show(s) {
    $("extract-backend").value = s.backend;
    $("extract-python").value = s.python;
    $("extract-weights").value = s.weights;
    $("extract-confidence").value = String(s.minConfidence);
    $("extract-needle").style.display = s.backend === "needle" ? "" : "none";
    $("extract-check").disabled = s.backend !== "needle";
    $("extract-warm").disabled = s.backend !== "needle";
  }
  function check(warm) {
    status.textContent = warm ? "Downloading the model - this can take a few minutes..." : "Checking...";
    $("extract-check").disabled = true;
    $("extract-warm").disabled = true;
    return window.api.checkExtraction(read(), warm).then(function (r) {
      status.textContent = X.describeCheck(r);
    }, function (e) {
      status.textContent = "Check failed: " + String(e);
    }).then(function () { show(read()); });
  }
  $("extract-backend").onchange = function () { show(read()); status.textContent = ""; };
  $("extract-save").onclick = function () {
    window.api.writeExtraction(read()).then(function (r) {
      if (r && r.ok) { show(r.settings); status.textContent = ""; toast("Extraction settings saved"); }
      else status.textContent = "Could not save: " + ((r && r.error) || "unknown error");
    });
  };
  $("extract-check").onclick = function () { check(false); };
  $("extract-warm").onclick = function () { check(true); };
  window.api.readExtraction().then(function (r) { show(r && r.ok ? r.settings : X.DEFAULTS); },
    function () { show(X.DEFAULTS); });
})();

$("welcome-reset").onclick = function () {
  try { localStorage.removeItem(window.CNOnboarding.DISMISS_KEY); } catch (e) {}
  renderOnboarding();
  const state = onboardingState();
  if (window.CNOnboarding.visible(state, false)) switchTab("chat");
  else toast("Nothing left to set up - every step is done");
};
