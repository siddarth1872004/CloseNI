import QtQuick
import CloseNI
import "../js/code-transcript.mjs" as T

/*
 * --self-test <dir>: drives the shell through every theme on every panel, with
 * decor on and off, then the console, a toast, the approval modal and the
 * browser gate, and saves three screenshots (terminal, paper, pixel) to <dir>,
 * plus the run console in each of those themes (run-terminal and so on).
 * One step per tick so each state renders before the next. main.cpp counts
 * the warnings and sets the exit code; this only quits. The saved theme and
 * decor are put back at the end.
 *
 * The Code panel walks the themes with a transcript in it - every kind of
 * entry, a pending permission prompt, a card of each sort, the todo list, the
 * mode strip and the run offer - and has three screenshots of its own
 * (code-terminal, code-paper, code-pixel). A live session through the panel
 * is CodeFlow.qml (--self-test-flow Code, native/tests/code-e2e.cjs).
 *
 * Settings also opens each of its sections in every theme, runs its exercise
 * (SettingsCheck.qml) and is saved in three themes as settings-*.png. A step
 * that returns false is waiting on something asynchronous and is run again on
 * the next tick, for up to ten seconds.
 */
Item {
    id: test

    required property var root
    required property string outDir
    required property var approval

    property var steps: []
    property int at: 0
    property int shots: 0
    property int planned: 0
    property int waits: 0
    readonly property string savedTheme: Theme.current
    readonly property bool savedDecor: Theme.decor

    function shot(name) {
        planned++
        // main.cpp saves the window synchronously and warns if it cannot.
        return function () {
            test.root.selfTestShot(test.outDir + "/" + name + ".png")
            test.shots++
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

    // --- Chat, Plan, Build and the run console ---------------------------
    // Content for their delegates, so the theme walk draws real rows: a
    // conversation, a plan in the sidebar, a build part-way through with a
    // diff open, and the run console with output and a server address.
    // Nothing is written to disk: the plan is shown with keepBuild and the
    // steps are set directly, so no build state is saved.
    property int runShots: 0
    function runShot(name) {
        return function () {
            var rw = runConsole.item
            rw.page.grabToImage(function (img) {
                if (img.saveToFile(test.outDir + "/" + name + ".png")) test.runShots++
                else console.warn("self-test: could not save " + name)
            })
        }
    }
    function fillBuildScreens() {
        PlanState.addBubble("user", "A todo list web app in Flask, with SQLite and a page to add and tick off items")
        PlanState.addBubble("ai", "Here is how I would lay it out:\n\n- **app.py** serves the pages and the JSON API\n- `models.py` holds the SQLite table\n- a single template with a form\n\nSay *Generate Implementation Plan* when it looks right.")
        var plan = { summary: "A Flask todo app backed by SQLite", steps: [
            { title: "Create the Flask app", detail: "app.py with an index route and the JSON API", files: ["app.py", "requirements.txt"] },
            { title: "Add the database model", detail: "models.py: a todos table with id, text and done", files: ["models.py"] },
            { title: "Write the page", detail: "templates/index.html with the list and a form", files: ["templates/index.html"] }
        ] }
        PlanState.showPlan(plan, true)
        BuildState.steps = [
            { title: plan.steps[0].title, detail: plan.steps[0].detail, files: plan.steps[0].files, status: "done",
              timing: { totalMs: 41000, phases: { thinking: 23000, writing: 15000, applying: 3000 } },
              result: { files: [{ path: "app.py", mode: "create", content: "from flask import Flask\napp = Flask(__name__)" }] } },
            { title: plan.steps[1].title, detail: plan.steps[1].detail, files: plan.steps[1].files, status: "failed",
              result: { error: "SyntaxError: invalid syntax (models.py, line 4)",
                        files: [{ path: "models.py", mode: "overwrite", diff: [
                            { type: "same", text: "import sqlite3" }, { type: "remove", text: "TABLE = 'todo'" },
                            { type: "add", text: "TABLE = 'todos'" }, { type: "gap", text: "... 12 unchanged lines" }] }] } },
            { title: plan.steps[2].title, detail: plan.steps[2].detail, files: plan.steps[2].files, status: "pending", result: null }
        ]
        BuildState._resetModel()
        BuildState.progress = 1 / 3
        BuildState.statusText = "finished: 1/3"
        BuildState.selectStep(1)
        BuildState.preview = { url: "http://localhost:5000", kind: "server", ws: "/tmp" }
        runConsole.active = true
        var rw = runConsole.item
        rw.present({ command: "python3 app.py", cwd: "/tmp/todo", gui: false, title: "Run - todo" })
        rw.state("running", "running")
        rw.write("sys", "$ python3 app.py\n")
        rw.write("", " * Serving Flask app 'app'\n * Running on http://127.0.0.1:5000\n")
        rw.write("err", "WARNING: This is a development server.\n")
        rw.url = "http://localhost:5000"
        rw.fixOffered = true
    }
    Loader { id: runConsole; active: false; sourceComponent: RunWindow {} }

    function build() {
        var s = []
        var panels = AppState.panels
        s.push(function () { test.fillBuildScreens() })
        function themeStep(id) { return function () { Theme.setTheme(id) } }
        function panelStep(m) { return function () { AppState.switchTab(m) } }
        function sectionStep(id) { return function () { SettingsStore.showSection(id) } }
        s.push(function () { test.seedCode() })
        for (var d = 0; d < 2; d++) {
            s.push(function (on) { return function () { Theme.setDecor(on) } }(d === 0))
            for (var i = 0; i < Theme.themes.length; i++) {
                s.push(themeStep(Theme.themes[i].id))
                for (var p = 0; p < panels.length; p++) {
                    s.push(panelStep(panels[p].mode))
                    if (panels[p].mode !== "settings") continue
                    for (var q = 0; q < SettingsStore.sections.length; q++) s.push(sectionStep(SettingsStore.sections[q].id))
                    s.push(sectionStep("provider"))
                }
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

        // Settings: every control, then the panel in three themes.
        s = s.concat(settingsCheck.steps())
        var settingsShots = [["terminal", "skills"], ["paper", "appearance"], ["pixel", "provider"]]
        for (var k = 0; k < settingsShots.length; k++) {
            s.push(themeStep(settingsShots[k][0]))
            s.push(panelStep("settings"))
            s.push(sectionStep(settingsShots[k][1]))
            for (var w = 0; w < 25; w++) s.push(function () {})   // let animations settle
            s.push(shot("settings-" + settingsShots[k][0]))
        }
        s.push(sectionStep("provider"))

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
        s.push(runShot("run-terminal"))

        // Paper: the chat panel with the getting-started guide.
        s.push(function () { Notify.setConsole(false, false); AppState.resetOnboarding() })
        s.push(themeStep("paper"))
        s.push(panelStep("chat"))
        for (var w = 0; w < 25; w++) s.push(function () {})   // let animations settle
        s.push(shot("paper"))
        s.push(runShot("run-paper"))

        // Pixel: the build panel under the approval modal.
        s.push(themeStep("pixel"))
        s.push(panelStep("build"))
        s.push(function () { test.approval.ask({ command: "npm install && npm test" }) })
        for (var w = 0; w < 25; w++) s.push(function () {})   // let animations settle
        s.push(shot("pixel"))
        s.push(runShot("run-pixel"))
        s.push(function () { test.approval.close() })

        // The browser gate opens and closes cleanly.
        s.push(function () { AppState.gateOpen = true })
        s.push(function () { AppState.gateOpen = false })
        s.push(function () { Notify.toast("Could not install the browser", "err") })

        s.push(function () {
            Theme.setTheme(test.savedTheme)
            Theme.setDecor(test.savedDecor)
            AppState.switchTab("code")
        })
        s.push(function () {
            runConsole.item.close()
            console.log("self-test: " + test.at + " steps, " + test.shots + " screenshots, " + test.runShots + " run console")
            Qt.exit(test.shots === test.planned && test.runShots === 3 ? 0 : 1)
        })
        return s
    }

    SettingsCheck { id: settingsCheck; root: test.root }

    Timer {
        id: ticker
        interval: 40
        repeat: true
        onTriggered: {
            if (test.at >= test.steps.length) { stop(); return }
            var step = test.steps[test.at]
            test.at++
            if (step() !== false) { test.waits = 0; return }
            if (++test.waits < 250) { test.at--; return }
            console.warn("self-test: step " + (test.at - 1) + " is still waiting after ten seconds")
            test.waits = 0
        }
    }

    Component.onCompleted: {
        steps = build()
        ticker.start()
    }
}
