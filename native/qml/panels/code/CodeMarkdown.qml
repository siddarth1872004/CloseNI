import QtQuick
import CloseNI

/*
 * .cc-body.md: the model's markdown, drawn by Qt's own text engine
 * (MarkdownText) - no web engine. Selectable; links open in the system
 * browser. Inline code is not tinted with the accent: Qt's markdown has no
 * stylesheet to say so.
 */
TextEdit {
    id: md

    property string markdown: ""

    text: markdown
    textFormat: TextEdit.MarkdownText
    readOnly: true
    selectByMouse: true
    wrapMode: TextEdit.Wrap
    font.family: Theme.mono
    font.pixelSize: 13
    color: Theme.txt
    selectionColor: Theme.lineFocus
    selectedTextColor: Theme.inverse

    onLinkActivated: function (link) { App.openExternal(link) }

    HoverHandler {
        cursorShape: md.hoveredLink ? Qt.PointingHandCursor : Qt.IBeamCursor
    }
}
