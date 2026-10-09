import QtQuick
import CloseNI
import "../js/code-transcript.mjs" as T

/*
 * --self-test <dir> --self-test-flow Code, with --start, --provider mock and a
 * --workspace (native/tests/code-e2e.cjs sets up the mock provider and the
 * project): a real agent session driven through the Code panel's own key
 * handlers. The request is typed and sent with enter, the edit's permission
 * prompt is answered 1 (allow), and the turn finishes with the model's answer.
 * Then the run console's "Fix errors" (Runner.runFix): one from another folder
 * is declined, one from this project becomes a turn. Each check prints
 * "code-flow: ok <name>"; a failed one warns, which main.cpp counts and turns
 * into exit 1. Two screenshots: the permission prompt and the finished turn.
 *
 * QML cannot post real key events to the panel, so the flow calls the
 * handlers the panel's Keys.onPressed runs (inputKey, permissionKey) with
 * the same key object shape.
 */
Item {
    id: flow

    required property var root
    required property string outDir

    property int failed: 0
    property int shots: 0
    // Pending waits: { cond, resolve, reject, until, what }.
    property var waits: []
    // The agent's event types since the flow last cleared it.
    property var events: []

    Connections {
        target: Agent
        function onCodeEvent(ev) { flow.events.push(ev.type) }
    }

    function check(name, cond, detail) {
        if (cond) console.log("code-flow: ok " + name)
        else { failed++; console.warn("code-flow: FAIL " + name + (detail !== undefined ? " -- " + detail : "")) }
    }

    function waitFor(what, cond, ms) {
        return new Promise(function (resolve, reject) {
            waits.push({ cond: cond, resolve: resolve, reject: reject, until: Date.now() + (ms || 60000), what: what })
            poll.start()
        })
    }
    function pause(ms) {
        var until = Date.now() + ms
        return waitFor("pause", function () { return Date.now() >= until }, ms + 1000)
    }
    function shot(name) {
        Notify.toasts.clear()
        return pause(600).then(function () {
            flow.root.selfTestShot(flow.outDir + "/code-" + name + ".png")
            flow.shots++
        })
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

    // A key as the panel's Keys handler receives it.
    function key(k, text) { return { key: k, text: text || "", modifiers: Qt.NoModifier, accepted: false } }

    // Whether any transcript entry's text contains `what` (a string or a RegExp).
    function transcriptHas(what) {
        for (var i = 0; i < CodeStore.items.count; i++) {
            var e = CodeStore.entry(CodeStore.items.get(i).uid)
            var t = (e && e.text) || ""
            if (typeof what === "string" ? t.indexOf(what) !== -1 : what.test(t)) return true
        }
        return false
    }

    function turnDone() { return flow.events.indexOf("done") !== -1 }

    function run() {
        var panel = null
        var input = null
        var fix = { command: "python3 calc.py", prompt: "python3 calc.py failed:\nNameError: name 'ad' is not defined" }
        Theme.setTheme("terminal")
        AppState.switchTab("code")
        // --start opens the session through CodeStore, as the panel does.
        return waitFor("the session", function () { return CodeStore.up && !CodeStore.starting }, 90000).then(function () {
            check("the session comes up", CodeStore.up)
            panel = find(flow.root.contentItem, "codePanel")
            input = find(panel, "codeInput")
            if (!panel || !input) throw new Error("no Code panel or prompt")
            flow.events = []
            input.text = "fix the bug in calc.py"
            panel.inputKey(key(Qt.Key_Return, "\r"))
            check("enter sends the request", input.text === "" && flow.transcriptHas("fix the bug in calc.py"), input.text)
            return waitFor("the permission prompt", function () { return !!CodeStore.permission }, 90000)
        }).then(function () {
            check("the first message keeps the session --start opened", !flow.transcriptHas("Settings changed"))
            check("the edit asks, in the transcript", CodeStore.permission.req.tool === "edit", JSON.stringify(CodeStore.permission.req))
            return shot("e2e")
        }).then(function () {
            // 1 is the first option, allow.
            panel.permissionKey(key(Qt.Key_1, "1"), true)
            check("allow answers the prompt", CodeStore.permission === null)
            return waitFor("the turn", turnDone, 90000)
        }).then(function () {
            check("the model's answer is shown", flow.transcriptHas(/add\(\) now adds/))
            return shot("e2e-done")
        }).then(function () {
            // "Fix errors" in the run console, from another folder: the panel
            // comes forward and says so, and no turn starts.
            AppState.switchTab("settings")
            var elsewhere = AppState.workspace + "-elsewhere"
            Runner.runFix({ cwd: elsewhere, command: fix.command, prompt: fix.prompt })
            check("a run fix brings the Code panel forward", AppState.mode === "code", AppState.mode)
            check("a run fix from another folder is declined",
                  !CodeStore.busy && flow.transcriptHas(T.runFixElsewhere(elsewhere)))
            // From this project: a turn, shown as what it fixes.
            AppState.switchTab("settings")
            flow.events = []
            Runner.runFix({ cwd: AppState.workspace, command: fix.command, prompt: fix.prompt })
            check("a run fix from this project is sent as a turn",
                  AppState.mode === "code" && flow.transcriptHas("fix the errors from " + fix.command))
            return waitFor("the run fix turn", turnDone, 90000)
        }).then(function () {
            check("the run fix answer is shown", flow.transcriptHas(/crash is fixed/))
        })
    }

    Timer {
        id: poll
        interval: 50
        repeat: true
        onTriggered: {
            var keep = []
            var now = Date.now()
            flow.waits.forEach(function (w) {
                var ok = false
                try { ok = !!w.cond() } catch (e) { ok = false }
                if (ok) w.resolve()
                else if (now > w.until) w.reject(new Error("timed out waiting for " + w.what))
                else keep.push(w)
            })
            flow.waits = keep
            if (!keep.length) stop()
        }
    }

    Component.onCompleted: {
        run().catch(function (e) {
            flow.failed++
            console.warn("code-flow: FAIL " + e)
        }).then(function () {
            console.log("code-flow: " + flow.shots + " screenshots, " + flow.failed + " failed")
            Qt.exit(flow.failed === 0 && flow.shots === 2 ? 0 : 1)
        })
    }
}
