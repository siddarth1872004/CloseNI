import QtQuick
import QtQuick.Layouts
import CloseNI

/*
 * #browser-gate: first run without Chromium. The app can do nothing without
 * it, so this blocks until the download finishes (startup.js). Open while
 * AppState.gateOpen; the progress line follows Agent.browserProgress.
 */
Modal {
    id: gate

    property string progress: ""
    property bool installing: false

    cardWidth: 460
    cardRadius: Theme.rLg
    visible: AppState.gateOpen
    onClosed: AppState.gateOpen = false

    function install() {
        installing = true
        progress = "Starting..."
        Agent.installBrowser(function (r) {
            installing = false
            if (r && r.ok) {
                AppState.browserReady = true
                AppState.gateOpen = false
                Notify.toast("Browser ready")
            } else {
                progress = (r && r.error) || "Download failed."
            }
        })
    }

    Connections {
        target: Agent
        enabled: gate.visible
        function onBrowserProgress(line) { gate.progress = line }
    }

    contentItem: ColumnLayout {
        spacing: 0
        Micro { text: "One-time setup" }
        Text {
            Layout.fillWidth: true
            Layout.topMargin: Theme.sp3
            Layout.bottomMargin: Theme.sp4
            text: "CloseNI drives real browsers to talk to AI providers. It needs its own copy of Chromium — about 389MB, downloaded once and kept for good."
            wrapMode: Text.Wrap
            lineHeight: 1.6
            font.family: Theme.ui
            font.pixelSize: 12
            color: Theme.dim
        }
        Btn {
            text: "Download browser"
            variant: "invert"
            enabled: !gate.installing
            onClicked: gate.install()
        }
        Text {
            Layout.fillWidth: true
            Layout.topMargin: Theme.sp3
            Layout.minimumHeight: 16
            text: gate.progress
            elide: Text.ElideRight
            font.family: Theme.mono
            font.pixelSize: 11
            color: Theme.mut
        }
    }
}
