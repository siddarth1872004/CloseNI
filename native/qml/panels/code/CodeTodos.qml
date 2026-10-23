import QtQuick
import CloseNI
import "../../js/code-logic.mjs" as C

/*
 * .cc-todos: the agent's task list - ☐ pending, ◼ in progress (bold, accent
 * box), ☒ done (struck through). Short by nature: the agent writes a handful.
 */
Column {
    id: todos

    property var items: []

    spacing: 2

    Repeater {
        model: todos.items
        Row {
            id: item
            required property var modelData
            readonly property string status: modelData.status
            width: todos.width
            Text {
                id: box
                text: C.todoBox(item.status)
                width: 2 * fm.averageCharacterWidth
                font.family: Theme.mono
                font.pixelSize: 13
                color: item.status === "in_progress" ? Theme.accent : Theme.mut
            }
            Text {
                width: item.width - box.width
                text: String(item.modelData.text || "")
                textFormat: Text.PlainText
                wrapMode: Text.WrapAtWordBoundaryOrAnywhere
                font.family: Theme.mono
                font.pixelSize: 13
                font.weight: item.status === "in_progress" ? Font.DemiBold : Font.Normal
                font.strikeout: item.status === "done"
                color: item.status === "in_progress" ? Theme.txt : item.status === "done" ? Theme.mut : Theme.dim
            }
        }
    }
    FontMetrics { id: fm; font.family: Theme.mono; font.pixelSize: 13 }
}
