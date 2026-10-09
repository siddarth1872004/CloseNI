import QtQuick
import CloseNI

/*
 * A progress bar (#builder-progress-wrap and #builder-progress): `value` 0..1,
 * a sunken track in a thin frame, and the fill inside it. The fill advances in
 * chunks - twelve steps over 400ms - rather than sliding, as in the
 * stylesheet; with decoration off or reduced motion it jumps.
 *
 * Pixel: the README's BUILD bar - a 2px frame, and the fill drawn as 8px
 * blocks with 2px gaps rather than one solid bar.
 */
Rectangle {
    id: root

    property real value: 0
    property color fill: Theme.txt

    implicitHeight: 4
    implicitWidth: 120
    color: Theme.surfaceSunken
    radius: Theme.rSm
    border.width: Theme.isPixel ? 2 : 1
    border.color: Theme.isPixel ? Theme.lineStrong : Theme.line

    Item {
        id: track
        x: root.border.width
        y: root.border.width
        width: root.width - root.border.width * 2
        height: root.height - root.border.width * 2
        clip: true

        Rectangle {
            id: bar
            height: parent.height
            radius: Math.max(0, root.radius - root.border.width)
            color: Theme.isPixel ? "transparent" : root.fill
            clip: Theme.isPixel
            width: Math.round(parent.width * Math.max(0, Math.min(1, root.value)) / (parent.width / 12 || 1)) * (parent.width / 12)
            Behavior on width {
                enabled: Theme.motion
                NumberAnimation { duration: Theme.durSlow }
            }
            Row {
                visible: Theme.isPixel
                spacing: 2
                Repeater {
                    model: Theme.isPixel ? Math.ceil(track.width / 10) : 0
                    Rectangle { width: 8; height: bar.height; color: root.fill }
                }
            }
        }
    }
}
