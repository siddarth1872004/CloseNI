import QtQuick
import CloseNI
import "../js/code-transcript.mjs" as T

/*
 * --self-test <dir>: drives the shell through every theme on every panel, with
 * decor on and off, then the console, a toast, the approval modal and the
 * browser gate, and saves three screenshots (terminal, paper, pixel) to <dir>.
 * One step per tick so each state renders before the next. main.cpp counts
 * the warnings and sets the exit code; this only quits. The saved theme and
 * decor are put back at the end.
 *
 * The Code panel walks the themes with a transcript in it - every kind of
 * entry, a pending permission prompt, a card of each sort, the todo list, the
 * mode strip and the run offer - and has three screenshots of its own
 * (code-terminal, code-paper, code-pixel). Run with --start, --provider mock
 * and a --workspace (native/tests/code-e2e.cjs), it then drives a real session
 * through the panel's own keys: send, the permission prompt, allow, done.
 */
Item {
    id: test

    required property var root
    required property string outDir
    required property var approval

    property var steps: []
    property int at: 0
    property int shots: 0
    property int expected: 0
    // A step that returns false runs again on the next tick (see waitFor).
    property double waitStart: 0
    property var codeEvents: []
    readonly property string savedTheme: Theme.current
    readonly property bool savedDecor: Theme.decor

    function shot(name) {
        expected++
        // main.cpp saves the window synchronously and warns if it cannot.
        return function () {
            test.root.selfTestShot(test.outDir + "/" + name + ".png")
            test.shots++
        }
    }

    // Waits, a tick at a time, until cond() holds; a timeout is a warning,
    // which fails the run.
    function waitFor(label, cond, ms) {
        return function () {
            if (!test.waitStart) test.waitStart = Date.now()
            if (cond()) { test.waitStart = 0; console.log("self-test: code e2e: " + label); return true }
            if (Date.now() - test.waitStart < ms) return false
            test.waitStart = 0
            console.warn("self-test: code e2e: timed out waiting for " + label)
            return true
        }
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

    // The Code panel with something in every kind of entry.
    function seedCode() {
        var before = "def add(a, b):\n    return a - b\n\n\ndef sub(a, b):\n    return a - b\n"
        var after = "def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n"
        var ev = function (e) { CodeStore.onEvent(e) }
        var noop = function () {}
        CodeStore.note("Using CLOSENI.md from the project", "dim")
        CodeStore.userLine("fix the failing test in calc.py")
        ev({ type: "turn-start" })
        ev({ type: "reasoning", step: 0, text: "The test expects **add(2, 3)** to be 5; the function subtracts." })
        ev({ type: "assistant", text: "The failing test is `test_add`. I'll read `calc.py` first:\n\n- `add` subtracts\n- `sub` is right" })
        ev({ type: "tool", id: "s1", name: "read", input: { path: "calc.py" }, status: "done", detail: { lines: 6 }, output: before })
        ev({ type: "tool", id: "s2", name: "bash", input: { command: "python -m pytest -q" }, status: "error",
             output: "F.\n___ test_add ___\n    assert add(2, 3) == 5\nE   assert -1 == 5\n1 failed, 1 passed in 0.02s" })
        ev({ type: "tool", id: "s3", name: "edit", input: { path: "calc.py" }, status: "done", detail: { path: "calc.py", before: before, after: after } })
        var todos = [{ text: "Read calc.py", status: "done" }, { text: "Fix add()", status: "in_progress" },
                     { text: "Run the tests", status: "pending" }]
        ev({ type: "tool", id: "s4", name: "todo", input: {}, status: "done", detail: { items: todos } })
        ev({ type: "todos", items: todos })
        CodeStore.offerPlan()
        var tests = CodeStore.card("test", "Tests", "1 of 3 checks pass")
        CodeStore._cardGroup(tests, "body", CodeStore._testParts([
            { command: "python -m pytest -q", language: "Python", success: false, detail: "1 failed, 1 passed\nE   assert -1 == 5" },
            { command: "python -m py_compile calc.py", language: "Python", success: true, detail: "" },
            { command: "cargo test", language: "Rust", success: false, detail: "skipped - no Cargo.toml" },
        ]), false)
        CodeStore.patch(tests, { tone: "fail" })
        var research = CodeStore.card("research", "Research", "calculator libraries",
                                      [{ id: "web", sep: false, parts: [] }, { id: "gh", sep: true, parts: [] }])
        CodeStore._cardGroup(research, "web", [
            { t: "answer", text: "Python's **decimal** module avoids float error in a calculator [1]." },
            { t: "title", text: T.sourcesTitle("web search") },
            { t: "source", n: 1, url: "https://docs.python.org/3/library/decimal.html" },
            { t: "actions", buttons: [{ label: "Plan with this", act: noop }] },
        ], false)
        CodeStore._cardGroup(research, "gh", [
            { t: "repo", url: "https://github.com/example/calc", name: "example/calc",
              meta: T.repoMeta({ stars: 412, language: "Python" }), lang: "Python", desc: "A small calculator with a REPL.",
              buttons: [{ label: "Use as reference", act: noop }, { label: "Clone", act: noop }] },
        ], false)
        var diff = CodeStore.card("git", "git diff", "1 file changed")
        CodeStore._cardGroup(diff, "body", [{ t: "gitdiff", lines: T.gitDiffLines(
            "diff --git a/calc.py b/calc.py\n@@ -1,2 +1,2 @@\n def add(a, b):\n-    return a - b\n+    return a + b") }], false)
        CodeStore.userLine("also add a test for sub", true)
        ev({ type: "tool", id: "s5", name: "bash", input: { command: "python -m pytest -q" }, status: "waiting" })
        ev({ type: "permission", id: "s5", tool: "bash", input: { command: "python -m pytest -q" },
             preview: { command: "python -m pytest -q" }, rememberAs: "python" })
        CodeStore.setMode("build")
        CodeStore.runOffer = { command: "python3 calc.py", state: "fail", prompt: "Traceback: NameError" }
    }

    function unseedCode() {
        CodeStore.runOffer = null
        CodeStore.setBusy(false)
        CodeStore.onEvent({ type: "cleared" })
        CodeStore.setMode("default")
        CodeStore.clearTranscript()
    }

    // A real session through the panel's own keys, against the mock provider.
    function codeSession(s) {
        var panel = null
        s.push(function () {
            test.unseedCode()
            AppState.switchTab("code")
        })
        // --start brought the session up through CodeStore, as the panel does.
        s.push(waitFor("ready", function () { return CodeStore.up }, 90000))
        s.push(function () {
            panel = test.find(test.root.contentItem, "codePanel")
            var input = test.find(panel, "codeInput")
            if (!panel || !input) { console.warn("self-test: code e2e: no Code panel"); return }
            test.codeEvents = []
            input.text = "fix the bug in calc.py"
            panel.inputKey(test.key(Qt.Key_Return, "\r"))
            if (input.text !== "") console.warn("self-test: code e2e: enter did not send")
            else console.log("self-test: code e2e: sent")
        })
        s.push(waitFor("permission", function () { return !!CodeStore.permission }, 90000))
        for (var w = 0; w < 10; w++) s.push(function () {})
        s.push(shot("code-e2e"))
        s.push(function () { if (panel) panel.permissionKey(test.key(Qt.Key_1, "1"), true) })
        s.push(waitFor("done", function () { return test.codeEvents.indexOf("done") !== -1 }, 90000))
        s.push(function () {
            var said = false
            for (var i = 0; i < CodeStore.items.count; i++) {
                var e = CodeStore.entry(CodeStore.items.get(i).uid)
                if (e && /add\(\) now adds/.test(e.text || "")) said = true
            }
            if (said) console.log("self-test: code e2e: the answer is shown")
            else console.warn("self-test: code e2e: the answer is not in the transcript")
        })
        for (var w2 = 0; w2 < 10; w2++) s.push(function () {})
        s.push(shot("code-e2e-done"))
    }

    Connections {
        target: Agent
        function onCodeEvent(ev) { test.codeEvents.push(ev.type) }
    }

    function build() {
        var s = []
        var panels = AppState.panels
        function themeStep(id) { return function () { Theme.setTheme(id) } }
        function panelStep(m) { return function () { AppState.switchTab(m) } }
        s.push(function () { test.seedCode() })
        for (var d = 0; d < 2; d++) {
            s.push(function (on) { return function () { Theme.setDecor(on) } }(d === 0))
            for (var i = 0; i < Theme.themes.length; i++) {
                s.push(themeStep(Theme.themes[i].id))
                for (var p = 0; p < panels.length; p++) s.push(panelStep(panels[p].mode))
            }
        }
        s.push(function () { Theme.setDecor(true) })

        // The Code panel, with content, in three themes.
        var codeThemes = ["terminal", "paper", "pixel"]
        for (var c = 0; c < codeThemes.length; c++) {
            s.push(themeStep(codeThemes[c]))
            s.push(panelStep("code"))
            // Terminal shows the end (the prompt), paper the top (the welcome
            // box), pixel the middle (the diff) with the mode strip's actions.
            s.push(function (at) {
                return function () {
                    var list = test.find(test.root.contentItem, "codeTranscript")
                    if (!list || at === 0) return
                    list.follow = false
                    if (at === 1) list.positionViewAtBeginning()
                    else { list.positionViewAtIndex(6, ListView.Beginning); CodeStore.runOffer = null }
                }
            }(c))
            for (var cw = 0; cw < 25; cw++) s.push(function () {})   // let animations settle
            s.push(shot("code-" + codeThemes[c]))
        }
        s.push(function () { test.unseedCode() })

        // Terminal: the agent panel, the console with both logs, a toast.
        s.push(themeStep("terminal"))
        s.push(panelStep("code"))
        s.push(function () {
            Notify.setConsole(true, false)
            Notify.log("agent ready: mock, default mode", "ok")
            Notify.log("$ npm test", "")
            Notify.log("could not reach the provider", "err")
            Notify.plog("[build] 3 of 5 tasks done")
            Notify.toast("Started new chat")
        })
        for (var w = 0; w < 25; w++) s.push(function () {})   // let animations settle
        s.push(shot("terminal"))

        // Paper: the chat panel with the getting-started guide.
        s.push(function () { Notify.setConsole(false, false); AppState.resetOnboarding() })
        s.push(themeStep("paper"))
        s.push(panelStep("chat"))
        for (var w = 0; w < 25; w++) s.push(function () {})   // let animations settle
        s.push(shot("paper"))

        // Pixel: the build panel under the approval modal.
        s.push(themeStep("pixel"))
        s.push(panelStep("build"))
        s.push(function () { test.approval.ask({ command: "npm install && npm test" }) })
        for (var w = 0; w < 25; w++) s.push(function () {})   // let animations settle
        s.push(shot("pixel"))
        s.push(function () { test.approval.close() })

        // The browser gate opens and closes cleanly.
        s.push(function () { AppState.gateOpen = true })
        s.push(function () { AppState.gateOpen = false })
        s.push(function () { Notify.toast("Could not install the browser", "err") })

        if (test.root.provider === "mock" && AppState.workspace) {
            s.push(themeStep("terminal"))
            codeSession(s)
        }

        s.push(function () {
            Theme.setTheme(test.savedTheme)
            Theme.setDecor(test.savedDecor)
            AppState.switchTab("code")
        })
        s.push(function () {
            console.log("self-test: " + test.at + " steps, " + test.shots + " screenshots")
            Qt.exit(test.shots === test.expected ? 0 : 1)
        })
        return s
    }

    Timer {
        id: ticker
        interval: 40
        repeat: true
        onTriggered: {
            if (test.at >= test.steps.length) { stop(); return }
            var step = test.steps[test.at]
            test.at++
            if (step() === false) test.at--
        }
    }

    Component.onCompleted: {
        steps = build()
        ticker.start()
    }
}
