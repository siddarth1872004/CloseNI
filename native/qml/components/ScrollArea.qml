import QtQuick
import QtQuick.Controls.Basic
import CloseNI

/*
 * A vertically scrolling area for panel content. Children go in as usual and
 * the width follows the view, so a Column inside wraps instead of scrolling
 * sideways.
 */
ScrollView {
    id: root

    clip: true
    contentWidth: availableWidth
    ScrollBar.vertical: ThinScrollBar {
        parent: root
        x: root.mirrored ? 0 : root.width - width
        y: root.topPadding
        height: root.availableHeight
        active: root.ScrollBar.horizontal.active
    }
    ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
}
