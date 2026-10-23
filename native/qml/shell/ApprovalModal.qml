import QtQuick
import QtQuick.Layouts
import CloseNI

/*
 * #approval-modal: the agent asks before running a command. Opens on
 * Agent.approvalRequest; Allow and Deny answer through
 * Agent.respondApproval. Nothing else closes it - the agent is waiting.
 */
Modal {
    id: modal

    property string command: ""

    cardWidth: 520

    function ask(req) {
        command = req && req.command !== undefined ? String(req.command) : ""
        open()
    }
    function answer(yes) {
        close()
        Agent.respondApproval(yes)
    }

    Connections {
        target: Agent
        function onApprovalRequest(req) { modal.ask(req) }
    }

    contentItem: ColumnLayout {
        spacing: 0
        Micro { text: "Permission Required" }
        Text {
            Layout.topMargin: 8
            Layout.bottomMargin: 4
            text: "The agent wants to run:"
            font.family: Theme.ui
            font.pixelSize: 12
            color: Theme.dim
        }
        Rectangle {
            Layout.fillWidth: true
            Layout.topMargin: 8
            Layout.bottomMargin: 14
            implicitHeight: cmd.implicitHeight + 20
            color: Theme.surface
            radius: Theme.isPixel ? 0 : 4
            border.width: 1
            border.color: Theme.line
            TextEdit {
                id: cmd
                x: 10; y: 10
                width: parent.width - 20
                text: modal.command
                readOnly: true
                selectByMouse: true
                wrapMode: TextEdit.Wrap
                textFormat: TextEdit.PlainText
                font.family: Theme.mono
                font.pixelSize: 12
                color: Theme.txt
                selectionColor: Theme.lineStrong
            }
        }
        RowLayout {
            spacing: 8
            Btn { text: "Allow"; variant: "invert"; onClicked: modal.answer(true) }
            Btn { text: "Deny"; onClicked: modal.answer(false) }
        }
    }
}
