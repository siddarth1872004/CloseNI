pragma Singleton
import QtQuick
import CloseNI
import "../js/api.mjs" as Api
import "../js/code-view.mjs" as V
import "../js/code-logic.mjs" as C
import "../js/code-transcript.mjs" as T
import "../js/entrypoint.mjs" as Entry
import "../js/github-safe.mjs" as Safe
import "../js/renderer-logic.mjs" as R

/*
 * The Code panel: a coding agent in the style of a terminal one.
 *
 * The state and decisions of desktop/code.js. The agent lives in a
 * long-lived process started on the first message; this only keeps what it
 * reports and sends what the user types. Everything shown comes from an event -
 * nothing here guesses at what the agent did.
 *
 * Kept here rather than in CodePanel.qml because it must outlive the panel:
 * the session, its transcript, the queue and the prompt history all carry on
 * while another panel is open, as they did when Electron's panel was never
 * destroyed. CodePanel.qml only draws this and passes the keyboard on.
 *
 * The transcript is `items`, a ListModel of { uid, kind, rev }; each entry's
 * data sits in a side table, replaced (never mutated) on every change and
 * announced by bumping its rev, so a delegate redraws exactly the entry that
 * changed. Entry kinds:
 *   note  { text, tone }              ⎿ a line from the app (tone dim/err/warn)
 *   user  { text, queued }            > what was typed
 *   help  { text }                    /help, ?, /memory
 *   msg   { text }                    ⏺ the model's answer, markdown
 *   think { text, live, open }        ✻ its reasoning, folded when done
 *   tool  { id, name, tone, verb, arg, summary, more, moreOpen, perm }
 *   plan  { opts, answered }          "Ready to code?" after a plan turn
 *   card  { cardKind, title, summary, tone, groups }   a mode action's result
 */
QtObject {
    id: store

    // ---- Session --------------------------------------------------------------
    property bool up: false
    property bool busy: false
    // Running a mode action (tests, a run, research): the one-shot runs borrow
    // the browser profile, so turns wait for them.
    property bool running: false
    property string mode: "default"
    property string provider: ""
    // --provider with --start: the provider asked for on the command line, kept
    // for this run's later turns (it need not be in the picker's list, as the
    // test suite's mock is not). Picking a provider in Settings replaces it;
    // the startup pick (made before the list is in) does not.
    property string pinnedProvider: ""
    property Connections _providers: Connections {
        target: Providers
        function onCurrentChanged() { if (Providers.list.length) store.pinnedProvider = "" }
    }
    // The settings the running agent was started with (sessionSettings).
    property string settings: ""
    property var _starting: null
    readonly property bool starting: _starting !== null
    property var queue: []
    // Whether this turn wrote or edited a file: only then is there something
    // new to offer to run.
    property bool changed: false
    // Whether this turn is fixing a failed run: the fix may be an install
    // rather than an edit, and either way the next step is to run it again.
    property bool fixing: false

    // ---- Prompt history ---------------------------------------------------------
    property var history: []
    property int hIndex: -1
    // Up-arrow recall of the last few hundred prompts; a session of thousands
    // of turns keeps no more.
    readonly property int maxHistory: 500

    // ---- Spinner ------------------------------------------------------------------
    property bool spinnerShown: false
    property string spinnerVerb: "Thinking…"
    property double turnStart: 0
    property int step: 0
    property int verbSeed: 0

    // ---- Mode strip ---------------------------------------------------------------
    // Build's todo list for its progress bar, and which sources research searches.
    property var todos: []
    property bool researchWeb: true
    property bool researchGh: true
    property string modebarInfo: ""
    property real modebarProgress: -1
    property int modebarSeq: 0

    // ---- Permission prompt ----------------------------------------------------------
    // { req, uid, opts, sel } while a prompt waits for an answer.
    property var permission: null
    // The deny feedback field has focus: keys belong to it, not the prompt.
    property bool feedbackFocused: false

    // ---- Run offer -----------------------------------------------------------------
    // { command, state: "checking"|"ready"|"fail", prompt } after a turn that
    // changed files, or null.
    property var runOffer: null
    property int _runOfferSeq: 0

    // ---- Clone question -------------------------------------------------------------
    property var pendingClone: null
    property string cloneText: ""

    // The @ file popup's list, per workspace.
    property var _files: null

    signal focusInput()
    signal focusPrompt()

    // ---- Transcript ------------------------------------------------------------------
    property ListModel items: ListModel {}
    property var _entries: ({})
    property int _nextUid: 1
    property var _tools: ({})
    // The reasoning block being written for the current step, while it grows.
    property var _think: null

    function entry(uid) { return _entries[uid] }

    function _index(uid) {
        if (!items.count) return -1
        var i = uid - items.get(0).uid
        return i >= 0 && i < items.count && items.get(i).uid === uid ? i : -1
    }

    function add(kind, data) {
        var uid = _nextUid++
        var e = Object.assign({ kind: kind }, data)
        _entries[uid] = e
        items.append({ uid: uid, kind: kind, rev: 0 })
        var drop = T.overflow(items.count, T.MAX_ENTRIES)
        if (drop) _dropOldest(drop)
        return uid
    }

    function _dropOldest(n) {
        var gone = {}
        for (var i = 0; i < n; i++) {
            var u = items.get(i).uid
            gone[u] = true
            delete _entries[u]
        }
        items.remove(0, n)
        for (var id in _tools) if (gone[_tools[id]]) delete _tools[id]
        if (_think && gone[_think.uid]) _think = null
    }

    function patch(uid, changes) {
        var old = _entries[uid]
        var i = _index(uid)
        if (!old || i < 0) return
        _entries[uid] = Object.assign({}, old, changes)
        items.setProperty(i, "rev", items.get(i).rev + 1)
    }

    function note(text, tone) { return add("note", { text: String(text), tone: tone || "" }) }
    function userLine(text, queued) { return add("user", { text: String(text), queued: !!queued }) }
    function helpText(text) { return add("help", { text: String(text) }) }

    function clearTranscript() {
        items.clear()
        _entries = ({})
        _tools = ({})
        _think = null
    }

    // ---- Header bits -------------------------------------------------------------------
    readonly property var welcomeNeed: T.welcomeNeed(AppState.workspace, AppState.onboardingSteps)
    readonly property var modeLabel: V.modeLabel(mode)
    readonly property string metaText: C.metaText(provider, AppState.workspace)

    /**
     * A mode's one accent, carried by the prompt box, the mode line, the strip
     * above the prompt and the cards the mode leaves (styles.css "Modes"). A
     * card's kind is its mode; "git" is ship's. `fallback` for modes with none.
     */
    function modeColor(m, fallback) {
        switch (m) {
        case "acceptEdits": case "accept": return Theme.langC
        case "plan": return Theme.langPy
        case "auto": return Theme.err
        case "build": return Theme.langRs
        case "test": return Theme.ok
        case "research": return Theme.langJs
        case "ship": case "git": return Theme.langJava
        default: return fallback
        }
    }

    // ---- Spinner -----------------------------------------------------------------------
    function spinnerOn(verb) {
        spinnerShown = true
        if (verb) spinnerVerb = verb + "…"
    }
    function spinnerOff() { spinnerShown = false }

    // ---- Tools ----------------------------------------------------------------------------
    function _toolEntry(ev) {
        var uid = _tools[ev.id]
        if (uid !== undefined && _entries[uid]) return uid
        uid = add("tool", { id: ev.id, name: "", tone: "wait", verb: "", arg: "", summary: "",
                            more: null, moreOpen: false, perm: null })
        _tools[ev.id] = uid
        return uid
    }

    function onTool(ev) {
        var uid = _toolEntry(ev)
        var t = V.toolTitle(ev)
        if (T.toolChanged(ev)) changed = true
        var ch = { name: ev.name || "invalid", tone: V.toolTone(ev.status), verb: t.verb, arg: t.arg,
                   summary: V.toolSummary(ev) }
        var more = T.toolMore(ev)
        if (more) {
            ch.more = more
            if (more.open) ch.moreOpen = true
        }
        patch(uid, ch)
    }

    function toggleMore(uid) {
        var e = _entries[uid]
        if (e) patch(uid, { moreOpen: !e.moreOpen })
    }

    // The model's reasoning, copied from the provider's page as it thinks: open
    // while it grows, folded to one line once the answer or a tool call follows.
    function onReasoning(ev) {
        if (_think && _think.step !== ev.step) endThinking()
        if (!_think) _think = { step: ev.step, uid: add("think", { text: "", live: true, open: true }) }
        patch(_think.uid, { text: String(ev.text || "") })
    }

    function endThinking() {
        if (!_think) return
        var uid = _think.uid
        _think = null
        patch(uid, { live: false, open: false })
    }

    function toggleThink(uid) {
        var e = _entries[uid]
        if (e) patch(uid, { open: !e.open })
    }

    function onTodos(list) {
        todos = list || []
        if (mode === "build") renderModebar()
    }
    readonly property bool todosShown: C.todosVisible(todos)

    // ---- Permissions -------------------------------------------------------------------------
    function onPermission(req) {
        var uid = _toolEntry({ id: req.id })
        var opts = V.permissionOptions(req)
        patch(uid, { perm: { question: V.permissionQuestion(req), body: T.permissionBody(req), opts: opts,
                             sel: 0, feedback: false, answered: "" } })
        permission = { req: req, uid: uid, opts: opts, sel: 0 }
        focusPrompt()
    }

    function _setPerm(uid, changes) {
        var e = _entries[uid]
        if (e && e.perm) patch(uid, { perm: Object.assign({}, e.perm, changes) })
    }

    function selectPermission(i) {
        var P = permission
        if (!P) return
        var sel = (i + P.opts.length) % P.opts.length
        permission = { req: P.req, uid: P.uid, opts: P.opts, sel: sel }
        _setPerm(P.uid, { sel: sel })
    }

    function answerPermission(decision, feedback) {
        var P = permission
        if (!P) return
        permission = null
        feedbackFocused = false
        Agent.codePermission(P.req.id, decision, feedback || "", function () {})
        _setPerm(P.uid, { answered: C.permissionAnswerLabel(decision, feedback), feedback: false })
        focusInput()
    }

    function choosePermission(i) {
        var P = permission
        if (!P) return
        var opt = P.opts[i]
        if (!opt) return
        if (opt.key !== "deny") { answerPermission(opt.key); return }
        // "No" takes an optional note, the way a person would say what they want instead.
        _setPerm(P.uid, { feedback: true, sel: i })
        permission = { req: P.req, uid: P.uid, opts: P.opts, sel: i }
    }

    // ---- Plan approval ------------------------------------------------------------------------
    function offerPlan() {
        add("plan", { opts: C.PLAN_OFFER_OPTIONS, answered: "" })
    }

    function choosePlan(uid, i) {
        var e = _entries[uid]
        if (!e || e.answered) return
        var o = e.opts[i]
        patch(uid, { answered: o.label })
        if (!o.mode) { focusInput(); return }
        setMode(o.mode)
        send("Go ahead and implement the plan.")
    }

    // ---- Modes -----------------------------------------------------------------------------------
    //
    // One window, one transcript. Each mode puts a strip above the prompt that
    // says what it is for and carries the actions its old tab had; what those
    // actions find comes back into the transcript as a card, so the conversation
    // stays the one record of what happened.

    function card(kind, title, summary, groups) {
        return add("card", { cardKind: kind, title: title, summary: summary || "", tone: "",
                             groups: groups || [{ id: "body", sep: false, parts: [] }] })
    }

    function _cardGroup(uid, gid, parts, append) {
        var e = _entries[uid]
        if (!e) return
        var groups = e.groups.map(function (g) {
            if (g.id !== gid) return g
            return { id: g.id, sep: g.sep, parts: append ? g.parts.concat(parts) : parts }
        })
        patch(uid, { groups: groups })
    }

    function toggleCardOut(uid, gi, pi) {
        var e = _entries[uid]
        if (!e) return
        var groups = e.groups.map(function (g, k) {
            if (k !== gi) return g
            return { id: g.id, sep: g.sep, parts: g.parts.map(function (p, j) {
                return j === pi ? Object.assign({}, p, { open: !p.open }) : p
            }) }
        })
        patch(uid, { groups: groups })
    }

    /** A button in a card or the mode strip: its action, then the prompt has focus again. */
    function act(button) {
        if (button && button.act) button.act()
        focusInput()
    }

    function _btn(label, act, tip, primary) {
        return { label: label, act: act, tip: tip || "", primary: !!primary }
    }

    // The one-shot runs borrow the browser profile, and the agent's session
    // yields it to them - which would cut a turn off mid-reply.
    function freeForRun() {
        if (busy || starting || running) { note("Wait for the current turn to finish, or press esc.", "err"); return false }
        if (!AppState.workspace) { note("Choose a project folder first - every mode works inside one.", "err"); return false }
        return true
    }

    function runStart(verb, status) {
        running = true
        turnStart = Date.now()
        spinnerOn(verb)
        AppState.setStatus(status)
        renderModebar()
    }
    function runEnd() {
        running = false
        spinnerOff()
        AppState.setStatus("idle")
        renderModebar()
        if (queue.length && !busy) _sendNextSoon()
    }

    function _outPart(text, open) {
        return text ? [{ t: "out", text: T.outputTail(text), open: !!open }] : []
    }

    function _testParts(results) {
        var parts = []
        T.checkRows(results).forEach(function (r) {
            parts.push({ t: "row", kind: r.kind, mark: r.mark, lang: r.language, command: r.command, detail: r.detail })
            if (r.multiline) parts = parts.concat(_outPart(r.output, false))
        })
        return parts
    }

    /** Tests ("behaviour") or syntax checks ("testall"), as a card. */
    function runChecks(kind) {
        if (!freeForRun()) return
        var ws = AppState.workspace
        var syntax = kind === "testall"
        var c = card("test", syntax ? "Syntax check" : "Tests", "running…")
        runStart(syntax ? "Checking every file" : "Running the tests", syntax ? "testing" : "running tests")
        var args = syntax ? ["testall", "x", ws, Providers.current] : ["behaviour", ws, ws, Providers.current]
        runAgent(args).then(function (res) {
            var s = C.checksSummary(res)
            patch(c, { summary: s.text, tone: s.tone })
            if (!res) return
            var parts = _testParts(res.results)
            var passed = res.passed || 0, failed = res.failed || 0, skipped = res.skipped || 0
            if (res.note && (passed || failed || skipped)) parts.push({ t: "hint", text: String(res.note) })
            if (failed) {
                parts.push({ t: "actions", buttons: [_btn("Ask the agent to fix it", function () {
                    send(C.fixChecksPrompt(res.results), "fix the failing checks")
                })] })
            }
            _cardGroup(c, "body", parts, true)
            AppState.markTested()
        }, function (e) { patch(c, { summary: String(e), tone: "fail" }) }).then(runEnd)
    }

    /** The project's own run command, run once, output in the card. */
    function runCommand() {
        if (!freeForRun()) return
        var ws = AppState.workspace
        resolveRunCommand().then(function (rc) {
            if (!rc || !rc.command) { note("No run command found - the Runner panel (/runner) can set one", "warn"); return }
            var c = card("test", "Run", rc.command)
            runStart("Running " + rc.command, "running")
            Api.call(Agent, "runCommand", { command: rc.command, cwd: ws }).then(function (r) {
                var ok = !!(r && r.success)
                patch(c, { tone: ok ? "pass" : "fail" })
                _cardGroup(c, "body", [{ t: "row", kind: ok ? "pass" : "fail", mark: ok ? "✓" : "✗", lang: "",
                                         command: ok ? "exited cleanly" : "failed", detail: "" }]
                                      .concat(_outPart(r && r.output, !ok)), true)
                AppState.markTested()
            }, function (e) { patch(c, { summary: String(e), tone: "fail" }) }).then(runEnd)
        })
    }

    /** The project in a full-screen window of its own: its output, its page, or its game. */
    function runInWindow(command) {
        closeRunOffer()
        var ws = AppState.workspace
        if (!ws) { note("Choose a project folder first.", "err"); return }
        Runner.openRunWindow({ command: command, cwd: ws }, function (r) {
            if (!r || !r.ok) note("Could not open the run window: " + ((r && r.error) || "unknown error"), "err")
        })
    }

    function runInWindowResolved() {
        resolveRunCommand().then(function (rc) {
            if (rc && rc.command) runInWindow(rc.command)
            else note("No run command found - the Runner panel (/runner) can set one", "warn")
        })
    }

    function closeRunOffer() {
        runOffer = null
        _runOfferSeq++
    }

    /**
     * After a turn that changed files, offer to run what was built, when there
     * is a command for it. A program with a window is first started unseen for
     * a few seconds; one that crashes on start is offered to the agent instead.
     */
    function offerRun() {
        resolveRunCommand().then(function (rc) {
            if (!rc || !rc.command || busy) return
            closeRunOffer()
            var seq = _runOfferSeq
            runOffer = { command: rc.command, state: "checking", prompt: "" }
            Runner.checkRun({ command: rc.command, cwd: AppState.workspace }, function (r) {
                if (seq !== _runOfferSeq) return
                if (r && r.checked && !r.ok) runOffer = { command: rc.command, state: "fail", prompt: r.prompt || "" }
                else runOffer = { command: rc.command, state: "ready", prompt: "" }
            })
        })
    }

    function runOfferFix() {
        var o = runOffer
        if (!o) return
        closeRunOffer()
        send(o.prompt, "fix the crash on start of " + o.command, true)
        focusInput()
    }

    // "Fix errors" in the run window: its failed run, as a turn for the agent here.
    property Connections _runner: Connections {
        target: Runner
        function onRunFix(d) {
            AppState.switchTab("code")
            if (d.cwd !== AppState.workspace) { store.note(T.runFixElsewhere(d.cwd), "err"); return }
            store.send(d.prompt, "fix the errors from " + d.command, true)
        }
    }

    /** Web answer and GitHub repositories for `q`, as one card. */
    function research(q) {
        if (!researchWeb && !researchGh) { note("Turn on Web or GitHub in the research bar first", "err"); return }
        if (!freeForRun()) return
        var ws = AppState.workspace
        var wantWeb = researchWeb, wantGh = researchGh
        var groups = []
        if (wantWeb) groups.push({ id: "web", sep: false, parts: [{ t: "hint", text: "searching the web…" }] })
        if (wantGh) groups.push({ id: "gh", sep: true, parts: [{ t: "hint", text: "searching GitHub…" }] })
        var c = card("research", "Research", q, groups)
        runStart("Researching", "researching")
        // Together, not in series: GitHub answers in milliseconds, the provider in seconds.
        var web = wantWeb ? runAgent(["research", q, ws, Providers.current]) : Promise.resolve(null)
        var gh = wantGh ? Api.call(GitHub, "call", "searchRepos", [q, 8]) : Promise.resolve(null)

        gh.then(function (r) {
            if (!wantGh) return
            var parts = [{ t: "title", text: "GitHub" }]
            if (!r || !r.ok) parts.push({ t: "hint", text: (r && r.error) || "GitHub search unavailable - sign in with /github" })
            else if (!(r.result || []).length) parts.push({ t: "hint", text: "no repositories matched" })
            else r.result.forEach(function (repo) {
                parts.push({ t: "repo", url: repo.url, name: repo.fullName, meta: T.repoMeta(repo),
                             lang: repo.language || "", desc: repo.description || "", buttons: [
                    _btn("Use as reference", function () { useAsReference({ url: repo.url }) }, "Pull its README and file list into the next plan"),
                    _btn("Clone", function () { cloneRepo({ url: repo.url, title: repo.fullName }) }),
                ] })
            })
            _cardGroup(c, "gh", parts, false)
        })

        web.then(function (res) {
            if (!wantWeb) return
            if (!res || !res.success) {
                _cardGroup(c, "web", [{ t: "hint", text: (res && res.error) || "the web search failed" }], false)
                return
            }
            var parts = [{ t: "answer", text: String(res.answer || "") }]
            var sources = res.sources || []
            if (sources.length) {
                parts.push({ t: "title", text: T.sourcesTitle(res.via) })
                sources.forEach(function (u, i) { parts.push({ t: "source", n: i + 1, url: String(u) }) })
            } else parts.push({ t: "hint", text: "The provider cited no sources for this answer." })
            parts.push({ t: "actions", buttons: [_btn("Plan with this", function () {
                setMode("plan")
                send(C.researchPlanPrompt(res.answer), "plan with this research")
            }, "Switch to plan mode and hand the answer to the agent")] })
            _cardGroup(c, "web", parts, false)
        })

        Promise.all([web, gh]).then(runEnd, runEnd)
    }

    /** One git command, its output in a card. */
    function gitCard(title, args) {
        if (!AppState.workspace) { note("Choose a project folder first", "err"); return }
        var c = card("git", title, "git " + args.join(" "))
        git(args).then(function (r) {
            var out = (r && r.output) || ""
            if (!r || !r.success) patch(c, { tone: "fail" })
            if (!out.trim()) { _cardGroup(c, "body", [{ t: "hint", text: r && r.success ? "nothing to show" : "git failed" }], true); return }
            _cardGroup(c, "body", [T.gitShowsDiff(args) ? { t: "gitdiff", lines: T.gitDiffLines(out) }
                                                         : { t: "pre", text: T.gitOutput(out) }], true)
        }).then(function () { renderModebar() })
    }

    // What the strip offers, per mode: { label, tip, look: "primary"|"on"|"off"|"", act }.
    readonly property var modebarActions: _actionsFor(mode, researchWeb, researchGh)
    function _actionsFor(m, web, gh) {
        var steps = [_btn("Step-by-step builder", function () { AppState.switchTab("chat") }, "The planned, step-at-a-time build (/steps)")]
        if (m === "plan" || m === "build") return steps
        if (m === "test") return [
            _look(_btn("Run tests ⏎", function () { runChecks("behaviour") }, "The project's own test suite, then a smoke run (enter on an empty line)"), "primary"),
            _btn("Syntax-check", function () { runChecks("testall") }, "Compile or parse every source file"),
            _btn("Run", function () { runCommand() }, "Run the project's run command once"),
            _btn("Run in window", function () { runInWindowResolved() }, "Run it full screen in a CloseNI window"),
            _btn("Runner…", function () { AppState.switchTab("test") }, "The full runner panel (/runner)"),
        ]
        if (m === "research") return [["web", "Web", web], ["gh", "GitHub", gh]].map(function (k) {
            return _look(_btn((k[2] ? "● " : "○ ") + k[1], function () { toggleResearch(k[0]) }, "Search " + k[1] + " too"), k[2] ? "on" : "off")
        })
        if (m === "ship") return [
            _look(_btn("Commit ⏎", function () { send("") }, "Review, run the tests, then commit (enter on an empty line)"), "primary"),
            _btn("Status", function () { gitCard("Status", ["status", "--short", "--branch"]) }),
            _btn("Diff", function () { gitCard("Diff", ["diff", "HEAD"]) }),
            _btn("Log", function () { gitCard("Log", ["log", "--oneline", "-n", "15"]) }),
            _btn("GitHub…", function () { AppState.switchTab("push") }, "Sign in, export a branch, open a pull request (/github)"),
        ]
        return []
    }
    function _look(b, look) { b.look = look; return b }

    function toggleResearch(which) {
        if (which === "web") researchWeb = !researchWeb
        else researchGh = !researchGh
        renderModebar()
    }

    // What the strip above the prompt says, per mode; its actions are drawn by
    // CodeModeBar from the mode. The async part (test's run command, ship's git
    // status) lands only if no newer render has started since.
    function renderModebar() {
        var spec = C.MODEBAR[mode]
        var seq = modebarSeq = modebarSeq + 1
        if (!spec) { modebarInfo = ""; modebarProgress = -1; return }
        modebarInfo = mode === "build" ? C.buildModeInfo(todos) : spec.info
        var pr = mode === "build" ? C.buildModeProgress(todos) : null
        modebarProgress = pr === null ? -1 : pr
        var p = null
        if (mode === "test") p = resolveRunCommand().then(function (rc) { return C.testModeInfo(rc) })
        else if (mode === "ship" && AppState.workspace)
            p = git(["status", "--short", "--branch"]).then(function (r) { return C.shipModeInfo(!!(r && r.success), r && r.output) })
        if (p) p.then(function (text) { if (seq === store.modebarSeq && text) store.modebarInfo = text }, function () {})
    }

    // ---- Events ---------------------------------------------------------------------------------------
    function setBusy(on) {
        busy = on
        if (on) {
            turnStart = Date.now()
            step = 0
            verbSeed = Math.floor(Math.random() * 1000)
            spinnerOn(V.spinnerVerb(0, verbSeed))
        } else spinnerOff()
    }

    function onEvent(ev) {
        if (ev.type === "assistant" || ev.type === "tool" || ev.type === "thinking" || ev.type === "done" || ev.type === "closed") endThinking()
        switch (ev.type) {
        case "ready":
            provider = ev.provider || provider
            if (ev.memory) note("Using " + ev.memory + " from the project", "dim")
            break
        case "turn-start": setBusy(true); changed = false; closeRunOffer(); break
        case "thinking": step = ev.step; spinnerOn(V.spinnerVerb(ev.step, verbSeed)); break
        case "reasoning": onReasoning(ev); break
        case "assistant": add("msg", { text: String(ev.text || "") }); break
        case "tool": onTool(ev); break
        case "permission": onPermission(ev); break
        case "todos": onTodos(ev.items); break
        case "attached": note("Attached " + ev.files.map(function (f) { return "@" + f }).join(", "), "dim"); break
        // The agent only knows its permission mode; build, test, research and
        // ship ride on one of those, so their own echo must not undo them.
        case "mode": if (ev.mode !== V.agentModeOf(mode)) { mode = ev.mode; renderModebar() } break
        case "interrupting": spinnerOn("Stopping after this reply"); break
        case "rewound": note(C.rewoundNote(ev.files || [])); break
        case "cleared": clearTranscript(); permission = null; onTodos([]); note("Started a new conversation", "dim"); break
        case "compacting": note("Conversation at " + ev.size + " - summarising it to continue in a new one", "dim"); break
        case "compacted": { var cn = C.compactedNote(ev.summary); note(cn.text, cn.tone); break }
        case "error": note(ev.message, "err"); break
        case "done": {
            setBusy(false)
            if (permission) { var pu = permission.uid; permission = null; feedbackFocused = false; patch(pu, { perm: null }) }
            var out = C.doneOutcome(ev, mode, changed, fixing)
            if (out && out.note) note(out.note, out.tone)
            else if (out && out.offer === "plan") offerPlan()
            else if (out && out.offer === "run") offerRun()
            AppState.setStatus("idle")
            if (mode === "ship" || mode === "test") renderModebar()
            if (queue.length && !running) _sendNextSoon()
            break
        }
        case "closed":
            up = false
            if (busy) { setBusy(false); note("The session ended", "err") }
            break
        }
    }

    property Connections _agent: Connections {
        target: Agent
        function onCodeEvent(ev) { store.onEvent(ev) }
    }

    // ---- Sending --------------------------------------------------------------------------------------

    // What the agent reads once, when it starts: which provider, whether its
    // browser is shown, and the provider's controls. Applied to the page at
    // sign-in, so a change made later means nothing until the agent restarts.
    function sessionSettings(prov) {
        var p = prov || Providers.current
        return JSON.stringify([p, Providers.showBrowser, controlsFor(p)])
    }
    // The controls of the session's own provider. In Electron that is always
    // the chosen one; a pinned --provider is not, and taking the chosen one's
    // here would also change once the provider list loads after --start, and
    // reopen a session that nothing about has changed.
    function controlsFor(prov) {
        return prov === Providers.current ? Providers.desiredControls()
             : R.desiredControls(Providers.list, prov, Prefs.get(R.controlsKey(prov), "{}"))
    }

    /**
     * The session, started if it is not up. `prov` overrides the chosen
     * provider (--start with --provider, before the provider list has loaded).
     */
    function ensureSession(prov) {
        if (_starting) return _starting
        var want = prov || pinnedProvider || Providers.current
        var s = sessionSettings(want)
        if (up && settings === s) return Promise.resolve(true)
        var ws = AppState.workspace
        if (!ws) { note("Choose a project folder first - the agent works inside one.", "err"); return Promise.resolve(false) }
        // Changed since the agent started: it yields and a new one opens with the
        // new settings. The provider's thread is saved per project, so it resumes.
        var closing = up ? Api.call(Agent, "codeEnd") : Promise.resolve()
        if (up) note("Settings changed - reopening " + Providers.fullName + " with them", "dim")
        up = false
        spinnerOn("Opening " + Providers.fullName)
        turnStart = Date.now()
        var p = closing.catch(function () {}).then(function () {
            return buildPreamble()
        }).catch(function () { return {} }).then(function (preamble) {
            return Api.call(Agent, "codeStart", {
                workspace: ws, provider: want, mode: V.agentModeOf(store.mode),
                headed: Providers.showBrowser, controls: store.controlsFor(want), preamble: preamble,
            })
        }).then(function (r) {
            store._starting = null
            if (!r || !r.ok) { store.spinnerOff(); store.note("Could not start: " + ((r && r.error) || "unknown error"), "err"); return false }
            store.up = true
            store.settings = s
            if (r.provider) store.provider = r.provider
            return true
        }, function (e) { store._starting = null; store.spinnerOff(); store.note("Could not start: " + String(e), "err"); return false })
        _starting = p
        return p
    }

    function setMode(m) {
        mode = m
        renderModebar()
        if (up) Agent.codeMode(V.agentModeOf(m), function () {})
    }

    function cycleMode() { setMode(V.nextMode(mode)) }

    // /build, /test, /research and /ship switch on and off like /plan.
    function toggleMode(m) {
        setMode(mode === m ? "default" : m)
        note(C.toggleNote(m, mode), "dim")
    }

    // /model and /theme land on their Settings section; /settings keeps the
    // one last shown (showSection ignores "").
    function openSettings(section) {
        if (section) SettingsStore.showSection(section)
        AppState.switchTab("settings")
    }

    function slash(p) {
        switch (p.cmd) {
        case "/help": helpText(V.HELP); return
        case "/clear":
            if (busy) { note("Wait for the current turn to finish, or press esc.", "err"); return }
            if (up) Agent.codeClear(function () {}); else onEvent({ type: "cleared" })
            return
        case "/plan":
            setMode(mode === "plan" ? "default" : "plan")
            note(mode === "plan" ? "Plan mode on: read-only, answers with a plan" : "Plan mode off", "dim")
            return
        case "/mode": {
            var m = V.modeFromWord(p.arg)
            if (!m) { note("Modes: default, accept, plan, build, test, research, ship, auto", "dim"); return }
            var was = mode
            setMode(m)
            note(C.modeNote(m), "dim")
            if (m === "auto" && was !== "auto") note(V.AUTO_WARNING, "warn")
            return
        }
        case "/compact":
            if (busy) { note("Wait for the current turn to finish, or press esc.", "err"); return }
            if (!up) { note("Nothing to compact yet", "dim"); return }
            Agent.codeCompact(function () {})
            return
        case "/rewind":
            if (!up) { note("Nothing to rewind yet", "dim"); return }
            Agent.codeRewind(function () {})
            return
        case "/init": send(V.INIT_PROMPT, "/init"); return
        case "/memory": {
            var ws = AppState.workspace
            if (!ws) { note("Choose a project folder first", "err"); return }
            Files.readFile({ path: C.memoryPath(ws), full: true }, function (r) {
                var text = r && (r.content || r.text)
                if (!text) { store.note("No CLOSENI.md yet - /init writes one", "dim"); return }
                store.helpText(text)
            })
            return
        }
        case "/build": case "/test": case "/research": case "/ship": {
            // "/test add a case for x" switches and does it; bare, it toggles.
            var mm = p.cmd.slice(1)
            if (!p.arg) { toggleMode(mm); return }
            if (mode !== mm) setMode(mm)
            if (mm === "research") research(p.arg)
            else send(V.modePrompt(mm, p.arg), p.arg)
            return
        }
        // The step-by-step builder, the runner and the GitHub screen keep their
        // full panels; these open them, and the Agent button comes back.
        case "/steps": AppState.switchTab("chat"); return
        case "/runner": AppState.switchTab("test"); return
        case "/github": AppState.switchTab("push"); return
        case "/settings": openSettings(""); return
        case "/model": openSettings("provider"); return
        case "/theme": openSettings("appearance"); return
        case "/stop": interrupt(); return
        default: note("Unknown command " + p.cmd + " - /help lists them", "err")
        }
    }

    function send(text, shownAs, fix) {
        var t = String(text || "").trim()
        var p = t ? V.parseSlash(t) : null
        if (p && !shownAs) {
            userLine(t)
            slash(p)
            return
        }
        // Enter on an empty line is the mode's own action: run the tests, or ship.
        if (!t && mode === "test") { userLine("run the tests"); runChecks("behaviour"); return }
        // A build request in a mode that cannot build goes to Build instead.
        var r = C.routeLine(mode, t, shownAs)
        if (r.mode !== mode) setMode(r.mode)
        if (mode === "research" && !shownAs) {
            if (!t) return
            userLine(t)
            research(r.research)
            return
        }
        // What the agent receives: the mode's job above the user's words. The
        // transcript shows only the words.
        if (!r.wire) return
        if (busy || starting || running) {
            queue = queue.concat([{ text: r.wire, shownAs: r.shown, fix: fix }])
            userLine(r.shown, true)
            if (r.switched) note(r.switched, "dim")
            return
        }
        userLine(r.shown)
        if (r.switched) note(r.switched, "dim")
        fixing = !!fix
        var wire = r.wire
        ensureSession().then(function (ok) {
            if (!ok) return
            Agent.codeSend(wire, function (res) {
                if (res && res.ok === false) store.note("Could not send: " + (res.error || "no session"), "err")
            })
        })
    }

    // A queued line goes 50 ms after the turn or run ends, as in code.js.
    property Timer _next: Timer {
        interval: 50
        onTriggered: {
            if (!store.queue.length) return
            var next = store.queue[0]
            store.queue = store.queue.slice(1)
            store.send(next.text, next.shownAs, next.fix)
        }
    }
    function _sendNextSoon() { _next.restart() }

    function interrupt() {
        if (permission) answerPermission("deny", "")
        if (busy && up) Agent.codeInterrupt(function () {})
    }

    /** Enter on the prompt: a typed line, or the mode's own action on an empty one. */
    function submit(text) {
        if (!String(text).trim()) {
            // Test and ship have something to do with nothing typed.
            if (mode === "test" || mode === "ship") send("")
            return false
        }
        history = history.slice(-(maxHistory - 1)).concat([text])
        hIndex = -1
        send(text)
        return true
    }

    function historyUp() {
        if (!history.length) return null
        var h = C.historyUp(history, hIndex)
        hIndex = h.index
        return h.text
    }
    function historyDown() {
        if (hIndex === -1) return null
        var h = C.historyDown(history, hIndex)
        hIndex = h.index
        return h.text
    }

    // ---- Files for @ -------------------------------------------------------------------------------------
    function loadFiles() {
        var ws = AppState.workspace
        if (!ws) return Promise.resolve([])
        if (_files && _files.ws === ws) return Promise.resolve(_files.list)
        return Api.call(Files, "listFiles", ws).then(function (r) {
            store._files = { ws: ws, list: (r && r.files) || [] }
            return store._files.list
        }, function () { return [] })
    }

    // A different folder is a different project: the old session yields and
    // the next message opens one there.
    property Connections _workspace: Connections {
        target: AppState
        function onWorkspaceOpened() {
            store._files = null
            if (store.up) { Agent.codeEnd(function () {}); store.up = false }
            store.renderModebar()
        }
    }

    // ---- What window.CN gave code.js ---------------------------------------------------------------------

    /** git in the workspace. */
    function git(args) {
        var ws = AppState.workspace
        if (!ws) return Promise.resolve({ success: false, output: "No project folder chosen" })
        return Api.call(Git, "git", { args: args, cwd: ws })
    }

    /**
     * Everything the model should be told before the task, for this run
     * (skills.js buildPreamble).
     *
     * MCP tools run here - once, before the run - rather than per step. A tool
     * whose answer changes mid-build is therefore read once, which is recorded in
     * the design as the known cost of not paying a browser round-trip per call.
     */
    function buildPreamble() {
        var parts = {}
        var persona = Prefs.get("closeni.persona", "")
        var skills = []
        try { skills = JSON.parse(Prefs.get("closeni.skills", "[]")) || [] } catch (e) { skills = [] }
        if (!Array.isArray(skills)) skills = []
        var texts = []
        var chain = Promise.resolve()
        if (persona) chain = chain.then(function () { return Api.call(Library, "readSkill", "persona", persona) })
            .then(function (p) { if (p && p.ok && String(p.text || "").trim()) parts.persona = p.text })
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

    /** A one-shot agent run (plan.js runAgent), with the preamble. */
    function runAgent(args) {
        return buildPreamble().then(function (preamble) {
            return Api.call(Agent, "runAgent", { args: args, headed: Providers.showBrowser,
                                                 controls: Providers.desiredControls(), preamble: preamble })
        }).catch(function (e) { return { success: false, error: String(e) } })
    }

    /** What an unconfigured project would be run with, from its files (test.js detectCommand). */
    function detectCommand(ws) {
        var files = [], pkg = null, makefile = null
        return Api.call(Files, "listFiles", ws).then(function (r) {
            files = (r && r.files) || []
            if (files.indexOf("package.json") === -1) return null
            return Api.call(Files, "readFile", { path: ws + "/package.json", full: true })
        }).then(function (r) {
            // An unreadable package.json falls through to the file rules.
            if (r && r.ok) { try { pkg = JSON.parse(r.text) } catch (e) { pkg = null } }
            if (files.indexOf("Makefile") === -1) return null
            return Api.call(Files, "readFile", { path: ws + "/Makefile", full: true })
        }).then(function (mk) {
            // An unreadable Makefile just means no `run` target.
            if (mk && mk.ok) makefile = mk.text
            return Entry.detectEntrypoint(files, pkg, { makefile: makefile }, App.platform)
        }).catch(function () { return null })
    }

    /** The run command and where it came from: what you saved, the plan's, or detected. */
    function resolveRunCommand() {
        var ws = AppState.workspace
        if (!ws) return Promise.resolve({ command: null, source: "none" })
        var manifest = null
        return Api.call(Builds, "readManifest", ws).then(function (m) { manifest = m }, function () {}).then(function () {
            return store.detectCommand(ws)
        }).then(function (detected) {
            if (manifest && String(manifest.run || "").trim()) return { command: String(manifest.run).trim(), source: "manifest" }
            var plan = AppState.currentPlan
            if (plan && String(plan.runCommand || "").trim()) return { command: String(plan.runCommand).trim(), source: "plan" }
            if (detected) return { command: detected, source: "detected" }
            return { command: null, source: "none" }
        })
    }

    /*
     * A repository chosen as reference (ship.js). Folded into the plan prompt so
     * the model designs against how a real project of that kind is laid out.
     * Nothing is written to the workspace, so there is no licence question on
     * this path.
     */
    function useAsReference(r) {
        var parsed = Safe.parseRepoUrl(r.url)
        if (!parsed) { Notify.toast("Not a GitHub repository", "err"); return }
        var readme = null
        Api.call(GitHub, "call", "getReadme", [parsed.owner, parsed.repo]).then(function (a) {
            readme = a || { ok: false }
            return Api.call(GitHub, "call", "getTree", [parsed.owner, parsed.repo])
        }).then(function (tree) {
            tree = tree || { ok: false }
            if (!readme.ok && !tree.ok) {
                Notify.toast(readme.error || tree.error || "Could not read that repository", "err")
                return
            }
            AppState.repoReference = {
                name: parsed.owner + "/" + parsed.repo,
                readme: String(readme.ok ? readme.result : "").slice(0, 3000),
                files: (tree.ok ? tree.result || [] : []).slice(0, 120),
            }
            Notify.toast("Referencing " + AppState.repoReference.name + " in the next plan")
            Notify.log("reference set: " + AppState.repoReference.name, "ok")
        })
    }

    /** Clone into the workspace, after asking: the licence is the user's to accept. */
    function cloneRepo(r) {
        if (!AppState.workspace) { Notify.toast("Pick a workspace", "err"); return }
        var parsed = Safe.parseRepoUrl(r.url)
        if (!parsed) { Notify.toast("Not a GitHub repository", "err"); return }
        cloneText = T.cloneQuestion(parsed.owner + "/" + parsed.repo, r.license)
        pendingClone = { url: r.url, workspace: AppState.workspace }
    }
    function answerClone(yes) {
        var c = pendingClone
        pendingClone = null
        if (!yes || !c) return
        AppState.setStatus("cloning")
        Api.call(GitHub, "clone", { url: c.url, workspace: c.workspace }).then(function (res) {
            AppState.setStatus("idle")
            if (res && res.ok) Notify.toast("Cloned into " + res.into)
            else Notify.toast((res && res.error) || "Clone failed", "err")
        })
    }
}
