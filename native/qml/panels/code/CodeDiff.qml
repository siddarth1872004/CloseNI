import QtQuick
import QtQuick.Controls.Basic
import CloseNI

/*
 * .cc-diff: an edit's lines, numbered, from C.numberDiff - added on the ok
 * ground, removed on the err ground, unchanged dim, and the "… N unchanged"
 * gaps in italic. A ListView, since a written file can be thousands of lines.
 * Long lines wrap rather than scroll sideways.
 */
Rectangle {
    id: diff

    property var rows: []
    property int maxHeight: 420

    implicitHeight: Math.min(maxHeight, list.contentHeight + 2)
    color: Theme.surfaceSunken
    border.width: 1
    border.color: Theme.line

    FontMetrics { id: fm; font.family: Theme.mono; font.pixelSize: 12 }

    ListView {
        id: list
        anchors.fill: parent
        anchors.margins: 1
        clip: true
        model: diff.rows
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height
        ScrollBar.vertical: ThinScrollBar {}

        delegate: Rectangle {
            id: row
            required property var modelData
            readonly property string type: modelData.type
            width: ListView.view.width
            height: tx.implicitHeight
            color: type === "add" ? Theme.okBg : type === "remove" ? Theme.errBg : "transparent"

            Text {
                id: ln
                width: fm.averageCharacterWidth * 5
                rightPadding: fm.averageCharacterWidth
                horizontalAlignment: Text.AlignRight
                text: String(row.modelData.ln)
                font: fm.font
                lineHeight: 18; lineHeightMode: Text.FixedHeight
                color: Theme.mut
            }
            Text {
                id: tx
                anchors.left: ln.right
                anchors.right: parent.right
                anchors.rightMargin: 8
                text: row.type === "gap" ? row.modelData.text : row.modelData.sign + " " + row.modelData.text
                textFormat: Text.PlainText
                wrapMode: Text.WrapAtWordBoundaryOrAnywhere
                font.family: Theme.mono
                font.pixelSize: 12
                font.italic: row.type === "gap"
                lineHeight: 18; lineHeightMode: Text.FixedHeight
                color: row.type === "add" ? Theme.ok : row.type === "remove" ? Theme.err
                     : row.type === "gap" ? Theme.mut : Theme.dim
            }
        }
    }
}
