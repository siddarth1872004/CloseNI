import QtQuick
import CloseNI

/*
 * The stylesheet's event-driven motion ("Pixel motion" in desktop/styles.css),
 * for one item. Each fires when something happens and then stops; nothing
 * runs on an idle screen:
 *
 *   "in"       pix-in: a stepped fade up from 3px below (cards, rows, a panel)
 *   "stamp"    pix-stamp: scale and fade in from nothing, 4 steps in .24s
 *   "flicker"  pix-flicker: opacity 1 .25 1 .25, 2 steps a key, twice in .36s each
 *
 * steps() is the whole technique - a linear transition reads as modern UI, a
 * stepped one reads as a sprite - so `p` runs 0..1 once per play() and the
 * outputs only change on whole frames. The item binds what it needs:
 *
 *   PixMotion { id: arrive }
 *   opacity: arrive.opacity
 *   transform: Translate { y: arrive.shift }
 *
 * play() does nothing with decoration off or reduced motion (Theme.motion),
 * and between plays every output is at rest: opacity 1, scale 1, shift 0.
 *
 * A stepped transition (`transition: X .1s steps(2)`) binds `target` and
 * reads `value`, which follows the target from wherever it was in `frames`
 * jumps - or at once, with motion off:
 *
 *   PixMotion { id: turn; frames: 2; duration: 100; target: open ? 90 : 0 }
 *   rotation: turn.value
 */
QtObject {
    id: m

    property string kind: "in"
    property int frames: kind === "flicker" ? 8 : kind === "stamp" ? 4 : 3
    property int duration: kind === "flicker" ? 360 : kind === "stamp" ? 240 : 160
    // The distance "in" rises from.
    property real rise: 3

    property real p: 1
    readonly property bool running: anim.running
    readonly property int frame: p >= 1 ? frames : Math.floor(p * frames)
    readonly property real t: frame / frames

    // pix-flicker's keys at steps(2): each quarter holds its start, then the midpoint.
    readonly property var flick: [1, .625, .25, .625, 1, .625, .25, .625]
    readonly property real opacity: kind === "flicker" ? (frame >= frames ? 1 : flick[frame]) : t
    readonly property real scale: kind === "stamp" ? t : 1
    readonly property real shift: kind === "in" ? rise * (1 - t) : 0

    // The stepped transition: `value` goes from where it was to `target`.
    property real target: 0
    property real _from: 0
    property real _to: 0
    readonly property real value: _from + (_to - _from) * t
    onTargetChanged: { _from = value; _to = target; play() }
    Component.onCompleted: { _from = target; _to = target }

    function play() { if (Theme.motion) anim.restart() }
    function stop() { anim.stop(); p = 1 }

    property NumberAnimation anim: NumberAnimation {
        target: m
        property: "p"
        from: 0
        to: 1
        duration: m.duration
        loops: m.kind === "flicker" ? 2 : 1
        onStopped: m.p = 1
    }
    // Switched off mid-play: land on the end state at once.
    readonly property bool live: Theme.motion
    onLiveChanged: if (!live) stop()
}
