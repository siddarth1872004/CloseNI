import QtQuick
import QtQuick.Layouts
import CloseNI

/*
 * A card: the rail cards and the panels' bordered boxes. Children stack in a
 * column with a 6px gap under an optional micro heading.
 *
 * Pixel: panel ground, line-strong edge, a 3px top border cycling green,
 * blue, purple, amber, red by `index`, a hard 3px shadow, and three chrome
 * squares before the heading. Terminal leaves rail cards unfilled.
 */
Item {
    id: card

    property string title: ""
    property int index: 0
    property int padding: Theme.sp3
    property int spacing: 6
    // "surface" (rail cards), "panel" (panel boxes) or "none".
    property string ground: "surface"
    property int radius: Theme.rMd
    default property alias content: body.data

    implicitWidth: body.implicitWidth + padding * 2
    implicitHeight: body.implicitHeight + padding * 2 + topEdge

    readonly property int topEdge: Theme.isPixel ? 2 : 0

    Rectangle {
        visible: Theme.isPixel
        x: 3; y: 3; width: parent.width; height: parent.height
        color: Theme.pxShadow
    }
    Rectangle {
        anchors.fill: parent
        radius: card.radius
        color: Theme.isPixel ? Theme.panel
             : card.ground === "none" || (card.ground === "surface" && Theme.isTerminal) ? "transparent"
             : card.ground === "panel" ? Theme.panel : Theme.surface
        border.width: 1
        border.color: Theme.isPixel ? Theme.lineStrong : Theme.line
    }
    Rectangle {
        visible: Theme.isPixel
        width: parent.width; height: 3
        color: Theme.pxCycle(card.index)
    }

    ColumnLayout {
        id: body
        x: card.padding
        y: card.padding + card.topEdge
        width: card.width - card.padding * 2
        spacing: card.spacing

        RowLayout {
            visible: card.title !== ""
            spacing: 0
            Layout.bottomMargin: 2
            Row {
                visible: Theme.isPixel
                spacing: 3
                Layout.rightMargin: 8
                Repeater { model: 3; Rectangle { width: 6; height: 6; color: Theme.pxChrome } }
            }
            Micro { text: card.title; Layout.fillWidth: true }
        }
    }
}
