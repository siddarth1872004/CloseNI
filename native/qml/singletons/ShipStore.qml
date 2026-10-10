pragma Singleton
import QtQuick
import CloseNI
import "../js/api.mjs" as Api
import "../js/renderer-logic.mjs" as R
import "../js/github-safe.mjs" as Safe
import "../js/entrypoint.mjs" as Entry
import "../js/preview-target.mjs" as Preview

/*
 * The Test, Research and Ship panels' state and actions. Each panel is a Loader that exists only while it is shown, so the
 * run results, the history, the research answer and the GitHub state live
 * here: leaving a panel and coming back loses nothing.
 *
 * The decisions are in js/renderer-logic.mjs (shared with the unit tests);
 * this holds the state and talks to the services.
 */
QtObject {
    id: store

    // ======================================================================
    // Agent runs, carrying whatever the user has configured (plan.js runAgent)
    // ======================================================================

    /**
     * The persona, the ticked skills and the MCP context (skills.js
     * buildPreamble). Read from Prefs at call time, so a change in Settings
     * applies to the next run.
     */
    function buildPreamble() {
        var parts = {}
        var persona = Prefs.get("closeni.persona", "")
        var skills = R.parseSkills(Prefs.get("closeni.skills", "[]"))
        var chain = Promise.resolve()
        if (persona) {
            chain = chain.then(function () { return Api.call(Library, "readSkill", "persona", persona) })
                         .then(function (p) { if (p && p.ok && String(p.text || "").trim()) parts.persona = p.text })
        }
        var texts = []
        skills.forEach(function (n) {
            chain = chain.then(function () { return Api.call(Library, "readSkill", "skill", n) })
                         .then(function (s) { if (s && s.ok && String(s.text || "").trim()) texts.push(s.text) })
        })
        return chain.then(function () {
            if (texts.length) parts.skills = texts
            return Api.call(Library, "gatherMcpContext")
        }).then(function (mcp) {
            if (mcp && mcp.texts && mcp.texts.length) parts.mcpContext = mcp.texts
            ;(mcp && mcp.notes ? mcp.notes : []).forEach(function (n) { Notify.log("mcp: " + n, "err") })
            return parts
        }).catch(function (e) {
            // A preamble that cannot be assembled means the behaviour before any of
            // this was configured, which is a working run.
            Notify.log("preamble unavailable: " + String(e), "err")
            return {}
        })
    }

    /**
     * One agent run. The preamble is built here rather than per step, because
     * it runs the configured MCP tools: per step it would pay a subprocess
     * launch twenty times for text that does not change during a build.
     */
    function runAgent(args) {
        return buildPreamble().then(function (preamble) {
            return Api.call(Agent, "runAgent", { args: args, headed: Providers.showBrowser,
                                                 controls: Providers.desiredControls(), preamble: preamble })
        }).catch(function (e) { return { success: false, error: String(e) } })
    }

    // ======================================================================
    // Test (test.js)
    // ======================================================================

    // The run bar: the command, where it came from (R.RUN_LABELS key), and the
    // command as last resolved, so an edit can be told from a refresh.
    property string runCommand: ""
    property string runResolved: ""
    property string runSource: ""
    readonly property string runBadge: runSource ? R.RUN_LABELS[runSource][0] : ""
    readonly property string runHint: runSource ? R.RUN_LABELS[runSource][1] : ""

    // The output column: the summary line, then rows { kind: "row", command,
    // success, language } and output blocks { kind: "output", text }.
    property string testSummary: ""
    property ListModel testResults: ListModel {}
    // A short list, not a log: enough that a syntax check does not vanish the
    // moment something else runs. [{ label, ok }], newest first, at most 6.
    property var testHistory: []
    property bool testing: false

    // The last run, carried into the chat automatically so nobody pastes a
    // traceback into a box sitting directly beneath that same traceback.
    property var lastRun: ({ command: "", output: "" })

    // The chat about the run: { who: "user"|"ai", text, markdown, applied }.
    // Bounded: this keeps the newest 200.
    readonly property int maxChat: 200
    property ListModel testChat: ListModel {}
    property bool asking: false

    // A command's output is shown whole up to this many characters; past it, the
    // tail, since that is where a failure says what went wrong. The whole run is
    // in the project log as it streams.
    readonly property int maxOutputChars: 200000

    // What the last run printed that a browser can show: { url, kind, ws } or null. The Build panel's preview
    // action reads it; there is no web view, so it opens in the system browser.
    property var runPreview: null

    function renderTestResults(rows, summary) {
        testSummary = summary || ""
        testResults.clear()
        // Language tokens from js/language-mark.mjs, so a check row is marked by
        // what it checked. The row's own text is a command and has nothing to
        // derive this from.
        ;(rows || []).forEach(function (r) {
            testResults.append({ kind: "row", command: String(r.command || ""), success: !!r.success,
                                 language: String(r.language || ""), text: "" })
        })
    }
    function renderTestOutput(text) {
        var t = String(text || "(no output)")
        if (t.length > maxOutputChars)
            t = "(" + (t.length - maxOutputChars) + " earlier characters not shown)\n" + t.slice(t.length - maxOutputChars)
        testResults.append({ kind: "output", command: "", success: false, language: "", text: t })
    }
    function pushHistory(label, ok) { testHistory = R.pushHistory(testHistory, label, ok) }
    function markRun(command, output) {
        lastRun = { command: command, output: output }
        AppState.markTested()
    }

    /** The files in the workspace, or [] when it cannot be read. */
    function listFiles(ws) {
        return Api.call(Files, "listFiles", ws).then(function (l) { return (l && l.files) || [] },
                                                      function () { return [] })
    }
    function readJsonFile(path) {
        return Api.call(Files, "readFile", { path: path, full: true }).then(function (r) {
            try { return r && r.ok ? JSON.parse(r.text) : null } catch (e) { return null }
        }, function () { return null })
    }

    /**
     * What to run, detected from the files: package.json's scripts, a
     * Makefile's run target, or the entry point's name.
     */
    function detectCommand(ws) {
        var files = [], pkg = null, makefile = null
        return listFiles(ws).then(function (f) {
            files = f
            // An unreadable package.json falls through to the file rules.
            if (files.indexOf("package.json") !== -1)
                return readJsonFile(ws + "/package.json").then(function (p) { pkg = p })
        }).then(function () {
            // An unreadable Makefile just means no `run` target.
            if (files.indexOf("Makefile") !== -1)
                return Api.call(Files, "readFile", { path: ws + "/Makefile", full: true }).then(function (mk) {
                    if (mk && mk.ok) makefile = mk.text
                })
        }).then(function () {
            return Entry.detectEntrypoint(files, pkg, { makefile: makefile }, App.platform)
        })
    }

    /**
     * The run command and where it came from: what you saved, the plan's, or
     * detected. The manifest wins, then the plan, then filename detection; the
     * badge says which, because "from your plan" and "detected from main.py" are
     * different levels of confidence. This is the fix for "no entry point
     * found" appearing when the app already knew.
     */
    function resolveRunCommand(ws) {
        if (!ws) return Promise.resolve({ command: null, source: "none" })
        var manifest = null
        return Api.call(Builds, "readManifest", ws).then(function (m) { manifest = m }, function () {})
            .then(function () { return detectCommand(ws) })
            .then(function (detected) { return R.chooseRunCommand(ws, manifest, AppState.currentPlan, detected) })
    }

    /** The run bar reads the manifest from disk, so it refreshes every time the panel opens. */
    function refreshRunBar() {
        var ws = AppState.workspace
        if (!ws) return Promise.resolve()
        return resolveRunCommand(ws).then(function (r) {
            if (ws !== AppState.workspace) return
            runCommand = r.command || ""
            runResolved = runCommand
            runSource = r.source
        })
    }

    /** Editing the command saves it and marks it, so no later build overwrites it. */
    function saveRunCommand(text) {
        var cmd = String(text || "").trim()
        runCommand = String(text || "")
        if (!cmd || !AppState.workspace || cmd === runResolved) return
        Api.call(Builds, "writeManifest", { workspace: AppState.workspace, run: cmd, userEdited: true })
            .then(function () { return refreshRunBar() })
            .then(function () { Notify.toast("Run command saved") })
    }

    /*
     * Re-detect, rather than run. Detection is one of three sources feeding the
     * run bar, so this refreshes it - it does not decide on its own what to
     * execute.
     */
    function redetect() {
        var ws = AppState.workspace
        if (!ws) { Notify.toast("Pick a workspace", "err"); return }
        detectCommand(ws).then(function (detected) {
            if (!detected) { Notify.toast("Nothing detectable in this workspace", "err"); return }
            Api.call(Builds, "writeManifest", { workspace: ws, run: detected })
                .then(function () { return refreshRunBar() })
                .then(function () { Notify.toast("Detected: " + detected) })
        })
    }

    /*
     * An agent run that never produced a result (a build holds the browser, the
     * agent could not start) replies { success: false, error } with no counts.
     * That is a failure that says why, not "0 passed, 0 failed".
     */
    function agentFailed(res) {
        return !res || (res.success === false && res.error && !res.results)
    }

    /** Syntax-check all: does the code parse. (The prompt slot is ignored by testall; kept for the positional layout.) */
    function syntaxCheck() {
        var ws = AppState.workspace
        if (!ws) { Notify.toast("Pick a workspace", "err"); return }
        testing = true
        AppState.setStatus("testing")
        renderTestResults([], "running syntax checks...")
        runAgent(["testall", "x", ws, Providers.current]).then(function (res) {
            testing = false
            AppState.setStatus("idle")
            if (agentFailed(res)) {
                renderTestResults([], "check failed" + (res && res.error ? ": " + res.error : ""))
                pushHistory("syntax check", false)
                return
            }
            var s = R.syntaxSummary(res)
            renderTestResults(res.results || [], s.summary)
            pushHistory(s.history, !res.failed)
            var l = R.lastRunFromResults("syntax check", res.results)
            markRun(l.command, l.output)
        })
    }

    /*
     * Behaviour, not syntax.
     *
     * "Syntax-check all" answers whether the code compiles. This answers whether
     * it works: the project's own suite if it has one, then a smoke run of the
     * entry point. A suite that exists but whose runner is missing is reported
     * as skipped rather than counted either way - a green "0 failed" on a
     * project whose tests never ran is the most misleading thing this panel
     * could show.
     */
    function behaviour() {
        var ws = AppState.workspace
        if (!ws) { Notify.toast("Pick a workspace", "err"); return }
        testing = true
        AppState.setStatus("running tests")
        renderTestResults([], "running the project's tests...")
        runAgent(["behaviour", ws, ws, Providers.current]).then(function (res) {
            testing = false
            AppState.setStatus("idle")
            if (agentFailed(res)) {
                renderTestResults([], "could not run" + (res && res.error ? ": " + res.error : ""))
                pushHistory("behaviour", false)
                return
            }
            var summary = R.behaviourSummary(res)
            renderTestResults(res.results || [], summary)
            if (res.note) renderTestOutput(res.note)
            pushHistory("tests · " + summary, !res.failed)
            var l = R.lastRunFromResults("behaviour checks", res.results)
            markRun(l.command, l.output)
        })
    }

    /** Run the command in the run bar, in the workspace. */
    function run(text) {
        var cmd = String(text === undefined ? runCommand : text).trim()
        if (!cmd) { Notify.toast("Nothing to run - type a command or build a project", "err"); return }
        var ws = AppState.workspace
        if (!ws) { Notify.toast("Pick a workspace", "err"); return }
        testing = true
        AppState.setStatus("running")
        renderTestResults([], "running: " + cmd)
        Api.call(Agent, "runCommand", { command: cmd, cwd: ws }).then(function (r) {
            testing = false
            AppState.setStatus("idle")
            var ok = !!(r && r.success)
            renderTestResults([{ command: cmd, success: ok }], ok ? "command succeeded" : "command failed")
            renderTestOutput(r && r.output)
            pushHistory(cmd, ok)
            markRun(cmd, (r && r.output) || "")
            // The frontend preview: offered only when the run printed something a
            // browser can show - an empty frame is worse than no button.
            return listFiles(ws).then(function (files) {
                var t = Preview.previewTarget((r && r.output) || "", files)
                runPreview = t ? { url: t.url, kind: t.kind, ws: ws } : null
            })
        })
    }

    property int _chatSeq: 0
    function addChat(who, text, markdown) {
        testChat.append({ who: who, text: String(text), markdown: !!markdown, applied: "", mid: ++_chatSeq })
        if (testChat.count > maxChat) testChat.remove(0, testChat.count - maxChat)
        return testChat.count - 1
    }

    /** Ask about the last run: its command and output go along with the question. */
    function ask(question) {
        var q = String(question || "").trim()
        if (!q) return false
        var ws = AppState.workspace
        if (!ws) { Notify.toast("Pick a workspace", "err"); return false }
        addChat("user", q, false)
        addChat("ai", "thinking...", false)
        // Found again by identity on reply: older messages may have been dropped meanwhile.
        var pending = _chatSeq
        asking = true
        Api.call(Agent, "askRun", {
            workspace: ws, provider: Providers.current, question: q,
            command: lastRun.command, output: lastRun.output,
            headed: Providers.showBrowser, controls: Providers.desiredControls(),
        }).catch(function (e) { return { success: false, error: String(e) } }).then(function (r) {
            asking = false
            var i = -1
            for (var k = testChat.count - 1; k >= 0; k--) if (testChat.get(k).mid === pending) { i = k; break }
            if (i < 0) return
            if (r && r.success) {
                // A question usually has no fix, and a prose answer is the normal case -
                // it used to be reported as a failure and shown as nothing at all.
                testChat.setProperty(i, "text", r.answer || "(no answer)")
                testChat.setProperty(i, "markdown", true)
                if (r.appliedFiles && r.appliedFiles.length) {
                    testChat.setProperty(i, "applied", "Applied: " + r.appliedFiles.join(", "))
                    Notify.toast(r.appliedFiles.length + " file(s) changed")
                }
            } else {
                testChat.setProperty(i, "text", (r && r.error) || "Could not get an answer.")
            }
        })
        return true
    }

    // ======================================================================
    // Research (plan.js)
    // ======================================================================

    property string researchQuery: ""
    property string researchVia: ""
    // Each half: state "" (not run) | "searching" | "done" | "error".
    property var researchWeb: ({ state: "", answer: "", sources: [], error: "" })
    property var researchGh: ({ state: "", items: [], error: "" })
    property bool researching: false

    /**
     * Research: the provider's own web search, plus GitHub through our token.
     *
     * Two independent halves, run together and reported separately. GitHub
     * failing because you are not signed in must not hide a perfectly good web
     * answer, and a provider that is busy must not hide the repositories.
     */
    function research(query) {
        var q = String(query === undefined ? researchQuery : query).trim()
        if (!q) { Notify.toast("Type a query", "err"); return }
        var ws = AppState.workspace
        if (!ws) { Notify.toast("Pick a workspace", "err"); return }
        researchQuery = q
        researchWeb = { state: "searching", answer: "", sources: [], error: "" }
        researchGh = { state: "searching", items: [], error: "" }
        researchVia = ""
        researching = true
        AppState.setStatus("researching")

        // Started together: the provider round trip takes seconds and the GitHub
        // call takes hundreds of milliseconds, so running them in series would make
        // the fast one wait for the slow one for no reason. Each half is drawn as
        // it arrives.
        var web = runAgent(["research", q, ws, Providers.current]).then(function (res) {
            if (res && res.success) {
                researchVia = res.via || ""
                researchWeb = { state: "done", answer: res.answer || "", sources: res.sources || [], error: "" }
            } else {
                researchWeb = { state: "error", answer: "", sources: [], error: (res && res.error) || "the search failed" }
            }
        })
        var gh = Api.call(GitHub, "call", "searchRepos", [q, 8])
            .catch(function (e) { return { ok: false, error: String(e) } })
            .then(function (r) {
                if (!r || !r.ok)
                    researchGh = { state: "error", items: [], error: (r && r.error) || "GitHub search unavailable - sign in on the Ship tab" }
                else if (!(r.result || []).length)
                    researchGh = { state: "error", items: [], error: "no repositories matched" }
                else
                    researchGh = { state: "done", items: r.result, error: "" }
            })
        Promise.all([web, gh]).then(function () {
            researching = false
            AppState.setStatus("idle")
            Notify.toast("Research done")
        })
    }

    // ======================================================================
    // A repository as reference, and cloning (ship.js)
    // ======================================================================

    /*
     * A repository chosen as reference: its README and file list ride along in
     * AppState.repoReference, which the plan prompt folds in, so the model
     * designs against how a real project of that kind is laid out. Nothing is
     * written to the workspace, so there is no licence question on this path.
     */
    function useAsReference(r) {
        var parsed = Safe.parseRepoUrl(r && r.url)
        if (!parsed) { Notify.toast("Not a GitHub repository", "err"); return }
        var readme = null
        Api.call(GitHub, "call", "getReadme", [parsed.owner, parsed.repo]).then(function (a) {
            readme = a || { ok: false }
            return Api.call(GitHub, "call", "getTree", [parsed.owner, parsed.repo])
        }).then(function (tree) {
            tree = tree || { ok: false }
            var ref = R.referenceFrom(parsed, readme, tree)
            if (!ref) {
                Notify.toast(readme.error || tree.error || "Could not read that repository", "err")
                return
            }
            AppState.repoReference = ref
            Notify.toast("Referencing " + ref.name + " in the next plan")
            Notify.log("reference set: " + ref.name, "ok")
        })
    }

    // The clone waiting for the user's answer (CloneConfirm, in the window).
    property var pendingClone: null
    property string cloneQuestion: ""
    property bool cloning: false

    /**
     * Clone a repository into the workspace, after asking. The licence is the
     * user's to accept, so it goes in front of them rather than into a doc they
     * will not read. `r` is { url, title, license }.
     */
    function cloneRepo(r) {
        if (!AppState.workspace) { Notify.toast("Pick a workspace", "err"); return }
        var parsed = Safe.parseRepoUrl(r && r.url)
        if (!parsed) { Notify.toast("Not a GitHub repository", "err"); return }
        cloneQuestion = R.cloneConfirmText(parsed, r.license)
        pendingClone = { url: r.url, workspace: AppState.workspace }
    }
    function answerClone(yes) {
        var c = pendingClone
        pendingClone = null
        if (!yes || !c) return
        cloning = true
        AppState.setStatus("cloning")
        Api.call(GitHub, "clone", { url: c.url, workspace: c.workspace }).then(function (res) {
            cloning = false
            AppState.setStatus("idle")
            if (res && res.ok) Notify.toast("Cloned into " + res.into)
            else Notify.toast((res && res.error) || "Clone failed", "err")
        })
    }

    // ======================================================================
    // Ship: GitHub, the local git buttons, export, Actions (ship.js, plan.js)
    // ======================================================================

    // GitHub. The UI never holds the token - it asks GitHub to make calls on
    // its behalf, and no getter for it exists.
    property bool ghKnown: false
    property bool ghSignedIn: false
    property string ghLogin: ""
    property string ghStorageNote: ""
    // [{ value, label }] - value is the clone URL.
    property var ghRepos: []
    property string ghRepo: ""
    property string remoteUrl: ""
    property string commitMsg: ""
    property string newRepoName: ""
    property string workflow: ""
    // [{ name, state }] and the line shown in their place ("" when there are runs).
    property var ghRuns: []
    property string ghRunsText: ""
    property bool exporting: false
    property bool gitBusy: false

    function refreshGitHub() {
        return Api.call(GitHub, "status").catch(function () { return { signedIn: false } }).then(function (st) {
            st = st || { signedIn: false }
            ghKnown = true
            ghSignedIn = !!st.signedIn
            // Said plainly rather than discovered next launch when the token is gone.
            ghStorageNote = R.tokenStorageNote(st.encryptionAvailable)
            if (!st.signedIn) { ghRepos = []; ghRepo = ""; return }
            ghLogin = st.login ? "@" + st.login : "signed in"
            return Api.call(GitHub, "call", "listRepos", []).then(function (r) {
                if (!r || !r.ok) {
                    ghRepos = []
                    Notify.log("github: " + ((r && r.error) || "could not list repositories"), "err")
                    return
                }
                var keep = ghRepo
                ghRepos = (r.result || []).map(R.repoOption)
                var found = ghRepos.some(function (o) { return o.value === keep })
                ghRepo = found ? keep : (ghRepos.length ? ghRepos[0].value : "")
                if (ghRepo) remoteUrl = ghRepo
                return refreshRuns()
            })
        })
    }

    /** The repository picker: picking one fills the push remote. */
    function pickRepo(value) {
        ghRepo = value || ""
        remoteUrl = ghRepo
    }

    function openTokenPage() {
        // Scopes pre-selected, so the user grants exactly what is needed and can
        // see what that is before agreeing to it.
        App.openExternal(R.TOKEN_URL)
    }

    function signIn(token) {
        var t = String(token || "").trim()
        if (!t) { Notify.toast("Paste a token first", "err"); return Promise.resolve(false) }
        return Api.call(GitHub, "signIn", t).then(function (r) {
            if (r && r.ok) {
                Notify.toast("Signed in as @" + (r.login || "?"))
                if (!r.persisted) Notify.toast("Token kept in memory only - see the note", "err")
                return refreshGitHub().then(function () { return true })
            }
            Notify.toast((r && r.error) || "Sign-in failed", "err")
            return false
        })
    }

    function signOut() {
        Api.call(GitHub, "signOut").then(function () {
            Notify.toast("Signed out")
            ghRuns = []
            ghRunsText = ""
            return refreshGitHub()
        })
    }

    function createRepo(name) {
        var n = String(name === undefined ? newRepoName : name).trim()
        if (!n) { Notify.toast("Name it first", "err"); return }
        Api.call(GitHub, "call", "createRepo", [n, true]).then(function (r) {
            if (r && r.ok) {
                Notify.toast("Created " + n)
                newRepoName = ""
                return refreshGitHub()
            }
            Notify.toast((r && r.error) || "Could not create it", "err")
        })
    }

    function currentRepo() {
        return Safe.parseRepoUrl(ghRepo || remoteUrl)
    }

    function refreshRuns() {
        var repo = currentRepo()
        if (!repo) return Promise.resolve()
        return Api.call(GitHub, "call", "listRuns", [repo.owner, repo.repo]).then(function (r) {
            if (!r || !r.ok) { ghRuns = []; ghRunsText = (r && r.error) || "Could not list runs."; return }
            ghRuns = (r.result || []).map(function (run) {
                return { name: run.name || "workflow", state: R.runState(run) }
            })
            ghRunsText = ghRuns.length ? "" : "No runs yet."
        })
    }

    // After a dispatch GitHub takes a moment to list the new run: one look, 3s on.
    property Timer _runsLater: Timer { interval: 3000; onTriggered: store.refreshRuns() }

    function dispatch(wf) {
        var repo = currentRepo()
        var w = String(wf === undefined ? workflow : wf).trim()
        if (!repo) { Notify.toast("Pick a repository first", "err"); return }
        if (!w) { Notify.toast("Name the workflow file", "err"); return }
        Api.call(GitHub, "call", "dispatchWorkflow", [repo.owner, repo.repo, w, "main"]).then(function (r) {
            // A missing `workflow` scope arrives as a 403, and the client already
            // says that is usually a scope problem rather than a generic refusal.
            if (r && r.ok) { Notify.toast("Triggered " + w); _runsLater.restart() }
            else Notify.toast((r && r.error) || "Could not trigger it", "err")
        })
    }

    // The plain git buttons. Their output reaches the project log through
    // Git.projectLog.
    function git(args) {
        return Api.call(Git, "git", { args: args, cwd: AppState.workspace })
    }
    function gitInit() {
        if (!AppState.workspace) { Notify.toast("Pick a workspace", "err"); return }
        git(["init", "-b", "main"])
    }
    function gitStatus() {
        if (!AppState.workspace) { Notify.toast("Pick a workspace", "err"); return }
        git(["status", "--short"])
    }
    function gitCommit(message) {
        if (!AppState.workspace) { Notify.toast("Pick a workspace", "err"); return }
        var msg = String(message === undefined ? commitMsg : message).trim() || "AI: automated changes"
        gitBusy = true
        git(["add", "-A"]).then(function () { return git(["commit", "-m", msg]) })
            .then(function () { gitBusy = false })
    }
    function gitPush(remote) {
        if (!AppState.workspace) { Notify.toast("Pick a workspace", "err"); return }
        var url = String(remote === undefined ? remoteUrl : remote).trim()
        gitBusy = true
        var chain = Promise.resolve()
        if (url) chain = git(["remote", "remove", "origin"]).then(function () { return git(["remote", "add", "origin", url]) })
        chain.then(function () { return git(["push", "-u", "origin", "main"]) }).then(function (r) {
            gitBusy = false
            if (r && r.success) AppState.markShipped()
        })
    }

    /**
     * Replay this workspace's build onto a branch of its own.
     *
     * Step titles come from the plan in memory when there is one, because a
     * checkpoint stores the step's detail rather than its title and "step 6:
     * Implement the streak calculation described in..." reads badly in git log.
     */
    function exportBranch() {
        var ws = AppState.workspace
        if (!ws) { Notify.toast("Pick a workspace", "err"); return }
        if (exporting) return
        exporting = true
        Api.call(Git, "exportBranch", R.exportRequest(ws, AppState.currentPlan))
            .catch(function (e) { return { ok: false, error: String(e) } })
            .then(function (res) {
                exporting = false
                if (!res || !res.ok) {
                    Notify.log("export failed: " + ((res && res.error) || "unknown"), "err")
                    Notify.toast((res && res.error) || "Export failed", "err")
                    return
                }
                Notify.log("exported " + res.commits + " commit(s) to " + res.branch, "ok")
                ;(res.warnings || []).forEach(function (w) { Notify.log("  " + w, "step") })
                Notify.toast("Exported to " + res.branch)
            })
    }

    // A different project: its runs, results and repository are not this one's.
    property Connections _app: Connections {
        target: AppState
        function onWorkspaceOpened() {
            store.runCommand = ""
            store.runResolved = ""
            store.runSource = ""
            store.testSummary = ""
            store.testResults.clear()
            store.testHistory = []
            store.lastRun = { command: "", output: "" }
            store.runPreview = null
        }
    }
}
