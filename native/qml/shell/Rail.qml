import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import CloseNI

/*
 * #rail: the wordmark, the two nav entries, and three cards - Provider (the
 * account light, the live phase, account actions, the provider's quick
 * controls, Show browser), Project (the folder, recent projects, Browse) and
 * Conversation (the chat list, New Chat, the thread). Scrolls when the window
 * is short, as #rail{overflow-y:auto} does.
 */
Rectangle {
    id: rail

    implicitWidth: 210
    color: Theme.panel

    Rectangle {
        anchors.right: parent.right
        width: 1
        height: parent.height
        color: Theme.line
    }

    ScrollArea {
        id: scroll
        anchors.fill: parent
        anchors.rightMargin: 1

        ColumnLayout {
            width: scroll.availableWidth
            spacing: 0

            Wordmark {
                Layout.topMargin: 20
                Layout.leftMargin: 14
                Layout.bottomMargin: 18
            }

            // nav
            ColumnLayout {
                Layout.fillWidth: true
                Layout.leftMargin: 14
                Layout.rightMargin: 14
                spacing: 2
                Repeater {
                    model: AppState.nav
                    NavButton {
                        required property var modelData
                        Layout.fillWidth: true
                        num: modelData.num
                        text: modelData.label
                        active: AppState.mode === modelData.mode
                        onClicked: AppState.switchTab(modelData.mode)
                    }
                }
            }

            // ---- Provider -------------------------------------------------
            Card {
                Layout.fillWidth: true
                Layout.leftMargin: 14
                Layout.rightMargin: 14
                Layout.topMargin: Theme.sp4
                title: "Provider"
                tile: 0

                // .acct: the light, the name and its state.
                GridLayout {
                    Layout.fillWidth: true
                    columns: 2
                    columnSpacing: Theme.sp2
                    rowSpacing: Theme.sp1
                    Rectangle {
                        Layout.preferredWidth: 8
                        Layout.preferredHeight: 8
                        Layout.alignment: Qt.AlignVCenter
                        readonly property string s: Providers.acct
                        color: s === "on" ? Theme.ok : s === "off" ? Theme.err : s === "busy" ? Theme.warn : Theme.mut
                        border.width: 1
                        border.color: s === "on" ? Theme.okLine : s === "off" ? Theme.errLine
                                    : s === "busy" ? Theme.warnLine : Theme.lineStrong
                    }
                    Text {
                        id: acctName
                        Layout.fillWidth: true
                        text: Providers.displayName
                        elide: Text.ElideRight
                        font.family: Theme.ui
                        font.pixelSize: 12
                        font.weight: Font.DemiBold
                        color: Theme.txt
                        HoverHandler { id: nameHover }
                        ToolTip.visible: nameHover.hovered
                        ToolTip.delay: 600
                        ToolTip.text: Providers.fullName
                    }
                    Text {
                        Layout.column: 1
                        Layout.row: 1
                        Layout.fillWidth: true
                        text: Providers.acctText
                        elide: Text.ElideRight
                        font.family: Theme.mono
                        font.pixelSize: 10
                        color: Theme.mut
                    }
                }

                PhaseIndicator {
                    Layout.fillWidth: true
                    phase: Providers.phase
                }

                Flow {
                    id: actions
                    Layout.fillWidth: true
                    Layout.bottomMargin: Theme.sp3 - 6
                    spacing: Theme.sp2
                    readonly property int cell: Math.max(72, (width - spacing) / 2)
                    Btn {
                        small: true; text: "Recheck"; tip: "Check again"
                        width: actions.cell
                        onClicked: Providers.refreshAccount(true)
                    }
                    Btn {
                        visible: Providers.acct !== "on"
                        small: true; text: Providers.signingIn ? "Opening…" : "Sign in"
                        enabled: !Providers.signingIn
                        width: actions.cell
                        onClicked: Providers.signIn()
                    }
                    Btn {
                        visible: Providers.acct === "on"
                        small: true; text: "Sign out"; tip: "Delete this provider's browser profile"
                        width: actions.cell
                        onClicked: Providers.signOut()
                    }
                    Btn {
                        small: true
                        text: Providers.checkingSelectors ? "Checking..." : "Check selectors"
                        enabled: !Providers.checkingSelectors
                        tip: "Check that this provider's page still looks the way the app expects. Uses this workspace's conversation, and sends nothing."
                        width: actions.width
                        onClicked: Providers.checkSelectors()
                    }
                }

                ProviderControls {
                    compact: true
                    Layout.fillWidth: true
                    Layout.bottomMargin: Theme.sp3 - 6
                }

                Check {
                    text: "Show browser"
                    checked: Providers.showBrowser
                    onToggled: Providers.setShowBrowser(checked)
                }
            }

            // ---- Project --------------------------------------------------
            Card {
                Layout.fillWidth: true
                Layout.leftMargin: 14
                Layout.rightMargin: 14
                Layout.topMargin: Theme.sp2
                title: "Project"
                tile: 1

                Text {
                    id: wsLabel
                    Layout.fillWidth: true
                    text: AppState.workspace || "none selected"
                    elide: Text.ElideRight
                    font.family: Theme.ui
                    font.pixelSize: 11
                    color: Theme.mut
                    HoverHandler { id: wsHover }
                    ToolTip.visible: wsHover.hovered && AppState.workspace !== ""
                    ToolTip.delay: 600
                    ToolTip.text: AppState.workspace
                }

                RecentList { Layout.fillWidth: true }

                Btn {
                    text: "Browse"
                    Layout.alignment: Qt.AlignLeft
                    onClicked: AppState.browse()
                }
            }

            // ---- Conversation ---------------------------------------------
            Card {
                Layout.fillWidth: true
                Layout.leftMargin: 14
                Layout.rightMargin: 14
                Layout.topMargin: Theme.sp2
                Layout.bottomMargin: 20
                title: "Conversation"
                tile: 2

                Select {
                    id: chatSelect
                    Layout.fillWidth: true
                    model: {
                        var m = [{ value: "new", label: "+ New Chat" }]
                        for (var i = 0; i < AppState.chats.length; i++)
                            m.push({ value: String(i), label: AppState.chatTitle(AppState.chats[i], i) })
                        return m
                    }
                    // A click sets currentIndex itself, which would break a
                    // binding: follow AppState explicitly instead.
                    function follow() { currentIndex = AppState.currentChatIndex + 1 }
                    onModelChanged: follow()
                    Component.onCompleted: follow()
                    Connections {
                        target: AppState
                        function onCurrentChatIndexChanged() { chatSelect.follow() }
                    }
                    onActivated: function (i) { AppState.selectChat(i === 0 ? "new" : String(i - 1)) }
                }
                Btn {
                    small: true
                    text: "New Chat"
                    Layout.alignment: Qt.AlignLeft
                    onClicked: AppState.newChat()
                }
                Btn {
                    visible: Providers.thread !== null
                    small: true
                    text: "Open chat in browser"
                    tip: "Open this conversation on the provider's site"
                    Layout.alignment: Qt.AlignLeft
                    onClicked: Providers.openThread()
                }
                Text {
                    visible: text !== ""
                    Layout.fillWidth: true
                    text: Providers.threadText
                    elide: Text.ElideRight
                    font.family: Theme.mono
                    font.pixelSize: 10
                    color: Theme.mut
                }
            }
        }
    }
}
