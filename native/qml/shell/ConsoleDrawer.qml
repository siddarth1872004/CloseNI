import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import CloseNI

/*
 * The console drawer (#console): a bar that counts what arrived while closed,
 * and, open, the agent and project logs side by side, 160px tall. An error
 * opens it (Notify._arrived); open or closed is remembered.
 */
ColumnLayout {
    id: drawer

    spacing: Theme.sp2

    property bool everOpened: false
    Component.onCompleted: everOpened = Notify.consoleOpen
    Connections {
        target: Notify
        function onConsoleOpenChanged() { if (Notify.consoleOpen) drawer.everOpened = true }
    }

    AbstractButton {
        id: bar
        Layout.fillWidth: true
        hoverEnabled: true
        focusPolicy: Qt.StrongFocus
        leftPadding: 10; rightPadding: 10; topPadding: 6; bottomPadding: 6
        implicitHeight: barRow.implicitHeight + topPadding + bottomPadding
        onClicked: Notify.setConsole(!Notify.consoleOpen, true)
        Accessible.name: "Console"
        Accessible.checkable: true
        Accessible.checked: Notify.consoleOpen

        readonly property color fg: hovered ? Theme.txt : Theme.dim

        contentItem: RowLayout {
            id: barRow
            spacing: Theme.sp3
            Text {
                visible: Theme.isPixel
                text: "$"
                font.family: Theme.mono
                font.pixelSize: 10
                color: Theme.pxG2
            }
            // The caret: a small triangle, pointing down when open.
            Text {
                text: "▶"
                font.pixelSize: 7
                color: bar.fg
                rotation: Notify.consoleOpen ? 90 : 0
            }
            Text {
                text: "Console"
                font.family: Theme.mono
                font.pixelSize: 10
                font.letterSpacing: 1.4
                font.capitalization: Font.AllUppercase
                color: bar.fg
            }
            Text {
                text: "agent · project"
                font.family: Theme.mono
                font.pixelSize: 10
                font.letterSpacing: 0.8
                color: Theme.mut
            }
            Item { Layout.fillWidth: true }
            Rectangle {
                visible: Notify.unreadText !== ""
                implicitWidth: unread.implicitWidth + 12
                implicitHeight: unread.implicitHeight + 4
                radius: Theme.rSm
                color: Theme.isPixel ? Theme.pxG2 : Theme.txt
                Text {
                    id: unread
                    anchors.centerIn: parent
                    text: Notify.unreadText
                    font.family: Theme.mono
                    font.pixelSize: 10
                    color: Theme.inverse
                }
            }
        }

        background: Item {
            Rectangle {
                visible: Theme.isPixel
                x: 3; y: 3; width: parent.width; height: parent.height
                color: Theme.pxShadow
            }
            Rectangle {
                anchors.fill: parent
                radius: Theme.rMd
                color: Theme.isPixel ? Theme.surfaceRaised : "transparent"
                border.width: 1
                border.color: bar.visualFocus ? Theme.lineFocus
                            : bar.hovered || Theme.isPixel ? Theme.lineStrong : Theme.line
            }
        }
    }

    // Created on first open and kept: reopening must not lose the scroll.
    Loader {
        Layout.fillWidth: true
        Layout.preferredHeight: 160
        visible: Notify.consoleOpen
        active: drawer.everOpened
        sourceComponent: RowLayout {
            spacing: 12
            Repeater {
                model: [{ title: "Agent", log: Notify.agentLog }, { title: "Project", log: Notify.projectLog }]
                ColumnLayout {
                    required property var modelData
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    Layout.preferredWidth: 1
                    spacing: 6
                    Micro { text: parent.modelData.title }
                    LogView {
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        model: parent.modelData.log
                    }
                }
            }
        }
    }
}
