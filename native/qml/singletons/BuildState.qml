pragma Singleton
import QtQuick
import CloseNI
import "../js/api.mjs" as Api
import "../js/builder-logic.mjs" as B
import "../js/scheduler.mjs" as Sched
import "../js/step-timing.mjs" as Timing
import "../js/diff.mjs" as Diff
import "../js/entrypoint.mjs" as Entry
import "../js/preview-target.mjs" as Preview
import "../js/renderer-logic.mjs" as R

/*
 * The build: desktop/builder.js, plus the agent calls window.CN made for it
 * in desktop/renderer/startup.js (runAgent, suggest, startSession, sendStep,
 * endSession) and buildPreamble from renderer/skills.js.
 *
 * A singleton rather than the Build panel's own state: the panel exists only
 * while it is open, and a build carries on while the user reads the chat or
 * the console. The panel draws from here and calls in here.
 *
 * QML has no async/await, so the build loop is a promise chain, and the
 * scheduler is pumped by events - a step settling, Resume, Skip, Stop -
 * rather than by Electron's sleep loop. Nothing here ticks while idle: the
 * two timers are single-shot and start only when something needs them.
 */
QtObject {
    id: build

    // ---- State ------------------------------------------------------------
    // The step objects, as builder.js held them; the source of truth. Mutated
    // in place, so every change bumps `revision` for the bindings that read it.
    property var steps: []
    // { title, status } per step, for the step list's delegates.
    property ListModel stepModel: ListModel {}
    property int revision: 0

    property bool running: false
    property bool paused: false
    property bool skipNext: false
    property bool stopRequested: false
    // A build runs through one long-lived agent session when it can;
    // retryFailed and any fallback keep using the per-step spawn.
    property bool sessionOn: false
    property int selected: -1

    property string statusText: "idle"
    property real progress: 0
    // "idle", "running" or "paused": which toolbar buttons show.
    property string mode: "idle"
    readonly property var shown: B.buttonVisibility(mode, revision >= 0 ? steps : [])

    // Step review: the bar shows only while a step is actually waiting on a
    // verdict. Buttons that are visible but inert read as broken.
    property bool reviewing: false
    property var _pendingReview: null
    // Off by default: a build you can walk away from is much of the point of
    // one, so pausing on every step is opted into, not out of.
    property bool reviewSteps: Prefs.get("closeni.review-steps", "off") === "on"
    function setReviewSteps(on) {
        reviewSteps = !!on
        Prefs.set("closeni.review-steps", on ? "on" : "off")
    }

    property bool suggesting: false
    // The frontend preview: { url, kind, ws } or null. Electron showed it in a
    // web view; the native app has none, so the Build panel offers it as
    // "Open in browser".
    property var preview: null

    property var _stepTimer: null
    property var _buildStartedAt: null
    property var _run: null

    // ---- Small helpers ----------------------------------------------------
    function setStatus(t) { statusText = String(t) }
    function _changed() {
        revision++
        AppState.buildStats = B.buildStats(steps, running)
    }
    function _progress() {
        progress = steps.length ? B.finishedCount(steps) / steps.length : 0
    }
    function _buttons(m) {
        mode = m
        _changed()
    }
    function _resetModel() {
        stepModel.clear()
        for (var i = 0; i < steps.length; i++)
            stepModel.append({ title: steps[i].title || "Step", status: steps[i].status })
    }
    function autonomy() { return Prefs.get("closeni.autonomy", "ask") }
    // One conversation, one composer: steps are serial and no longer
    // configurable. Kept as a function returning 1 rather than removed, so the
    // build keeps a single meaning for "how many may start now" instead of
    // scattering the assumption.
    function concurrency() { return 1 }

    // ---- The agent calls (window.CN in startup.js) --------------------------
    /**
     * Everything the model should be told before the task, for this run.
     *
     * MCP tools run here - once, before the run - rather than per step. A tool
     * whose answer changes mid-build is therefore read once, which is recorded
     * in the design as the known cost of not paying a browser round-trip per
     * call.
     */
    function preamble() {
        var parts = {}
        var persona = Prefs.get("closeni.persona", "")
        var names = R.parseSkills(Prefs.get("closeni.skills", "[]"))
        var texts = []
        var chain = persona
            ? Api.call(Library, "readSkill", "persona", persona).then(function (p) {
                if (p && p.ok && String(p.text || "").trim()) parts.persona = p.text
            })
            : Promise.resolve()
        names.forEach(function (n) {
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
        }, function (e) {
            // A preamble that cannot be assembled means the behaviour before
            // any of this was configured, which is a working run.
            Notify.log("preamble unavailable: " + String(e), "err")
            return {}
        })
    }

    /**
     * One agent run, carrying whatever the user has configured.
     *
     * The preamble is awaited here rather than per step, because it runs the
     * configured MCP tools: per step it would pay a subprocess launch twenty
     * times for text that does not change during a build.
     */
    function runAgent(args) {
        return preamble().then(function (pre) {
            return Api.call(Agent, "runAgent", { args: args, headed: Providers.showBrowser,
                                                 controls: Providers.desiredControls(), preamble: pre })
        }).then(null, function (e) { return { success: false, error: String(e) } })
    }
    function _startSession(ws, resuming) {
        // Awaited once here, because the preamble runs the configured MCP tools.
        return preamble().then(function (pre) {
            return Api.call(Agent, "startSession", {
                workspace: ws, provider: Providers.current, autonomy: autonomy(),
                headed: Providers.showBrowser, controls: Providers.desiredControls(),
                concurrency: concurrency(), resuming: resuming, preamble: pre })
        }).then(null, function (e) { return { ok: false, error: String(e) } })
    }
    function _sendStep(index, detail, goal, testable, title) {
        return Api.call(Agent, "sendStep", { index: index, detail: detail, goal: goal, testable: testable, title: title })
            .then(null, function (e) { return { success: false, error: String(e) } })
    }
    function _suggest(stepIndex, text) {
        return Api.call(Agent, "suggest", {
            workspace: AppState.workspace, provider: Providers.current, stepIndex: stepIndex,
            text: text, headed: Providers.showBrowser, controls: Providers.desiredControls() })
            .then(null, function (e) { return { success: false, error: String(e) } })
    }

    // ---- Step timing ------------------------------------------------------
    /*
     * The step currently on the clock.
     *
     * A session runs one step at a time, so "which step is this phase about"
     * has exactly one answer - the same property that lets the review gate
     * work. A phase arriving with nothing running belongs to a chat or a plan,
     * not to a build, and is dropped.
     */
    property Connections _phases: Connections {
        target: Providers
        function onPhaseNoted(name) {
            if (!build._stepTimer) return
            Timing.markPhase(build._stepTimer, name === "idle" ? null : name, Date.now())
        }
    }

    function setStatusOf(i, st) {
        steps[i].status = st
        if (i < stepModel.count) stepModel.setProperty(i, "status", st)
        _changed()
        saveBuildState()
    }

    /*
     * Write the build to the workspace so closing the app does not lose it.
     *
     * Hung off setStatusOf rather than settle() because it is the one place
     * every status change passes through - settle misses a skip and misses the
     * blocked steps a failure cascades into.
     *
     * Coalesced on a timer: marking a failure blocks its whole subtree, which
     * is one setStatusOf per blocked step, and that should be one write rather
     * than fourteen. Fire-and-forget, and a failure is deliberately silent - a
     * build must not stop because its bookkeeping could not be written. A
     * read-only workspace costs the resume, not the run.
     */
    property Timer _saveTimer: Timer {
        interval: 250
        repeat: false
        onTriggered: {
            var ws = AppState.workspace
            if (!ws || !build.steps.length) return
            // The store keeps only these fields; the file contents and diffs a
            // step's result holds are not sent across for nothing.
            var slim = build.steps.map(function (s) {
                return { title: s.title, detail: s.detail, files: s.files, dependsOn: s.dependsOn,
                         testable: s.testable, timing: s.timing, status: s.status }
            })
            Builds.writeBuildState({ workspace: ws, plan: AppState.currentPlan, steps: slim,
                                     provider: Providers.current, startedAt: build._buildStartedAt }, function (r) {
                if (r && r.ok && !build._buildStartedAt) build._buildStartedAt = r.startedAt
            })
        }
    }
    function saveBuildState() { if (!_saveTimer.running) _saveTimer.start() }

    /**
     * Bring back the build this workspace was in the middle of.
     *
     * Restores the plan and its statuses and stops there. Nothing runs: a
     * restart is as often a crash or a deliberate escape as a tidy shutdown,
     * and resuming into one automatically would repeat whatever went wrong,
     * unattended. The user presses Build, and seedState skips what is already
     * done. Resolves to the restored plan, or null.
     */
    function restoreBuild(workspace) {
        if (running || !workspace) return Promise.resolve(null)
        return Api.call(Builds, "readBuildState", workspace).then(function (state) {
            if (!state || !state.steps || !state.steps.length) return null
            steps = B.stepsFromSaved(state.steps)
            _buildStartedAt = state.startedAt || null
            selected = -1
            _resetModel()
            _buttons("idle")
            var done = B.finishedCount(steps)
            _progress()
            var st = B.restoredStatus(done, steps.length)
            setStatus(st.status)
            if (st.log) Notify.log(st.log, "step")
            // Handed back so the caller can restore currentPlan.
            return B.planFromSaved(state, steps)
        }, function () { return null })
    }

    /*
     * Opening a workspace: bring back its unfinished build and show its plan
     * without resetting the statuses (workspace.js).
     */
    property Connections _workspace: Connections {
        target: AppState
        function onWorkspaceOpened(folder) {
            build.restoreBuild(folder).then(function (restored) {
                if (!restored) return
                AppState.currentPlan = restored
                PlanState.showPlan(restored, true)
            })
        }
    }

    // ---- Rollback -----------------------------------------------------------
    /**
     * Undo a step without asking, for the Reject path.
     *
     * The button confirms because the user is undoing work they may have
     * forgotten writing. Reject does not, because the confirmation already
     * happened - pressing Reject IS the decision, and asking "are you sure?"
     * immediately after would be asking the same question twice.
     */
    function _rollbackQuietly(i) {
        var ws = AppState.workspace
        if (!ws) return Promise.resolve(false)
        return Api.call(Builds, "planRollback", ws, i).then(function (res) {
            if (!res || !res.ok) {
                Notify.log("could not undo step " + (i + 1) + ": " + ((res && res.error) || "unknown"), "err")
                return false
            }
            return Api.call(Builds, "applyRollback", ws, res.plan).then(function (applied) {
                if (!applied || !applied.ok) { Notify.log("could not undo step " + (i + 1), "err"); return false }
                Notify.log("step " + (i + 1) + " undone: " + applied.restored.length + " restored, " +
                           applied.removed.length + " removed", "step")
                return true
            })
        })
    }

    /**
     * Put the workspace back to just before step i.
     *
     * Everything after it goes too. Step 6 was written against a step 4 that is
     * about to stop existing, and leaving it done would describe a workspace no
     * plan matches - which the next step would then be written against.
     *
     * The plan is computed first and shown before anything is touched (through
     * `confirm(message, proceed)`, the panel's dialog). A file the user edited
     * by hand since the build wrote it is named rather than quietly
     * overwritten, because the backup that would recover it is the one about
     * to be replaced.
     */
    function rollbackTo(i, confirm) {
        if (running) { Notify.toast("Stop the build first", "err"); return }
        var ws = AppState.workspace
        if (!ws) return
        Builds.planRollback(ws, i, function (res) {
            if (!res || !res.ok) { Notify.toast("Cannot roll back: " + ((res && res.error) || "unknown"), "err"); return }
            var plan = res.plan
            var msg = B.rollbackMessage(plan, i)
            if (!msg) { Notify.toast("Nothing recorded for step " + (i + 1) + " onwards"); return }
            confirm(msg, function () { build._applyRollback(ws, i, plan) })
        })
    }
    function _applyRollback(ws, i, plan) {
        Builds.applyRollback(ws, plan, function (applied) {
            if (!applied || !applied.ok) { Notify.toast("Rollback failed: " + ((applied && applied.error) || "unknown"), "err"); return }
            for (var s = i; s < steps.length; s++) {
                steps[s].result = null
                setStatusOf(s, "pending")
            }
            selected = -1
            _progress()
            _buttons("idle")
            setStatus("rolled back: " + B.finishedCount(steps) + "/" + steps.length + " done")
            Notify.log("rolled back to before step " + (i + 1) + ": " +
                       applied.restored.length + " restored, " + applied.removed.length + " removed", "ok")
            if ((applied.refused || []).length)
                Notify.log("refused to touch paths outside the workspace: " + applied.refused.join(", "), "err")
            Notify.toast("Rolled back to step " + (i + 1))
        })
    }

    // ---- Review -----------------------------------------------------------
    /**
     * Wait for the user's verdict on a step that has just finished.
     *
     * A promise resolved by whichever button is pressed, so the build simply
     * waits on it. Stop resolves it too - a build that will not end because it
     * is waiting for a verdict nobody is going to give would be worse than one
     * that did not pause at all.
     */
    function _awaitReview(i) {
        selectStep(i)
        reviewing = true
        setStatus("step " + (i + 1) + " waiting for review")
        Notify.log("step " + (i + 1) + " finished - review the changes, then Accept or Reject", "step")
        return new Promise(function (resolve) {
            build._pendingReview = function (verdict) {
                build._pendingReview = null
                build.reviewing = false
                resolve(verdict)
            }
        })
    }
    function settleReview(verdict) {
        if (_pendingReview) _pendingReview(verdict)
    }
    function accept() { settleReview({ accept: true }) }
    /** False when there is no reason: the panel keeps the focus in the box. */
    function reject(reason) {
        reason = String(reason || "").trim()
        // Required, not optional. A rejection with no reason gives the next
        // attempt nothing to go on, and it will most likely produce the same
        // thing again - costing a step and teaching the user that Reject does
        // not work.
        if (!reason) {
            Notify.toast("Say what was wrong first - the model is told your reason", "err")
            return false
        }
        settleReview({ accept: false, reason: reason })
        return true
    }

    // ---- The step detail ------------------------------------------------------
    function selectStep(i) {
        selected = i
        revision++
    }
    function rollbackOffered(i) {
        return i >= 0 && i < steps.length && B.rollbackOffered(steps, i, running)
    }

    /*
     * The selected step's cards as flat rows for one ListView, so a long diff
     * creates only the rows on screen: { k, card, text, type, mode, path, last }
     * where k is "head", "pre" or "diff". `open` lists the file cards whose
     * bodies are shown (closed by default, as .file-body was).
     */
    function detailRows(i, open) {
        var rows = []
        var s = steps[i]
        if (!s) return rows
        var card = 0
        function pre(text) {
            var lines = String(text).split("\n")
            for (var n = 0; n < lines.length; n++)
                rows.push({ k: "pre", card: card, text: lines[n], type: "", last: n === lines.length - 1 })
        }
        if (s.timing) {
            var t = B.timingText(s.timing)
            rows.push({ k: "head", card: card, path: "time", mode: t.total, file: -1 })
            pre(t.body)
            card++
        }
        rows.push({ k: "head", card: card, path: "step detail", mode: s.status, file: -1 })
        pre(s.detail || "(no detail)")
        card++
        if (s.result && s.result.error) {
            rows.push({ k: "head", card: card, path: "error", mode: "failed", file: -1 })
            pre(s.result.error)
            card++
        }
        var files = (s.result && s.result.files) || []
        for (var f = 0; f < files.length; f++) {
            var fc = files[f]
            var isOpen = (open || []).indexOf(f) !== -1
            rows.push({ k: "head", card: card, path: fc.path, mode: fc.mode || "create", file: f, lang: true,
                        open: isOpen, last: !isOpen })
            if (isOpen) {
                if (fc.diff && fc.diff.length) {
                    for (var d = 0; d < fc.diff.length; d++)
                        rows.push({ k: "diff", card: card, type: fc.diff[d].type,
                                    text: fc.diff[d].type === "gap" ? fc.diff[d].text
                                          : B.diffMark(fc.diff[d].type) + " " + fc.diff[d].text,
                                    last: d === fc.diff.length - 1 })
                } else {
                    pre(fc.content || "")
                }
            }
            card++
        }
        return rows
    }

    // Reads the written file and, when applyPatch made a backup, the version
    // it replaced, so the card can show a diff rather than a wall of content.
    function _loadFileDiffs(ws, res) {
        var out = []
        var chain = Promise.resolve()
        ;(res.appliedFiles || []).forEach(function (af) {
            var after = "", before = ""
            chain = chain.then(function () {
                return Api.call(Files, "readFile", { path: ws + "/" + af, full: true })
            }).then(function (fr) {
                if (fr && fr.ok) after = fr.text
                // No backup entry means the file was created.
                return res.backupDir ? Api.call(Files, "readFile", { path: res.backupDir + "/" + af, full: true }) : null
            }).then(function (br) {
                if (br && br.ok) before = br.text
                out.push({ path: af, mode: before ? "overwrite" : "create", content: after,
                           diff: Diff.diffLines(before, after) })
            })
        })
        return chain.then(function () { return out })
    }

    // ---- One step -------------------------------------------------------------
    function _runOne(i) {
        var ws = AppState.workspace
        var plan = AppState.currentPlan
        var s = steps[i]
        var goal = (plan && plan.summary) || ""

        // `rejection` is set by Reject and carried into the next attempt, so the
        // model is told what was wrong rather than being asked to guess a
        // second time.
        function attempt(rejection) {
            build.selectStep(i)
            build._stepTimer = Timing.newTimer(Date.now())
            build.setStatusOf(i, "running")
            build.setStatus("building " + (i + 1) + "/" + build.steps.length)
            Notify.log("step " + (i + 1) + "/" + build.steps.length + ": " + (s.title || ""), "step")
            Notify.toast("Step " + (i + 1) + ": " + (s.title || ""))

            var stepDetail = B.stepPrompt(plan, s, rejection)
            var call = build.sessionOn
                ? build._sendStep(i, stepDetail, goal, !!s.testable, s.title || "")
                : build.runAgent(["browser", stepDetail, ws, Providers.current, build.autonomy(), String(i), stepDetail, goal])
            return call.then(function (res) {
                if (build._stepTimer) {
                    Timing.finish(build._stepTimer, Date.now())
                    s.timing = Timing.toRecord(build._stepTimer)
                    build._stepTimer = null
                }
                if (!(res && res.success)) {
                    s.result = { error: (res && res.error) || "unknown" }
                    build.setStatusOf(i, "failed")
                    Notify.log("step " + (i + 1) + " failed: " + ((res && res.error) || "unknown"), "err")
                    Notify.toast("Step " + (i + 1) + " failed", "err")
                    build.selectStep(i)
                    return false
                }
                return build._loadFileDiffs(ws, res).then(function (filesArr) {
                    s.result = { files: filesArr }
                    build.setStatusOf(i, "done")
                    if (s.timing) Notify.log(B.stepTimingLog(i, s.timing), "step")
                    Notify.log("step " + (i + 1) + " done: " + (res.appliedFiles || []).join(", "), "ok")
                    Notify.toast("Step " + (i + 1) + " complete")

                    // Nothing to review on a step that changed no files, and a
                    // stopping build must not stop to ask a question. Read now,
                    // not when the build started, so turning review on mid-build
                    // takes effect at the next step - which is what someone
                    // reaching for it after a bad step wants.
                    if (!build.reviewSteps || !filesArr.length || build.stopRequested) return true
                    return build._awaitReview(i).then(function (verdict) {
                        if (!verdict || verdict.accept) return true
                        // Rejected: put the workspace back before trying again,
                        // or the next attempt edits files the last one wrote and
                        // the diff stops describing one step's work.
                        return build._rollbackQuietly(i).then(function () {
                            var reason = verdict.reason || ""
                            Notify.log("step " + (i + 1) + " rejected" + (reason ? ": " + reason : "") +
                                       " - running it again", "step")
                            return attempt(reason)
                        })
                    })
                })
            })
        }
        return attempt("")
    }

    // ---- Plan and build -------------------------------------------------------
    function setPlan(plan) {
        if (!plan || !plan.steps) return
        steps = B.stepsFromPlan(plan.steps)
        selected = -1
        _resetModel()
        _buttons("idle")
        progress = 0
        setStatus("ready: " + steps.length + " steps")
        // A new plan starts a new build, so the old one's timestamp goes with
        // it - and so do the previous build's checkpoints, which are addressed
        // by step number and would otherwise let "roll back to step 4" restore
        // a file from a build that has nothing to do with this one.
        _buildStartedAt = null
        var ws = AppState.workspace
        if (ws) Builds.clearCheckpoints(ws, function () {})
        saveBuildState()
    }

    /** Resolves when the build has finished, been stopped or refused to start. */
    function startBuild() {
        if (running) { Notify.toast("Already running", "err"); return Promise.resolve() }
        if (!steps.length) { Notify.toast("No plan - generate one first", "err"); return Promise.resolve() }
        var ws = AppState.workspace
        if (!ws) { Notify.toast("Pick a workspace", "err"); return Promise.resolve() }
        running = true; stopRequested = false; paused = false; skipNext = false
        // A build is when the logs matter, so they open for it.
        Notify.setConsole(true, false)
        _buttons("running")

        // A build with steps already done is being picked up, not started. The
        // session needs to know: it decides whether to clear the record of what
        // the conversation has been shown.
        var resuming = steps.some(function (s) { return s.status === "done" })
        return _startSession(ws, resuming).then(function (started) {
            build.sessionOn = !!(started && started.ok)
            if (!build.sessionOn)
                Notify.log("session unavailable, falling back to a browser per step: " + ((started && started.error) || "unknown"), "step")
            else Notify.log("build session ready - one browser for the whole build", "step")

            // The graph, declared or implied. A plan where nothing is declared
            // is a chain, which reproduces the old serial loop exactly.
            var built = Sched.graphFor(build.steps)
            var dep = B.dependencyLog(built)
            if (dep) Notify.log(dep.text, dep.tone)
            // A conversation has one composer, so a session runs one step at a
            // time no matter what the graph permits. This mattered the moment
            // dependsOn started being honoured: before, a chain made exactly one
            // step runnable and the limit never had to hold anything back.
            var limit = build.sessionOn ? 1 : build.concurrency()
            // Seeded from what the step list already records, so pressing Build
            // after a partial run continues instead of redoing everything from
            // step 0.
            var state = Sched.seedState(build.steps)
            // A step that failed last time is being retried by starting again,
            // so clear it and anything it blocked - otherwise the scheduler
            // treats the whole subtree as settled and stops immediately.
            state.failed.concat(state.blocked).forEach(function (i) { build.setStatusOf(i, "pending") })
            state.failed = []
            state.blocked = []
            if (state.completed.length)
                Notify.log("resuming: " + state.completed.length + "/" + build.steps.length + " already done", "step")

            return new Promise(function (resolve) {
                build._run = { graph: built.graph, state: state, limit: limit, ended: resolve, looping: true, drained: null }
                build._pump()
            })
        }).then(function () { return build._drain() }).then(function () { return build._finish() })
    }

    function _done(state) {
        return state.completed.length + state.failed.length + state.blocked.length + state.skipped.length
    }

    function _settle(i, ok) {
        var r = _run
        if (!r) return
        var state = r.state
        state.running = state.running.filter(function (x) { return x !== i })
        ;(ok ? state.completed : state.failed).push(i)
        if (!ok) {
            // Blocked, not failed: these steps never ran, and calling them
            // failed would claim something about code nobody executed.
            Sched.blockedBy(r.graph, state.failed).forEach(function (b) {
                if (state.blocked.indexOf(b) === -1 && state.completed.indexOf(b) === -1 &&
                    state.failed.indexOf(b) === -1 && state.running.indexOf(b) === -1) {
                    state.blocked.push(b)
                    build.setStatusOf(b, "blocked")
                    Notify.log("step " + (b + 1) + " blocked: a step it depends on failed", "step")
                }
            })
        }
        progress = _done(state) / steps.length
        if (r.looping) _pump()
        else if (!state.running.length && r.drained) r.drained()
    }

    /*
     * The scheduler's loop body, run whenever something may have changed what
     * can start: the build starting, a step settling, Resume, Skip, Stop.
     */
    function _pump() {
        var r = _run
        if (!r || !r.looping) return
        if (stopRequested) { r.looping = false; r.ended(); return }
        if (paused) return
        var state = r.state
        var ready = Sched.runnableSteps(r.graph, state, r.limit)
        if (!ready.length) {
            // Nothing running and nothing startable means the build is over -
            // either finished, or every remaining step is blocked.
            if (state.running.length === 0) { r.looping = false; r.ended() }
            return
        }
        var skipped = false
        ready.forEach(function (i) {
            if (build.skipNext) {
                build.skipNext = false
                state.skipped.push(i)
                build.setStatusOf(i, "skipped")
                Notify.log("step " + (i + 1) + " skipped", "step")
                build.progress = build._done(state) / build.steps.length
                skipped = true
                return
            }
            state.running.push(i)
            build._runOne(i).then(function (ok) { build._settle(i, ok) }, function () { build._settle(i, false) })
        })
        if (skipped) Qt.callLater(_pump)
    }

    /*
     * Let anything still in flight finish before the session closes, or its
     * apply would be cut off midway.
     *
     * This drains on stop too: ending the session pulls the browser out from
     * under a step that is still waiting, and the step then fails with "Target
     * page, context or browser has been closed" - an internal error where the
     * honest answer is "you stopped it". Bounded, because a step waiting out a
     * five-minute completion should not hold the interface hostage after the
     * user has asked it to stop.
     */
    property Timer _drainTimer: Timer {
        repeat: false
        onTriggered: if (build._run && build._run.drained) build._run.drained()
    }
    function _drain() {
        var r = _run
        if (!r.state.running.length) return Promise.resolve()
        if (stopRequested)
            Notify.log("stopping: letting " + r.state.running.length + " running step(s) unwind", "step")
        return new Promise(function (resolve) {
            r.drained = function () {
                r.drained = null
                build._drainTimer.stop()
                resolve()
            }
            build._drainTimer.interval = build.stopRequested ? 20000 : 10 * 60 * 1000
            build._drainTimer.start()
        })
    }

    function _finish() {
        var r = _run
        if (r.state.running.length)
            Notify.log("step(s) still in flight when the session closed; they are reported as failed", "err")
        _run = null
        var ended = sessionOn ? Api.call(Agent, "endSession") : Promise.resolve()
        return ended.then(function () {
            build.sessionOn = false
            build.running = false
            build.paused = false
            build.reviewing = false
            build._buttons("idle")
            var finished = B.finishedCount(build.steps)
            B.buildTimingLog(build.steps).forEach(function (line) { Notify.log(line, "step") })
            build.setStatus("finished: " + finished + "/" + build.steps.length)
            Notify.log("build finished: " + finished + "/" + build.steps.length, "step")
            Notify.toast("Build finished: " + finished + "/" + build.steps.length)
            return build._saveRunManifest()
        })
    }

    /**
     * Persist how to run what was just built.
     *
     * The model declared this while planning; without writing it down the
     * answer dies with the session and the Test panel is back to guessing from
     * filenames. mergeManifest preserves a command the user edited, so this
     * cannot undo a correction.
     */
    function _saveRunManifest() {
        var ws = AppState.workspace
        if (!ws) return Promise.resolve()
        var plan = AppState.currentPlan
        return Api.call(Files, "listFiles", ws).then(function (listing) {
            // An unreadable workspace just means no detection.
            return Entry.detectEntrypoint((listing && listing.files) || [], null, null, App.platform)
        }).then(function (detected) {
            var chosen = (plan && plan.runCommand) || detected
            if (!chosen) return
            return Api.call(Builds, "writeManifest", { workspace: ws, run: chosen }).then(function (r) {
                if (r && r.ok) Notify.log("run command saved: " + r.manifest.run, "ok")
            })
        })
    }

    /**
     * Retry the failed step and carry on through the rest.
     *
     * This used to run exactly one step and stop, so the only way forward was
     * Start Build - which restarted from step 0 and redid everything.
     * Delegating to startBuild resumes: seedState keeps what succeeded, and the
     * failed step and anything it blocked are reset to pending.
     */
    function retryFailed() {
        if (running) { Notify.toast("Already running", "err"); return }
        if (!steps.some(function (s) { return s.status === "failed" || s.status === "blocked" })) {
            Notify.toast("Nothing failed to retry")
            return
        }
        startBuild()
    }

    function pause() { paused = true; _buttons("paused"); setStatus("paused"); Notify.toast("Paused") }
    function resume() { paused = false; _buttons("running"); setStatus("resumed"); Notify.toast("Resumed"); _pump() }
    function skip() { skipNext = true; Notify.toast("Will skip next step") }
    function stop() {
        stopRequested = true
        paused = false
        // A step waiting for Accept or Reject would wait forever otherwise, and
        // Stop would be the one button that does not stop anything. Accepting
        // is the safe reading: the work is already on disk, and undoing it
        // silently because someone pressed Stop would destroy a step they
        // never rejected.
        settleReview({ accept: true })
        setStatus("stopping...")
        Notify.toast("Stopping", "err")
        _pump()
    }

    // ---- Suggest a change to a finished step ------------------------------------
    /** Resolves true when the change was applied, so the panel clears its box. */
    function suggest(text) {
        text = String(text || "").trim()
        if (!text) return Promise.resolve(false)
        var i = selected
        if (i < 0 || !steps[i]) { Notify.toast("Select a step first", "err"); return Promise.resolve(false) }
        if (steps[i].status === "pending" || steps[i].status === "running") {
            Notify.toast("That step has not finished yet", "err"); return Promise.resolve(false)
        }
        suggesting = true
        Notify.log("suggesting on step " + (i + 1) + ": " + text, "step")
        return _suggest(i, text).then(function (res) {
            build.suggesting = false
            if (res && res.success) {
                return build._loadFileDiffs(AppState.workspace, res).then(function (files) {
                    build.steps[i].result = { files: files }
                    build.selectStep(i)
                    Notify.log("suggestion applied: " + (res.appliedFiles || []).join(", "), "ok")
                    Notify.toast("Change applied")
                    return true
                })
            }
            Notify.log("suggestion failed: " + ((res && res.error) || "unknown"), "err")
            Notify.toast((res && res.error) || "Suggestion failed", "err")
            return false
        })
    }

    // ---- The preview ------------------------------------------------------------
    /**
     * The frontend preview.
     *
     * Only offered when there is genuinely something to show - a button that
     * opens nothing is worse than no button. Called after a run, since that is
     * where the server output arrives: by the run console, and by the Test
     * panel (Electron's CNBuilderPreview.update).
     */
    function updatePreview(runOutput, ws, files) {
        var target = Preview.previewTarget(runOutput || "", files || [])
        // A server listening on 0.0.0.0 is reached at localhost: Electron's web
        // view coped with either, but a system browser on Windows does not.
        // Runner hands the run console the same address.
        var url = target ? (target.kind === "server" ? target.url.replace("0.0.0.0", "localhost") : target.url) : ""
        preview = target ? { url: url, kind: target.kind, ws: ws || AppState.workspace || "" } : null
    }
    /*
     * Electron showed the page in a sandboxed web view. There is no web view
     * here at all: a server's address goes to the system browser, and a static
     * page is opened as the file it is (openExternal only takes http, https and
     * mailto, so a file goes through openPath).
     */
    function openPreview() {
        var p = preview
        if (!p || !p.url) return
        var ok = p.kind === "file" ? App.openPath(p.ws + "/" + p.url) : App.openExternal(p.url)
        if (!ok) Notify.toast("Could not open " + B.previewUrl(p.kind, p.ws, p.url), "err")
    }

    // ---- Run what was built ------------------------------------------------------
    /*
     * Run the project in the run console: the replacement for the preview
     * pane. The command is chosen as the Test panel chooses it - the saved
     * manifest, then the plan, then detection from the files.
     */
    function detectCommand(ws) {
        var files = []
        var pkg = null
        var makefile = null
        return Api.call(Files, "listFiles", ws).then(function (listing) {
            files = (listing && listing.files) || []
            return files.indexOf("package.json") !== -1 ? Api.call(Files, "readFile", { path: ws + "/package.json", full: true }) : null
        }).then(function (r) {
            // An unreadable package.json falls through to the file rules.
            if (r && r.ok) { try { pkg = JSON.parse(r.text) } catch (e) {} }
            return files.indexOf("Makefile") !== -1 ? Api.call(Files, "readFile", { path: ws + "/Makefile", full: true }) : null
        }).then(function (mk) {
            if (mk && mk.ok) makefile = mk.text
            return { command: Entry.detectEntrypoint(files, pkg, { makefile: makefile }, App.platform), files: files }
        })
    }
    function runProject() {
        var ws = AppState.workspace
        if (!ws) { Notify.toast("Pick a workspace", "err"); return Promise.resolve() }
        var manifest = null
        return Api.call(Builds, "readManifest", ws).then(function (m) {
            manifest = m
            return build.detectCommand(ws)
        }).then(function (d) {
            var chosen = R.chooseRunCommand(ws, manifest, AppState.currentPlan, d.command)
            if (!chosen.command) { Notify.toast("Nothing to run - no run command was found", "err"); return }
            Notify.log("run: " + chosen.command + " (" + R.RUN_LABELS[chosen.source][0].toLowerCase() + ")", "step")
            return Api.call(Runner, "openRunWindow", { command: chosen.command, cwd: ws }).then(function (r) {
                if (r && r.ok === false) Notify.toast(r.error || "Could not run it", "err")
            })
        })
    }
}
