import QtQuick
import CloseNI

/*
 * #toast-stack: Notify.toasts, top right, newest last, 8px apart. Each toast
 * removes itself from the model when its time is up.
 */
Column {
    id: stack

    spacing: 8
    z: 80

    Repeater {
        model: Notify.toasts
        Toast {
            // Toast's own msg and kind, filled from the model's roles.
            required msg
            required kind
            required property int tid
            anchors.right: parent ? parent.right : undefined
            onExpired: Notify.dropToast(tid)
        }
    }
}
