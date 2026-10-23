import QtQuick
import QtQuick.Layouts
import CloseNI

/*
 * A list of tabs (the Settings nav): vertical by default, horizontal with
 * `horizontal`. `model` is [{ id, label }]; `current` is the active id and
 * `activated(id)` fires on a click.
 */
GridLayout {
    id: tabs

    property var model: []
    property string current: ""
    property bool horizontal: false
    signal activated(string id)

    flow: horizontal ? GridLayout.LeftToRight : GridLayout.TopToBottom
    rows: horizontal ? 1 : Math.max(1, model.length)
    columns: horizontal ? Math.max(1, model.length) : 1
    rowSpacing: 2
    columnSpacing: 2

    Repeater {
        model: tabs.model
        NavButton {
            required property var modelData
            Layout.fillWidth: !tabs.horizontal
            text: modelData.label
            active: modelData.id === tabs.current
            onClicked: tabs.activated(modelData.id)
        }
    }
}
