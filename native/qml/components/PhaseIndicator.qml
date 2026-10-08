import QtQuick
import QtQuick.Layouts
import CloseNI

/*
 * The live phase (.phase): what the browser is doing right now. `phase` is
 * R.phaseLabel's { name, label, kind, detail }. The mark blinks only while
 * busy (warn, 0.8s) or working (ok, 0.5s) - the one looping animation the app
 * keeps, because it means something - and is still when idle.
 */
Rectangle {
    id: root

    property var phase: ({ name: "idle", label: "idle", kind: "idle", detail: "" })
    readonly property string kind: phase && phase.kind ? phase.kind : "idle"

    implicitHeight: row.implicitHeight + 10
    implicitWidth: row.implicitWidth + 16
    color: Theme.surfaceSunken
    radius: Theme.rSm
    border.width: 1
    border.color: kind === "busy" ? Theme.lineStrong : kind === "work" ? Theme.okLine : Theme.line

    RowLayout {
        id: row
        anchors.fill: parent
        anchors.leftMargin: 8
        anchors.rightMargin: 8
        spacing: Theme.sp2

        Rectangle {
            id: mark
            implicitWidth: 6
            implicitHeight: 6
            color: root.kind === "busy" ? Theme.warn : root.kind === "work" ? Theme.ok : Theme.mut
            // steps(4) over 1 -> .15 -> 1
            property int step: 0
            opacity: [1, 0.575, 0.15, 0.575][step]
            Timer {
                interval: root.kind === "work" ? 125 : 200
                repeat: true
                running: root.kind !== "idle" && root.visible
                onRunningChanged: if (!running) mark.step = 0
                onTriggered: mark.step = (mark.step + 1) % 4
            }
        }
        Text {
            Layout.fillWidth: true
            text: root.phase && root.phase.label ? root.phase.label : "idle"
            font.family: Theme.mono
            font.pixelSize: 10
            font.letterSpacing: 0.6
            font.capitalization: Font.AllUppercase
            color: root.kind === "idle" ? Theme.mut : Theme.txt
            elide: Text.ElideRight
        }
        Text {
            visible: text !== ""
            Layout.maximumWidth: 60
            text: root.phase && root.phase.detail ? root.phase.detail : ""
            font.family: Theme.mono
            font.pixelSize: 10
            color: Theme.mut
            elide: Text.ElideRight
        }
    }
}
