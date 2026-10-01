/*
 * What the Settings panel reads and writes: extraction, skills and personas,
 * and the MCP servers whose context goes into a run.
 */
const fs = require("fs");
const path = require("path");
const { ipcMain } = require("electron");
const GH = require("../github-safe.js");
const EXTRACT = require("../extraction-settings.js");

/** Registers the handlers. main.js hands in unpackedPath, storageRoot, spawnAgent, gh, currentToken. */
module.exports = function settings(main) {
  const { unpackedPath, storageRoot, spawnAgent, gh, currentToken } = main;

  const SKILLS = require(unpackedPath(path.join("local-agent", "dist", "skill-store.js")));
  const MCPCTX = require(unpackedPath(path.join("local-agent", "dist", "mcp", "mcp-context.js")));

  function skillDirFor(kind) {
    return kind === "persona" ? SKILLS.personasDir(storageRoot()) : SKILLS.skillsDir(storageRoot());
  }
  function mcpConfigPath() { return path.join(storageRoot(), "mcp.json"); }

  function extractionPath() { return path.join(storageRoot(), "extraction.json"); }

  function readExtraction() {
    try { return EXTRACT.normalize(JSON.parse(fs.readFileSync(extractionPath(), "utf-8"))); }
    catch (e) { return EXTRACT.normalize(null); }
  }

  ipcMain.handle("read-extraction", function () {
    return { ok: true, settings: readExtraction() };
  });

  ipcMain.handle("write-extraction", function (event, raw) {
    try {
      const settings = EXTRACT.normalize(raw);
      fs.writeFileSync(extractionPath(), JSON.stringify(settings, null, 2));
      return { ok: true, settings: settings };
    } catch (e) { return { ok: false, error: String(e) }; }
  });

  /*
   * Check the settings as typed, before they are saved. Not queued behind other
   * agent runs: it opens no browser profile, only the Python bridge, so it cannot
   * contend with a build. The agent bounds every step of it, the optional model
   * download included.
   */
  ipcMain.handle("check-extraction", function (event, payload) {
    const settings = EXTRACT.normalize(payload && payload.settings);
    const args = ["extractor-check"].concat(payload && payload.warm ? ["warm"] : []);
    return new Promise(function (resolve) {
      let proc;
      const env = Object.assign({ CLOSENI_EXTRACTOR: "builtin" }, EXTRACT.toEnv(settings));
      try { proc = spawnAgent(args, env); }
      catch (e) { resolve({ success: false, error: String(e) }); return; }
      let out = "";
      proc.stdout.on("data", function (d) { out += d.toString(); });
      proc.on("close", function () {
        const start = out.indexOf("AGENT_OUTPUT_START");
        const end = out.indexOf("AGENT_OUTPUT_END");
        let result = null;
        if (start !== -1 && end !== -1) {
          const lines = out.substring(start + 18, end).split(/\r?\n/)
            .map(function (l) { return l.trim(); })
            .filter(function (l) { return l.indexOf("{") === 0; });
          if (lines.length) { try { result = JSON.parse(lines[lines.length - 1]); } catch (e) {} }
        }
        resolve(result || { success: false, error: "no answer from the agent" });
      });
      proc.on("error", function (e) { resolve({ success: false, error: String(e) }); });
    });
  });

  ipcMain.handle("list-skills", function () {
    return {
      ok: true,
      personas: SKILLS.listMarkdown(SKILLS.personasDir(storageRoot())),
      skills: SKILLS.listMarkdown(SKILLS.skillsDir(storageRoot())),
    };
  });

  ipcMain.handle("read-skill", function (event, p) {
    try {
      if (!SKILLS.isSafeName(p.name)) return { ok: false, error: "bad name" };
      return { ok: true, text: fs.readFileSync(path.join(skillDirFor(p.kind), p.name + ".md"), "utf-8") };
    } catch (e) { return { ok: false, error: String(e) }; }
  });

  ipcMain.handle("write-skill", function (event, p) {
    try {
      // Refused rather than sanitised: a sanitised name writes a different file
      // than the one the user asked for, and the name arrives from the renderer.
      if (!SKILLS.isSafeName(p.name)) {
        return { ok: false, error: "A name may only contain letters, numbers, dot, dash and underscore, and cannot start with a dot." };
      }
      const dir = skillDirFor(p.kind);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, p.name + ".md"), String(p.text || ""));
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  });

  ipcMain.handle("delete-skill", function (event, p) {
    try {
      if (!SKILLS.isSafeName(p.name)) return { ok: false, error: "bad name" };
      fs.rmSync(path.join(skillDirFor(p.kind), p.name + ".md"), { force: true });
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  });

  ipcMain.handle("import-skill", async function (event, p) {
    try {
      const text = await gh.getFile(p.owner, p.repo, p.path);
      const name = String(p.path).split("/").pop().replace(/\.md$/i, "");
      if (!SKILLS.isSafeName(name)) return { ok: false, error: "That file's name cannot be used as a skill name." };
      const dir = skillDirFor(p.kind || "skill");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name + ".md"), text);
      return { ok: true, name: name };
    } catch (e) { return { ok: false, error: GH.redactToken(String(e && e.message), currentToken()) }; }
  });

  ipcMain.handle("read-mcp-config", function () {
    try { return { ok: true, text: fs.readFileSync(mcpConfigPath(), "utf-8") }; }
    catch (e) { return { ok: true, text: "" }; }
  });

  ipcMain.handle("write-mcp-config", function (event, text) {
    try {
      fs.mkdirSync(storageRoot(), { recursive: true });
      fs.writeFileSync(mcpConfigPath(), String(text || ""));
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  });

  /**
   * Run the configured MCP calls once, before a build.
   *
   * An MCP server is an arbitrary subprocess the user configured, and this is
   * where the app runs one. That is what MCP is, but it is a new category of
   * thing this app executes and it is worth naming: a malicious mcp.json is a
   * malicious program.
   *
   * Nothing here can fail a build - gatherContext returns notes instead of
   * throwing, and no configuration at all is the common case.
   */
  ipcMain.handle("gather-mcp-context", async function () {
    try {
      let raw = "";
      try { raw = fs.readFileSync(mcpConfigPath(), "utf-8"); }
      catch (e) { return { ok: true, texts: [], notes: [] }; }
      const res = await MCPCTX.gatherContext(MCPCTX.parseMcpConfig(raw));
      return { ok: true, texts: res.texts, notes: res.notes };
    } catch (e) { return { ok: true, texts: [], notes: [String(e)] }; }
  });

  return { readExtraction };
};
