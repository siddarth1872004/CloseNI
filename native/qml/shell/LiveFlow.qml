import QtQuick
import CloseNI

/*
 * --live <file>, with --start and a --workspace: one scenario of the live
 * suite (scripts/agent-live.mjs), typed into the Code panel of a real window.
 * The file is JSON: { auto, turnTimeoutMs, steps }, where each step is one of
 *   { say }             type a message and wait for its turn
 *   { command }         type a slash command that runs no turn
 *   { mode }            switch the panel's mode (/mode <mode>)
 *   { approvePlan }     accept the plan offered at the end of a plan-mode turn
 *   { say, interrupt }  press esc once the turn's first tool has run
 *
 * Like CodeFlow.qml it drives the panel through its own key handlers
 * (inputKey) with the key object shape Keys.onPressed hands them, as QML
 * cannot post real key events. A permission prompt is never answered here:
 * without auto a person answers it in the window and the flow waits.
 *
 * Progress goes to the log as "closeni-live: <what> <json>" lines, which the
 * script parses (QT_FORCE_STDERR_LOGGING=1 puts them on stderr):
 *   session                    the session is up
 *   step {i, ...step}          a step begins
 *   permission {question}      a prompt waits for a person (once per prompt)
 *   turn {reason, seconds}     a turn ended
 *   transcript "<line>"        the transcript, one entry a line, at the end
 *   end {error}                the scenario is over ("" when it went through)
 * Then the session is closed and the app exits. Warnings fail nothing here.
 */
Item {
    id: flow

    required property var root
    property string scenario: ""

    // Pending waits: { cond, resolve, reject, until, what }.
    property var waits: []
    // The agent's turn ends (their reasons) and tool events since launch.
    property var dones: []
    property int tools: 0
    property int askedUid: -1

    Connections {
        target: Agent
        function onCodeEvent(ev) {
            if (ev.type === "done") flow.dones = flow.dones.concat([String(ev.reason)])
            else if (ev.type === "tool") flow.tools++
        }
    }

    function report(what, data) { console.log("closeni-live: " + what + (data === undefined ? "" : " " + JSON.stringify(data))) }

    function waitFor(what, cond, ms) {
        return new Promise(function (resolve, reject) {
            waits.push({ cond: cond, resolve: resolve, reject: reject, until: Date.now() + ms, what: what })
            poll.start()
        })
    }
    function pause(ms) {
        var until = Date.now() + ms
        return waitFor("pause", function () { return Date.now() >= until }, ms + 1000)
    }

    function find(item, name) {
        if (!item) return null
        if (item.objectName === name) return item
        var kids = item.children || []
        for (var i = 0; i < kids.length; i++) {
            var f = find(kids[i], name)
            if (f) return f
        }
        return null
    }

    function key(k, text) { return { key: k, text: text || "", modifiers: Qt.NoModifier, accepted: false } }

    function entryAt(i) { return CodeStore.entry(CodeStore.items.get(i).uid) || {} }

    // A session that could not start or ended mid-turn, as the panel says it.
    function fatal() {
        for (var i = Math.max(0, CodeStore.items.count - 3); i < CodeStore.items.count; i++) {
            var e = entryAt(i)
            if (e.kind === "note" && e.tone === "err" && /Could not start|session ended/.test(e.text)) return e.text
        }
        return ""
    }

    // Says once per prompt that a person is needed in the window.
    function noticePermission() {
        var P = CodeStore.permission
        if (!P || P.uid === askedUid) return
        askedUid = P.uid
        var e = CodeStore.entry(P.uid) || {}
        report("permission", { question: String((e.perm && e.perm.question) || P.req.tool || "") })
    }

    function plainEntry(e) {
        switch (e.kind) {
        case "user": return "> " + e.text + (e.queued ? " (queued)" : "")
        case "msg": case "help": return e.text
        case "note": return (e.tone ? "[" + e.tone + "] " : "") + e.text
        case "think": return "(thinking) " + String(e.text || "").split("\n")[0].slice(0, 200)
        case "tool": return "* " + (e.verb || e.name) + (e.arg ? " " + e.arg : "") + (e.summary ? " - " + e.summary : "")
               + (e.perm && e.perm.answered ? " [" + e.perm.answered + "]" : "")
        case "plan": return "Ready to code?" + (e.answered ? " -> " + e.answered : "")
        case "card": return "[" + e.cardKind + "] " + e.title + (e.summary ? " - " + e.summary : "")
        default: return "(" + e.kind + ")"
        }
    }

    function run() {
        var s = JSON.parse(flow.scenario)
        var timeout = s.turnTimeoutMs || 20 * 60 * 1000
        var panel = null
        var input = null
        var enter = function (text) { panel.setInput(text); panel.inputKey(key(Qt.Key_Return, "\r")) }
        AppState.switchTab("code")

        // --start opens the session through CodeStore; nothing is typed before
        // it is up, or a mode set now would not reach the agent.
        var chain = waitFor("the session", function () {
            var f = fatal()
            if (f) throw new Error(f)
            return CodeStore.up && !CodeStore.starting
        }, timeout).then(function () {
            panel = find(flow.root.contentItem, "codePanel")
            input = find(panel, "codeInput")
            if (!panel || !input) throw new Error("no Code panel or prompt")
            report("session")
            if (!s.auto) return
            enter("/mode auto")
            return pause(500)
        })

        s.steps.forEach(function (step, i) {
            chain = chain.then(function () {
                report("step", Object.assign({ i: i }, step))
                if (step.mode) { enter("/mode " + step.mode); return pause(500) }
                if (step.command) { enter(step.command); return pause(3000) }
                var before = flow.dones.length
                var toolsBefore = flow.tools
                var started = Date.now()
                var sent
                if (step.approvePlan) {
                    sent = waitFor("the plan offer", function () {
                        var e = entryAt(CodeStore.items.count - 1)
                        return e.kind === "plan" && !e.answered
                    }, 10000).then(function () {
                        if (s.auto) {
                            // The offer's choices switch to a mode that asks
                            // (or to build); auto mode is set again and the
                            // go-ahead typed, as a person would. Typing it in
                            // plan mode would keep the agent read-only.
                            enter("/mode auto")
                            return pause(500).then(function () { enter("Go ahead and implement the plan.") })
                        }
                        // "Yes, and manually approve edits", through the offer's own handler.
                        CodeStore.choosePlan(CodeStore.items.get(CodeStore.items.count - 1).uid, 2)
                    })
                } else {
                    enter(step.say)
                    sent = Promise.resolve()
                }
                if (step.interrupt) {
                    sent = sent.then(function () {
                        return waitFor("a tool to run", function () {
                            return flow.tools > toolsBefore || flow.dones.length > before
                        }, timeout)
                    }).then(function () { panel.inputKey(key(Qt.Key_Escape)) })
                }
                return sent.then(function () {
                    return waitFor("the turn to finish", function () {
                        if (flow.dones.length > before) return true
                        var f = fatal()
                        if (f) throw new Error(f)
                        noticePermission()
                        return false
                    }, timeout)
                }).then(function () {
                    var reason = flow.dones[before]
                    report("turn", { reason: reason, seconds: Math.round((Date.now() - started) / 1000) })
                    // A turn that errored can leave files as they were, which some checks would pass.
                    var want = step.interrupt ? "interrupted" : "complete"
                    if (reason !== want) throw new Error("a turn ended " + reason + ", not " + want)
                })
            })
        })
        return chain
    }

    function finish(error) {
        for (var i = 0; i < CodeStore.items.count; i++) report("transcript", plainEntry(entryAt(i)))
        report("end", { error: error })
        quitTimer.start()
        if (CodeStore.up) Agent.codeEnd(function () { Qt.exit(0) })
        else Qt.exit(0)
    }

    // If the session does not close, the app exits anyway.
    Timer { id: quitTimer; interval: 15000; onTriggered: Qt.exit(0) }

    Timer {
        id: poll
        interval: 100
        repeat: true
        onTriggered: {
            var keep = []
            var now = Date.now()
            flow.waits.forEach(function (w) {
                var ok = false
                try { ok = !!w.cond() } catch (e) { w.reject(e); return }
                if (ok) w.resolve()
                else if (now > w.until) w.reject(new Error("timed out waiting for " + w.what))
                else keep.push(w)
            })
            flow.waits = keep
            if (!keep.length) stop()
        }
    }

    Component.onCompleted: {
        var p
        try { p = run() } catch (e) { p = Promise.reject(e) }
        p.then(function () { flow.finish("") }, function (e) { flow.finish(String(e && e.message ? e.message : e)) })
    }
}
