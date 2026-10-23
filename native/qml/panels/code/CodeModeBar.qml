import QtQuick
import CloseNI
import "../../js/code-logic.mjs" as C

/*
 * .code-modebar: the strip above the prompt in plan, build, test, research and
 * ship - the mode's glyph and name, what it is for (or, for test and ship,
 * what CodeStore found out), its actions, and build's progress as a 2px bar.
 * Hidden in the modes without one. The actions wait while a run is going,
 * except research's source toggles.
 */
Rectangle {
    id: bar

    readonly property var spec: C.MODEBAR[CodeStore.mode] || null
    readonly property color mode: CodeStore.modeColor(CodeStore.mode, Theme.accent)

    visible: !!spec
    implicitHeight: visible ? flow.implicitHeight + 12 : 0
    radius: Theme.rMd
    color: Theme.surface
    border.width: 1
    border.color: Theme.line
    clip: true

    Rectangle { width: 2; height: parent.height; color: bar.mode }

    Flow {
        id: flow
        x: 10; y: 6
        width: bar.width - 20
        spacing: 12

        Text {
            id: name
            height: Math.max(implicitHeight, 22)
            verticalAlignment: Text.AlignVCenter
            text: bar.spec ? bar.spec.glyph + " " + bar.spec.name : ""
            font.family: Theme.mono
            font.pixelSize: 11
            font.bold: true
            font.letterSpacing: 0.66
            font.capitalization: Font.AllUppercase
            color: bar.mode
        }
        Text {
            // min-width 20ch, and otherwise the room the actions leave.
            width: Math.max(Math.min(20 * 6.6, flow.width), flow.width - name.width - acts.width - 2 * flow.spacing)
            height: Math.max(implicitHeight, 22)
            verticalAlignment: Text.AlignVCenter
            text: CodeStore.modebarInfo
            textFormat: Text.PlainText
            elide: Text.ElideRight
            font.family: Theme.mono
            font.pixelSize: 11
            color: Theme.dim
        }
        Row {
            id: acts
            spacing: 6
            Repeater {
                model: CodeStore.modebarActions
                CodeBtn {
                    required property var modelData
                    text: modelData.label
                    tip: modelData.tip || ""
                    look: modelData.look || ""
                    tint: bar.mode
                    enabled: !(CodeStore.running && CodeStore.mode !== "research")
                    onClicked: CodeStore.act(modelData)
                }
            }
        }
    }

    Rectangle {
        visible: CodeStore.modebarProgress >= 0
        x: 0
        y: parent.height - 2
        height: 2
        width: Math.round(parent.width * Math.max(0, CodeStore.modebarProgress))
        color: bar.mode
        Behavior on width { enabled: Theme.animate; NumberAnimation { duration: 300 } }
    }
}
