import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import CloseNI
import "../js/language-mark.mjs" as Lang

/*
 * Build: the plan's steps on the left,
 * the selected step's detail on the right - its timing, what it was asked to
 * do, its error, and every file it wrote as a diff against what was there.
 *
 * The build itself runs in BuildState, so leaving this panel mid-build loses
 * nothing: it keeps going, and coming back shows where it is.
 *
 * There is no web view: "Open in browser" hands the detected address to the system
 * browser, and "Run" starts the project in the run console.
 */
Item {
    id: panel
    objectName: "buildPanel"

    // The selected step's file cards whose bodies are shown. Closed by default,
    // as .file-body was, and reset when another step is picked.
    property var openFiles: []
    readonly property int sel: BuildState.selected
    onSelChanged: openFiles = []

    readonly property var shown: BuildState.shown
    readonly property var step: BuildState.revision >= 0 && sel >= 0 ? BuildState.steps[sel] : null

    function toggleFile(f) {
        var next = openFiles.slice()
        var at = next.indexOf(f)
        if (at === -1) next.push(f); else next.splice(at, 1)
        openFiles = next
    }
    function sendSuggestion() {
        BuildState.suggest(suggestInput.text).then(function (applied) {
            if (applied) suggestInput.text = ""
        })
    }
    function sendReject() {
        if (BuildState.reject(reviewReason.text)) reviewReason.text = ""
        else reviewReason.forceActiveFocus()
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 14

        // #builder-toolbar
        Flow {
            id: toolbar
            Layout.fillWidth: true
            spacing: 8

            // The progress bar takes what the rest of the row leaves (flex:1,
            // min-width 120px), and wraps to its own line when that is too little.
            function restWidth() {
                var w = 0
                for (var i = 0; i < children.length; i++) {
                    var c = children[i]
                    if (c !== progressWrap && c.visible) w += c.width + spacing
                }
                return w
            }

            Btn { objectName: "buildStart"; variant: "invert"; text: "Start Build"; visible: panel.shown.start; onClicked: BuildState.startBuild() }
            Btn { text: "Pause"; visible: panel.shown.pause; onClicked: BuildState.pause() }
            Btn { text: "Resume"; visible: panel.shown.resume; onClicked: BuildState.resume() }
            Btn { text: "Skip Step"; visible: panel.shown.skip; onClicked: BuildState.skip() }
            Btn { text: "Retry Failed"; visible: panel.shown.retry; onClicked: BuildState.retryFailed() }
            Btn { objectName: "buildStop"; text: "Stop"; visible: panel.shown.stop; onClicked: BuildState.stop() }

            Item {
                id: progressWrap
                width: Math.max(120, toolbar.width - toolbar.restWidth())
                height: 32
                Progress {
                    anchors.verticalCenter: parent.verticalCenter
                    width: parent.width
                    height: Theme.isPixel ? 12 : 6
                    value: BuildState.progress
                    fill: Theme.isPixel ? Theme.pxG2 : Theme.txt
                }
            }

            Row {
                id: toolbarRest
                spacing: 8
                height: 32
                Text {
                    objectName: "buildStatus"
                    anchors.verticalCenter: parent.verticalCenter
                    text: BuildState.statusText
                    font.family: Theme.mono
                    font.pixelSize: 11
                    color: Theme.dim
                    style: Theme.hasGlow ? Text.Outline : Text.Normal
                    styleColor: Theme.glow
                }
                // Off by default: a build you can walk away from is much of the
                // point of one, so pausing on every step is opted into, not out of.
                Check {
                    anchors.verticalCenter: parent.verticalCenter
                    text: "Review each step"
                    checked: BuildState.reviewSteps
                    onToggled: BuildState.setReviewSteps(checked)
                    ToolTip.visible: hovered
                    ToolTip.delay: 600
                    ToolTip.text: "Pause after each step that changed files, and show what it changed before the next step builds on it"
                }
                // Only offered when there is genuinely something to show - a
                // button that opens nothing is worse than no button.
                Btn {
                    objectName: "buildOpenBrowser"
                    visible: !!BuildState.preview
                    text: "Open in browser"
                    tip: BuildState.preview ? "Open " + BuildState.preview.url + " outside CloseNI" : ""
                    onClicked: BuildState.openPreview()
                }
                Btn {
                    objectName: "buildRun"
                    visible: !BuildState.running && BuildState.steps.length > 0 && BuildState.revision >= 0
                    text: "Run"
                    tip: "Run what was built in the run console"
                    onClicked: BuildState.runProject()
                }
            }
        }

        // #builder-view
        RowLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 14

            // #builder-sidebar
            Rectangle {
                Layout.preferredWidth: 260
                Layout.fillHeight: true
                color: Theme.panel
                radius: Theme.isPixel ? 0 : 4
                border.width: 1
                border.color: Theme.isPixel ? Theme.lineStrong : Theme.line

                ColumnLayout {
                    anchors.fill: parent
                    anchors.margins: 12
                    spacing: 8
                    Micro { text: "Steps" }
                    ListView {
                        id: stepList
                        cacheBuffer: 0   // no async look-ahead in a Loader: ARCHITECTURE.md, Panels
                        objectName: "buildSteps"
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        clip: true
                        spacing: 4
                        boundsBehavior: Flickable.StopAtBounds
                        model: BuildState.stepModel
                        ScrollBar.vertical: ThinScrollBar {}
                        // Cards arrive (pix-in) when the list is drawn or grows,
                        // not when scrolling brings a delegate into being.
                        property double drawnAt: Date.now()
                        onCountChanged: drawnAt = Date.now()

                        // .step-card
                        delegate: Rectangle {
                            id: stepCard
                            required property int index
                            required property string title
                            required property string status
                            readonly property bool active: index === panel.sel
                            // Pixel's hard shadow needs room inside the list's clip.
                            width: stepList.width - (Theme.isPixel ? 3 : 0)
                            height: row.implicitHeight + 16
                            radius: Theme.isPixel ? 0 : 3
                            color: active ? Theme.surfaceRaised : Theme.surface
                            border.width: 1
                            border.color: active ? (Theme.isPixel ? Theme.pxG2 : Theme.txt)
                                        : hover.hovered ? Theme.lineStrong : Theme.line
                            // .step-card's transition: .12s on its edge and ground.
                            Behavior on color { enabled: !App.reducedMotion; ColorAnimation { duration: 120 } }
                            Behavior on border.color { enabled: !App.reducedMotion; ColorAnimation { duration: 120 } }
                            activeFocusOnTab: true
                            Keys.onReturnPressed: BuildState.selectStep(index)
                            Keys.onSpacePressed: BuildState.selectStep(index)

                            // Pixel motion marks the change: a finished step
                            // stamps in, a running one spins, a failed one
                            // flickers. No entry for pending or skipped: nothing
                            // has happened to them, so nothing should move.
                            readonly property string pixMotion: status === "done" ? "stamp" : status === "failed" ? "flicker"
                                                              : status === "running" ? "spin" : ""
                            PixMotion { id: arrive; duration: 120; frames: 2 }
                            opacity: arrive.opacity
                            transform: Translate { y: arrive.shift }
                            Component.onCompleted: if (Date.now() - stepList.drawnAt < 300) { arrive.play(); statusChip.play() }

                            // Pixel: a hard 2px shadow, 3px and green under the active card.
                            Rectangle {
                                visible: Theme.isPixel
                                z: -1
                                x: stepCard.active ? 3 : 2
                                y: x
                                width: parent.width
                                height: parent.height
                                color: stepCard.active ? Theme.pxG4 : Theme.pxShadow
                            }

                            HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }
                            TapHandler { onTapped: BuildState.selectStep(stepCard.index) }
                            FocusRing { target: stepCard; targetRadius: stepCard.radius; shown: stepCard.activeFocus }

                            RowLayout {
                                id: row
                                x: 10
                                width: parent.width - 20
                                anchors.verticalCenter: parent.verticalCenter
                                spacing: 8
                                Text {
                                    text: "0" + (stepCard.index + 1)
                                    font.family: Theme.mono
                                    font.pixelSize: 10
                                    color: stepCard.active ? Theme.txt : Theme.mut
                                }
                                Text {
                                    Layout.fillWidth: true
                                    text: stepCard.title
                                    elide: Text.ElideRight
                                    font.family: Theme.ui
                                    font.pixelSize: 12
                                    color: stepCard.active ? Theme.txt : Theme.dim
                                    style: stepCard.active && Theme.hasGlow ? Text.Outline : Text.Normal
                                    styleColor: Theme.glow
                                }
                                Chip { id: statusChip; text: stepCard.status; kind: stepCard.status; motion: stepCard.pixMotion }
                            }
                        }
                    }
                }
            }

            // #builder-main
            Rectangle {
                Layout.fillWidth: true
                Layout.fillHeight: true
                color: Theme.panel
                radius: Theme.isPixel ? 0 : 4
                border.width: 1
                border.color: Theme.isPixel ? Theme.lineStrong : Theme.line
                clip: true

                // #builder-empty
                Text {
                    visible: !panel.step
                    anchors.fill: parent
                    anchors.margins: 36
                    horizontalAlignment: Text.AlignHCenter
                    wrapMode: Text.Wrap
                    font.family: Theme.ui
                    font.pixelSize: 12
                    color: Theme.mut
                    text: BuildState.steps.length && BuildState.revision >= 0
                          ? "Pick a step to see what it was asked to do and what it wrote."
                          : "No plan loaded. Go to Chat, describe your idea, hit Generate Implementation Plan, then Build with this."
                }

                // #step-detail
                ColumnLayout {
                    visible: !!panel.step
                    anchors.fill: parent
                    anchors.margins: 1
                    spacing: 0

                    // #step-detail-head
                    Item {
                        Layout.fillWidth: true
                        implicitHeight: head.implicitHeight + 24
                        RowLayout {
                            id: head
                            x: 14
                            width: parent.width - 28
                            anchors.verticalCenter: parent.verticalCenter
                            spacing: 10
                            Text {
                                objectName: "stepDetailLabel"
                                Layout.fillWidth: true
                                text: panel.step ? "0" + (panel.sel + 1) + " " + (panel.step.title || "") : ""
                                elide: Text.ElideRight
                                font.family: Theme.mono
                                font.pixelSize: 12
                                color: Theme.txt
                            }
                            Text {
                                text: panel.step ? panel.step.status : ""
                                font.family: Theme.ui
                                font.pixelSize: 11
                                color: Theme.dim
                            }
                            // Shown only for a step that actually wrote something;
                            // a step that never ran has nothing to undo, and a build
                            // in progress must not have the ground moved.
                            Btn {
                                small: true
                                visible: BuildState.revision >= 0 && BuildState.rollbackOffered(panel.sel)
                                text: "Roll back to here"
                                tip: "Put the workspace back to how it was before this step, undoing this step and every step after it"
                                onClicked: BuildState.rollbackTo(panel.sel, function (msg, proceed) { confirm.ask(msg, proceed) })
                            }
                            // Only while a step is actually waiting on a verdict.
                            // Buttons that are visible but inert read as broken.
                            RowLayout {
                                visible: BuildState.reviewing
                                spacing: 8
                                Field {
                                    id: reviewReason
                                    objectName: "reviewReason"
                                    Layout.preferredWidth: 240
                                    placeholderText: "What was wrong? (needed to reject)"
                                    onAccepted: panel.sendReject()
                                }
                                Btn {
                                    objectName: "reviewAccept"
                                    small: true
                                    variant: "invert"
                                    text: "Accept"
                                    tip: "Keep this step and carry on"
                                    onClicked: BuildState.accept()
                                }
                                Btn {
                                    small: true
                                    text: "Reject"
                                    tip: "Undo this step and do it again, telling the model what was wrong"
                                    onClicked: panel.sendReject()
                                }
                            }
                        }
                        Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 1; color: Theme.line }
                    }

                    // #step-detail-body: every card as flat rows of one list,
                    // so a thousand-line diff makes only the rows on screen.
                    ListView {
                        id: detail
                        cacheBuffer: 0   // no async look-ahead in a Loader: ARCHITECTURE.md, Panels
                        objectName: "stepDetail"
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        clip: true
                        boundsBehavior: Flickable.StopAtBounds
                        topMargin: 12
                        bottomMargin: 12
                        leftMargin: 14
                        rightMargin: 14
                        model: BuildState.revision >= 0 && panel.sel >= 0 ? BuildState.detailRows(panel.sel, panel.openFiles) : []
                        ScrollBar.vertical: ThinScrollBar {}
                        // A step's cards arrive (pix-in) when it is picked or
                        // the panel opens - not on every build event that
                        // redraws the rows, and not when scrolling makes one.
                        property double drawnAt: Date.now()
                        Connections {
                            target: panel
                            function onSelChanged() { detail.drawnAt = Date.now() }
                        }

                        delegate: Item {
                            id: rowItem
                            required property var modelData
                            required property int index
                            readonly property var r: modelData
                            readonly property bool isHead: r.k === "head"
                            readonly property bool first: !isHead && index > 0 && detail.model[index - 1].k === "head"
                            readonly property bool closes: !!r.last
                            // Pixel's 3px top edge, 2px more than the line it replaces.
                            readonly property int topEdge: isHead && Theme.isPixel ? 2 : 0
                            readonly property bool diffLine: r.k === "diff" && (r.type === "add" || r.type === "remove")
                            width: detail.width - detail.leftMargin - detail.rightMargin
                            height: box.height + (closes ? 10 : 0)

                            // .file-card arrives in three steps; a diff line
                            // stamps in on its own, in two.
                            PixMotion { id: arrive; frames: rowItem.diffLine ? 2 : 3; duration: rowItem.diffLine ? 120 : 160 }
                            opacity: arrive.opacity
                            transform: Translate { y: arrive.shift }
                            Component.onCompleted: if (Date.now() - detail.drawnAt < 300) arrive.play()

                            // Pixel: the card's hard 3px shadow, drawn per row
                            // down its right side and under its last row.
                            Rectangle {
                                visible: Theme.isPixel
                                x: box.width
                                y: rowItem.isHead ? 3 : 0
                                width: 3
                                height: box.height - y + (rowItem.closes ? 3 : 0)
                                color: Theme.pxShadow
                            }
                            Rectangle {
                                visible: Theme.isPixel && rowItem.closes
                                x: 3
                                y: box.height
                                width: box.width - 3
                                height: 3
                                color: Theme.pxShadow
                            }

                            Rectangle {
                                id: box
                                width: parent.width
                                height: rowItem.isHead ? headRow.implicitHeight + 16 + 1 + rowItem.topEdge
                                        : body.implicitHeight + (rowItem.first ? 12 : 0) + (rowItem.closes ? 12 : 0)
                                color: rowItem.isHead ? (headHover.hovered && rowItem.r.file >= 0 ? Theme.surfaceRaised : Theme.surface)
                                       : rowItem.r.k === "diff" && rowItem.r.type === "add" ? Theme.okBg
                                       : rowItem.r.k === "diff" && rowItem.r.type === "remove" ? Theme.errBg
                                       : Theme.surfaceSunken

                                // The card's edges, drawn per row. Pixel's top
                                // edge cycles green, blue, purple, amber, red
                                // down the step's cards.
                                Rectangle { width: 1; height: parent.height; color: Theme.line }
                                Rectangle { x: parent.width - 1; width: 1; height: parent.height; color: Theme.line }
                                Rectangle {
                                    visible: rowItem.isHead
                                    width: parent.width
                                    height: 1 + rowItem.topEdge
                                    color: Theme.isPixel ? Theme.pxCycle(rowItem.r.card || 0) : Theme.line
                                }
                                Rectangle { visible: rowItem.closes || rowItem.isHead; y: parent.height - 1; width: parent.width; height: 1; color: Theme.line }

                                // .file-card-head: a file's head opens and closes its body.
                                HoverHandler {
                                    id: headHover
                                    enabled: rowItem.isHead && rowItem.r.file >= 0
                                    cursorShape: Qt.PointingHandCursor
                                }
                                TapHandler {
                                    enabled: rowItem.isHead && rowItem.r.file >= 0
                                    onTapped: panel.toggleFile(rowItem.r.file)
                                }
                                RowLayout {
                                    id: headRow
                                    visible: rowItem.isHead
                                    x: 12
                                    y: 8 + rowItem.topEdge
                                    width: parent.width - 24
                                    spacing: 8
                                    // The mark's colour is data about the file, not
                                    // styling of the card.
                                    Rectangle {
                                        readonly property var mark: rowItem.isHead && rowItem.r.lang ? Lang.languageMark(rowItem.r.path) : null
                                        readonly property color tone: mark ? Theme.langColor(mark.token.replace("--lang-", "")) : Theme.langDefault
                                        visible: !!mark
                                        implicitWidth: markText.implicitWidth + 10
                                        implicitHeight: markText.implicitHeight + 6
                                        color: "transparent"
                                        radius: Theme.rSm
                                        border.width: 1
                                        border.color: tone
                                        opacity: 0.85
                                        Text {
                                            id: markText
                                            anchors.centerIn: parent
                                            text: parent.mark ? parent.mark.label : ""
                                            font.family: Theme.mono
                                            font.pixelSize: 9
                                            color: parent.tone
                                        }
                                    }
                                    Text {
                                        Layout.fillWidth: true
                                        text: rowItem.isHead ? rowItem.r.path : ""
                                        elide: Text.ElideMiddle
                                        font.family: Theme.mono
                                        font.pixelSize: 12
                                        color: Theme.txt
                                    }
                                    Text {
                                        text: rowItem.isHead ? String(rowItem.r.mode || "") : ""
                                        font.family: Theme.ui
                                        font.pixelSize: 10
                                        font.letterSpacing: 1
                                        font.capitalization: Font.AllUppercase
                                        color: rowItem.r.mode === "create" ? Theme.txt
                                             : rowItem.r.mode === "failed" ? Theme.err
                                             : rowItem.r.mode === "overwrite" || rowItem.r.mode === "search_replace" ? Theme.dim
                                             : Theme.mut
                                    }
                                }

                                Text {
                                    id: body
                                    visible: !rowItem.isHead
                                    x: 12
                                    y: rowItem.first ? 12 : 0
                                    width: parent.width - 24
                                    text: rowItem.isHead ? "" : (rowItem.r.text === "" ? " " : rowItem.r.text)
                                    textFormat: Text.PlainText
                                    wrapMode: Text.WrapAnywhere
                                    lineHeight: 1.25
                                    font.family: Theme.mono
                                    font.pixelSize: 11
                                    font.italic: rowItem.r.type === "gap"
                                    color: rowItem.r.type === "add" ? Theme.ok
                                         : rowItem.r.type === "remove" ? Theme.err
                                         : rowItem.r.type === "gap" ? Theme.mut
                                         : Theme.dim
                                }
                            }
                        }
                    }

                    // #suggest-bar
                    Rectangle {
                        Layout.fillWidth: true
                        implicitHeight: suggestRow.implicitHeight + 20
                        color: Theme.bg
                        Rectangle { width: parent.width; height: 1; color: Theme.line }
                        RowLayout {
                            id: suggestRow
                            x: 12
                            width: parent.width - 24
                            anchors.verticalCenter: parent.verticalCenter
                            spacing: 8
                            Field {
                                id: suggestInput
                                objectName: "suggestInput"
                                Layout.fillWidth: true
                                enabled: !BuildState.suggesting
                                placeholderText: "Suggest a change to this step..."
                                onAccepted: panel.sendSuggestion()
                            }
                            Btn {
                                variant: "invert"
                                text: "Send"
                                enabled: !BuildState.suggesting
                                onClicked: panel.sendSuggestion()
                            }
                        }
                    }
                }
            }
        }
    }

    // Rollback asks first: it names what will be restored and removed, and any
    // file edited by hand since the build wrote it, before anything is touched.
    Modal {
        id: confirm
        property string message: ""
        property var proceed: null
        cardWidth: 520
        function ask(msg, go) { message = msg; proceed = go; open() }
        contentItem: ColumnLayout {
            spacing: 0
            Micro { text: "Roll back" }
            Text {
                Layout.fillWidth: true
                Layout.topMargin: 8
                Layout.bottomMargin: 14
                text: confirm.message
                wrapMode: Text.Wrap
                font.family: Theme.ui
                font.pixelSize: 12
                color: Theme.dim
            }
            RowLayout {
                spacing: 8
                Btn {
                    objectName: "confirmRollback"
                    text: "Roll back"
                    variant: "invert"
                    onClicked: { var go = confirm.proceed; confirm.proceed = null; confirm.close(); if (go) go() }
                }
                Btn { text: "Cancel"; onClicked: { confirm.proceed = null; confirm.close() } }
            }
        }
    }
}
