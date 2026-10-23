import QtQuick
import QtQuick.Controls.Basic
import CloseNI

/*
 * The modal base (#approval-modal, #browser-gate): a dimmed overlay and a
 * centred card - panel ground, strong edge, 6px corners, 20px padding and the
 * deep shadow. `cardWidth` is the CSS width; the card shrinks to fit a narrow
 * window. Children go in the card. Not dismissable by default: both modals in
 * the app wait for an answer.
 */
Popup {
    id: modal

    property int cardWidth: 520
    property int cardRadius: Theme.rLg

    parent: Overlay.overlay
    modal: true
    dim: true
    focus: true
    closePolicy: Popup.NoAutoClose
    anchors.centerIn: parent
    width: Math.min(cardWidth, (parent ? parent.width : cardWidth) - 32)
    padding: 20

    Overlay.modal: Rectangle { color: Theme.overlay }

    background: Item {
        Shadow { target: card; level: 2; hard: Theme.isPixel ? 3 : 0; radius: card.radius }
        Rectangle {
            id: card
            anchors.fill: parent
            color: Theme.panel
            radius: modal.cardRadius
            border.width: 1
            border.color: Theme.lineStrong
        }
    }
}
