import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import CloseNI

/*
 * .btn and its variants from styles.css: plain (outline), invert (filled),
 * primary (accent outline), small (.btn-sm), block (.btn-block, fills a
 * layout's width) and the on/off pair (checkable). Uppercase and letter-spaced,
 * with the two-layer focus ring, and Pixel's square corners and hard shadow.
 */
Button {
    id: control

    property string variant: ""      // "" | "invert" | "primary"
    property bool small: false
    property bool block: false
    property string tip: ""
    // The on/off pair: off reads quiet, on takes the accent.
    readonly property bool isOn: checkable && checked

    readonly property bool lit: hovered && enabled
    readonly property color fg: {
        if (variant === "invert") return Theme.inverse
        if (Theme.isPixel && lit) return Theme.pxG1
        if (variant === "primary" || isOn) return Theme.accent
        if (checkable) return lit ? Theme.txt : Theme.mut
        return lit ? Theme.txt : Theme.dim
    }
    readonly property color edge: {
        if (variant === "invert") return Theme.invertBg
        if (Theme.isPixel && lit) return Theme.pxG2
        if (variant === "primary" || isOn) return Theme.accent
        if (checkable) return lit ? Theme.txt : Theme.line
        return lit ? Theme.txt : Theme.lineStrong
    }

    Layout.fillWidth: block
    implicitWidth: Math.max(implicitBackgroundWidth, implicitContentWidth + leftPadding + rightPadding)
    implicitHeight: Math.max(implicitBackgroundHeight, implicitContentHeight + topPadding + bottomPadding)
    leftPadding: small ? Theme.sp3 : 14
    rightPadding: small ? Theme.sp3 : 14
    topPadding: small ? Theme.sp1 : Theme.sp3
    bottomPadding: small ? Theme.sp1 : Theme.sp3
    opacity: enabled ? 1 : 0.35
    focusPolicy: Qt.StrongFocus
    hoverEnabled: true

    font.family: Theme.ui
    font.pixelSize: small ? 10 : 11
    font.weight: variant === "invert" ? Font.DemiBold : Font.Normal
    font.letterSpacing: (small ? 10 : 11) * 0.08
    font.capitalization: Font.AllUppercase

    ToolTip.visible: tip !== "" && hovered
    ToolTip.text: tip
    ToolTip.delay: 600

    contentItem: Text {
        text: control.text
        font: control.font
        color: control.fg
        horizontalAlignment: Text.AlignHCenter
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
    }

    background: Item {
        implicitHeight: control.small ? 22 : 32
        // Pixel's 2px hard shadow; pressing pushes the block onto it.
        Rectangle {
            visible: Theme.isPixel && !control.down
            x: 2; y: 2; width: parent.width; height: parent.height
            color: Theme.pxShadow
        }
        Rectangle {
            id: face
            readonly property int push: Theme.isPixel && control.down ? 2 : 0
            x: push; y: push
            width: parent.width; height: parent.height
            radius: Theme.rMd
            color: control.variant === "invert"
                   ? (control.lit ? Qt.lighter(Theme.invertBg, 1.15) : Theme.invertBg)
                   : (Theme.isPixel ? Theme.bg : "transparent")
            border.width: 1
            border.color: control.edge
        }
        FocusRing { target: face; targetRadius: face.radius; shown: control.visualFocus }
    }
}
