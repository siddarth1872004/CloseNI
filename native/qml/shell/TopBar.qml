import QtQuick
import QtQuick.Layouts
import CloseNI

/*
 * #topbar: "← Agent" away from the agent, the mode title, the flow bar in the
 * planned-build panels, and the status line. A rule underneath; on Pixel a
 * raised title bar with three chrome squares and " // CLOSENI".
 */
Item {
    id: top

    implicitHeight: row.implicitHeight + (Theme.isPixel ? 16 : 10)

    Rectangle {
        visible: Theme.isPixel
        x: 3; y: 3; width: parent.width; height: parent.height
        color: Theme.pxShadow
    }
    Rectangle {
        visible: Theme.isPixel
        anchors.fill: parent
        color: Theme.surfaceRaised
        border.width: 1
        border.color: Theme.lineStrong
    }
    Rectangle {
        visible: !Theme.isPixel
        anchors.bottom: parent.bottom
        width: parent.width
        height: 1
        color: Theme.line
    }

    RowLayout {
        id: row
        x: Theme.isPixel ? 12 : 0
        y: Theme.isPixel ? 8 : 0
        width: parent.width - x * 2
        spacing: Theme.sp4

        Btn {
            visible: AppState.mode !== "code"
            small: true
            text: "← Agent"
            tip: "Back to the agent"
            onClicked: AppState.switchTab("code")
        }

        Row {
            visible: Theme.isPixel
            spacing: 4
            Layout.rightMargin: 40 - Theme.sp4
            Repeater { model: 3; Rectangle { width: 8; height: 8; color: Theme.pxChrome } }
        }
        Text {
            id: title
            text: AppState.modeTitle + (Theme.isPixel ? "<font color='" + Theme.mut + "'> // CLOSENI</font>" : "")
            textFormat: Text.StyledText
            font.family: Theme.mono
            font.pixelSize: 11
            font.letterSpacing: 1.98
            color: Theme.dim
        }

        FlowBar {
            id: flow
            visible: AppState.flowVisible
            compact: top.width < 1180 - 210 - 36
            Layout.fillWidth: true
            Layout.minimumWidth: 0
        }
        Item { visible: !flow.visible; Layout.fillWidth: true }

        Text {
            Layout.maximumWidth: Math.max(80, top.width * 0.4)
            text: AppState.statusText
            elide: Text.ElideRight
            font.family: Theme.ui
            font.pixelSize: 11
            color: Theme.isPixel ? Theme.pxG2 : Theme.mut
            style: Theme.hasGlow ? Text.Outline : Text.Normal
            styleColor: Theme.glow
        }
    }
}
