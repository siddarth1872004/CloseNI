import QtQuick
import QtQuick.Layouts
import CloseNI

/*
 * Stands in for a panel until its screen is ported: the panel's name, and the
 * Electron files it comes from. Children go above the name.
 */
ColumnLayout {
    id: ph

    property string name: ""
    property string source: ""
    default property alias extra: top.data

    spacing: Theme.sp4

    ColumnLayout {
        id: top
        Layout.fillWidth: true
        spacing: Theme.sp4
    }
    Item {
        Layout.fillWidth: true
        Layout.fillHeight: true
        Column {
            anchors.centerIn: parent
            spacing: Theme.sp2
            Micro { anchors.horizontalCenter: parent.horizontalCenter; text: ph.name + " panel" }
            Hint { anchors.horizontalCenter: parent.horizontalCenter; text: "Not ported yet: " + ph.source }
        }
    }
}
