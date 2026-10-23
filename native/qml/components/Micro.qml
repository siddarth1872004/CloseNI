import QtQuick
import CloseNI

/** .micro: the small uppercase label above a group. */
Text {
    font.family: Theme.mono
    font.pixelSize: Theme.microSize
    font.letterSpacing: Theme.microSpacing
    font.capitalization: Font.AllUppercase
    color: Theme.mut
    elide: Text.ElideRight
}
