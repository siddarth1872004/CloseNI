import QtQuick
import QtQuick.Controls.Basic
import CloseNI

/*
 * .cc-perm: a question with numbered options, in the focus colour - a tool's
 * permission prompt, or "Ready to code?" after a plan. The body between the
 * question and "Do you want to proceed?" is a command (bash) or a path and its
 * diff (write, edit). Once answered it collapses to one quiet line saying what
 * was chosen.
 *
 * The keyboard (1-3, arrows, enter, esc) is CodePanel's, so it works wherever
 * focus is; this draws and takes clicks. Choosing "No" opens the feedback
 * field: enter sends what is typed, esc sends nothing.
 */
Rectangle {
    id: box

    property string question: ""
    property string ask: "Do you want to proceed?"
    property var body: null
    property var opts: []
    property int sel: 0
    property bool feedback: false
    property string answered: ""

    signal chosen(int index)
    signal feedbackSent(string text)

    readonly property real ch: fm.averageCharacterWidth

    implicitHeight: col.implicitHeight + (answered ? 8 : 20) + 2
    radius: Theme.rLg
    color: Theme.panel
    border.width: 1
    border.color: answered ? Theme.line : Theme.lineFocus

    FontMetrics { id: fm; font.family: Theme.mono; font.pixelSize: 13 }

    Column {
        id: col
        x: box.answered ? 12 : 14
        y: box.answered ? 4 : 10
        width: box.width - 2 * x
        spacing: 0

        Text {
            visible: box.answered !== ""
            width: parent.width
            text: box.answered
            textFormat: Text.PlainText
            wrapMode: Text.WrapAtWordBoundaryOrAnywhere
            font: fm.font
            color: Theme.mut
        }

        Column {
            visible: box.answered === ""
            width: parent.width
            spacing: 0

            Text {
                width: parent.width
                bottomPadding: 6
                text: box.question
                textFormat: Text.PlainText
                wrapMode: Text.WrapAtWordBoundaryOrAnywhere
                font.family: Theme.mono
                font.pixelSize: 13
                font.bold: true
                color: Theme.lineFocus
            }

            // The command it wants to run.
            Rectangle {
                visible: !!box.body && box.body.kind === "cmd"
                width: parent.width
                height: visible ? cmd.implicitHeight + 12 : 0
                color: Theme.surfaceSunken
                Text {
                    id: cmd
                    x: 10; y: 6
                    width: parent.width - 20
                    text: box.body && box.body.kind === "cmd" ? box.body.text : ""
                    textFormat: Text.PlainText
                    wrapMode: Text.WrapAtWordBoundaryOrAnywhere
                    font: fm.font
                    color: Theme.txt
                }
            }
            Item { visible: !!box.body && box.body.kind === "cmd"; width: 1; height: 8 }

            // The file and what would change in it.
            Text {
                visible: !!box.body && box.body.kind === "diff"
                width: parent.width
                bottomPadding: 4
                text: box.body && box.body.kind === "diff" ? box.body.path : ""
                textFormat: Text.PlainText
                elide: Text.ElideMiddle
                font: fm.font
                color: Theme.dim
            }
            Loader {
                active: !!box.body && box.body.kind === "diff"
                visible: active
                width: parent.width
                sourceComponent: CodeDiff { rows: box.body.rows; maxHeight: 300 }
            }
            Item { visible: !!box.body && box.body.kind === "diff"; width: 1; height: 8 }

            Text {
                width: parent.width
                topPadding: 6
                bottomPadding: 6
                text: box.ask
                textFormat: Text.PlainText
                wrapMode: Text.WrapAtWordBoundaryOrAnywhere
                font: fm.font
                color: Theme.txt
            }

            Repeater {
                model: box.opts
                Item {
                    id: opt
                    required property var modelData
                    required property int index
                    readonly property bool lit: box.sel === index || hover.hovered
                    width: parent.width
                    height: label.implicitHeight + 4
                    Text {
                        visible: box.sel === opt.index
                        y: 2
                        text: "❯"
                        font: fm.font
                        color: Theme.lineFocus
                    }
                    Text {
                        id: label
                        x: 2 * box.ch
                        y: 2
                        width: parent.width - x
                        text: "<span style=\"color:" + Theme.mut + "\">" + (opt.index + 1) + ".</span> " +
                              String(opt.modelData.label).replace(/&/g, "&amp;").replace(/</g, "&lt;")
                        textFormat: Text.StyledText
                        wrapMode: Text.WrapAtWordBoundaryOrAnywhere
                        font: fm.font
                        color: opt.lit ? Theme.lineFocus : Theme.dim
                    }
                    HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }
                    TapHandler { onTapped: box.chosen(opt.index) }
                }
            }

            Item { visible: box.feedback; width: 1; height: 8 }
            Field {
                id: field
                visible: box.feedback
                width: parent.width
                height: visible ? implicitHeight : 0
                placeholderText: "Tell CloseNI what to do instead (enter to send, esc to skip)"
                onVisibleChanged: if (visible) forceActiveFocus()
                onActiveFocusChanged: CodeStore.feedbackFocused = activeFocus
                Keys.onReturnPressed: box.feedbackSent(text.trim())
                Keys.onEnterPressed: box.feedbackSent(text.trim())
                Keys.onEscapePressed: box.feedbackSent("")
            }
        }
    }
}
