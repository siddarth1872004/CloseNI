import QtQuick
import QtQuick.Layouts
import CloseNI

/*
 * A provider's own controls (model, deep thinking...), from
 * renderProviderControls in renderer/providers.js. Two copies exist - the
 * rail's (`compact`, no heading) and Settings' - and both read and write the
 * same saved value through Providers, so they cannot disagree.
 */
ColumnLayout {
    id: root

    property bool compact: false

    readonly property var controls: Providers.info && Providers.info.controls ? Providers.info.controls : []
    // Re-read whenever either copy saves or the provider changes.
    readonly property var values: { Providers.controlsRevision; return Providers.desiredControls() }

    visible: controls.length > 0
    spacing: compact ? Theme.sp1 : Theme.sp2

    Micro {
        visible: !root.compact
        Layout.topMargin: 14
        text: "Provider settings"
    }

    Repeater {
        model: root.controls
        ColumnLayout {
            id: ctl
            required property var modelData
            Layout.fillWidth: true
            spacing: Theme.sp1

            Micro {
                visible: ctl.modelData.kind === "select"
                Layout.topMargin: Theme.sp3
                text: ctl.modelData.label || ""
            }
            Select {
                id: sel
                visible: ctl.modelData.kind === "select"
                Layout.fillWidth: true
                model: (ctl.modelData.options || []).map(function (o) {
                    return { value: o.value, label: o.label || o.value }
                })
                Component.onCompleted: selectValue(root.values[ctl.modelData.id])
                Connections {
                    target: root
                    function onValuesChanged() { sel.selectValue(root.values[ctl.modelData.id]) }
                }
                onActivated: Providers.saveControl(ctl.modelData.id, currentValue)
            }
            Check {
                visible: ctl.modelData.kind === "toggle"
                Layout.topMargin: root.compact ? 0 : Theme.sp3
                text: ctl.modelData.label || ""
                checked: root.values[ctl.modelData.id] === true
                onToggled: Providers.saveControl(ctl.modelData.id, checked)
            }
        }
    }
}
