import QtQuick
import CloseNI

/*
 * --self-test <dir>: drives the shell through every theme on every panel, with
 * decor on and off, then the console, a toast, the approval modal and the
 * browser gate, and saves three screenshots (terminal, paper, pixel) to <dir>.
 * One step per tick so each state renders before the next. main.cpp counts
 * the warnings and sets the exit code; this only quits. The saved theme and
 * decor are put back at the end.
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

    function build() {
        var s = []
        var panels = AppState.panels
        function themeStep(id) { return function () { Theme.setTheme(id) } }
        function panelStep(m) { return function () { AppState.switchTab(m) } }
        function sectionStep(id) { return function () { SettingsStore.showSection(id) } }
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
            Qt.exit(test.shots === test.planned ? 0 : 1)
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
