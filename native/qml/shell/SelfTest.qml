import QtQuick
import CloseNI

/*
 * --self-test <dir>: drives the shell through every theme on every panel, with
 * decor on and off, then the console, a toast, the approval modal and the
 * browser gate, and saves three screenshots (terminal, paper, pixel) to <dir>,
 * plus the run console in each of those themes (run-terminal and so on).
 * One step per tick so each state renders before the next. main.cpp counts
 * the warnings and sets the exit code; this only quits. The saved theme and
 * decor are put back at the end.
 */
Item {
    id: test

    required property var root
    required property string outDir
    required property var approval

    property var steps: []
    property int at: 0
    property int shots: 0
    readonly property string savedTheme: Theme.current
    readonly property bool savedDecor: Theme.decor

    function shot(name) {
        // main.cpp saves the window synchronously and warns if it cannot.
        return function () {
            test.root.selfTestShot(test.outDir + "/" + name + ".png")
            test.shots++
        }
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
        for (var d = 0; d < 2; d++) {
            s.push(function (on) { return function () { Theme.setDecor(on) } }(d === 0))
            for (var i = 0; i < Theme.themes.length; i++) {
                s.push(themeStep(Theme.themes[i].id))
                for (var p = 0; p < panels.length; p++) s.push(panelStep(panels[p].mode))
            }
        }
        s.push(function () { Theme.setDecor(true) })

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
            Qt.exit(test.shots === 3 && test.runShots === 3 ? 0 : 1)
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
            step()
        }
    }

    Component.onCompleted: {
        steps = build()
        ticker.start()
    }
}
