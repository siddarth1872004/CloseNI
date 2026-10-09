import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import CloseNI
import "../js/renderer-logic.mjs" as R

/*
 * The plan document (#plan-sidebar in index.html, renderPlanDocument in
 * renderer/plan.js): the summary, its scale, the files and tech stack it
 * implies, and the steps, each with inline editing. Below it, Suggest Changes
 * and Build with this.
 *
 * The Chat panel shows it beside the conversation, as Electron did (`sidebar`
 * true). Opened on its own as the "plan" panel, × goes back to the chat.
 * Everything it shows is PlanState's and AppState's, so it holds nothing.
 */
Rectangle {
    id: doc

    property bool sidebar: false
    readonly property var plan: AppState.currentPlan
    readonly property var planSteps: plan ? (plan.steps || []) : []

    color: Theme.panel
    radius: Theme.isPixel ? 0 : 4
    border.width: 1
    border.color: Theme.isPixel ? Theme.lineStrong : Theme.line
    clip: true

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 1
        spacing: 0

        // #plan-head
        Rectangle {
            Layout.fillWidth: true
            implicitHeight: headRow.implicitHeight + 28
            color: Theme.surfaceRaised
            RowLayout {
                id: headRow
                anchors.fill: parent
                anchors.margins: 14
                Micro { text: "Implementation Plan"; Layout.fillWidth: true }
                Btn {
                    objectName: "closePlan"
                    text: "×"
                    small: true
                    tip: doc.sidebar ? "Hide the plan" : "Back to the chat"
                    onClicked: {
                        PlanState.closePlan()
                        if (!doc.sidebar) AppState.switchTab("chat")
                    }
                }
            }
            Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 1; color: Theme.line }
        }

        // #plan-content: one ListView, the document's top as its header and
        // one delegate per step, so a long plan draws only what is on screen.
        ListView {
            id: list
            objectName: "planSteps"
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            model: doc.planSteps
            spacing: 10
            topMargin: 16
            bottomMargin: 16
            leftMargin: 16
            rightMargin: 16
            ScrollBar.vertical: ThinScrollBar {}

            header: ColumnLayout {
                width: list.width - list.leftMargin - list.rightMargin
                spacing: 0

                Hint {
                    visible: !doc.plan
                    Layout.fillWidth: true
                    text: "No plan yet. Describe your idea in Chat, then Generate Implementation Plan."
                }

                // .plan-summary
                Text {
                    visible: !!doc.plan
                    Layout.fillWidth: true
                    Layout.bottomMargin: Theme.sp2
                    text: doc.plan ? (doc.plan.summary || "Implementation Plan") : ""
                    font.family: Theme.ui
                    font.pixelSize: 14
                    font.weight: Font.DemiBold
                    lineHeight: 1.3
                    color: Theme.txt
                    wrapMode: Text.Wrap
                }
                // .plan-scale: each step is a browser round-trip, so a long
                // plan is a long build. Say so before the Build button rather
                // than after twenty minutes of waiting.
                Hint {
                    readonly property string scale: doc.plan ? R.planScaleText(doc.plan) : ""
                    visible: scale !== ""
                    Layout.fillWidth: true
                    Layout.bottomMargin: 16
                    text: scale
                }

                // File Structure
                ColumnLayout {
                    readonly property var files: doc.plan ? R.planFiles(doc.plan) : []
                    visible: files.length > 0
                    Layout.fillWidth: true
                    Layout.bottomMargin: 20
                    spacing: 8
                    Micro { text: "File Structure" }
                    Rectangle {
                        Layout.fillWidth: true
                        implicitHeight: tree.implicitHeight + 24
                        color: Theme.surface
                        radius: Theme.isPixel ? 0 : 4
                        border.width: 1
                        border.color: Theme.line
                        Text {
                            id: tree
                            x: 12; y: 12
                            width: parent.width - 24
                            text: parent.parent.files.join("\n")
                            font.family: Theme.mono
                            font.pixelSize: 11
                            lineHeight: 1.4
                            color: Theme.dim
                            elide: Text.ElideRight
                        }
                    }
                }

                // Tech Stack
                ColumnLayout {
                    readonly property var tech: doc.plan ? R.planTechStack(doc.plan) : []
                    visible: tech.length > 0
                    Layout.fillWidth: true
                    Layout.bottomMargin: 20
                    spacing: 8
                    Micro { text: "Tech Stack" }
                    Flow {
                        Layout.fillWidth: true
                        spacing: 6
                        Repeater {
                            model: parent.parent.tech
                            Rectangle {
                                required property string modelData
                                width: tag.implicitWidth + 20
                                height: tag.implicitHeight + 8
                                color: Theme.surfaceRaised
                                radius: Theme.isPixel ? 0 : 3
                                border.width: 1
                                border.color: Theme.lineStrong
                                Text {
                                    id: tag
                                    anchors.centerIn: parent
                                    text: parent.modelData
                                    font.family: Theme.mono
                                    font.pixelSize: 11
                                    color: Theme.txt
                                }
                            }
                        }
                    }
                }

                Micro {
                    visible: !!doc.plan
                    text: "Implementation Steps"
                    Layout.bottomMargin: 8
                }
            }

            // .plan-step
            delegate: Card {
                id: stepCard
                required property var modelData
                required property int index
                width: list.width - list.leftMargin - list.rightMargin
                ground: "surface"
                padding: 12
                radius: Theme.isPixel ? 0 : 4

                HoverHandler { id: hover }

                // .plan-step-head. In the narrow sidebar the edit buttons
                // would squeeze the title to a word per line, so there they
                // take a line of their own under it.
                GridLayout {
                    readonly property bool roomy: stepCard.width - 24 >= num.implicitWidth + title.implicitWidth + edit.implicitWidth + 16
                    Layout.fillWidth: true
                    columns: roomy ? 3 : 2
                    columnSpacing: 8
                    rowSpacing: 4
                    Text {
                        id: num
                        text: "0" + (stepCard.index + 1)
                        font.family: Theme.mono
                        font.pixelSize: 11
                        color: Theme.mut
                    }
                    Text {
                        id: title
                        Layout.fillWidth: true
                        text: stepCard.modelData.title || "Step"
                        font.family: Theme.ui
                        font.pixelSize: 13
                        font.weight: Font.DemiBold
                        color: Theme.txt
                        wrapMode: Text.Wrap
                    }
                    // Editing is inline rather than a separate mode: the plan is
                    // read here, and the moment you want to change something is
                    // while reading it. Shown on hover or keyboard focus.
                    Row {
                        id: edit
                        Layout.columnSpan: parent.roomy ? 1 : 2
                        Layout.alignment: Qt.AlignRight
                        spacing: 4
                        readonly property bool focused: up.activeFocus || down.activeFocus || merge.activeFocus || del.activeFocus
                        opacity: hover.hovered || focused ? 1 : 0
                        Btn { id: up; small: true; text: "^"; tip: "Move earlier"; onClicked: PlanState.editPlanStep("up", stepCard.index) }
                        Btn { id: down; small: true; text: "v"; tip: "Move later"; onClicked: PlanState.editPlanStep("down", stepCard.index) }
                        Btn { id: merge; small: true; text: "merge up"; tip: "Merge into the step above"; onClicked: PlanState.editPlanStep("merge", stepCard.index) }
                        Btn { id: del; small: true; text: "delete"; tip: "Delete this step"; onClicked: PlanState.editPlanStep("del", stepCard.index) }
                    }
                }
                Text {
                    Layout.fillWidth: true
                    visible: text !== ""
                    text: stepCard.modelData.detail || ""
                    font.family: Theme.ui
                    font.pixelSize: 12
                    lineHeight: 1.2
                    color: Theme.dim
                    wrapMode: Text.Wrap
                }
                Text {
                    Layout.fillWidth: true
                    Layout.topMargin: 2
                    visible: (stepCard.modelData.files || []).length > 0
                    text: (stepCard.modelData.files || []).join("  ")
                    font.family: Theme.mono
                    font.pixelSize: 10
                    color: Theme.mut
                    wrapMode: Text.Wrap
                }
            }
        }

        // #plan-actions
        Rectangle {
            Layout.fillWidth: true
            implicitHeight: actions.implicitHeight + 24
            color: "transparent"
            Rectangle { width: parent.width; height: 1; color: Theme.line }
            RowLayout {
                id: actions
                anchors.fill: parent
                anchors.leftMargin: 14
                anchors.rightMargin: 14
                anchors.topMargin: 12
                anchors.bottomMargin: 12
                spacing: 8
                Btn {
                    objectName: "editPlan"
                    block: true
                    text: PlanState.editLabel
                    onClicked: if (PlanState.toggleEdit() && !doc.sidebar) AppState.switchTab("chat")
                }
                Btn {
                    objectName: "buildPlan"
                    block: true
                    variant: "invert"
                    text: "Build with this"
                    onClicked: PlanState.buildWithPlan()
                }
            }
        }
    }
}
