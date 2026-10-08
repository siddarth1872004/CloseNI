import QtQuick
import QtQuick.Controls.Basic
import CloseNI

/*
 * The scrollbar: thin and quiet, visible while there is something to scroll.
 * Pixel draws it square on a sunken track, like its ::-webkit-scrollbar rules.
 */
ScrollBar {
    id: bar

    padding: Theme.isPixel ? 2 : 1
    minimumSize: 0.08
    policy: size < 1 ? ScrollBar.AsNeeded : ScrollBar.AlwaysOff

    contentItem: Rectangle {
        implicitWidth: Theme.isPixel ? 6 : 5
        implicitHeight: Theme.isPixel ? 6 : 5
        radius: Theme.square ? 0 : 3
        color: Theme.isPixel && (bar.hovered || bar.pressed) ? Theme.pxG3
             : bar.pressed || bar.hovered ? Theme.mut : Theme.lineStrong
        opacity: bar.policy === ScrollBar.AlwaysOn || bar.active || Theme.isPixel ? 1 : 0.6
    }
    background: Rectangle {
        visible: Theme.isPixel
        color: Theme.surfaceSunken
    }
}
