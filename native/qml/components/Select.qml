import QtQuick
import QtQuick.Controls.Basic
import CloseNI

/*
 * A select: the field's look with a caret, and a themed drop-down list.
 * Models are arrays of { value, label, disabled } (textRole "label",
 * valueRole "value"), or plain strings.
 */
ComboBox {
    id: control

    font.family: Theme.mono
    font.pixelSize: Theme.inputSize
    leftPadding: 10
    rightPadding: 26
    topPadding: 7
    bottomPadding: 7
    hoverEnabled: true
    textRole: "label"
    valueRole: "value"

    /** Select the entry whose value is `v`, if there is one. */
    function selectValue(v) {
        var i = indexOfValue(v)
        if (i >= 0) currentIndex = i
    }

    delegate: ItemDelegate {
        id: row
        required property var modelData
        required property int index
        readonly property bool off: typeof modelData === "object" && modelData !== null && !!modelData.disabled
        width: ListView.view ? ListView.view.width : implicitWidth
        enabled: !off
        hoverEnabled: true
        padding: 0
        topPadding: 6
        bottomPadding: 6
        leftPadding: 10
        rightPadding: 10
        highlighted: control.highlightedIndex === index
        contentItem: Text {
            text: typeof row.modelData === "object" && row.modelData !== null
                  ? (row.modelData[control.textRole] !== undefined ? row.modelData[control.textRole] : "")
                  : String(row.modelData)
            font: control.font
            color: row.off ? Theme.mut : (row.highlighted || control.currentIndex === row.index ? Theme.txt : Theme.dim)
            elide: Text.ElideRight
            verticalAlignment: Text.AlignVCenter
        }
        background: Rectangle {
            color: row.highlighted ? Theme.surfaceRaised : "transparent"
        }
    }

    indicator: Text {
        x: control.width - width - 10
        y: (control.height - height) / 2
        text: "▾"
        font.pixelSize: 10
        color: control.hovered ? Theme.txt : Theme.dim
    }

    contentItem: Text {
        leftPadding: 0
        text: control.displayText
        font: control.font
        color: Theme.txt
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
    }

    background: Item {
        implicitWidth: 140
        implicitHeight: 30
        Rectangle {
            id: box
            anchors.fill: parent
            radius: Theme.rMd
            color: Theme.surface
            border.width: 1
            border.color: control.popup.visible ? Theme.dim : Theme.lineStrong
        }
        FocusRing { target: box; targetRadius: box.radius; shown: control.visualFocus }
    }

    popup: Popup {
        y: control.height + 2
        width: control.width
        implicitHeight: Math.min(contentItem.implicitHeight + 2, 320)
        padding: 1

        contentItem: ListView {
            clip: true
            implicitHeight: contentHeight
            model: control.popup.visible ? control.delegateModel : null
            currentIndex: control.highlightedIndex
            ScrollBar.vertical: ThinScrollBar {}
        }
        background: Rectangle {
            radius: Theme.rMd
            color: Theme.panel
            border.width: 1
            border.color: Theme.lineStrong
        }
    }
}
