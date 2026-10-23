import QtQuick
import CloseNI

/*
 * The keyboard focus ring: a 2px gap in the page colour, then a 2px ring in
 * --line-focus, so it reads against any theme. Shown for keyboard focus only,
 * like :focus-visible. Place it as a sibling of `target`.
 *
 * It appears in one step (steps(1) over .06s), never fading in: Pix.ring.
 */
Rectangle {
    property Item target: null
    property bool shown: false
    property real targetRadius: 0

    visible: shown && target !== null
    opacity: Pix.ring.t
    onShownChanged: if (shown) Pix.ring.play()
    x: target ? target.x - 4 : 0
    y: target ? target.y - 4 : 0
    width: target ? target.width + 8 : 0
    height: target ? target.height + 8 : 0
    radius: targetRadius > 0 ? targetRadius + 4 : 0
    color: "transparent"
    border.width: 2
    border.color: Theme.lineFocus

    Rectangle {
        anchors.fill: parent
        anchors.margins: 2
        radius: Math.max(0, parent.radius - 2)
        color: "transparent"
        border.width: 2
        border.color: Theme.bg
    }
}
