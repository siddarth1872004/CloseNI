import QtQuick
import CloseNI

/*
 * A status chip or badge (.step-card-status, .run-badge): 9px uppercase in a
 * thin box. The state carries the colour:
 *   running, detected, warn         -> warn
 *   done, manifest, plan, ok        -> ok
 *   failed, none, err               -> err
 *   skipped, blocked                -> dashed (blocked also faded)
 *   anything else                   -> quiet
 *
 * `motion` is the Pixel motion builder.js put on a step's status: "stamp" (a
 * finished step stamps in), "flicker" (a failed one flickers) or "spin" (a
 * running one has a stepped | / - \ after its word). A stamp or flicker plays
 * when `motion` changes and on play(); the spin ticks only while shown.
 */
Rectangle {
    id: chip

    property string text: ""
    property string kind: ""
    property string motion: ""

    function play() { if (motion === "stamp" || motion === "flicker") pix.play() }
    onMotionChanged: play()

    PixMotion { id: pix; kind: chip.motion === "flicker" ? "flicker" : "stamp" }
    transform: Scale { origin.x: chip.width / 2; origin.y: chip.height / 2; xScale: pix.scale; yScale: pix.scale }

    readonly property string tone: {
        switch (kind) {
        case "running": case "detected": case "warn": return "warn"
        case "done": case "manifest": case "plan": case "ok": return "ok"
        case "failed": case "none": case "err": return "err"
        case "skipped": case "blocked": return "dashed"
        default: return ""
        }
    }
    readonly property color fg: tone === "warn" ? Theme.warn : tone === "ok" ? Theme.ok : tone === "err" ? Theme.err : Theme.mut
    readonly property color edge: tone === "warn" ? Theme.warnLine : tone === "ok" ? Theme.okLine : tone === "err" ? Theme.errLine : Theme.lineStrong

    implicitWidth: face.implicitWidth + 12
    implicitHeight: face.implicitHeight + 4
    radius: Theme.rSm
    color: tone === "warn" ? Theme.warnBg : tone === "ok" ? Theme.okBg : tone === "err" ? Theme.errBg : "transparent"
    border.width: tone === "dashed" ? 0 : 1
    border.color: edge
    opacity: (kind === "blocked" ? 0.7 : 1) * pix.opacity

    // A dashed edge, drawn as four rows of dashes: Rectangle has no dash style.
    Repeater {
        model: chip.tone === "dashed" ? 2 : 0
        Row {
            required property int index
            y: index ? chip.height - 1 : 0
            spacing: 2
            Repeater {
                model: Math.ceil(chip.width / 5)
                Rectangle { width: 3; height: 1; color: chip.edge }
            }
        }
    }
    Repeater {
        model: chip.tone === "dashed" ? 2 : 0
        Column {
            required property int index
            x: index ? chip.width - 1 : 0
            spacing: 2
            Repeater {
                model: Math.ceil(chip.height / 5)
                Rectangle { width: 1; height: 3; color: chip.edge }
            }
        }
    }

    Row {
        id: face
        anchors.centerIn: parent
        spacing: Theme.sp1
        Text {
            id: label
            text: chip.text
            color: chip.fg
            font.family: Theme.ui
            font.pixelSize: 9
            font.letterSpacing: 0.9
            font.capitalization: Font.AllUppercase
        }
        // .pix-spin::after: with decoration off it stays, still, as "|".
        Spinner {
            visible: chip.motion === "spin"
            running: visible
            color: chip.fg
            font.pixelSize: 9
            anchors.verticalCenter: label.verticalCenter
        }
    }
}
