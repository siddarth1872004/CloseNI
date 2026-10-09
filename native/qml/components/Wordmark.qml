import QtQuick
import CloseNI

/*
 * #wordmark: the bracket mark and "Close" + "NI", 15px, letter-spaced. "NI"
 * is muted, or the accent on Terminal along with the mark.
 *
 * Pixel: bold and wider, the letters in a stepped three-band green (three
 * clipped copies, no shader), a 2px hard shadow, a blinking block cursor and
 * a nine-step left-to-right boot sweep when the theme comes on. The cursor
 * and the sweep only run while decoration is on.
 */
Item {
    id: wm

    readonly property bool px: Theme.isPixel
    readonly property real spacing: px ? 2.1 : 1.2

    implicitWidth: row.implicitWidth
    implicitHeight: row.implicitHeight

    // The boot sweep: how many ninths are revealed.
    property int boot: 9
    function sweep() { if (px && Theme.motion) boot = 0 }
    onPxChanged: sweep()
    Component.onCompleted: sweep()
    Timer {
        interval: 100
        repeat: true
        running: wm.boot < 9
        onTriggered: wm.boot++
    }

    Item {
        width: wm.boot >= 9 ? wm.width + 20 : wm.width * wm.boot / 9
        height: wm.height
        clip: wm.boot < 9

        Row {
            id: row
            spacing: Theme.sp3

            Item {
                width: 17
                height: 17
                anchors.verticalCenter: parent.verticalCenter
                BracketMark { visible: wm.px; x: 2; y: 2; color: Theme.pxShadow }
                BracketMark {
                    color: wm.px ? Theme.pxG2 : Theme.isTerminal ? Theme.accent : Theme.txt
                }
            }

            Item {
                id: word
                width: plain.implicitWidth
                height: plain.implicitHeight
                anchors.verticalCenter: parent.verticalCenter

                // Everywhere but Pixel: one line of text.
                Text {
                    id: plain
                    visible: !wm.px
                    textFormat: Text.StyledText
                    text: "Close<font color='" + (Theme.isTerminal ? Theme.accent : Theme.mut) + "'>NI</font>"
                    font.family: Theme.ui
                    font.pixelSize: 15
                    font.letterSpacing: wm.spacing
                    font.weight: wm.px ? Font.Bold : Font.Normal
                    color: Theme.txt
                }

                // Pixel: the shadow, then the green in three bands.
                Text {
                    visible: wm.px
                    x: 2; y: 2
                    text: "CloseNI"
                    font: plain.font
                    color: Theme.pxShadow
                }
                Repeater {
                    model: wm.px ? [[0, 0.34, Theme.pxG1], [0.34, 0.67, Theme.pxG2], [0.67, 1, Theme.pxG3]] : []
                    Item {
                        required property var modelData
                        y: Math.round(word.height * modelData[0])
                        width: word.width
                        height: Math.round(word.height * modelData[1]) - y
                        clip: true
                        Text {
                            y: -parent.y
                            text: "CloseNI"
                            font: plain.font
                            color: parent.modelData[2]
                        }
                    }
                }
            }

            // The block cursor, 8x14, blinking every 1.1s.
            Rectangle {
                id: cursor
                visible: wm.px
                width: 8
                height: 14
                anchors.verticalCenter: parent.verticalCenter
                color: Theme.pxG2
                property bool on: true
                opacity: on ? 1 : 0
                Timer {
                    interval: 550
                    repeat: true
                    running: cursor.visible && Theme.animate
                    onRunningChanged: if (!running) cursor.on = true
                    onTriggered: cursor.on = !cursor.on
                }
            }
        }
    }
}
