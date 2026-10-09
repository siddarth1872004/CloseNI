import QtQuick
import QtQuick.Controls.Basic
import CloseNI

/*
 * A themed tooltip: the title= hover text of the web app. Use it as
 *   Tip { text: "..."; visible: area.containsMouse }
 * or through a control's attached ToolTip (the app sets the same look there,
 * see Main.qml).
 */
ToolTip {
    id: tip

    delay: 600
    timeout: 8000
    padding: 6
    font.family: Theme.ui
    font.pixelSize: 11

    contentItem: Text {
        text: tip.text
        font: tip.font
        color: Theme.txt
        wrapMode: Text.Wrap
    }
    background: Rectangle {
        color: Theme.surfaceRaised
        border.width: 1
        border.color: Theme.lineStrong
        radius: Theme.rMd
    }
}
