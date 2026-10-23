import QtQuick
import QtQuick.Controls.Basic
import CloseNI

/*
 * .cc-out: a command's output, sunken, 12px dim monospace, wrapped, and
 * scrolling inside its own height past `maxHeight` (360 under a tool line,
 * 320 on a card). Selectable, so an error can be copied out.
 */
Rectangle {
    id: out

    property string text: ""
    property int maxHeight: 360
    property color textColor: Theme.dim

    implicitHeight: Math.min(maxHeight, body.implicitHeight + 18)
    color: Theme.surfaceSunken
    border.width: 1
    border.color: Theme.line
    radius: 0

    Flickable {
        id: flick
        anchors.fill: parent
        anchors.margins: 1
        clip: true
        contentWidth: width
        contentHeight: body.implicitHeight + 16
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height
        ScrollBar.vertical: ThinScrollBar {}

        TextEdit {
            id: body
            x: 10
            y: 8
            width: flick.width - 20
            text: out.text
            readOnly: true
            selectByMouse: true
            textFormat: TextEdit.PlainText
            wrapMode: TextEdit.WrapAtWordBoundaryOrAnywhere
            font.family: Theme.mono
            font.pixelSize: 12
            color: out.textColor
            selectionColor: Theme.lineFocus
            selectedTextColor: Theme.inverse
        }
    }
}
