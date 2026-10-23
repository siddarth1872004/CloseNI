import QtQuick
import CloseNI

/*
 * .run-offer: "Run this project", offered bottom-right after a turn that
 * changed files. First "Checking that it starts…" while the program runs
 * unseen for a few seconds; then "▶ Ready to run", or "✗ Crashed on start"
 * with the crash offered to the agent. Gone on the next turn, or "Not now".
 */
Item {
    id: offer

    readonly property var o: CodeStore.runOffer
    readonly property bool fail: !!o && o.state === "fail"
    readonly property color tint: fail ? Theme.err : Theme.accent

    visible: !!o
    // min-width 280, max-width 440, and in between as wide as the command.
    width: Math.max(280, Math.min(440, Math.max(acts.implicitWidth, cmdWidth.advanceWidth) + 30))
    height: col.implicitHeight + 24

    Shadow { target: face; level: 2; hard: Theme.isPixel ? 3 : 0; radius: face.radius }
    Rectangle {
        id: face
        anchors.fill: parent
        radius: Theme.rLg
        color: Theme.panel
        border.width: 1
        border.color: Theme.lineStrong
    }
    Rectangle { width: 2; height: parent.height; color: offer.tint }

    TextMetrics { id: cmdWidth; font.family: Theme.mono; font.pixelSize: 12; text: offer.o ? offer.o.command : "" }

    Column {
        id: col
        x: 14; y: 12
        width: offer.width - 28
        spacing: 0

        Text {
            text: !offer.o ? "" : offer.o.state === "checking" ? "Checking that it starts…"
                : offer.fail ? "✗ Crashed on start" : "▶ Ready to run"
            font.family: Theme.ui
            font.pixelSize: 11
            font.bold: true
            font.letterSpacing: 1.32
            font.capitalization: Font.AllUppercase
            color: offer.tint
        }
        Text {
            width: parent.width
            topPadding: 4
            bottomPadding: 12
            text: offer.o ? offer.o.command : ""
            textFormat: Text.PlainText
            wrapMode: Text.WrapAnywhere
            font.family: Theme.mono
            font.pixelSize: 12
            color: Theme.dim
        }
        Row {
            id: acts
            spacing: 8
            CodeBtn {
                visible: !!offer.o && offer.o.state === "fail"
                text: "Fix errors"
                tip: "Sends the error to the agent"
                look: "primary"
                tint: offer.tint
                onClicked: CodeStore.runOfferFix()
            }
            CodeBtn {
                visible: !!offer.o && offer.o.state === "fail"
                text: "Run anyway"
                onClicked: CodeStore.runInWindow(offer.o.command)
            }
            CodeBtn {
                visible: !!offer.o && offer.o.state === "ready"
                text: "Run this project"
                tip: "Opens it full screen in a CloseNI window"
                look: "primary"
                tint: offer.tint
                onClicked: CodeStore.runInWindow(offer.o.command)
            }
            CodeBtn {
                text: "Not now"
                onClicked: { CodeStore.closeRunOffer(); CodeStore.focusInput() }
            }
        }
    }
}
