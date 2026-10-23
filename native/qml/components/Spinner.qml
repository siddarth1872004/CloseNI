import QtQuick
import CloseNI

/*
 * .pix-spin: a stepped | / - \ after busy text, four frames in 0.6s. It ticks
 * only while `running`, visible and decorated; otherwise it is a static bar
 * and costs nothing.
 */
Text {
    id: spin

    property bool running: true
    property int frame: 0
    readonly property var frames: ["|", "/", "-", "\\"]

    text: frames[frame]
    font.family: Theme.mono
    font.pixelSize: 12
    color: Theme.mut
    width: Math.max(implicitWidth, contentHeight * 0.6)

    Timer {
        interval: 150
        repeat: true
        running: spin.running && spin.visible && Theme.animate
        onRunningChanged: if (!running) spin.frame = 0
        onTriggered: spin.frame = (spin.frame + 1) % 4
    }
}
