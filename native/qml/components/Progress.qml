import QtQuick
import CloseNI

/*
 * A progress bar (#builder-progress): `value` 0..1, a sunken track and a solid
 * fill. The fill advances in chunks - twelve steps over 400ms - rather than
 * sliding, as in the stylesheet; with decoration off it jumps.
 */
Rectangle {
    id: root

    property real value: 0
    property color fill: Theme.txt

    implicitHeight: 4
    implicitWidth: 120
    color: Theme.surfaceSunken
    radius: Theme.rSm
    border.width: Theme.isPixel ? 1 : 0
    border.color: Theme.lineStrong

    Rectangle {
        height: parent.height
        radius: parent.radius
        color: root.fill
        width: Math.round(parent.width * Math.max(0, Math.min(1, root.value)) / (parent.width / 12 || 1)) * (parent.width / 12)
        Behavior on width {
            enabled: Theme.decor
            NumberAnimation { duration: Theme.durSlow }
        }
    }
}
