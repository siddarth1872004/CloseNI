import QtQuick
import CloseNI

/*
 * --shadow-1 / --shadow-2 without a blur shader: three translucent layers
 * offset downward, each wider and fainter. Static, so it costs three
 * rectangles and no GPU pass. Pixel uses its hard offset shadow instead
 * (`hard`, in px). Place it as a sibling declared before `target`.
 */
Item {
    id: root

    property Item target: null
    property int level: 1          // 1: 0 4px 20px, 2: 0 12px 40px
    property int hard: 0           // Pixel: a solid offset of this many px
    property real radius: 0

    readonly property color tint: level === 2 ? Theme.shadow2 : Theme.shadow1
    readonly property int drop: level === 2 ? 12 : 4
    readonly property int spread: level === 2 ? 14 : 7

    visible: target !== null && target.visible && Theme.hasShadow
    x: target ? target.x : 0
    y: target ? target.y : 0
    width: target ? target.width : 0
    height: target ? target.height : 0

    Rectangle {
        visible: root.hard > 0
        x: root.hard; y: root.hard
        width: parent.width; height: parent.height
        color: Theme.pxShadow
    }
    Repeater {
        model: root.hard > 0 ? 0 : 3
        Rectangle {
            required property int index
            readonly property int grow: Math.round(root.spread * (index + 1) / 3)
            x: -grow
            y: root.drop - grow + index
            width: root.width + grow * 2
            height: root.height + grow * 2
            radius: root.radius + grow
            color: root.tint
            opacity: [0.45, 0.25, 0.12][index]
        }
    }
}
