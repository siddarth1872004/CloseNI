import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import CloseNI

/*
 * #recent-list: projects opened before, newest first, each with its build
 * progress and an "x" to forget it (the folder is not touched). Clicking one
 * restores it; nothing runs until asked.
 */
ColumnLayout {
    id: list

    visible: AppState.recentWorkspaces.length > 0
    spacing: 2
    Layout.bottomMargin: Theme.sp2 - 6

    Repeater {
        model: AppState.recentWorkspaces
        AbstractButton {
            id: row
            required property string modelData
            readonly property bool active: modelData === AppState.workspace
            Layout.fillWidth: true
            hoverEnabled: true
            focusPolicy: Qt.StrongFocus
            padding: 4
            leftPadding: 6
            rightPadding: 6
            implicitHeight: content.implicitHeight + topPadding + bottomPadding
            onClicked: if (!active) AppState.openWorkspace(modelData)
            ToolTip.visible: hovered && !forget.hovered
            ToolTip.delay: 600
            ToolTip.text: modelData

            contentItem: RowLayout {
                id: content
                spacing: 6
                Text {
                    Layout.fillWidth: true
                    text: AppState.pathTail(row.modelData)
                    elide: Text.ElideRight
                    font.family: Theme.ui
                    font.pixelSize: 11
                    color: Theme.txt
                }
                Text {
                    text: AppState.recentState(row.modelData)
                    visible: text !== ""
                    font.family: Theme.ui
                    font.pixelSize: 10
                    color: Theme.mut
                }
                AbstractButton {
                    id: forget
                    hoverEnabled: true
                    implicitWidth: 12
                    implicitHeight: 12
                    onClicked: AppState.forgetWorkspace(row.modelData)
                    ToolTip.visible: hovered
                    ToolTip.delay: 600
                    ToolTip.text: "Forget this workspace (the folder is not touched)"
                    contentItem: Text {
                        text: "x"
                        horizontalAlignment: Text.AlignHCenter
                        verticalAlignment: Text.AlignVCenter
                        font.pixelSize: 10
                        color: forget.hovered ? Theme.txt : Theme.mut
                    }
                }
            }
            background: Rectangle {
                radius: Theme.rMd
                color: row.active || row.hovered ? Theme.surfaceSunken : "transparent"
                border.width: 1
                border.color: row.visualFocus ? Theme.lineFocus : row.active ? Theme.line : "transparent"
            }
        }
    }
}
