import QtQuick
import QtQuick.Controls.Basic
import CloseNI

/*
 * A one-line input: surface ground, line-strong edge, monospace 12px, 9/10
 * padding. Focus turns the edge dim (Pixel: blue); keyboard focus adds the ring.
 */
TextField {
    id: control

    property bool sunken: false

    font.family: Theme.mono
    font.pixelSize: Theme.inputSize
    color: Theme.txt
    placeholderTextColor: Theme.mut
    selectionColor: Theme.lineFocus
    selectedTextColor: Theme.inverse
    leftPadding: 10
    rightPadding: 10
    topPadding: 9
    bottomPadding: 9
    selectByMouse: true
    onActiveFocusChanged: if (activeFocus) Pix.ring.play()

    background: Item {
        implicitWidth: 160
        Rectangle {
            id: box
            anchors.fill: parent
            radius: Theme.rMd
            color: control.sunken ? Theme.surfaceSunken : Theme.surface
            border.width: 1
            // Focus marks the edge in one step too (steps(1) over .06s).
            border.color: control.activeFocus && Pix.ring.t >= 1 ? (Theme.isPixel ? Theme.pxBlue : Theme.dim) : Theme.lineStrong
        }
        FocusRing {
            target: box
            targetRadius: box.radius
            shown: control.activeFocus && control.focusReason === Qt.TabFocusReason
        }
    }
}
