const fs = require("fs");
const path = require("path");

console.log("FIXING: Browser visibility + Builder QoL + Performance...\n");

// ---------- 1. Fix browser visibility bug (read env var in constructor) ----------
const controllerPath = path.join(__dirname, "local-agent", "src", "providers", "playwright-controller.ts");
let controller = fs.readFileSync(controllerPath, "utf-8");

// Store headed state in class
controller = controller.replace(
  'private chatUrlFile: string;',
  'private chatUrlFile: string;\n  private isHeaded: boolean;'
);

// Read env var in constructor
controller = controller.replace(
  'constructor(config: ProviderConfig) {\n    const storageDir = path.join(config.profileDir, "..", "..");',
  'constructor(config: ProviderConfig) {\n    this.isHeaded = process.env.AGENT_HEADED === "1";\n    const storageDir = path.join(config.profileDir, "..", "..");'
);

// Use stored state in launch
controller = controller.replace(
  'const isHeadless = process.env.AGENT_HEADED !== "1";',
  'const isHeadless = !this.isHeaded;'
);

controller = controller.replace(
  'console.log("Launching browser (" + (isHeadless ? "headless" : "headed") + ") for " + config.name + "...");',
  'console.log("Launching browser (" + (isHeadless ? "headless" : "HEADED") + ") for " + config.name + "...");'
);

// Increase build timeout from 90s to 120s
controller = controller.replace(
  'const maxWait = 90000;  // 90 seconds max (fail fast)',
  'const maxWait = 120000;  // 120 seconds for builds'
);

controller = controller.replace(
  'console.log("Waiting for AI response (90s timeout)...");',
  'console.log("Waiting for AI response (120s timeout)...");'
);

controller = controller.replace(
  'console.log("Timeout after 90s - DeepSeek may be overloaded or slow. Extracting partial response.");',
  'console.log("Timeout after 120s - AI may be slow or overloaded.");'
);

fs.writeFileSync(controllerPath, controller, "utf-8");
console.log("  OK controller (fixed browser visibility + 120s timeout)");

// ---------- 2. Rewrite renderer.js with Builder QoL features ----------
const rendererPath = path.join(__dirname, "desktop", "renderer.js");
let renderer = fs.readFileSync(rendererPath, "utf-8");

// Add build state management
renderer = renderer.replace(
  'let buildRunning = false;',
  `let buildRunning = false;
let buildPaused = false;
let skipCurrentStep = false;`
);

// Add pause/resume/skip buttons to builder UI
renderer = renderer.replace(
  '<button id="builder-start" class="btn invert" style="margin-top:auto;">Start Build</button>\n          <button id="builder-stop" class="btn" style="margin-top:6px;">Stop</button>',
  `<button id="builder-start" class="btn invert" style="margin-top:auto;">Start Build</button>
          <button id="builder-pause" class="btn" style="margin-top:6px;display:none;">Pause</button>
          <button id="builder-resume" class="btn" style="margin-top:6px;display:none;">Resume</button>
          <button id="builder-skip" class="btn" style="margin-top:6px;display:none;">Skip Step</button>
          <button id="builder-stop" class="btn" style="margin-top:6px;">Stop</button>`
);

// Add pause handler
renderer = renderer.replace(
  '$("builder-stop").onclick = function () {',
  `$("builder-pause").onclick = function () {
  buildPaused = true;
  $("builder-pause").style.display = "none";
  $("builder-resume").style.display = "block";
  toast("Build paused - click Resume to continue");
  log("Build paused", "step");
};

$("builder-resume").onclick = function () {
  buildPaused = false;
  $("builder-resume").style.display = "none";
  $("builder-pause").style.display = "block";
  toast("Build resumed");
  log("Build resumed", "step");
};

$("builder-skip").onclick = function () {
  skipCurrentStep = true;
  toast("Skipping current step after it completes");
};

$("builder-stop").onclick = function () {`
);

// Update builder start to show/hide buttons
renderer = renderer.replace(
  'buildRunning = true;',
  `buildRunning = true;
  buildPaused = false;
  skipCurrentStep = false;
  $("builder-start").style.display = "none";
  $("builder-pause").style.display = "block";
  $("builder-skip").style.display = "block";`
);

renderer = renderer.replace(
  'buildRunning = false;\n  log("plan execution finished", "step");',
  `buildRunning = false;
  $("builder-start").style.display = "block";
  $("builder-pause").style.display = "none";
  $("builder-resume").style.display = "none";
  $("builder-skip").style.display = "none";
  log("plan execution finished", "step");`
);

// Add pause check in build loop
renderer = renderer.replace(
  'const args = ["browser", stepDetail, workspace, provider, "ask", String(i), stepDetail, currentPlan.summary || ""];',
  `// Check if paused
    while (buildPaused) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (!buildRunning) break;
    }
    
    if (skipCurrentStep) {
      skipCurrentStep = false;
      setStepStatus(i, "skipped");
      log("step " + (k + 1) + " skipped by user", "step");
      toast("Step " + (k + 1) + " skipped");
      continue;
    }
    
    const args = ["browser", stepDetail, workspace, provider, "ask", String(i), stepDetail, currentPlan.summary || ""];`
);

fs.writeFileSync(rendererPath, renderer, "utf-8");
console.log("  OK renderer (pause/resume/skip buttons)");

// ---------- 3. Add real-time file preview to builder cards ----------
let renderer2 = fs.readFileSync(rendererPath, "utf-8");

renderer2 = renderer2.replace(
  'setStepStatus(i, "done");\n      log("step " + (k + 1) + " done: " + (res.appliedFiles || []).join(", "), "ok");',
  `setStepStatus(i, "done");
      
      // Load real file contents for preview
      const filesArr = [];
      for (const af of (res.appliedFiles || [])) {
        let content = "[click to load]";
        try {
          const fr = await window.api.readFile(workspace + "/" + af);
          if (fr && fr.ok) {
            content = fr.text;
            if (fr.truncated) content += "\\n\\n... (truncated)";
          }
        } catch (e) {
          content = "[could not load: " + e + "]";
        }
        filesArr.push({ path: af, mode: "written", content: content });
      }
      s.result = { files: filesArr };
      
      log("step " + (k + 1) + " done: " + (res.appliedFiles || []).join(", "), "ok");`
);

fs.writeFileSync(rendererPath, renderer2, "utf-8");
console.log("  OK renderer (real-time file preview)");

console.log("\nDone. Rebuild + launch.\n");
