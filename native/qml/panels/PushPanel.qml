import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import CloseNI

/*
 * #panel-push (SHIP), from desktop/renderer/ship.js and the export-branch
 * handler in desktop/renderer/plan.js: the GitHub account, the plain git
 * buttons, exporting the build to a branch, and GitHub Actions. ShipStore holds
 * the state; opening the panel re-reads the account and its repositories,
 * as Electron's switchTab did.
 */
ScrollArea {
    id: panel

    // Room for the scroll bar, which sits over the content's right edge.
    rightPadding: 10
    Component.onCompleted: ShipStore.refreshGitHub()

    // .gh-run: a workflow run and its state, coloured by success, failure or running.
    component RunRow: Rectangle {
        id: run
        property string name: ""
        property string verdict: ""
        implicitHeight: runLine.implicitHeight + 10
        radius: Theme.rMd
        color: Theme.surface
        border.width: 1
        border.color: Theme.line
        RowLayout {
            id: runLine
            x: 8; width: parent.width - 16
            anchors.verticalCenter: parent.verticalCenter
            spacing: Theme.sp4
            Text {
                Layout.fillWidth: true
                text: run.name
                color: Theme.dim
                font.family: Theme.mono
                font.pixelSize: 11
                elide: Text.ElideRight
            }
            Text {
                text: run.verdict
                color: run.verdict === "success" ? Theme.ok : run.verdict === "failure" ? Theme.err
                     : run.verdict === "running" ? Theme.warn : Theme.mut
                font.family: Theme.mono
                font.pixelSize: 10
                font.letterSpacing: 1
                font.capitalization: Font.AllUppercase
            }
        }
    }

    ColumnLayout {
        width: panel.availableWidth
        spacing: Theme.sp4

        // #gh-account
        Rectangle {
            Layout.fillWidth: true
            implicitHeight: account.implicitHeight + Theme.sp4 * 2
            color: Theme.panel
            radius: Theme.rLg
            border.width: 1
            border.color: Theme.line

            ColumnLayout {
                id: account
                x: Theme.sp5; y: Theme.sp4
                width: parent.width - Theme.sp5 * 2
                spacing: 0

                Micro { text: "GitHub"; Layout.bottomMargin: Theme.sp2 }

                // #gh-signed-out
                ColumnLayout {
                    Layout.fillWidth: true
                    visible: ShipStore.ghKnown && !ShipStore.ghSignedIn
                    spacing: 0
                    Hint {
                        Layout.fillWidth: true
                        textFormat: Text.StyledText
                        text: "Create a token with <b>repo</b> and <b>workflow</b> scopes, then paste it here. It is encrypted with your operating system's key and never leaves this machine."
                    }
                    RowLayout {
                        Layout.topMargin: Theme.sp3
                        Btn { text: "Open GitHub token page"; onClicked: ShipStore.openTokenPage() }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        Layout.topMargin: Theme.sp3
                        spacing: 8
                        Field {
                            id: token
                            objectName: "ghToken"
                            Layout.fillWidth: true
                            echoMode: TextInput.Password
                            placeholderText: "ghp_..."
                            onAccepted: signIn.clicked()
                        }
                        Btn {
                            id: signIn
                            text: "Sign in"; variant: "invert"
                            onClicked: {
                                var t = token.text
                                // The box is cleared whatever happens: a token is not left lying in it.
                                token.text = ""
                                ShipStore.signIn(t)
                            }
                        }
                    }
                    Hint { Layout.fillWidth: true; Layout.topMargin: Theme.sp2; text: ShipStore.ghStorageNote }
                    Hint { Layout.fillWidth: true; Layout.topMargin: Theme.sp2; visible: text !== ""; text: ShipStore.ghLegacyNote; color: Theme.warn }
                }

                // #gh-signed-in
                ColumnLayout {
                    Layout.fillWidth: true
                    visible: ShipStore.ghSignedIn
                    spacing: 0
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 8
                        Text {
                            objectName: "ghLogin"
                            text: ShipStore.ghLogin
                            color: Theme.txt
                            font.family: Theme.mono
                            font.pixelSize: 12
                        }
                        Item { Layout.fillWidth: true }
                        Btn { text: "Sign out"; small: true; onClicked: ShipStore.signOut() }
                    }
                    Micro { text: "Repository"; Layout.topMargin: Theme.sp5; Layout.bottomMargin: Theme.sp2 }
                    Select {
                        id: repoPick
                        objectName: "ghRepo"
                        Layout.fillWidth: true
                        model: ShipStore.ghRepos
                        onModelChanged: Qt.callLater(function () { repoPick.selectValue(ShipStore.ghRepo) })
                        onActivated: ShipStore.pickRepo(currentValue)
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        Layout.topMargin: Theme.sp3
                        spacing: 8
                        Field {
                            id: newRepo
                            Layout.fillWidth: true
                            placeholderText: "new repository name"
                            text: ShipStore.newRepoName
                            onTextEdited: ShipStore.newRepoName = text
                            onAccepted: ShipStore.createRepo(text)
                        }
                        Btn { text: "Create"; small: true; onClicked: ShipStore.createRepo(newRepo.text) }
                    }
                }
            }
        }

        Micro { text: "Local"; Layout.topMargin: Theme.sp5 - Theme.sp4 }
        RowLayout {
            spacing: 8
            Btn { text: "git init"; onClicked: ShipStore.gitInit() }
            Btn { text: "git status"; onClicked: ShipStore.gitStatus() }
        }
        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            Field {
                id: commitMsg
                Layout.fillWidth: true
                placeholderText: "commit message"
                text: ShipStore.commitMsg
                onTextEdited: ShipStore.commitMsg = text
            }
            Btn { text: "commit all"; enabled: !ShipStore.gitBusy; onClicked: ShipStore.gitCommit(commitMsg.text) }
        }
        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            Field {
                id: remote
                objectName: "remoteUrl"
                Layout.fillWidth: true
                placeholderText: "https://github.com/you/repo.git"
                text: ShipStore.remoteUrl
                onTextEdited: ShipStore.remoteUrl = text
            }
            Btn { text: "push origin"; variant: "invert"; enabled: !ShipStore.gitBusy; onClicked: ShipStore.gitPush(remote.text) }
        }

        Micro { text: "This build"; Layout.topMargin: Theme.sp5 - Theme.sp4 }
        Hint {
            Layout.fillWidth: true
            text: "Replays the build onto a branch of its own, one commit per step, so you can read it with git log, diff any step, and revert one without undoing the rest. Your working tree is put back exactly as it is now."
        }
        RowLayout {
            Btn {
                objectName: "exportBranch"
                text: ShipStore.exporting ? "Exporting..." : "Export build to a branch"
                enabled: !ShipStore.exporting
                onClicked: ShipStore.exportBranch()
            }
        }

        Micro { text: "Actions"; Layout.topMargin: Theme.sp5 - Theme.sp4 }
        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            Field {
                id: wf
                Layout.fillWidth: true
                placeholderText: "workflow file, e.g. release.yml"
                text: ShipStore.workflow
                onTextEdited: ShipStore.workflow = text
                onAccepted: ShipStore.dispatch(text)
            }
            Btn { text: "Run"; small: true; onClicked: ShipStore.dispatch(wf.text) }
            Btn { text: "Refresh"; small: true; onClicked: ShipStore.refreshRuns() }
        }
        // #gh-runs
        ColumnLayout {
            Layout.fillWidth: true
            Layout.topMargin: Theme.sp3 - Theme.sp4
            spacing: Theme.sp1
            Text {
                visible: ShipStore.ghRunsText !== ""
                Layout.fillWidth: true
                text: ShipStore.ghRunsText
                color: Theme.txt
                font.family: Theme.ui
                font.pixelSize: 12
                wrapMode: Text.Wrap
            }
            Repeater {
                model: ShipStore.ghRuns
                RunRow {
                    required property var modelData
                    Layout.fillWidth: true
                    name: modelData.name
                    verdict: modelData.state
                }
            }
        }
    }
}
