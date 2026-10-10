import QtQuick
import QtQuick.Controls.Basic
import CloseNI

/*
 * A monospace log (#log, #plog): one row per line, coloured by class
 * ("" dim, "ok"/"step" txt, "err" txt bold). Bounded - `model` is a ListModel
 * of { line, cls }; append() trims it to maxLines. Follows the tail while the
 * view is scrolled to the bottom, and stops following when the user scrolls up
 * to read. The ListView only creates the rows on screen.
 */
Rectangle {
    id: root

    property ListModel model: ListModel {}
    property int maxLines: 2000

    function append(line, cls) {
        model.append({ line: String(line), cls: cls || "" })
        if (model.count > maxLines) model.remove(0, model.count - maxLines)
    }
    function clear() { model.clear() }
    // Everything, for a Copy button: the view only selects within a line.
    function text() {
        var out = []
        for (var i = 0; i < model.count; i++) out.push(model.get(i).line)
        return out.join("\n")
    }

    color: Theme.isPixel ? Theme.surfaceSunken : Theme.surface
    border.width: 1
    border.color: Theme.isPixel ? Theme.lineStrong : Theme.line
    radius: Theme.isPixel ? 0 : 4
    clip: true

    ListView {
        id: list
        cacheBuffer: 0   // no async look-ahead in a Loader: ARCHITECTURE.md, Panels
        anchors.fill: parent
        anchors.leftMargin: 10
        anchors.rightMargin: 10
        anchors.topMargin: 8
        anchors.bottomMargin: 8
        model: root.model
        boundsBehavior: Flickable.StopAtBounds
        reuseItems: true
        property bool follow: true
        onMovementEnded: follow = atYEnd
        onCountChanged: if (follow) Qt.callLater(positionViewAtEnd)
        ScrollBar.vertical: ThinScrollBar {}

        delegate: TextEdit {
            required property string line
            required property string cls
            width: ListView.view.width
            text: line
            readOnly: true
            selectByMouse: true
            wrapMode: TextEdit.Wrap
            textFormat: TextEdit.PlainText
            font.family: Theme.mono
            font.pixelSize: 11
            font.weight: cls === "err" ? Font.DemiBold : Font.Normal
            color: cls === "" ? Theme.dim : Theme.txt
            selectionColor: Theme.lineStrong
            selectedTextColor: Theme.txt
        }
    }
}
