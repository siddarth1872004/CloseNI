import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Dialogs
import QtQuick.Layouts
import CloseNI

/*
 * The window: desktop/index.html's shell. The rail, the top bar with the flow,
 * one Loader per panel (only the open one exists, plus Code once visited, so
 * an idle window holds one screen), the console drawer, toasts, the approval
 * modal, the browser gate and the folder picker.
 *
 * State shared between panels lives in the singletons (AppState, Providers,
 * Notify, Theme); panels read and write it there, never each other.
 *
 * main.cpp sets workspace, provider and autoStart from --workspace, --provider
 * and --start ("" when not given: the last project and the saved provider are
 * used), selfTestDir from --self-test and uiScript from --ui-script.
 */
ApplicationWindow {
    id: window

    required property string workspace
    required property string provider
    required property bool autoStart
    property string selfTestDir: ""
    // --ui-script <file>: a test's QML file, loaded below with the window as root.
    property string uiScript: ""
    // --self-test: main.cpp saves the window to `path` (see SelfTest.qml).
    signal selfTestShot(string path)

    width: 1280
    height: 800
    minimumWidth: 760
    minimumHeight: 520
    visible: true
    title: AppState.workspace ? "CloseNI - " + AppState.pathTail(AppState.workspace) : "CloseNI"
    color: Theme.bg

    font.family: Theme.ui
    font.pixelSize: Theme.bodySize
    // The attached ToolTip and other stock pieces read the palette.
    palette.window: Theme.bg
    palette.windowText: Theme.txt
    palette.base: Theme.surface
    palette.text: Theme.txt
    palette.button: Theme.surface
    palette.buttonText: Theme.txt
    palette.highlight: Theme.lineStrong
    palette.highlightedText: Theme.txt
    palette.toolTipBase: Theme.surfaceRaised
    palette.toolTipText: Theme.txt
    palette.dark: Theme.lineStrong
    palette.mid: Theme.line
    palette.light: Theme.surfaceRaised

    // A local path to a file URL and back, with Windows drive letters.
    function toUrl(path) { return (path.startsWith("/") ? "file://" : "file:///") + path }
    function fromUrl(url) { return decodeURIComponent(url.toString().replace(/^file:\/\/(\/(?=[A-Za-z]:))?/, "")) }

    // --start: bring the agent session up at launch, as phase 0 did. The Code
    // panel owns the session once it is ported.
    function startAgent() {
        var ws = AppState.workspace || window.workspace
        if (!ws) { Notify.toast("Pick a workspace", "err"); return }
        AppState.setStatus("starting the agent…")
        Agent.codeStart({ workspace: ws, provider: window.provider || Providers.current, mode: "default" }, function (r) {
            if (r && r.ok) {
                AppState.setStatus("ready")
                Notify.log("agent ready: " + r.provider + ", " + r.mode + " mode", "ok")
            } else {
                AppState.setStatus("idle")
                Notify.log("agent failed: " + ((r && r.error) || "no answer"), "err")
            }
        })
    }

    Component.onCompleted: {
        AppState.start(workspace, provider)
        if (autoStart) startAgent()
        if (selfTestDir) selfTest.begin()
    }

    // Pixel's starfield sits behind the content; scanlines go over it (below).
    Texture { anchors.fill: parent; behind: true }

    RowLayout {
        anchors.fill: parent
        spacing: 0

        Rail {
            Layout.fillHeight: true
            Layout.preferredWidth: 210
        }

        ColumnLayout {
            id: main
            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.leftMargin: 18
            Layout.rightMargin: 18
            Layout.topMargin: 14
            Layout.bottomMargin: 14
            spacing: 12

            TopBar { Layout.fillWidth: true }

            Item {
                id: panels
                Layout.fillWidth: true
                Layout.fillHeight: true

                Repeater {
                    model: AppState.panels
                    Loader {
                        id: panel
                        required property var modelData
                        readonly property bool current: AppState.mode === modelData.mode
                        // The agent is where people spend the session: once
                        // opened it stays, so coming back from Settings costs
                        // nothing and loses nothing.
                        property bool kept: false
                        onCurrentChanged: if (current && modelData.mode === "code") kept = true
                        anchors.fill: parent
                        active: current || kept
                        visible: current
                        asynchronous: false
                        source: "panels/" + modelData.name + "Panel.qml"
                        Component.onCompleted: if (current && modelData.mode === "code") kept = true
                    }
                }
            }

            ConsoleDrawer { Layout.fillWidth: true }
        }
    }

    Texture { anchors.fill: parent; behind: false; z: 1 }

    ToastStack {
        anchors.top: parent.top
        anchors.right: parent.right
        anchors.topMargin: 14
        anchors.rightMargin: 14
        z: 2
    }

    ApprovalModal { id: approvalModal }
    BrowserGate { id: gate }

    // Made on first use: the native dialog pulls in the platform's dialog
    // stack, which an idle window has no need for.
    Loader {
        id: folderDialog
        active: false
        sourceComponent: FolderDialog {
            title: "Choose a workspace"
            currentFolder: window.toUrl(AppState.workspace || window.workspace || "/")
            onAccepted: AppState.openWorkspace(window.fromUrl(selectedFolder))
        }
    }
    Connections {
        target: AppState
        function onBrowseRequested() {
            folderDialog.active = true
            folderDialog.item.open()
        }
    }

    // The run console: made on the first run and reused after, so an app that
    // never runs anything never builds it (main/run-window.js kept one too).
    Loader {
        id: runWindow
        objectName: "runWindowLoader"
        active: false
        sourceComponent: RunWindow {}
    }
    Connections {
        target: Runner
        function onWindowRequested(req) {
            runWindow.active = true
            runWindow.item.present(req)
        }
        // "Fix errors" in the run console: the agent here takes the request,
        // so this window comes forward. The Code panel turns the prompt into
        // a task (Electron's code.js onRunFix).
        function onRunFix(detail) {
            window.raise()
            window.requestActivate()
            AppState.switchTab("code")
        }
    }

    // --self-test <dir>: every theme, every panel, the console, a toast, both
    // modals, three screenshots, then quit. main.cpp fails the run on any
    // warning. Nothing here exists unless asked for.
    Loader {
        id: selfTest
        active: false
        function begin() { active = true }
        sourceComponent: SelfTest {
            root: window
            outDir: window.selfTestDir
            approval: approvalModal
        }
    }

    // --ui-script <file>: an end-to-end test drives the window through the UI.
    // Nothing here exists unless asked for.
    Loader {
        active: window.uiScript !== ""
        source: window.uiScript
        onLoaded: item.root = window
    }
}
