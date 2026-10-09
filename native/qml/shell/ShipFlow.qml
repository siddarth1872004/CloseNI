import QtQuick
import CloseNI

/*
 * --self-test <dir> --self-test-flow Ship: the Test, Research and Ship panels'
 * real flows, driven through ShipStore against whatever tests/tst_ship_ui.cpp
 * set up - a scratch git workspace with a build's checkpoints, a bare repository
 * beside it as the push remote, and the local GitHub mock. Nothing reaches
 * the network: the one flow that would (cloning) is stopped at its
 * confirmation. Each check prints "ship-flow: ok <name>"; a failed one warns,
 * which main.cpp counts and turns into exit 1. Nine screenshots: each panel in
 * terminal, paper and pixel.
 */
Item {
    id: flow

    required property var root
    required property string outDir

    property int failed: 0
    property int shots: 0
    // Pending waits: { cond, resolve, reject, until, what }.
    property var waits: []

    function check(name, cond, detail) {
        if (cond) console.log("ship-flow: ok " + name)
        else { failed++; console.warn("ship-flow: FAIL " + name + (detail !== undefined ? " -- " + detail : "")) }
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
        // The flow's toasts would pile up over the panel being pictured.
        Notify.toasts.clear()
        return pause(600).then(function () {
            flow.root.selfTestShot(flow.outDir + "/ship-" + name + ".png")
            flow.shots++
        })
    }
    function lastLog() {
        var m = Notify.agentLog
        return m.count ? m.get(m.count - 1).line : ""
    }
    function logHas(re) {
        var m = Notify.agentLog
        for (var i = 0; i < m.count; i++) if (re.test(m.get(i).line)) return true
        return false
    }
    function threeShots(panel) {
        return Promise.resolve()
            .then(function () { Theme.setTheme("terminal"); return shot(panel + "-terminal") })
            .then(function () { Theme.setTheme("paper"); return shot(panel + "-paper") })
            .then(function () { Theme.setTheme("pixel"); return shot(panel + "-pixel") })
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

    readonly property string ws: AppState.workspace
    readonly property string remote: ws.replace(/\/[^\/]+$/, "") + "/remote.git"

    function run() {
        var S = ShipStore
        return Promise.resolve()
        // ---- Test ------------------------------------------------------
        .then(function () {
            Theme.setTheme("terminal")
            AppState.switchTab("test")
            return waitFor("the run bar", function () { return S.runSource !== "" })
        }).then(function () {
            check("run bar: detected from the files", S.runSource === "detected" && S.runCommand === "npm start",
                  S.runSource + " / " + S.runCommand)
            check("run bar: the badge says so", S.runBadge === "DETECTED", S.runBadge)

            // Export first: it refuses a dirty tree, and the runs below write
            // the run manifest into the workspace.
            AppState.switchTab("push")
            S.exportBranch()
            check("export: the button reads Exporting...", S.exporting === true)
            return waitFor("the export", function () { return !S.exporting })
        }).then(function () {
            check("export: one commit per step, logged", logHas(/^exported 2 commit\(s\) to closeni\//), lastLog())
            AppState.switchTab("test")

            S.run("")
            check("run: an empty command is refused", Notify.toasts.count > 0
                  && Notify.toasts.get(Notify.toasts.count - 1).msg === "Nothing to run - type a command or build a project")
            S.run("node hello.js")
            check("run: the summary says it is running", S.testSummary === "running: node hello.js", S.testSummary)
            return waitFor("the command", function () { return !S.testing })
        }).then(function () {
            check("run: succeeded", S.testSummary === "command succeeded", S.testSummary)
            check("run: a row and the output", S.testResults.count === 2 && S.testResults.get(1).kind === "output"
                  && S.testResults.get(1).text.indexOf("hello from the workspace") !== -1,
                  S.testResults.count ? S.testResults.get(S.testResults.count - 1).text : "none")
            check("run: history", S.testHistory.length === 1 && S.testHistory[0].label === "node hello.js" && S.testHistory[0].ok)
            check("run: the flow counts it tested", AppState.flowTested === true)
            check("run: carried into the chat", S.lastRun.command === "node hello.js")

            S.run("node -e \"process.exit(3)\"")
            return waitFor("the failing command", function () { return !S.testing })
        }).then(function () {
            check("run: a failure says so", S.testSummary === "command failed" && !S.testHistory[0].ok, S.testSummary)

            S.syntaxCheck()
            check("syntax: running", S.testSummary === "running syntax checks...", S.testSummary)
            return waitFor("the syntax check", function () { return !S.testing }, 120000)
        }).then(function () {
            check("syntax: a summary of counts", /^\d+ passed, \d+ failed$/.test(S.testSummary), S.testSummary)
            check("syntax: history", /^syntax check · \d+ checks$/.test(S.testHistory[0].label), S.testHistory[0].label)

            S.behaviour()
            check("tests: running", S.testSummary === "running the project's tests...", S.testSummary)
            return waitFor("the behaviour run", function () { return !S.testing }, 120000)
        }).then(function () {
            check("tests: summary", S.testSummary !== "" && S.testSummary !== "running the project's tests...", S.testSummary)
            check("tests: history", S.testHistory[0].label === "tests · " + S.testSummary, S.testHistory[0].label)
            check("history: newest first, at most 6", S.testHistory.length === 4, S.testHistory.length)

            S.redetect()
            return waitFor("re-detect", function () { return S.runSource === "manifest" && S.runCommand === "npm start" })
        }).then(function () {
            check("re-detect: saves the detected command", S.runBadge === "SAVED")
            S.saveRunCommand("node hello.js")
            return waitFor("the saved command", function () { return S.runCommand === "node hello.js" && S.runResolved === "node hello.js" })
        }).then(function () {
            check("run bar: an edit is saved", S.runSource === "manifest", S.runSource)
            S.redetect()
            return waitFor("re-detect", function () { return Notify.toasts.get(Notify.toasts.count - 1).msg === "Detected: npm start" })
        }).then(function () {
            return pause(300)
        }).then(function () {
            check("run bar: an edit sticks through re-detect", S.runCommand === "node hello.js", S.runCommand)
            S.run("node hello.js")
            return waitFor("the command", function () { return !S.testing })
        }).then(function () {
            // The chat needs a live provider, which this run does not start: an
            // exchange is put in so the screenshots show how one reads.
            S.addChat("user", "why did the second run fail?", false)
            S.addChat("ai", "It exited with **status 3**: `process.exit(3)` ends the process with that code, " +
                      "and anything other than 0 counts as a failure.\n\n- `node hello.js` exits 0\n- the run bar now saves `node hello.js`", true)
            return threeShots("test")
        })
        // ---- Research ---------------------------------------------------
        .then(function () {
            Theme.setTheme("terminal")
            AppState.switchTab("research")
            S.research("")
            check("research: an empty query is refused", Notify.toasts.get(Notify.toasts.count - 1).msg === "Type a query")
            S.research("flask sqlite")
            check("research: both halves searching", S.researchWeb.state === "searching" && S.researchGh.state === "searching")
            return waitFor("the research", function () { return !S.researching }, 120000)
        }).then(function () {
            // The mock provider has no web search control: the web half says so,
            // and the GitHub half, signed out, says why on its own.
            check("research: the web half reports its own failure", S.researchWeb.state === "error" && S.researchWeb.error !== "",
                  JSON.stringify(S.researchWeb))
            check("research: signed out, GitHub says so", S.researchGh.state === "error", JSON.stringify(S.researchGh))
            return S.signIn("ghp_mock_token")
        }).then(function (ok) {
            check("sign-in: against the mock", ok === true && S.ghSignedIn && S.ghLogin === "@mock-user", S.ghLogin)
            S.research("flask sqlite")
            return waitFor("the research", function () { return !S.researching }, 120000)
        }).then(function () {
            check("research: repositories", S.researchGh.state === "done" && S.researchGh.items.length === 3
                  && S.researchGh.items[0].fullName === "pallets/flask", JSON.stringify(S.researchGh))
            check("research: done toast", Notify.toasts.get(Notify.toasts.count - 1).msg === "Research done")

            S.useAsReference({ url: S.researchGh.items[0].url })
            return waitFor("the reference", function () { return AppState.repoReference !== null })
        }).then(function () {
            check("reference: README and files", AppState.repoReference.name === "pallets/flask"
                  && AppState.repoReference.readme.indexOf("Flask") !== -1 && AppState.repoReference.files.length === 2,
                  JSON.stringify(AppState.repoReference))
            check("reference: logged", logHas(/^reference set: pallets\/flask$/))

            // Stopped at the confirmation: a real clone would reach github.com.
            S.cloneRepo({ url: S.researchGh.items[0].url, title: S.researchGh.items[0].fullName })
            check("clone: asks first", S.pendingClone !== null
                  && S.cloneQuestion.indexOf("Clone pallets/flask into your workspace?") === 0, S.cloneQuestion)
            return pause(300)
        }).then(function () {
            S.answerClone(false)
            check("clone: cancelled clones nothing", S.pendingClone === null && !S.cloning)

            // The provider's answer, for the screenshots: the mock cannot search.
            S.researchVia = "via Mock Provider web search"
            S.researchWeb = { state: "done", sources: ["https://flask.palletsprojects.com/en/stable/patterns/sqlite3/",
                                                       "https://docs.python.org/3/library/sqlite3.html"],
                              error: "", answer: "Flask leaves the database to you. The usual pattern:\n\n" +
                              "1. Open a connection per request with `g` and `sqlite3.connect`.\n" +
                              "2. Close it in a `teardown_appcontext` handler.\n" +
                              "3. Use `sqlite3.Row` so rows read like dicts.\n\n**Avoid** a module-level connection: it is not thread-safe." }
            return threeShots("research")
        })
        // ---- Ship -------------------------------------------------------
        .then(function () {
            Theme.setTheme("terminal")
            AppState.switchTab("push")
            return waitFor("repositories and runs", function () { return S.ghRepos.length === 2 && S.ghRuns.length === 3 })
        }).then(function () {
            check("repos: listed with private marked", S.ghRepos[1].label === "mock-user/secret (private)", JSON.stringify(S.ghRepos))
            check("repos: the first fills the remote", S.remoteUrl === "https://github.com/mock-user/demo.git", S.remoteUrl)
            check("runs: states", S.ghRuns[0].state === "success" && S.ghRuns[1].state === "running"
                  && S.ghRuns[2].state === "failure", JSON.stringify(S.ghRuns))

            S.createRepo("")
            check("create: needs a name", Notify.toasts.get(Notify.toasts.count - 1).msg === "Name it first")
            S.createRepo("new-one")
            return waitFor("the new repository", function () { return Notify.toasts.get(Notify.toasts.count - 1).msg === "Created new-one" })
        }).then(function () {
            S.dispatch("")
            check("dispatch: needs a workflow", Notify.toasts.get(Notify.toasts.count - 1).msg === "Name the workflow file")
            S.dispatch("release.yml")
            return waitFor("the dispatch", function () { return Notify.toasts.get(Notify.toasts.count - 1).msg === "Triggered release.yml" })
        }).then(function () {
            S.gitCommit("ship flow: the run manifest")
            return waitFor("the commit", function () { return !S.gitBusy })
        }).then(function () {
            S.gitPush(flow.remote)
            return waitFor("the push", function () { return !S.gitBusy }, 60000)
        }).then(function () {
            check("push: the flow counts it shipped", AppState.flowShipped === true)
            // Two with the Actions runs in view, one with the console's git output.
            Theme.setTheme("terminal")
            return shot("push-terminal")
        }).then(function () {
            Theme.setTheme("paper")
            return shot("push-paper")
        }).then(function () {
            Theme.setTheme("pixel")
            Notify.setConsole(true, false)
            return shot("push-pixel")
        }).then(function () {
            Notify.setConsole(false, false)
            S.signOut()
            return waitFor("sign-out", function () { return !S.ghSignedIn && S.ghKnown && Notify.toasts.get(Notify.toasts.count - 1).msg === "Signed out" })
        }).then(function () {
            check("sign-out: back to the token box", !S.ghSignedIn)
        })
    }

    Component.onCompleted: {
        run().catch(function (e) {
            flow.failed++
            console.warn("ship-flow: FAIL " + e)
        }).then(function () {
            console.log("ship-flow: " + flow.shots + " screenshots, " + flow.failed + " failed")
            Theme.setTheme("terminal")
            Qt.exit(flow.failed === 0 && flow.shots === 9 ? 0 : 1)
        })
    }
}
