import QtQuick
import QtQuick.Controls.Basic
import CloseNI

/*
 * .btn.btn-sm as the Code panel uses it: in the mode strip, on cards and on
 * the run offer. `look` is the strip's class ("primary", "on", "off" or "");
 * `tint` is the colour primary and on take - the mode's own in the strip
 * (.cm-actions .btn.primary), the accent or err on the run offer. Btn cannot
 * take a colour, so this is its small variant with one.
 */
Btn {
    id: b

    property string look: ""
    property color tint: Theme.accent

    small: true

    contentItem: Text {
        text: b.text
        font: b.font
        horizontalAlignment: Text.AlignHCenter
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
        color: b.look === "primary" || b.look === "on" ? b.tint
             : b.look === "off" ? Theme.mut
             : b.fg
    }
    background: Item {
        implicitHeight: 22
        Rectangle {
            visible: Theme.isPixel && !b.down
            x: 2; y: 2; width: parent.width; height: parent.height
            color: Theme.pxShadow
        }
        Rectangle {
            id: face
            readonly property int push: Theme.isPixel && b.down ? 2 : 0
            x: push; y: push
            width: parent.width; height: parent.height
            radius: Theme.rMd
            color: Theme.isPixel ? Theme.bg : "transparent"
            border.width: 1
            border.color: b.look === "primary" || b.look === "on" ? b.tint
                        : b.look === "off" ? Theme.line
                        : b.edge
        }
        FocusRing { target: face; targetRadius: face.radius; shown: b.visualFocus }
    }
}
