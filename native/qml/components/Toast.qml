import QtQuick
import CloseNI

/*
 * One toast (.toast): panel ground, a strong edge with a 2px left bar, mono
 * 11px. Errors take the error ground and an "x " prefix. It slides in (four
 * steps, 0.2s, decorated themes only), fades at 3.5s and asks to be removed
 * at 3.9s - two one-shot timers, nothing that runs once it is gone.
 */
Item {
    id: toast

    property string msg: ""
    property string kind: ""
    signal expired()

    readonly property bool isErr: kind === "err"
    readonly property int bar: Theme.isPixel ? 3 : 2

    implicitWidth: Math.min(label.implicitWidth, 360) + 28 + bar
    implicitHeight: label.implicitHeight + 20

    Shadow { target: face; level: 1; hard: Theme.isPixel ? 3 : 0; radius: face.radius }
    Rectangle {
        id: face
        width: parent.width
        height: parent.height
        radius: Theme.rMd
        color: toast.isErr ? Theme.errBg : Theme.panel
        border.width: 1
        border.color: Theme.lineStrong
        // The left bar sits over the border, square like the CSS one.
        Rectangle {
            width: toast.bar
            height: parent.height
            color: toast.isErr ? Theme.errLine : Theme.isPixel ? Theme.pxG2 : Theme.txt
        }
        Text {
            id: label
            x: 14 + toast.bar
            y: 10
            width: Math.min(implicitWidth, 360)
            text: (toast.isErr ? "x " : "") + toast.msg
            wrapMode: Text.Wrap
            font.family: Theme.mono
            font.pixelSize: 11
            font.letterSpacing: 0.66
            color: Theme.txt
        }
    }

    // Arrival: pix-slide, 10px from the right in four steps.
    property int slide: Theme.decor ? 4 : 0
    transform: Translate { x: toast.slide * 2.5 }
    property real fade: 1
    opacity: (1 - toast.slide / 4) * fade
    Timer {
        interval: 50
        repeat: true
        running: toast.slide > 0
        onTriggered: toast.slide--
    }

    Behavior on fade { NumberAnimation { duration: 300 } }
    Timer { interval: 3500; running: true; onTriggered: { toast.slide = 0; toast.fade = 0 } }
    Timer { interval: 3900; running: true; onTriggered: toast.expired() }
}
