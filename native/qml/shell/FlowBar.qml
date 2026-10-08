import QtQuick
import QtQuick.Controls.Basic
import CloseNI

/*
 * #flow: Describe, Plan, Build, Test, Ship - where the project is and the one
 * thing to do next, from flow.mjs through AppState.flowStages. Each stage
 * opens its panel. Narrow windows (`compact`) keep the numbers and drop the
 * words, as the CSS does under 1180px.
 */
Row {
    id: bar

    property bool compact: false

    spacing: 2
    clip: true

    Repeater {
        model: AppState.flowStages
        Row {
            id: cell
            required property var modelData
            required property int index
            readonly property var st: modelData
            spacing: 2

            // .flow-sep: a line, or Pixel's dotted one; green after a done stage.
            Item {
                visible: cell.index > 0
                width: 14
                height: step.height
                readonly property bool done: cell.index > 0 && AppState.flowStages[cell.index - 1].status === "done"
                Rectangle {
                    visible: !Theme.isPixel
                    anchors.verticalCenter: parent.verticalCenter
                    width: 14; height: 1
                    color: parent.done ? Theme.okLine : Theme.lineStrong
                }
                Row {
                    visible: Theme.isPixel
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: 2
                    Repeater {
                        model: Theme.isPixel ? 4 : 0
                        Rectangle { width: 2; height: 2; color: parent.parent.done ? Theme.pxG3 : Theme.pxChrome }
                    }
                }
            }

            AbstractButton {
                id: step
                readonly property string status: cell.st.status
                readonly property bool here: cell.st.mode === AppState.mode
                readonly property bool next: status === "next"
                readonly property color fg: {
                    if (Theme.isPixel && next) return Theme.pxG1
                    switch (status) {
                    case "done": return Theme.dim
                    case "next": return Theme.txt
                    case "active": return Theme.warn
                    case "failed": return Theme.err
                    }
                    return hovered ? Theme.txt : Theme.mut
                }
                hoverEnabled: true
                focusPolicy: Qt.StrongFocus
                leftPadding: 8; rightPadding: 8; topPadding: 4; bottomPadding: 4
                implicitWidth: content.implicitWidth + leftPadding + rightPadding
                implicitHeight: content.implicitHeight + topPadding + bottomPadding
                onClicked: AppState.switchTab(cell.st.mode)
                ToolTip.visible: hovered
                ToolTip.delay: 600
                ToolTip.text: AppState.flowTitle(cell.st)

                contentItem: Row {
                    id: content
                    spacing: bar.compact ? 0 : Theme.sp2
                    // The number, a tick or a "!".
                    Rectangle {
                        width: 15; height: 15
                        anchors.verticalCenter: parent.verticalCenter
                        radius: Theme.rSm
                        color: step.status === "done" ? Theme.okBg : step.status === "active" ? Theme.warnBg
                             : step.status === "failed" ? Theme.errBg : "transparent"
                        border.width: 1
                        border.color: Theme.isPixel && step.next ? Theme.pxG2
                                    : step.status === "done" ? Theme.okLine : step.status === "active" ? Theme.warnLine
                                    : step.status === "failed" ? Theme.errLine : step.next ? Theme.txt : Theme.lineStrong
                        Text {
                            anchors.centerIn: parent
                            text: AppState.flowMark(cell.st, cell.index)
                            font.family: Theme.mono
                            font.pixelSize: 9
                            color: Theme.isPixel && step.next ? Theme.pxG2
                                 : step.status === "done" ? Theme.ok : step.status === "active" ? Theme.warn
                                 : step.status === "failed" ? Theme.err : step.fg
                        }
                    }
                    Text {
                        visible: !bar.compact
                        anchors.verticalCenter: parent.verticalCenter
                        text: cell.st.label
                        font.family: Theme.mono
                        font.pixelSize: 10
                        font.letterSpacing: 1.4
                        font.capitalization: Font.AllUppercase
                        color: step.fg
                    }
                    // Pixel: the blinking cursor on the next stage.
                    Rectangle {
                        id: cur
                        visible: Theme.isPixel && step.next
                        width: 6; height: 10
                        anchors.verticalCenter: parent.verticalCenter
                        color: Theme.pxG2
                        property bool on: true
                        opacity: on ? 1 : 0
                        Timer {
                            interval: 550
                            repeat: true
                            running: cur.visible && Theme.animate
                            onRunningChanged: if (!running) cur.on = true
                            onTriggered: cur.on = !cur.on
                        }
                    }
                }

                background: Item {
                    Rectangle {
                        visible: Theme.isPixel && step.next
                        x: 2; y: 2; width: parent.width; height: parent.height
                        color: Theme.pxShadow
                    }
                    Rectangle {
                        anchors.fill: parent
                        radius: Theme.rSm
                        color: step.here ? Theme.surfaceRaised : Theme.isPixel && step.next ? Theme.bg : "transparent"
                        border.width: 1
                        border.color: step.visualFocus ? Theme.lineFocus
                                    : Theme.isPixel && step.next ? Theme.pxG2
                                    : step.next ? Theme.lineStrong : "transparent"
                    }
                }
            }
        }
    }
}
