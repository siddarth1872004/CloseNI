pragma Singleton
import QtQuick
import CloseNI

/*
 * The stepped press and the stepped focus ring, one clock each for the whole
 * app. Only one control is pressed and only one focus ring is drawn at a
 * time, so the hundreds of buttons and fields share these rather than each
 * carrying an animation of its own. The control starts the clock and reads
 * `t` (0..1, whole frames only) while it is the one pressed or focused.
 */
QtObject {
    // .btn:active, .nav-btn:active, .settings-tab:active: "a stepped press,
    // so a click lands rather than glides" - transform .06s steps(2).
    readonly property PixMotion press: PixMotion { frames: 2; duration: 60 }
    // :focus-visible: "a focus ring that appears in one frame. A fading ring
    // reads as a web page" - box-shadow .06s steps(1). A field's focused edge
    // (input:focus, border-color .06s steps(1)) keeps the same time.
    readonly property PixMotion ring: PixMotion { frames: 1; duration: 60 }
}
