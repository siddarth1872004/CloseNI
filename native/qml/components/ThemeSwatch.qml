import QtQuick
import QtQuick.Controls.Basic
import CloseNI

/*
 * One theme in the Settings picker (.theme-swatch): a chip and the name.
 *
 * The swatch is drawn in the palette of the theme it selects rather than the
 * one currently applied - each swatch previews its own palette. Clicking it
 * applies the theme; the selected one has a text-coloured edge.
 */
AbstractButton {
    id: control

    /** An entry of Theme.themes: { id, name, decor }. */
    property var theme: ({ id: "", name: "" })
    readonly property var pal: Theme.palette(theme.id)
    readonly property bool current: Theme.current === theme.id

    objectName: "themeSwatch-" + theme.id
    hoverEnabled: true
    focusPolicy: Qt.StrongFocus
    padding: Theme.sp3
    implicitWidth: 150
    implicitHeight: 18 + 2 * Theme.sp3 + 2
    text: theme.name
    ToolTip.text: theme.name
    ToolTip.visible: hovered
    ToolTip.delay: 600

    onClicked: Theme.setTheme(theme.id)

    // Hovering steps up rather than glides, so the picker feels like the rest
    // of the app.
    transform: Translate { y: control.down ? 1 : (control.hovered ? -2 : 0) }

    contentItem: Row {
        spacing: Theme.sp3
        Rectangle {
            // The chip: the theme's page colour.
            width: 26
            height: 18
            anchors.verticalCenter: parent.verticalCenter
            radius: control.theme.id === "pixel" ? 0 : 2
            color: control.pal.bg
            border.width: 1
            border.color: control.theme.id === "terminal" ? control.pal.accent : control.pal.lineStrong
            // The swatch previews Pixel with its green gradient.
            gradient: control.theme.id === "pixel" ? pixelBands : null
        }
        Text {
            anchors.verticalCenter: parent.verticalCenter
            width: control.availableWidth - 26 - Theme.sp3
            text: control.text
            font.family: Theme.ui
            font.pixelSize: 11
            color: control.current ? control.pal.txt : control.pal.dim
            elide: Text.ElideRight
        }
    }

    Gradient {
        id: pixelBands
        GradientStop { position: 0.0; color: Theme.pxG1 }
        GradientStop { position: 0.3399; color: Theme.pxG1 }
        GradientStop { position: 0.34; color: Theme.pxG2 }
        GradientStop { position: 0.6699; color: Theme.pxG2 }
        GradientStop { position: 0.67; color: Theme.pxG3 }
        GradientStop { position: 1.0; color: Theme.pxG3 }
    }

    background: Item {
        Rectangle {
            id: box
            anchors.fill: parent
            radius: Theme.rMd
            color: control.pal.panel
            border.width: 1
            border.color: control.current ? control.pal.txt
                        : control.hovered ? control.pal.lineStrong : control.pal.line
        }
        FocusRing { target: box; targetRadius: box.radius; shown: control.visualFocus }
    }
}
