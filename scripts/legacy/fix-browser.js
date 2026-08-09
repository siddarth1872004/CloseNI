const fs = require('fs');
const path = require('path');

console.log('FIXING: Browser visibility + Builder QoL...\n');

// Fix 1: Browser visibility
const controllerPath = path.join(__dirname, 'local-agent/src/providers/playwright-controller.ts');
let controller = fs.readFileSync(controllerPath, 'utf-8');

controller = controller.replace(
  'private chatUrlFile: string;',
  'private chatUrlFile: string;\n  private isHeaded: boolean;'
);

controller = controller.replace(
  'constructor(config: ProviderConfig) {\n    const storageDir = path.join(config.profileDir, "..", "..");',
  'constructor(config: ProviderConfig) {\n    this.isHeaded = process.env.AGENT_HEADED === "1";\n    const storageDir = path.join(config.profileDir, "..", "..");'
);

controller = controller.replace(
  'const isHeadless = process.env.AGENT_HEADED !== "1";',
  'const isHeadless = !this.isHeaded;'
);

controller = controller.replace(
  'console.log("Launching browser (" + (isHeadless ? "headless" : "headed") + ") for " + config.name + "...");',
  'console.log("Launching browser (" + (isHeadless ? "headless" : "HEADED") + ") for " + config.name + "...");'
);

controller = controller.replace(
  'const maxWait = 90000;  // 90 seconds max (fail fast)',
  'const maxWait = 120000;  // 120 seconds for builds'
);

controller = controller.replace(
  'console.log("Waiting for AI response (90s timeout)...");',
  'console.log("Waiting for AI response (120s timeout)...");'
);

fs.writeFileSync(controllerPath, controller, 'utf-8');
console.log('  OK controller (browser visibility + 120s timeout)');

// Fix 2: Builder QoL
const rendererPath = path.join(__dirname, 'desktop/renderer.js');
let renderer = fs.readFileSync(rendererPath, 'utf-8');

renderer = renderer.replace(
  'let buildRunning = false;',
  'let buildRunning = false;\nlet buildPaused = false;\nlet skipCurrentStep = false;'
);

renderer = renderer.replace(
  '<button id="builder-stop" class="btn" style="margin-top:6px;">Stop</button>',
  '<button id="builder-pause" class="btn" style="margin-top:6px;display:none;">Pause</button>\n          <button id="builder-resume" class="btn" style="margin-top:6px;display:none;">Resume</button>\n          <button id="builder-skip" class="btn" style="margin-top:6px;display:none;">Skip Step</button>\n          <button id="builder-stop" class="btn" style="margin-top:6px;">Stop</button>'
);

renderer = renderer.replace(
  '\builder-stop.onclick = function () {',
  '\builder-pause.onclick = function () {\n  buildPaused = true;\n  \builder-pause.style.display = "none";\n  \builder-resume.style.display = "block";\n  toast("Build paused");\n};\n\n\builder-resume.onclick = function () {\n  buildPaused = false;\n  \builder-resume.style.display = "none";\n  \builder-pause.style.display = "block";\n  toast("Build resumed");\n};\n\n\builder-skip.onclick = function () {\n  skipCurrentStep = true;\n  toast("Skipping current step");\n};\n\n\builder-stop.onclick = function () {'
);

renderer = renderer.replace(
  'buildRunning = true;',
  'buildRunning = true;\n  buildPaused = false;\n  skipCurrentStep = false;\n  \builder-start.style.display = "none";\n  \builder-pause.style.display = "block";\n  \builder-skip.style.display = "block";'
);

renderer = renderer.replace(
  'buildRunning = false;\n  log("plan execution finished", "step");',
  'buildRunning = false;\n  \builder-start.style.display = "block";\n  \builder-pause.style.display = "none";\n  \builder-resume.style.display = "none";\n  \builder-skip.style.display = "none";\n  log("plan execution finished", "step");'
);

renderer = renderer.replace(
  'const args = ["browser", stepDetail, workspace, provider, "ask", String(i), stepDetail, currentPlan.summary || ""];',
  'while (buildPaused) {\n      await new Promise(r => setTimeout(r, 1000));\n      if (!buildRunning) break;\n    }\n    \n    if (skipCurrentStep) {\n      skipCurrentStep = false;\n      setStepStatus(i, "skipped");\n      log("step " + (k + 1) + " skipped", "step");\n      toast("Step skipped");\n      continue;\n    }\n    \n    const args = ["browser", stepDetail, workspace, provider, "ask", String(i), stepDetail, currentPlan.summary || ""];'
);

renderer = renderer.replace(
  's.result = { files: (res.appliedFiles || []).map(function (f) { return { path: f, mode: "create", content: "[see workspace: " + f + "]" }; }) };',
  'const filesArr = [];\n      for (const af of (res.appliedFiles || [])) {\n        let content = "[click to load]";\n        try {\n          const fr = await window.api.readFile(workspace + "/" + af);\n          if (fr && fr.ok) content = fr.text + (fr.truncated ? "\\n... (truncated)" : "");\n        } catch (e) { content = "[error: " + e + "]"; }\n        filesArr.push({ path: af, mode: "written", content: content });\n      }\n      s.result = { files: filesArr };'
);

fs.writeFileSync(rendererPath, renderer, 'utf-8');
console.log('  OK renderer (pause/resume/skip + file preview)');

console.log('\nDone!\n');
