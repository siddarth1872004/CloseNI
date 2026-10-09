import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import CloseNI
import "../js/code-view.mjs" as V
import "../js/code-transcript.mjs" as T

/*
 * The Code panel (#panel-code, desktop/code.js): a coding agent in the style
 * of a terminal one. The welcome box and tips, the transcript, the spinner,
 * the todo list, the mode strip, the prompt with its / and @ popup, and the
 * status line under it.
 *
 * Everything that must outlive the panel - the session, the transcript, the
 * queue, the prompt history - is CodeStore's; this draws it and turns keys
 * into CodeStore calls. Monospace throughout: it is a terminal agent's
 * transcript, and alignment carries meaning here (the result elbow under its
 * tool, diff columns).
 *
 * No timer runs idle: the spinner's only while it is shown, a dot's blink only
 * while its tool runs, and neither while the panel is hidden.
 */
FocusScope {
    id: panel
    objectName: "codePanel"

    readonly property real ch: fm.averageCharacterWidth
    // The / and @ popup: { items: [{ label, desc, arg }], kind: "cmd"|"file", sel }.
    property var popup: null
    property double now: Date.now()
    property int glyph: 0

    FontMetrics { id: fm; font.family: Theme.mono; font.pixelSize: 13 }

    Component.onCompleted: {
        CodeStore.renderModebar()
        input.forceActiveFocus()
    }
    onVisibleChanged: if (visible && !CodeStore.permission) input.forceActiveFocus()

    Connections {
        target: CodeStore
        function onFocusInput() { input.forceActiveFocus() }
        // A permission prompt takes the keyboard from the prompt, as Electron's
        // focused its first option: enter answers it rather than sending.
        function onFocusPrompt() { promptKeys.forceActiveFocus(); transcript.stick() }
        function onPendingCloneChanged() { if (CodeStore.pendingClone) cloneModal.open() }
    }
    Connections {
        target: AppState
        function onTabSwitched(m) { if (m === "code" && !CodeStore.permission) input.forceActiveFocus() }
    }

    // ---- The spinner ---------------------------------------------------------
    Timer {
        interval: 140
        repeat: true
        running: CodeStore.spinnerShown && panel.visible
        onRunningChanged: if (running) { panel.glyph = 0; panel.now = Date.now() }
        onTriggered: {
            panel.glyph = (panel.glyph + 1) % V.GLYPHS.length
            panel.now = Date.now()
        }
    }

    // ---- Permission keys -------------------------------------------------------
    // 1-3, arrows, enter and esc answer a pending prompt wherever focus is in
    // the panel; the feedback field keeps its own keys. The prompt input
    // passes them on too (see its Keys handler).
    Item {
        id: promptKeys
        focus: false
        Keys.onPressed: function (event) { panel.permissionKey(event, true) }
    }

    function permissionKey(event, enterChooses) {
        var P = CodeStore.permission
        if (!P || CodeStore.feedbackFocused) return false
        var n = parseInt(event.text, 10)
        if (n >= 1 && n <= P.opts.length) { event.accepted = true; CodeStore.choosePermission(n - 1); return true }
        if (event.key === Qt.Key_Down) { event.accepted = true; CodeStore.selectPermission(P.sel + 1); return true }
        if (event.key === Qt.Key_Up) { event.accepted = true; CodeStore.selectPermission(P.sel - 1); return true }
        if (enterChooses && (event.key === Qt.Key_Return || event.key === Qt.Key_Enter)) {
            event.accepted = true
            CodeStore.choosePermission(P.sel)
            return true
        }
        if (event.key === Qt.Key_Escape) { event.accepted = true; CodeStore.answerPermission("deny", ""); return true }
        return false
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        // ---- Transcript ------------------------------------------------------
        ListView {
            id: transcript
            objectName: "codeTranscript"
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            leftMargin: 4
            // Pixel's scrollbar sits on a track of its own, as a webkit one takes room.
            rightMargin: Theme.isPixel ? 12 : 4
            topMargin: 4
            bottomMargin: 12
            model: CodeStore.items
            cacheBuffer: 1200
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ThinScrollBar {}

            // Keep to the end while the agent writes, unless scrolled up.
            property bool follow: true
            property bool auto: false
            function stick() { follow = true; Qt.callLater(toEnd) }
            function toEnd() {
                if (!follow) return
                auto = true
                positionViewAtEnd()
                auto = false
            }
            onCountChanged: stick()
            onContentHeightChanged: if (follow) Qt.callLater(toEnd)
            onMovementEnded: follow = atYEnd
            onContentYChanged: if (!auto && moving) follow = atYEnd

            delegate: CodeEntry {}

            header: Column {
                width: ListView.view.width - ListView.view.leftMargin - ListView.view.rightMargin
                spacing: 0
                bottomPadding: 0

                Item { width: 1; height: 6 }
                // The welcome box: what the panel is, and what is missing before
                // it can work (a folder, then the sign-in and its terms).
                Rectangle {
                    id: welcome
                    width: Math.min(parent.width, wcol.implicitWidth + 32)
                    height: wcol.implicitHeight + 20
                    radius: Theme.rLg
                    color: "transparent"
                    border.width: 1
                    border.color: Theme.accent
                    Column {
                        id: wcol
                        x: 16; y: 10
                        width: Math.min(implicitWidth, panel.width - 48)
                        spacing: 6
                        Text {
                            text: "<span style=\"color:" + Theme.accent + "\">✻</span> Welcome to <b>CloseNI</b>!"
                            textFormat: Text.StyledText
                            font: fm.font
                            color: Theme.txt
                        }
                        Text {
                            text: "/help for help, shift+tab to change mode, @ to attach a file"
                            font.family: Theme.mono; font.pixelSize: 12; color: Theme.mut
                        }
                        Text {
                            text: "cwd: " + (AppState.workspace || "no folder selected")
                            textFormat: Text.PlainText
                            font.family: Theme.mono; font.pixelSize: 12; color: Theme.mut
                        }
                        Row {
                            readonly property var need: CodeStore.welcomeNeed
                            visible: !!need
                            spacing: 8
                            topPadding: 2
                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                text: parent.need ? parent.need.text : ""
                                font.family: Theme.mono; font.pixelSize: 11; color: Theme.mut
                            }
                            Btn {
                                visible: !!parent.need && (parent.need.kind === "folder" || !!parent.need.action)
                                small: true
                                text: !parent.need ? "" : parent.need.kind === "folder" ? "Choose a project folder" : parent.need.action
                                onClicked: parent.need.kind === "folder" ? AppState.browse() : AppState.onboardingAction("signin")
                            }
                        }
                        Text {
                            readonly property var need: CodeStore.welcomeNeed
                            visible: !!need && need.kind === "signin" && !!need.terms
                            width: Math.min(implicitWidth, 64 * panel.ch)
                            text: !visible ? "" : need.terms.replace(/&/g, "&amp;").replace(/</g, "&lt;") +
                                  (need.termsUrl ? "<a href=\"terms\" style=\"color:" + Theme.txt + "\">Read the terms</a>" : "")
                            textFormat: Text.StyledText
                            wrapMode: Text.Wrap
                            linkColor: Theme.txt
                            font.family: Theme.mono; font.pixelSize: 11; color: Theme.mut
                            onLinkActivated: Providers.openThread(need.termsUrl)
                            HoverHandler { cursorShape: parent.hoveredLink ? Qt.PointingHandCursor : Qt.ArrowCursor }
                        }
                    }
                }
                Item { width: 1; height: 12 }
                Text {
                    width: parent.width
                    text: "Tips for getting started:<br>" +
                          "1. Ask for a change, a fix or an explanation - the agent reads the project itself<br>" +
                          "2. Run " + b("/init") + " to write a CLOSENI.md with instructions for this project<br>" +
                          "3. " + b("shift+tab") + " switches mode: plan, build, test, research and ship all run here"
                    function b(s) { return "<b><span style=\"color:" + Theme.dim + "\">" + s + "</span></b>" }
                    textFormat: Text.StyledText
                    wrapMode: Text.Wrap
                    lineHeight: 20; lineHeightMode: Text.FixedHeight
                    font.family: Theme.mono; font.pixelSize: 12; color: Theme.mut
                }
                Item { width: 1; height: 14 }
            }

            // The spinner: a glyph that turns, the verb, and how long it has been.
            footer: Item {
                width: ListView.view.width - ListView.view.leftMargin - ListView.view.rightMargin
                height: CodeStore.spinnerShown ? spin.implicitHeight + 20 : 0
                visible: CodeStore.spinnerShown
                Text {
                    id: spin
                    y: 10
                    width: parent.width
                    text: V.GLYPHS[panel.glyph] + " " + CodeStore.spinnerVerb.replace(/&/g, "&amp;").replace(/</g, "&lt;") +
                          " <span style=\"color:" + Theme.mut + "\">" + T.spinnerMeta(Math.max(0, panel.now - CodeStore.turnStart)) + "</span>"
                    textFormat: Text.StyledText
                    wrapMode: Text.Wrap
                    font: fm.font
                    color: Theme.accent
                }
            }
        }

        // ---- The todo list -------------------------------------------------------
        Rectangle {
            Layout.fillWidth: true
            Layout.bottomMargin: 8
            visible: CodeStore.todosShown
            implicitHeight: visible ? todos.implicitHeight + 12 : 0
            color: Theme.surface
            Rectangle { width: 2; height: parent.height; color: Theme.accent }
            CodeTodos {
                id: todos
                x: 10; y: 6
                width: parent.width - 20
                items: CodeStore.todos
            }
        }

        // ---- The mode strip ------------------------------------------------------
        CodeModeBar {
            Layout.fillWidth: true
            Layout.bottomMargin: visible ? 8 : 0
        }

        // ---- The prompt -------------------------------------------------------------
        Rectangle {
            id: box
            Layout.fillWidth: true
            implicitHeight: Math.min(220, input.implicitHeight) + 20
            radius: Theme.rLg
            color: Theme.surface
            border.width: 1
            border.color: CodeStore.modeColor(CodeStore.mode === "auto" ? "" : CodeStore.mode,
                                              CodeStore.mode === "auto" ? Theme.errLine : input.activeFocus ? Theme.dim : Theme.lineStrong)

            TapHandler { onTapped: input.forceActiveFocus() }

            Text {
                id: caret
                x: 12; y: 10
                text: ">"
                font: fm.font
                lineHeight: 20
                lineHeightMode: Text.FixedHeight
                color: Theme.dim
            }

            Flickable {
                id: inputFlick
                x: caret.x + caret.width + panel.ch
                y: 10
                width: box.width - x - 12
                height: box.height - 20
                clip: true
                contentWidth: width
                contentHeight: input.implicitHeight
                boundsBehavior: Flickable.StopAtBounds
                interactive: contentHeight > height
                ScrollBar.vertical: ThinScrollBar {}
                function ensureVisible(r) {
                    if (contentY >= r.y) contentY = r.y
                    else if (contentY + height <= r.y + r.height) contentY = r.y + r.height - height
                }

                TextArea.flickable: null
                TextArea {
                    id: input
                    objectName: "codeInput"
                    width: inputFlick.width
                    padding: 0
                    leftPadding: 0
                    rightPadding: 0
                    topPadding: 0
                    bottomPadding: 0
                    background: null
                    wrapMode: TextEdit.Wrap
                    font.family: Theme.mono
                    font.pixelSize: 13
                    color: Theme.txt
                    placeholderText: "Try \"fix the failing test\" or \"explain @src/app.py\""
                    placeholderTextColor: Theme.mut
                    selectionColor: Theme.lineFocus
                    selectedTextColor: Theme.inverse
                    selectByMouse: true
                    focus: true
                    onCursorRectangleChanged: inputFlick.ensureVisible(cursorRectangle)
                    onTextChanged: panel.updatePopup()

                    Keys.onPressed: function (event) { panel.inputKey(event) }
                }
            }
        }

        // ---- The status line -----------------------------------------------------------
        RowLayout {
            Layout.fillWidth: true
            Layout.topMargin: 6
            Layout.leftMargin: 4
            Layout.rightMargin: 4
            spacing: 12
            Text {
                text: CodeStore.modeLabel.text
                font.family: Theme.mono
                font.pixelSize: 11
                color: CodeStore.modeColor(CodeStore.modeLabel.cls, Theme.mut)
            }
            Text {
                Layout.fillWidth: true
                horizontalAlignment: Text.AlignRight
                text: CodeStore.metaText
                textFormat: Text.PlainText
                elide: Text.ElideRight
                font.family: Theme.mono
                font.pixelSize: 11
                color: Theme.mut
            }
        }
    }

    // ---- The / and @ popup, over the transcript, just above the prompt ---------------
    Rectangle {
        id: suggest
        visible: !!panel.popup
        x: box.x
        width: box.width
        y: box.mapToItem(panel, 0, 0).y - height - 4
        height: Math.min(260, sugList.contentHeight + 2)
        z: 5
        radius: Theme.rMd
        color: Theme.panel
        border.width: 1
        border.color: Theme.lineStrong

        ListView {
            id: sugList
            anchors.fill: parent
            anchors.margins: 1
            clip: true
            model: panel.popup ? panel.popup.items : []
            currentIndex: panel.popup ? panel.popup.sel : -1
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ThinScrollBar {}
            onCurrentIndexChanged: positionViewAtIndex(currentIndex, ListView.Contain)
            delegate: Rectangle {
                id: sug
                required property var modelData
                required property int index
                readonly property bool sel: !!panel.popup && panel.popup.sel === index
                width: ListView.view.width
                height: k.implicitHeight + 10
                color: sel ? Theme.surfaceRaised : "transparent"
                Row {
                    x: 12; y: 5
                    spacing: 2 * panel.ch
                    Text {
                        id: k
                        width: Math.max(implicitWidth, 14 * panel.ch)
                        text: sug.modelData.label
                        textFormat: Text.PlainText
                        font: fm.font
                        color: sug.sel ? Theme.accent : Theme.txt
                    }
                    Text {
                        text: sug.modelData.desc || ""
                        textFormat: Text.PlainText
                        font: fm.font
                        color: Theme.mut
                    }
                }
                HoverHandler { cursorShape: Qt.PointingHandCursor }
                // Picked on press, so the prompt keeps its focus.
                TapHandler { gesturePolicy: TapHandler.DragThreshold; onPressedChanged: if (pressed) panel.pickPopup(sug.index) }
            }
        }
    }

    // ---- "Run this project" --------------------------------------------------------
    CodeRunOffer {
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.rightMargin: Theme.sp6
        anchors.bottomMargin: Theme.sp6
        z: 6
    }

    // ---- Clone, after asking (ship.js's confirm()) ----------------------------------
    Modal {
        id: cloneModal
        cardWidth: 460
        onClosed: if (CodeStore.pendingClone) CodeStore.answerClone(false)
        contentItem: Column {
            spacing: 16
            Text {
                width: parent.width
                text: CodeStore.cloneText
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                font.family: Theme.ui
                font.pixelSize: Theme.bodySize
                color: Theme.txt
            }
            Row {
                x: parent.width - width
                spacing: 8
                Btn { text: "Cancel"; onClicked: { CodeStore.answerClone(false); cloneModal.close() } }
                Btn { text: "Clone"; variant: "invert"; onClicked: { CodeStore.answerClone(true); cloneModal.close() } }
            }
        }
    }

    // ---- The prompt's keys ------------------------------------------------------------

    function closePopup() { popup = null }

    function showPopup(items, kind) {
        if (!items.length) { closePopup(); return }
        popup = { items: items, kind: kind, sel: 0 }
    }

    function movePopup(d) {
        var P = popup
        if (!P) return
        popup = { items: P.items, kind: P.kind, sel: (P.sel + d + P.items.length) % P.items.length }
    }

    function pickPopup(i) {
        var P = popup
        if (!P) return
        var it = P.items[i === undefined ? P.sel : i]
        if (P.kind === "cmd") {
            input.text = it.label + (it.arg ? " " : "")
            input.cursorPosition = input.length
        } else {
            var r = V.completeMention(input.text, input.cursorPosition, it.label)
            input.text = r.text
            input.cursorPosition = r.caret
        }
        closePopup()
        input.forceActiveFocus()
    }

    function updatePopup() {
        var v = input.text
        if (/^\/\S*$/.test(v)) {
            showPopup(V.matchCommands(v).map(function (c) { return { label: c.name, desc: c.desc, arg: c.arg } }), "cmd")
            return
        }
        var at = V.mentionAt(v, input.cursorPosition)
        if (at) {
            CodeStore.loadFiles().then(function (files) {
                // Only if the line still asks for a file: the list may come late.
                if (!V.mentionAt(input.text, input.cursorPosition)) return
                showPopup(V.rankFiles(files, at.query, 8).map(function (f) { return { label: f, desc: "" } }), "file")
            })
            return
        }
        closePopup()
    }

    function setInput(text) {
        input.text = text
        input.cursorPosition = input.length
    }

    function inputKey(event) {
        var shift = event.modifiers & Qt.ShiftModifier
        var enter = event.key === Qt.Key_Return || event.key === Qt.Key_Enter
        // A pending prompt answers to 1-3, the arrows and esc here too.
        if (CodeStore.permission && permissionKey(event, false)) return
        if (popup) {
            if (event.key === Qt.Key_Down) { event.accepted = true; movePopup(1); return }
            if (event.key === Qt.Key_Up) { event.accepted = true; movePopup(-1); return }
            if ((event.key === Qt.Key_Tab && !shift) || (enter && !shift && popup.kind === "file")) { event.accepted = true; pickPopup(); return }
            if (event.key === Qt.Key_Escape) { event.accepted = true; closePopup(); return }
        }
        if (event.key === Qt.Key_Backtab || (event.key === Qt.Key_Tab && shift)) {
            event.accepted = true
            CodeStore.cycleMode()
            return
        }
        if (event.key === Qt.Key_Escape) {
            event.accepted = true
            if (CodeStore.busy || CodeStore.permission) CodeStore.interrupt()
            else setInput("")
            return
        }
        if (enter && !shift) {
            event.accepted = true
            var t = input.text
            if (CodeStore.submit(t)) { setInput(""); closePopup() }
            return
        }
        if (event.text === "?" && !input.text) {
            event.accepted = true
            CodeStore.helpText(V.HELP)
            return
        }
        if (event.key === Qt.Key_Up && input.cursorPosition === 0 && CodeStore.history.length) {
            event.accepted = true
            var up = CodeStore.historyUp()
            if (up !== null) setInput(up)
            return
        }
        if (event.key === Qt.Key_Down && CodeStore.hIndex !== -1 && input.cursorPosition === input.length) {
            event.accepted = true
            var down = CodeStore.historyDown()
            if (down !== null) setInput(down)
        }
    }
}
