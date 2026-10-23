import QtQuick
import QtQuick.Controls.Basic
import CloseNI

/*
 * An on/off switch with its label. Square on Pixel, a flat track elsewhere;
 * the knob moves in steps like the CSS transitions, never a slide.
 */
Switch {
    id: control

    spacing: Theme.sp3
    padding: 0
    hoverEnabled: true
    font.family: Theme.ui
    font.pixelSize: Theme.hintSize

    indicator: Rectangle {
        id: track
        implicitWidth: 26
        implicitHeight: 14
        x: control.leftPadding
        y: control.topPadding + (control.availableHeight - height) / 2
        radius: Theme.square ? 0 : height / 2
        color: control.checked ? Theme.okBg : Theme.surfaceSunken
        border.width: 1
        border.color: control.checked ? Theme.okLine : (control.hovered ? Theme.txt : Theme.lineStrong)

        Rectangle {
            width: 8
            height: 8
            radius: Theme.square ? 0 : 4
            y: 3
            x: control.checked ? parent.width - width - 3 : 3
            color: control.checked ? Theme.ok : Theme.mut
        }
        FocusRing { target: track; targetRadius: track.radius; shown: control.visualFocus }
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
