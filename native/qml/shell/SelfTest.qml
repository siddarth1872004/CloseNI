import QtQuick
import CloseNI

/*
 * --self-test <dir>: drives the shell through every theme on every panel, with
 * decor on and off, then the console, a toast, the approval modal and the
 * browser gate, and saves three screenshots (terminal, paper, pixel) to <dir>.
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

    function build() {
        var s = []
        var panels = AppState.panels
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

        s.push(function () {
            Theme.setTheme(test.savedTheme)
            Theme.setDecor(test.savedDecor)
            AppState.switchTab("code")
        })
        s.push(function () {
            console.log("self-test: " + test.at + " steps, " + test.shots + " screenshots")
            Qt.exit(test.shots === 3 ? 0 : 1)
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
