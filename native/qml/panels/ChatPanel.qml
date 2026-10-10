import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import CloseNI

/*
 * Chat: talk the idea through,
 * then Generate Implementation Plan. The plan document opens beside the
 * conversation, where it can be edited, revised by message
 * ("Suggest Changes") or handed to the builder.
 *
 * The conversation, the draft and the plan live in PlanState and AppState, so
 * a reply that lands while another panel is open is still here on return.
 */
Item {
    id: chat

    RowLayout {
        anchors.fill: parent
        spacing: 16

        // #chat-column. Pixel gives it its own panel ground and hard shadow.
        Item {
            Layout.fillWidth: true
            Layout.fillHeight: true

            Rectangle {
                visible: Theme.isPixel
                x: 3; y: 3; width: parent.width; height: parent.height
                color: Theme.pxShadow
            }
            Rectangle {
                visible: Theme.isPixel
                anchors.fill: parent
                color: Theme.panel
                border.width: 1
                border.color: Theme.lineStrong
            }

            ColumnLayout {
                anchors.fill: parent
                anchors.margins: Theme.isPixel ? 12 : 0
                spacing: 10

                // The getting-started guide sits above the chat it is teaching.
                OnboardingGuide { Layout.fillWidth: true }

                // #chat-flow
                ListView {
                    id: flow
                    cacheBuffer: 0   // no async look-ahead in a Loader: ARCHITECTURE.md, Panels
                    objectName: "chatFlow"
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true
                    boundsBehavior: Flickable.StopAtBounds
                    model: PlanState.bubbles
                    topMargin: 4
                    bottomMargin: 4
                    ScrollBar.vertical: ThinScrollBar {}

                    // Follow the conversation, as the flow's scrollTop did, but
                    // only while the reader is already at the bottom.
                    property bool following: true
                    onMovementEnded: following = atYEnd
                    // Messages arrive (pix-in) when they are said or the panel
                    // opens, not when scrolling brings a delegate into being.
                    property double drawnAt: Date.now()
                    onCountChanged: { drawnAt = Date.now(); following = true; Qt.callLater(flow.positionViewAtEnd) }
                    onContentHeightChanged: if (following) Qt.callLater(flow.positionViewAtEnd)
                    Component.onCompleted: positionViewAtEnd()

                    // .msg
                    delegate: Item {
                        id: msg
                        required property string who
                        required property string text
                        required property bool md
                        width: flow.width
                        implicitHeight: col.implicitHeight + 20 + 1
                        height: implicitHeight
                        PixMotion { id: arrive }
                        opacity: arrive.opacity
                        transform: Translate { y: arrive.shift }
                        Component.onCompleted: if (Date.now() - flow.drawnAt < 300) arrive.play()

                        ColumnLayout {
                            id: col
                            x: 2
                            y: 10
                            width: parent.width - 4
                            spacing: 4
                            Text {
                                text: (Theme.isPixel && msg.who === "user" ? "$ " : "") + (msg.who === "user" ? "you" : "ai")
                                font.family: Theme.ui
                                font.pixelSize: 10
                                font.letterSpacing: 1.4
                                font.capitalization: Font.AllUppercase
                                color: Theme.isPixel ? (msg.who === "user" ? Theme.pxG2 : Theme.pxBlue)
                                     : msg.who === "user" ? Theme.txt : Theme.mut
                            }
                            TextEdit {
                                Layout.fillWidth: true
                                readOnly: true
                                selectByMouse: true
                                text: msg.text
                                textFormat: msg.md ? TextEdit.MarkdownText : TextEdit.PlainText
                                wrapMode: TextEdit.Wrap
                                font.family: Theme.ui
                                font.pixelSize: 13
                                color: msg.who === "user" ? Theme.txt : Theme.dim
                                selectionColor: Theme.lineFocus
                                selectedTextColor: Theme.inverse
                                onLinkActivated: function (link) { App.openExternal(link) }
                            }
                        }
                        Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 1; color: Theme.line }
                    }
                }

                // #chat-bar
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8
                    TextBox {
                        id: input
                        objectName: "chatInput"
                        Layout.fillWidth: true
                        Layout.preferredHeight: 54
                        placeholderText: PlanState.inputPlaceholder
                        // Two-way with PlanState.draft by hand: a plain binding
                        // would break at the first keystroke, and the draft is
                        // also set from outside (send clears it, the guide's
                        // example fills it).
                        Component.onCompleted: input.text = PlanState.draft
                        area.onTextChanged: if (PlanState.draft !== input.text) PlanState.draft = input.text
                    }
                    Btn {
                        objectName: "chatSend"
                        variant: "invert"
                        text: PlanState.sendLabel
                        Layout.preferredHeight: 54
                        onClicked: PlanState.send(input.text)
                    }
                }
                Btn {
                    objectName: "generatePlan"
                    text: "Generate Implementation Plan"
                    onClicked: PlanState.generatePlan()
                }
            }
        }

        // #plan-sidebar
        PlanPanel {
            sidebar: true
            visible: PlanState.sidebarOpen
            Layout.fillHeight: true
            Layout.preferredWidth: Math.min(520, chat.width * 0.45)
        }
    }

    // Suggest Changes puts the cursor where the change is to be described.
    Connections {
        target: PlanState
        function onDraftChanged() { if (input.text !== PlanState.draft) input.text = PlanState.draft }
        function onEditingPlanChanged() { if (PlanState.editingPlan) input.area.forceActiveFocus() }
    }
}
