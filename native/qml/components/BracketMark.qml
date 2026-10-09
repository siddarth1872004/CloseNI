import QtQuick
import CloseNI

/*
 * The CloseNI mark: "][" from the wordmark's SVG (viewBox 32, stroke 2.8,
 * square caps), drawn with six rectangles so it needs no Shapes module.
 * `stroke` is in viewBox units: Settings' About draws it at 2.4.
 */
Item {
    id: mark

    property color color: Theme.txt
    property real size: 17
    property real stroke: 2.8
    readonly property real k: size / 32
    readonly property real sw: stroke * k

    implicitWidth: size
    implicitHeight: size

    // ]: M7 6 H13 V26 H7    [: M25 6 H19 V26 H25
    Repeater {
        model: [
            [7, 6, 13, 6], [13, 6, 13, 26], [7, 26, 13, 26],
            [19, 6, 25, 6], [19, 6, 19, 26], [19, 26, 25, 26]
        ]
        Rectangle {
            required property var modelData
            x: (modelData[0] - mark.stroke / 2) * mark.k
            y: (modelData[1] - mark.stroke / 2) * mark.k
            width: (modelData[2] - modelData[0]) * mark.k + mark.sw
            height: (modelData[3] - modelData[1]) * mark.k + mark.sw
            color: mark.color
        }
    }
}
