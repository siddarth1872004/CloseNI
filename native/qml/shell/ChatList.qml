import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import CloseNI
import "../js/renderer-logic.mjs" as R

/*
 * The workspace's chats, newest first, with the open one marked. Clicking one
 * opens it with its messages and plan; the pencil renames it in place and the
 * "x" removes it from the list, after a second click to confirm (the thread on
 * the provider's site is not touched). Nothing changes while a reply, a build
 * or a Code turn is using the thread: AppState says why instead.
 */
ColumnLayout {
    id: list

    spacing: 2
    // The url being renamed or awaiting a delete confirmation.
    property string editing: ""
    property string confirming: ""
    readonly property string busyReason: AppState.chatBusyReason()

    // Newest first, each with its place in AppState.chats for its fallback title.
    readonly property var rows: {
        var out = []
        for (var i = AppState.chats.length - 1; i >= 0; i--)
            out.push({ url: AppState.chats[i].url, title: AppState.chatTitle(AppState.chats[i], i),
                       when: R.shortWhen(AppState.chats[i].createdAt) })
        return out
    }

    // A new chat that has not been sent to yet: shown so the open chat is
    // always marked somewhere.
    Text {
        visible: AppState.activeChat === ""
        Layout.fillWidth: true
        leftPadding: 6
        text: AppState.chatHistory.length ? "New chat (not saved by the provider yet)" : "New chat"
        elide: Text.ElideRight
        font.family: Theme.ui
        font.pixelSize: 11
        color: Theme.txt
        Rectangle {
            anchors.fill: parent
            z: -1
            radius: Theme.rMd
            color: Theme.surfaceSunken
            border.width: 1
            border.color: Theme.line
        }
        topPadding: 4
        bottomPadding: 4
    }

    Repeater {
        model: list.rows
        AbstractButton {
            id: row
            required property var modelData
            readonly property bool active: modelData.url === AppState.activeChat
            readonly property bool renaming: list.editing === modelData.url
            readonly property bool confirm: list.confirming === modelData.url
            Layout.fillWidth: true
            hoverEnabled: true
            focusPolicy: Qt.StrongFocus
            padding: 4
            leftPadding: 6
            rightPadding: 6
            implicitHeight: content.implicitHeight + topPadding + bottomPadding
            onClicked: if (!active && !renaming) AppState.switchChat(modelData.url)
            ToolTip.visible: hovered && !active && list.busyReason !== "" && !rename.hovered && !remove.hovered
            ToolTip.delay: 400
            ToolTip.text: list.busyReason

            contentItem: RowLayout {
                id: content
                spacing: 6
                Text {
                    visible: !row.renaming
                    Layout.fillWidth: true
                    text: row.confirm ? "Remove \"" + row.modelData.title + "\"?" : row.modelData.title
                    elide: Text.ElideRight
                    font.family: Theme.ui
                    font.pixelSize: 11
                    font.bold: row.active
                    color: row.confirm ? Theme.err : Theme.txt
                }
                Field {
                    id: field
                    visible: row.renaming
                    Layout.fillWidth: true
                    topPadding: 3
                    bottomPadding: 3
                    font.pixelSize: 11
                    onAccepted: { AppState.renameChat(row.modelData.url, text); list.editing = "" }
                    Keys.onEscapePressed: list.editing = ""
                    onActiveFocusChanged: if (!activeFocus && row.renaming) list.editing = ""
                }
                Text {
                    visible: !row.renaming && !row.confirm && !row.hovered && text !== ""
                    text: row.modelData.when
                    font.family: Theme.ui
                    font.pixelSize: 10
                    color: Theme.mut
                }
                AbstractButton {
                    id: rename
                    visible: (row.hovered || row.visualFocus) && !row.renaming && !row.confirm
                    hoverEnabled: true
                    implicitWidth: 14
                    implicitHeight: 12
                    onClicked: {
                        list.confirming = ""
                        list.editing = row.modelData.url
                        field.text = row.modelData.title
                        field.selectAll()
                        field.forceActiveFocus()
                    }
                    ToolTip.visible: hovered
                    ToolTip.delay: 600
                    ToolTip.text: "Rename"
                    contentItem: Text {
                        text: "✎"
                        horizontalAlignment: Text.AlignHCenter
                        verticalAlignment: Text.AlignVCenter
                        font.pixelSize: 10
                        color: rename.hovered ? Theme.txt : Theme.mut
                    }
                }
                AbstractButton {
                    id: remove
                    visible: (row.hovered || row.visualFocus || row.confirm) && !row.renaming
                    hoverEnabled: true
                    implicitWidth: row.confirm ? 40 : 12
                    implicitHeight: 12
                    onClicked: {
                        if (!row.confirm) { list.confirming = row.modelData.url; return }
                        list.confirming = ""
                        AppState.deleteChat(row.modelData.url)
                    }
                    ToolTip.visible: hovered && !row.confirm
                    ToolTip.delay: 600
                    ToolTip.text: "Remove from this list (the provider keeps its copy)"
                    contentItem: Text {
                        text: row.confirm ? "remove" : "x"
                        horizontalAlignment: Text.AlignHCenter
                        verticalAlignment: Text.AlignVCenter
                        font.pixelSize: 10
                        color: row.confirm ? Theme.err : remove.hovered ? Theme.txt : Theme.mut
                    }
                }
            }
            // Moving off a row drops its pending delete.
            onHoveredChanged: if (!hovered && confirm) list.confirming = ""
            background: Rectangle {
                radius: Theme.rMd
                color: row.active || row.hovered ? Theme.surfaceSunken : "transparent"
                border.width: 1
                border.color: row.visualFocus ? Theme.lineFocus : row.active ? Theme.line : "transparent"
            }
        }
    }
}
