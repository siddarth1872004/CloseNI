import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import CloseNI
import "../js/language-mark.mjs" as Lang

/*
 * #panel-test, from desktop/renderer/test.js: the run bar, the output column
 * with its history, and the chat about the last run. The state is in
 * ShipStore, so leaving the panel loses nothing; opening it re-reads the run
 * bar, because the manifest on disk may have changed (Electron's switchTab).
 */
ColumnLayout {
    id: panel
    spacing: Theme.sp4

    Component.onCompleted: ShipStore.refreshRunBar()

    // .test-row: a command and its verdict, optionally led by a language mark.
    component TestRow: Rectangle {
        id: row
        property string command: ""
        property string verdict: ""
        property bool ok: false
        property string language: ""
        width: parent ? parent.width : 0
        implicitHeight: rowLine.implicitHeight + 10
        radius: Theme.isPixel ? 0 : 3
        color: Theme.surface
        border.width: 1
        border.color: Theme.line
        RowLayout {
            id: rowLine
            x: 8; width: parent.width - 16
            anchors.verticalCenter: parent.verticalCenter
            spacing: 12
            // .lang-mark: the language in its family's colour, in a thin box.
            Rectangle {
                visible: row.language !== ""
                implicitWidth: mark.implicitWidth + 10
                implicitHeight: mark.implicitHeight + 6
                color: "transparent"
                radius: Theme.rSm
                border.width: 1
                border.color: mark.color
                Text {
                    id: mark
                    anchors.centerIn: parent
                    text: row.language
                    color: Theme.langColor(Lang.languageToken(row.language).slice(7))
                    font.family: Theme.mono
                    font.pixelSize: 9
                }
            }
            Text {
                Layout.fillWidth: true
                text: row.command
                color: Theme.dim
                font.family: Theme.mono
                font.pixelSize: 11
                wrapMode: Text.WrapAnywhere
            }
            Text {
                text: row.verdict
                color: row.ok ? Theme.ok : Theme.err
                font.family: Theme.mono
                font.pixelSize: 10
                font.letterSpacing: 1
                font.capitalization: Font.AllUppercase
            }
        }
    }

    // #test-output-col and #test-chat-col: a panel box whose content fills its height.
    component ColumnBox: Rectangle {
        default property alias content: inner.data
        color: Theme.panel
        radius: Theme.rLg
        border.width: 1
        border.color: Theme.line
        ColumnLayout {
            id: inner
            anchors.fill: parent
            anchors.leftMargin: Theme.sp6
            anchors.rightMargin: Theme.sp6
            anchors.topMargin: Theme.sp5
            anchors.bottomMargin: Theme.sp5
            spacing: 6
        }
    }

    // #run-bar
    Card {
        Layout.fillWidth: true
        ground: "panel"
        radius: Theme.rLg
        padding: Theme.sp4
        spacing: Theme.sp3

        RowLayout {
            Layout.fillWidth: true
            spacing: Theme.sp3
            Micro { text: "Run" }
            Field {
                id: cmd
                objectName: "testCmd"
                Layout.fillWidth: true
                placeholderText: "no run command yet - type one, or build a project"
                text: ShipStore.runCommand
                // Electron's "change": saved when the edit is done, not per key.
                onEditingFinished: ShipStore.saveRunCommand(text)
                onAccepted: ShipStore.run(text)
            }
            Btn { text: "Run"; variant: "invert"; enabled: !ShipStore.testing; onClicked: ShipStore.run(cmd.text) }
        }
        RowLayout {
            Layout.fillWidth: true
            spacing: Theme.sp3
            Chip { visible: ShipStore.runSource !== ""; text: ShipStore.runBadge; kind: ShipStore.runSource }
            Hint { text: ShipStore.runHint; Layout.fillWidth: true; elide: Text.ElideRight; wrapMode: Text.NoWrap }
            Btn { text: "Re-detect"; small: true; onClicked: ShipStore.redetect() }
            Btn { text: "Syntax-check all"; small: true; enabled: !ShipStore.testing; onClicked: ShipStore.syntaxCheck() }
            // Syntax checks prove the code parses. This runs the project's own
            // test suite and starts its entry point, which is the only way to
            // find out whether it behaves.
            Btn {
                text: "Run tests"; small: true; enabled: !ShipStore.testing
                tip: "Run the project's tests and start it"
                onClicked: ShipStore.behaviour()
            }
        }
    }

    // #test-view
    RowLayout {
        Layout.fillWidth: true
        Layout.fillHeight: true
        spacing: Theme.sp6

        // #test-output-col
        ColumnBox {
            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.horizontalStretchFactor: 135
            Layout.preferredWidth: 1

            Micro { text: "Output" }
            ScrollArea {
                Layout.fillWidth: true
                Layout.fillHeight: true

                ColumnLayout {
                    width: parent.width
                    spacing: 0
                    Micro {
                        Layout.fillWidth: true
                        Layout.topMargin: 14
                        Layout.bottomMargin: 6
                        visible: text !== ""
                        text: ShipStore.testSummary
                        wrapMode: Text.Wrap
                    }
                    // #test-results: at most 340px, scrolling inside.
                    ListView {
                        id: results
                        objectName: "testResults"
                        Layout.fillWidth: true
                        Layout.preferredHeight: Math.min(contentHeight, 340)
                        clip: true
                        spacing: 4
                        boundsBehavior: Flickable.StopAtBounds
                        model: ShipStore.testResults
                        ScrollBar.vertical: ThinScrollBar {}
                        delegate: Loader {
                            id: cell
                            required property string kind
                            required property string command
                            required property bool success
                            required property string language
                            required property string text
                            width: ListView.view.width
                            sourceComponent: kind === "output" ? outputBlock : resultRow
                            Component {
                                id: resultRow
                                TestRow { command: cell.command; ok: cell.success; language: cell.language; verdict: cell.success ? "pass" : "fail" }
                            }
                            Component {
                                id: outputBlock
                                // .test-output: the command's output, selectable.
                                Rectangle {
                                    width: parent ? parent.width : 0
                                    implicitHeight: out.implicitHeight + 20
                                    color: Theme.surfaceSunken
                                    radius: Theme.rSm
                                    TextEdit {
                                        id: out
                                        x: 10; y: 10
                                        width: parent.width - 20
                                        text: cell.text
                                        readOnly: true
                                        selectByMouse: true
                                        textFormat: TextEdit.PlainText
                                        wrapMode: TextEdit.WrapAnywhere
                                        font.family: Theme.mono
                                        font.pixelSize: 11
                                        color: Theme.dim
                                        selectionColor: Theme.lineFocus
                                    }
                                }
                            }
                        }
                    }
                    Micro {
                        Layout.topMargin: Theme.sp5
                        Layout.bottomMargin: 4
                        visible: ShipStore.testHistory.length > 0
                        text: "Earlier"
                    }
                    Repeater {
                        model: ShipStore.testHistory
                        TestRow {
                            required property var modelData
                            Layout.fillWidth: true
                            Layout.bottomMargin: 4
                            command: modelData.label
                            ok: !!modelData.ok
                            verdict: modelData.ok ? "passed" : "failed"
                        }
                    }
                }
            }
        }

        // #test-chat-col
        ColumnBox {
            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.horizontalStretchFactor: 100
            Layout.preferredWidth: 1

            Micro { text: "Ask about this run" }
            ListView {
                id: flow
                objectName: "testChat"
                Layout.fillWidth: true
                Layout.fillHeight: true
                Layout.bottomMargin: Theme.sp3
                clip: true
                boundsBehavior: Flickable.StopAtBounds
                model: ShipStore.testChat
                ScrollBar.vertical: ThinScrollBar {}
                onCountChanged: Qt.callLater(positionViewAtEnd)
                delegate: Item {
                    id: msg
                    required property string who
                    required property string text
                    required property bool markdown
                    required property string applied
                    readonly property bool user: who === "user"
                    width: ListView.view.width
                    implicitHeight: msgCol.implicitHeight + Theme.sp3 * 2 + 1
                    height: implicitHeight
                    Column {
                        id: msgCol
                        y: Theme.sp3
                        width: parent.width - 4
                        x: 2
                        spacing: 4
                        Text {
                            text: (Theme.isPixel && msg.user ? "$ " : "") + (msg.user ? "you" : "ai")
                            color: Theme.isPixel ? (msg.user ? Theme.pxG2 : Theme.pxBlue) : (msg.user ? Theme.txt : Theme.mut)
                            font.family: Theme.ui
                            font.pixelSize: 10
                            font.letterSpacing: 1.4
                            font.capitalization: Font.AllUppercase
                        }
                        TextEdit {
                            width: parent.width
                            text: msg.text
                            readOnly: true
                            selectByMouse: true
                            textFormat: msg.markdown ? TextEdit.MarkdownText : TextEdit.PlainText
                            wrapMode: TextEdit.Wrap
                            font.family: Theme.ui
                            font.pixelSize: 13
                            color: msg.user ? Theme.txt : Theme.dim
                            selectionColor: Theme.lineFocus
                            onLinkActivated: function (link) { App.openExternal(link) }
                        }
                        // .applied-note
                        Hint {
                            visible: msg.applied !== ""
                            width: parent.width
                            text: msg.applied
                            color: Theme.ok
                        }
                    }
                    Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 1; color: Theme.line }
                }
            }
            RowLayout {
                Layout.fillWidth: true
                spacing: Theme.sp3
                Field {
                    id: ask
                    objectName: "testChatInput"
                    Layout.fillWidth: true
                    placeholderText: "Ask anything about this run..."
                    onAccepted: if (ShipStore.ask(text)) text = ""
                }
                Btn { text: "Send"; variant: "invert"; onClicked: if (ShipStore.ask(ask.text)) ask.text = "" }
            }
        }
    }
}
