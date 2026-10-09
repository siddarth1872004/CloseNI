import QtQuick
import QtQuick.Controls.Basic
import CloseNI

/*
 * A checkbox with its label: 11px dim text, the box drawn in the theme's text
 * colour (accent-color:var(--txt) in the CSS).
 */
CheckBox {
    id: control

    spacing: Theme.sp2
    padding: 0
    hoverEnabled: true
    font.family: Theme.ui
    font.pixelSize: Theme.hintSize

    indicator: Rectangle {
        id: box
        implicitWidth: 13
        implicitHeight: 13
        x: control.leftPadding
        y: control.topPadding + (control.availableHeight - height) / 2
        radius: Theme.square ? 0 : 2
        color: control.checked ? Theme.txt : Theme.surface
        border.width: 1
        border.color: control.checked || control.hovered ? Theme.txt : Theme.lineStrong

        // The tick, as two strokes: cheaper than an icon and themed for free.
        Item {
            visible: control.checked
            anchors.fill: parent
            Rectangle { x: 2.5; y: 6; width: 4; height: 1.6; rotation: 45; color: Theme.inverse; antialiasing: true }
            Rectangle { x: 4.5; y: 5; width: 7; height: 1.6; rotation: -50; color: Theme.inverse; antialiasing: true }
        }
        FocusRing { target: box; targetRadius: box.radius; shown: control.visualFocus }
    }

    contentItem: Text {
        text: control.text
        font: control.font
        color: control.hovered ? Theme.txt : Theme.dim
        verticalAlignment: Text.AlignVCenter
        leftPadding: control.indicator.width + control.spacing
        wrapMode: Text.Wrap
    }
}
