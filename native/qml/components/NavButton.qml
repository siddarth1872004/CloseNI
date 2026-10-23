import QtQuick
import QtQuick.Controls.Basic
import CloseNI

/*
 * A rail nav button (.nav-btn) or settings tab (.settings-tab): a 2px left
 * bar, a raised ground on hover and when active, and an optional number.
 * Terminal marks the active one in the accent, Pixel in green.
 */
AbstractButton {
    id: control

    property string num: ""
    property bool active: false
    property int textSize: num !== "" ? 13 : 12

    hoverEnabled: true
    focusPolicy: Qt.StrongFocus
    leftPadding: num !== "" ? 10 : Theme.sp4
    rightPadding: leftPadding
    topPadding: num !== "" ? 7 : Theme.sp3
    bottomPadding: topPadding
    implicitWidth: contentItem.implicitWidth + leftPadding + rightPadding
    implicitHeight: contentItem.implicitHeight + topPadding + bottomPadding

    // The stepped press: 1px down in two steps over .06s; letting go is instant.
    onDownChanged: if (down) Pix.press.play()
    transform: Translate { y: control.down ? Pix.press.t : 0 }

    contentItem: Row {
        spacing: 10
        Text {
            visible: control.num !== ""
            anchors.baseline: label.baseline
            text: control.num
            font.family: Theme.mono
            font.pixelSize: 10
            color: control.active ? Theme.activeMark
                 : control.hovered && Theme.isPixel ? Theme.pxBlue : Theme.mut
        }
        Text {
            id: label
            text: control.text
            font.family: Theme.ui
            font.pixelSize: control.textSize
            color: control.active || control.hovered ? Theme.txt : Theme.dim
        }
    }

    background: Item {
        Rectangle {
            id: ground
            anchors.fill: parent
            color: control.active || control.hovered ? Theme.surfaceRaised : "transparent"
        }
        Rectangle {
            width: 2
            height: parent.height
            color: control.active ? Theme.activeMark : "transparent"
        }
        FocusRing { target: ground; shown: control.visualFocus }
    }
}
