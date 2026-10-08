import QtQuick
import CloseNI

/** Body text in the theme's body font and size. */
Text {
    font.family: Theme.ui
    font.pixelSize: Theme.bodySize
    color: Theme.txt
    wrapMode: Text.Wrap
}
