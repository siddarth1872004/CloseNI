import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import CloseNI

/*
 * Getting started (#welcome, renderOnboarding in renderer/account.js): a
 * checklist above the chat it is teaching, every tick read from real state
 * through onboarding.mjs. Only the current step explains itself and offers
 * its action. Hidden once everything is done or the user hides it.
 */
Rectangle {
    id: guide

    visible: AppState.onboardingVisible
    implicitHeight: body.implicitHeight + Theme.sp4 * 2
    color: Theme.surfaceRaised
    radius: Theme.rLg
    border.width: 1
    border.color: Theme.lineStrong

    ColumnLayout {
        id: body
        x: Theme.sp5
        y: Theme.sp4
        width: parent.width - Theme.sp5 * 2
        spacing: 0

        RowLayout {
            Layout.fillWidth: true
            Micro { text: "Getting started"; Layout.fillWidth: true }
            Btn {
                small: true
                text: "Hide"
                tip: "Hide this guide. Settings, About brings it back."
                onClicked: AppState.dismissOnboarding()
            }
        }
        Hint {
            Layout.fillWidth: true
            Layout.topMargin: Theme.sp2
            text: "CloseNI plans and builds software by chatting with a free AI site in a real browser - no API key. Four things, in this order:"
        }

        ColumnLayout {
            Layout.fillWidth: true
            Layout.topMargin: Theme.sp4
            spacing: Theme.sp3

            Repeater {
                model: AppState.onboardingSteps
                RowLayout {
                    id: step
                    required property var modelData
                    readonly property bool done: !!modelData.done
                    readonly property bool next: modelData.id === AppState.onboardingCurrent
                    Layout.fillWidth: true
                    spacing: Theme.sp4

                    Rectangle {
                        Layout.alignment: Qt.AlignTop
                        Layout.topMargin: 2
                        implicitWidth: 16
                        implicitHeight: 16
                        radius: Theme.rSm
                        color: step.done ? Theme.okBg : "transparent"
                        border.width: 1
                        border.color: step.done ? Theme.okLine : step.next ? Theme.txt : Theme.lineStrong
                        Text {
                            anchors.centerIn: parent
                            text: step.done ? "✓" : ""
                            font.pixelSize: 11
                            color: Theme.ok
                        }
                    }
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 2
                        Text {
                            Layout.fillWidth: true
                            text: step.modelData.title + (step.done ? " - done" : "")
                            wrapMode: Text.Wrap
                            font.family: Theme.ui
                            font.pixelSize: 13
                            color: step.next ? Theme.txt : step.done ? Theme.mut : Theme.dim
                        }
                        Hint {
                            visible: step.next
                            Layout.fillWidth: true
                            text: step.modelData.detail || ""
                        }
                        Hint {
                            visible: step.next && !!step.modelData.terms
                            Layout.fillWidth: true
                            textFormat: Text.StyledText
                            text: (step.modelData.terms || "") + " "
                                  + (step.modelData.termsUrl ? "<a href='terms'>Read the terms</a>" : "")
                            linkColor: Theme.txt
                            onLinkActivated: Providers.openThread(step.modelData.termsUrl)
                            HoverHandler { cursorShape: parent.hoveredLink ? Qt.PointingHandCursor : Qt.ArrowCursor }
                        }
                    }
                    Btn {
                        visible: step.next && !!step.modelData.action
                        Layout.alignment: Qt.AlignVCenter
                        small: true
                        variant: "invert"
                        text: step.modelData.action || ""
                        onClicked: AppState.onboardingAction(step.modelData.id)
                    }
                }
            }
        }
    }
}
