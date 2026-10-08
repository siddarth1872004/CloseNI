import QtQuick
import CloseNI

/*
 * The theme's static decoration (#app::before): a tiled scanline or grid
 * image over everything, input passing through - or, on Pixel, a three-layer
 * starfield placed behind the content (`behind`) that twinkles in four steps
 * every 7s while decoration is on. Nothing is drawn, and nothing ticks, when
 * the theme has no texture or decoration is off.
 *
 * Use two: one with `behind: true` first in the window and one last.
 */
Item {
    id: tex

    property bool behind: false
    readonly property string name: Theme.texture
    readonly property bool stars: name === "stars"

    visible: name !== "" && stars === behind
    enabled: false

    Image {
        anchors.fill: parent
        visible: !tex.stars && tex.visible
        source: !tex.behind && !tex.stars && tex.name !== "" ? Theme.asset(tex.name) : ""
        fillMode: Image.Tile
        smooth: false
        cache: true
    }

    // px-twinkle: .55 -> 1 -> .35 -> .55, stepped.
    property int phase: 0
    opacity: stars ? [0.55, 0.78, 1, 0.35][phase] : 1
    Timer {
        interval: 1750
        repeat: true
        running: tex.stars && tex.visible && Theme.animate
        onRunningChanged: if (!running) tex.phase = 0
        onTriggered: tex.phase = (tex.phase + 1) % 4
    }
    Repeater {
        model: tex.stars && tex.behind ? 3 : 0
        Image {
            required property int index
            anchors.fill: parent
            source: Theme.asset("stars-" + (index + 1))
            fillMode: Image.Tile
            smooth: false
        }
    }
}
