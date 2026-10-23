import QtQuick
import QtQuick.Layouts
import CloseNI

/*
 * The clone confirmation (ship.js cloneRepo's confirm()): it opens when
 * ShipStore.cloneRepo has a clone waiting, and the answer goes back through
 * ShipStore.answerClone. The licence is the user's to accept, so it goes in
 * front of them rather than into a doc they will not read.
 */
Modal {
    id: modal

    cardWidth: 460

    Connections {
        target: ShipStore
        // It follows the pending clone: answered from here or anywhere else, it goes.
        function onPendingCloneChanged() { if (ShipStore.pendingClone) modal.open(); else modal.close() }
    }

    function answer(yes) { ShipStore.answerClone(yes) }

    contentItem: ColumnLayout {
        spacing: 0
        Micro { text: "Clone" }
        Text {
            Layout.fillWidth: true
            Layout.topMargin: 8
            Layout.bottomMargin: 14
            text: ShipStore.cloneQuestion
            wrapMode: Text.Wrap
            font.family: Theme.ui
            font.pixelSize: 12
            color: Theme.dim
        }
        RowLayout {
            spacing: 8
            Btn { text: "Clone"; variant: "invert"; onClicked: modal.answer(true) }
            Btn { text: "Cancel"; onClicked: modal.answer(false) }
        }
    }
}
