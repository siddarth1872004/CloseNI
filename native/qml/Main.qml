import QtQuick
import QtQuick.Controls
import QtQuick.Dialogs
import QtQuick.Layouts
import CloseNI

/*
 * Phase 0: pick a folder and a provider, start the agent session, and show
 * that it came up. The Code panel replaces the log in phase 1.
 */
ApplicationWindow {
    id: window

    required property string workspace
    required property string provider
    required property bool autoStart

    width: 1000
    height: 680
    visible: true
    title: "CloseNI"

    function log(line) {
        logModel.append({ line: line })
        // A long session must not grow the view without bound.
        if (logModel.count > 2000)
            logModel.remove(0, logModel.count - 2000)
        logView.positionViewAtEnd()
    }

    // A local path to a file URL and back, with Windows drive letters.
    function toUrl(path) { return (path.startsWith("/") ? "file://" : "file:///") + path }
    function fromUrl(url) { return decodeURIComponent(url.toString().replace(/^file:\/\/(\/(?=[A-Za-z]:))?/, "")) }

    // "idle", "starting", "ready", "closing" or "failed", from Agent's replies.
    property string status: "idle"
    property var readyInfo: ({})
    property string error: ""

    function startAgent() {
        status = "starting"
        Agent.codeStart({ workspace: workspace, provider: provider, mode: "default" }, function (r) {
            if (r.ok) {
                readyInfo = r
                status = "ready"
                log("ready: " + JSON.stringify(r))
            } else {
                error = r.error
                status = "failed"
                log("failed: " + r.error)
            }
        })
    }

    function stopAgent() {
        status = "closing"
        Agent.codeEnd(function () { status = "idle" })
    }

    Connections {
        target: Agent
        function onLog(line) { window.log(line) }
        function onCodeEvent(ev) {
            if (ev.type === "closed" && window.status === "ready")
                window.status = "idle"
            else if (ev.type !== "ready")
                window.log(JSON.stringify(ev))
        }
    }

    Component.onCompleted: if (autoStart) startAgent()

    FolderDialog {
        id: folderDialog
        currentFolder: window.toUrl(window.workspace)
        onAccepted: window.workspace = window.fromUrl(selectedFolder)
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 12
        spacing: 8

        RowLayout {
            Layout.fillWidth: true
            spacing: 8

            Label { text: "Workspace" }
            TextField {
                Layout.fillWidth: true
                text: window.workspace
                onEditingFinished: window.workspace = text
                enabled: window.status === "idle" || window.status === "failed"
            }
            Button {
                text: "Browse…"
                onClicked: folderDialog.open()
                enabled: window.status === "idle" || window.status === "failed"
            }
            Label { text: "Provider" }
            TextField {
                Layout.preferredWidth: 120
                text: window.provider
                onEditingFinished: window.provider = text
                enabled: window.status === "idle" || window.status === "failed"
            }
            Button {
                text: window.status === "idle" || window.status === "failed" ? "Start" : "Stop"
                enabled: window.status !== "closing"
                onClicked: {
                    if (window.status === "idle" || window.status === "failed")
                        window.startAgent()
                    else
                        window.stopAgent()
                }
            }
        }

        Label {
            Layout.fillWidth: true
            wrapMode: Text.Wrap
            font.bold: true
            text: {
                switch (window.status) {
                case "starting": return "Starting the agent…"
                case "ready": return "Ready: " + window.readyInfo.provider + ", " + window.readyInfo.mode + " mode, in " + window.readyInfo.workspace
                case "closing": return "Closing…"
                case "failed": return "Failed: " + window.error
                default: return "Not running"
                }
            }
        }

        Frame {
            Layout.fillWidth: true
            Layout.fillHeight: true
            padding: 4

            ListView {
                id: logView
                anchors.fill: parent
                clip: true
                model: ListModel { id: logModel }
                ScrollBar.vertical: ScrollBar {}
                delegate: Text {
                    required property string line
                    width: logView.width
                    text: line
                    wrapMode: Text.WrapAnywhere
                    font.family: "monospace"
                    font.pixelSize: 12
                    color: palette.text
                }
            }
        }

        Label {
            Layout.fillWidth: true
            elide: Text.ElideMiddle
            opacity: 0.6
            font.pixelSize: 11
            text: "Storage: " + App.storageRoot
        }
    }
}
