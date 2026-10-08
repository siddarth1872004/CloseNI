import QtQuick
import QtQuick.Controls.Basic
import CloseNI

/*
 * A multi-line input (textarea): the field's look, scrolling inside its own
 * height. `text`, `placeholderText` and `area` (the TextArea) are exposed.
 */
ScrollView {
    id: root

    property alias text: area.text
    property alias placeholderText: area.placeholderText
    property alias readOnly: area.readOnly
    property alias area: area
    property bool sunken: false

    implicitWidth: 240
    implicitHeight: 80
    clip: true
    ScrollBar.vertical: ThinScrollBar {
        parent: root
        x: root.width - width - 1
        y: 1
        height: root.height - 2
    }
    ScrollBar.horizontal.policy: ScrollBar.AlwaysOff

    TextArea {
        id: area

        font.family: Theme.mono
        font.pixelSize: Theme.inputSize
        color: Theme.txt
        placeholderTextColor: Theme.mut
        selectionColor: Theme.lineFocus
        selectedTextColor: Theme.inverse
        wrapMode: TextEdit.Wrap
        leftPadding: 10
        rightPadding: 10
        topPadding: 9
        bottomPadding: 9
        selectByMouse: true
        background: null
    }

    background: Item {
        Rectangle {
            id: box
            anchors.fill: parent
            radius: Theme.rMd
            color: root.sunken ? Theme.surfaceSunken : Theme.surface
            border.width: 1
            border.color: area.activeFocus ? (Theme.isPixel ? Theme.pxBlue : Theme.dim) : Theme.lineStrong
        }
        FocusRing {
            target: box
            targetRadius: box.radius
            shown: area.activeFocus && area.focusReason === Qt.TabFocusReason
        }
    }
}
