import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import CloseNI

/*
 * The run console: the program a
 * build produced, running in a window of its own, with its live output, an
 * input line to its stdin, how it ended, and Restart, Stop and Fix errors.
 *
 * There is no web view: when the output announces a local address, "Open in
 * browser" hands it to the system browser (Runner has already turned 0.0.0.0
 * into localhost), and the Build panel offers the same address.
 *
 * One window, reused: Main.qml makes it on the first Runner.windowRequested and
 * calls present() on every later one. Closing it by any means calls
 * Runner.close(), so the program stops with it.
 */
ApplicationWindow {
    id: win

    width: 1000
    height: 680
    minimumWidth: 520
    minimumHeight: 320
    title: "Run"
    color: Theme.bg

    font.family: Theme.ui
    font.pixelSize: Theme.bodySize
    palette.window: Theme.bg
    palette.windowText: Theme.txt
    palette.base: Theme.surface
    palette.text: Theme.txt
    palette.button: Theme.surface
    palette.buttonText: Theme.txt
    palette.highlight: Theme.lineStrong
    palette.highlightedText: Theme.txt
    palette.toolTipBase: Theme.surfaceRaised
    palette.toolTipText: Theme.txt

    // The run on screen: output and exits from any other run are an old
    // program's last words and are dropped.
    property int run: 0
    property string command: ""
    property string cwd: ""
    property bool gui: false
    property string stateLabel: "starting"
    property string stateKind: ""      // "" | "running" | "ok" | "fail"
    property bool fixOffered: false
    property string url: ""
    property bool full: true
    property bool noticeShown: false
    // The workspace's files, for the preview's static-page rule.
    property var files: []

    // The console. Bounded: this keeps the last
    // maxLines lines, each a row of one ListView, so a chatty program costs
    // the rows on screen rather than one ever-growing text layout.
    readonly property int maxLines: 10000
    readonly property int maxLineChars: 8000
    property bool lineOpen: false
    // The output so far, without colour codes, for the preview's address rule.
    property string plainText: ""
    readonly property int keep: 20000

    function present(req) {
        command = req.command || ""
        cwd = req.cwd || ""
        gui = !!req.gui
        title = req.title || "Run"
        // Already open: bring it forward (run-window.js focused the old one).
        var reused = visible
        // Full screen, except a program with its own window, which would be
        // covered, so that one starts windowed.
        setFull(!gui)
        if (reused) raise()
        requestActivate()
    }
    function setFull(on) {
        full = on
        if (on) win.showFullScreen()
        else win.showNormal()
    }

    function clearConsole() {
        lines.clear()
        lineOpen = false
        plainText = ""
    }
    // Append text, splitting it into rows. A chunk that does not end its line
    // carries on in the next chunk, as it did in the <pre>.
    function write(cls, s) {
        var atEnd = out.atYEnd || out.contentHeight <= out.height
        var parts = String(s).split("\n")
        for (var i = 0; i < parts.length; i++) {
            var piece = parts[i]
            var ends = i < parts.length - 1
            var last = lines.count - 1
            if (lineOpen && last >= 0 && lines.get(last).c === cls
                && lines.get(last).t.length + piece.length <= maxLineChars) {
                if (piece !== "") lines.setProperty(last, "t", lines.get(last).t + piece)
            } else if (piece !== "" || ends) {
                lines.append({ t: piece, c: cls })
            }
            lineOpen = !ends
        }
        if (lines.count > maxLines) lines.remove(0, lines.count - maxLines)
        if (atEnd) Qt.callLater(out.positionViewAtEnd)
    }
    function state(label, kind) { stateLabel = label; stateKind = kind || "" }

    function sendInput() {
        var v = input.text
        input.text = ""
        write("sys", v + "\n")
        Runner.input(v + "\n", function () {})
    }
    function sendFix() {
        // One request per failed run: a second click queued the same fix again.
        fixOffered = false
        // Out of full screen, or it covers the agent at work.
        if (full) setFull(false)
        Runner.fix(function (r) {
            if (r && r.ok) win.write("sys", "\n[sent to the CloseNI agent to fix - run it again when it is done]\n")
            else win.write("err", "\n[could not send: " + ((r && r.error) || "unknown error") + "]\n")
        })
    }
    function restart() {
        url = ""
        Runner.restart(function () {})
    }

    onClosing: function (close) { Runner.close(function () {}) }

    Shortcut { sequence: "F11"; onActivated: win.setFull(!win.full) }

    Connections {
        target: Runner
        function onStarted(d) {
            win.run = d.run
            win.clearConsole()
            win.command = d.command
            win.cwd = d.cwd
            win.gui = !!d.gui
            win.title = "Run - " + d.command
            win.url = ""
            win.state("running", "running")
            win.fixOffered = false
            win.write("sys", "$ " + d.command + "\n")
            // A native game window cannot be drawn inside this one, and full
            // screen would cover it, so step aside for it.
            win.noticeShown = !!d.gui
            if (d.gui) win.setFull(false)
            input.forceActiveFocus()
            Files.listFiles(d.cwd, function (r) { win.files = (r && r.files) || [] })
        }
        function onOutput(d) {
            if (d.run !== win.run) return
            win.write(d.stream === "err" ? "err" : "", d.plain)
            win.plainText = (win.plainText + d.plain).slice(-win.keep)
            // A web server: offer its page in the browser, and to the Build
            // panel's "Open in browser".
            if (d.urlChanged && d.url) {
                win.url = d.url
                BuildState.updatePreview(win.plainText, win.cwd, win.files)
            }
        }
        function onExited(d) {
            // A restart stops the old run after the new one has started.
            if (!d.current || d.run !== win.run) return
            var signalled = d.signal !== null && d.signal !== undefined && d.signal !== ""
            var ok = d.code === 0
            var how = signalled ? "stopped (" + d.signal + ")" : "exited with code " + d.code
            win.write("sys", "\n[" + how + "]\n")
            win.state(signalled ? "stopped" : ok ? "exited 0" : "exit " + d.code, signalled ? "" : ok ? "ok" : "fail")
            // A crash is worth handing to the agent; a program you stopped is not.
            win.fixOffered = !ok && !signalled
        }
    }

    // The whole console, for a screenshot.
    readonly property alias page: page

    ColumnLayout {
        id: page
        anchors.fill: parent
        spacing: 0

        // .rw-bar
        Rectangle {
            Layout.fillWidth: true
            implicitHeight: bar.implicitHeight + 16
            color: Theme.panel
            RowLayout {
                id: bar
                x: 14
                width: parent.width - 28
                anchors.verticalCenter: parent.verticalCenter
                spacing: 12
                Text {
                    text: "▶ RUN"
                    font.family: Theme.ui
                    font.pixelSize: 11
                    font.weight: Font.Bold
                    font.letterSpacing: 1.3
                    color: Theme.accent
                }
                Text {
                    id: cmd
                    objectName: "runCommand"
                    Layout.fillWidth: true
                    text: win.command
                    elide: Text.ElideRight
                    font.family: Theme.mono
                    font.pixelSize: 12
                    color: Theme.dim
                    HoverHandler { id: cmdHover }
                    ToolTip.visible: cmdHover.hovered && win.cwd !== ""
                    ToolTip.delay: 600
                    ToolTip.text: win.cwd
                }
                // .rw-state
                Rectangle {
                    objectName: "runState"
                    readonly property string label: win.stateLabel
                    implicitWidth: stateText.implicitWidth + 16
                    implicitHeight: stateText.implicitHeight + 4
                    radius: Theme.rMd
                    color: win.stateKind === "running" ? Theme.warnBg : win.stateKind === "ok" ? Theme.okBg
                         : win.stateKind === "fail" ? Theme.errBg : "transparent"
                    border.width: 1
                    border.color: win.stateKind === "running" ? Theme.warnLine : win.stateKind === "ok" ? Theme.okLine
                                : win.stateKind === "fail" ? Theme.errLine : Theme.lineStrong
                    Text {
                        id: stateText
                        anchors.centerIn: parent
                        text: win.stateLabel
                        font.family: Theme.ui
                        font.pixelSize: 10
                        font.letterSpacing: 1
                        font.capitalization: Font.AllUppercase
                        color: win.stateKind === "running" ? Theme.warn : win.stateKind === "ok" ? Theme.ok
                             : win.stateKind === "fail" ? Theme.err : Theme.dim
                    }
                }
                Btn {
                    objectName: "runOpenBrowser"
                    small: true
                    visible: win.url !== ""
                    text: "Open in browser"
                    tip: "Open " + win.url + " in the system browser"
                    onClicked: if (!App.openExternal(win.url)) Notify.toast("Could not open " + win.url, "err")
                }
                Btn {
                    id: fixBtn
                    objectName: "runFix"
                    small: true
                    visible: win.fixOffered
                    text: "Fix errors"
                    tip: "Send the error to the CloseNI agent to fix"
                    contentItem: Text {
                        text: fixBtn.text
                        font: fixBtn.font
                        color: Theme.err
                        horizontalAlignment: Text.AlignHCenter
                        verticalAlignment: Text.AlignVCenter
                    }
                    onClicked: win.sendFix()
                }
                Btn { objectName: "runRestart"; small: true; text: "Restart"; tip: "Stop the program and start it again"; onClicked: win.restart() }
                Btn { objectName: "runStop"; small: true; text: "Stop"; tip: "Stop the program"; onClicked: Runner.stop(function () {}) }
                Btn {
                    small: true
                    text: "Copy"
                    tip: "Copy the output"
                    onClicked: {
                        var all = []
                        for (var i = 0; i < lines.count; i++) all.push(lines.get(i).t)
                        App.copyText(all.join("\n"))
                        Notify.toast("Output copied")
                    }
                }
                Btn { small: true; text: win.full ? "Windowed" : "Full screen"; tip: "Full screen on or off (F11)"; onClicked: win.setFull(!win.full) }
                Btn { objectName: "runClose"; small: true; text: "Close"; tip: "Stop the program and close this window"; onClicked: win.close() }
            }
            Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 1; color: Theme.line }
        }

        // .rw-notice
        Rectangle {
            visible: win.noticeShown
            Layout.fillWidth: true
            implicitHeight: notice.implicitHeight + 24
            color: Theme.surfaceRaised
            Text {
                id: notice
                x: 14
                width: parent.width - 28
                anchors.verticalCenter: parent.verticalCenter
                wrapMode: Text.Wrap
                text: "This program opens its own window. This one has left full screen so it does not cover it; the program's output shows below."
                font.family: Theme.ui
                font.pixelSize: 12
                color: Theme.dim
            }
            Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 1; color: Theme.line }
        }

        // .rw-console
        Rectangle {
            Layout.fillWidth: true
            Layout.fillHeight: true
            color: Theme.surfaceSunken
            ListView {
                id: out
                objectName: "runConsole"
                anchors.fill: parent
                topMargin: 12
                bottomMargin: 12
                leftMargin: 14
                rightMargin: 14
                clip: true
                boundsBehavior: Flickable.StopAtBounds
                model: ListModel { id: lines }
                ScrollBar.vertical: ThinScrollBar {}
                delegate: TextEdit {
                    required property string t
                    required property string c
                    width: out.width - out.leftMargin - out.rightMargin
                    text: t
                    textFormat: TextEdit.PlainText
                    readOnly: true
                    selectByMouse: true
                    wrapMode: TextEdit.WrapAnywhere
                    font.family: Theme.mono
                    font.pixelSize: 13
                    color: c === "err" ? Theme.err : c === "sys" ? Theme.mut : Theme.txt
                    selectionColor: Theme.lineFocus
                    selectedTextColor: Theme.inverse
                }
            }
        }

        // .rw-in
        Rectangle {
            Layout.fillWidth: true
            implicitHeight: inRow.implicitHeight + 16
            color: Theme.panel
            Rectangle { width: parent.width; height: 1; color: Theme.line }
            RowLayout {
                id: inRow
                x: 14
                width: parent.width - 28
                anchors.verticalCenter: parent.verticalCenter
                spacing: 8
                Text {
                    text: "stdin ›"
                    font.family: Theme.mono
                    font.pixelSize: 12
                    color: Theme.mut
                }
                TextField {
                    id: input
                    objectName: "runInput"
                    Layout.fillWidth: true
                    background: null
                    placeholderText: "type input for the program, Enter sends it"
                    placeholderTextColor: Theme.mut
                    color: Theme.txt
                    selectionColor: Theme.lineFocus
                    selectedTextColor: Theme.inverse
                    font.family: Theme.mono
                    font.pixelSize: 13
                    leftPadding: 0
                    onAccepted: win.sendInput()
                }
            }
        }
    }
}
