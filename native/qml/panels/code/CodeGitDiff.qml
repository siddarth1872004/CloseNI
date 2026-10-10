import QtQuick
import QtQuick.Controls.Basic
import CloseNI

/*
 * .cc-out.cc-gitdiff: `git diff` or `git show` output, one line each, coloured
 * by T.gitDiffLines (add ok, del err, hunk in the mode colour, file headers
 * bold). A ListView: a diff of a whole project is long.
 */
Rectangle {
    id: out

    property var lines: []
    property int maxHeight: 320
    property color modeColor: Theme.langJava

    implicitHeight: Math.min(maxHeight, list.contentHeight + 18)
    color: Theme.surfaceSunken
    border.width: 1
    border.color: Theme.line

    ListView {
        id: list
        cacheBuffer: 0   // no async look-ahead in a Loader: ARCHITECTURE.md, Panels
        anchors.fill: parent
        anchors.leftMargin: 10
        anchors.rightMargin: 10
        anchors.topMargin: 8
        anchors.bottomMargin: 8
        clip: true
        model: out.lines
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height
        ScrollBar.vertical: ThinScrollBar {}

        delegate: Text {
            required property var modelData
            width: ListView.view.width
            text: modelData.text === "" ? " " : modelData.text
            textFormat: Text.PlainText
            wrapMode: Text.WrapAtWordBoundaryOrAnywhere
            font.family: Theme.mono
            font.pixelSize: 12
            font.weight: modelData.cls === "meta" ? Font.DemiBold : Font.Normal
            lineHeight: 18; lineHeightMode: Text.FixedHeight
            color: modelData.cls === "add" ? Theme.ok : modelData.cls === "del" ? Theme.err
                 : modelData.cls === "hunk" ? out.modeColor : modelData.cls === "meta" ? Theme.txt : Theme.dim
        }
    }
}
