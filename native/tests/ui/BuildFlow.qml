import QtQuick
import CloseNI

/*
 * The Build flow end to end, through the UI (loaded by --ui-script; driven by
 * native/e2e-build.cjs, which runs the mock provider and queues its replies as
 * each stage is announced):
 *
 *   describe in Chat -> Generate Implementation Plan -> Build with this ->
 *   the steps build -> Run -> the run console shows the output, the server's
 *   address and stdin echoed back -> Open in browser (stubbed by main.cpp) ->
 *   Stop -> Close.
 *
 * Screenshots of Chat, Plan, Build and the run console in the terminal, paper
 * and pixel themes go to the directory given as the last argument. An argument
 * "themes=<id>,<id>" before it picks other themes (scripts/make-screenshots.mjs).
 * Prints "E2E PASS" and exits 0, or "E2E FAIL <stage>" and exits 1.
 */
Item {
    id: flow

    property var root: null
    readonly property var args: Qt.application.arguments
    readonly property string shots: args[args.length - 1]
    readonly property var themes: {
        var picked = args.filter(function (a) { return String(a).indexOf("themes=") === 0 })
        return picked.length ? picked[0].slice(7).split(",").filter(function (t) { return t }) : ["terminal", "paper", "pixel"]
    }

    property var stages: []
    property int at: -1
    property int ticks: 0
    property bool acted: false

    function find(item, name) {
        if (!item) return null
        if (item.objectName === name) return item
        var kids = item.children || []
        for (var i = 0; i < kids.length; i++) {
            var hit = find(kids[i], name)
            if (hit) return hit
        }
        return null
    }
    function main(name) { return find(root.contentItem, name) }
    function runWin() { var l = main("runWindowLoader"); return l ? l.item : null }
    function inRun(name) { var w = runWin(); return w ? find(w.page, name) : null }
    function press(btn) {
        if (!btn) { console.log("E2E missing button"); return }
        if (!btn.visible || !btn.enabled) console.log("E2E button not usable: " + btn.objectName)
        btn.clicked()
    }
    function consoleText() {
        var w = runWin()
        if (!w) return ""
        var out = find(w.page, "runConsole")
        var all = []
        for (var i = 0; i < out.model.count; i++) all.push(out.model.get(i).t)
        return all.join("\n")
    }

    // One stage: announce, act two ticks later (time for the driver to queue
    // the provider's reply), then wait for `until`.
    function stage(name, act, until, ms) { return { name: name, act: act, until: until, ms: ms || 30000 } }
    function shotsOf(what, tab) {
        var s = []
        themes.forEach(function (t) {
            s.push(stage("theme " + t, function () { Theme.setTheme(t); if (tab) AppState.switchTab(tab) }, function () { return flow.ticks >= 8 }))
            s.push(stage("shot " + what + " " + t, function () {
                flow.root.selfTestShot(flow.shots + "/build-" + what + "-" + t + ".png")
            }, function () { return true }))
        })
        return s
    }
    function runShots() {
        var s = []
        themes.forEach(function (t) {
            s.push(stage("theme " + t, function () { Theme.setTheme(t) }, function () { return flow.ticks >= 8 }))
            s.push(stage("shot run " + t, function () {
                flow.runWin().page.grabToImage(function (img) {
                    if (!img.saveToFile(flow.shots + "/build-run-" + t + ".png")) console.warn("E2E could not save run " + t)
                })
            }, function () { return flow.ticks >= 4 }))
        })
        return s
    }

    function build() {
        var s = []
        s.push(stage("ready", function () {
            Theme.setTheme("terminal")
            AppState.switchTab("chat")
        }, function () { return AppState.workspace !== "" && Providers.list.length > 0 && flow.main("chatInput") !== null }))
        // The provider list comes from the agent's own config folder, and the
        // mock lives in the driver's AGENT_PROVIDER_DIR, which only the agent
        // reads: so it is chosen here, as --provider would for a listed one.
        s.push(stage("provider", function () { Providers.current = "mock" }, function () { return Providers.current === "mock" }))

        s.push(stage("chat", function () {
            flow.main("chatInput").text = "A tiny Python web server that says hello"
            flow.press(flow.main("chatSend"))
        }, function () {
            var b = PlanState.bubbles
            return PlanState.busy === 0 && b.count >= 2 && b.get(b.count - 1).text !== "..."
        }, 120000))

        s.push(stage("plan", function () { flow.press(flow.main("generatePlan")) }, function () {
            return PlanState.busy === 0 && AppState.currentPlan && (AppState.currentPlan.steps || []).length === 2
        }, 120000))
        s = s.concat(shotsOf("chat", "chat"))
        s = s.concat(shotsOf("plan", "plan"))

        s.push(stage("build", function () {
            AppState.switchTab("chat")
            Theme.setTheme("terminal")
        }, function () { return flow.main("buildPlan") !== null }))
        s.push(stage("steps", function () { flow.press(flow.main("buildPlan")) }, function () {
            var st = BuildState.steps
            return !BuildState.running && BuildState.mode === "idle" && st.length === 2
                && st.every(function (x) { return x.status === "done" })
        }, 240000))
        s.push(stage("detail", function () {
            BuildState.selectStep(0)
            flow.main("buildPanel").openFiles = [0]
        }, function () { return flow.ticks >= 20 && flow.main("buildRun") !== null && flow.main("buildRun").visible }))
        s = s.concat(shotsOf("build", "build"))

        s.push(stage("run", function () {
            Theme.setTheme("terminal")
            flow.press(flow.main("buildRun"))
        }, function () {
            var w = flow.runWin()
            return w && w.visible && w.url !== "" && flow.consoleText().indexOf("Serving on") !== -1
        }, 60000))
        s.push(stage("stdin", function () {
            var input = flow.inRun("runInput")
            input.text = "ping"
            input.accepted()
        }, function () { return flow.consoleText().indexOf("got: ping") !== -1 }))
        s.push(stage("open", function () { flow.press(flow.inRun("runOpenBrowser")) },
                     function () { return flow.ticks >= 4 }))
        s.push(stage("build preview", function () { AppState.switchTab("build") }, function () {
            var b = flow.main("buildOpenBrowser")
            return !!BuildState.preview && b !== null && b.visible
        }))
        s.push(stage("open from build", function () { flow.press(flow.main("buildOpenBrowser")) },
                     function () { return flow.ticks >= 4 }))
        s = s.concat(runShots())
        s.push(stage("stop", function () { flow.press(flow.inRun("runStop")) },
                     function () { return flow.runWin().stateLabel === "stopped" }))
        s.push(stage("close", function () { flow.press(flow.inRun("runClose")) },
                     function () { return !flow.runWin().visible }))
        return s
    }

    Timer {
        interval: 50
        repeat: true
        running: flow.root !== null
        onTriggered: {
            if (flow.at < 0) { flow.stages = flow.build(); flow.at = 0; flow.ticks = 0; flow.acted = false; console.log("E2E stage " + flow.stages[0].name) }
            var st = flow.stages[flow.at]
            flow.ticks++
            if (!flow.acted) {
                if (flow.ticks < 3) return
                flow.acted = true
                flow.ticks = 0
                st.act()
                return
            }
            if (st.until()) {
                flow.at++
                flow.ticks = 0
                flow.acted = false
                if (flow.at >= flow.stages.length) {
                    stop()
                    console.log("E2E PASS")
                    Qt.exit(0)
                    return
                }
                console.log("E2E stage " + flow.stages[flow.at].name)
            } else if (flow.ticks * 50 > st.ms) {
                stop()
                console.log("E2E FAIL " + st.name + " (workspace " + AppState.workspace + ", provider " + Providers.current
                            + ", mode " + AppState.mode + ", build " + BuildState.mode + " " + BuildState.statusText + ")")
                Qt.exit(1)
            }
        }
    }
}
