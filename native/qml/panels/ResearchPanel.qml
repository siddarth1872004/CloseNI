import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import CloseNI

/*
 * The Research panel: the provider's own web search beside a GitHub
 * repository search. The searching is in ShipStore.research, the answers stay
 * there too, so switching tabs mid-search loses nothing.
 */
ColumnLayout {
    id: panel
    spacing: Theme.sp4

    // .res-item: a surface box; Pixel gives it a coloured top edge, cycling
    // through the badge colours so a list reads as a row of tiles, and a hard shadow.
    component ResItem: Item {
        id: item
        property int tile: 0
        default property alias content: inner.data
        implicitHeight: inner.implicitHeight + 20 + (Theme.isPixel ? 2 : 0)
        // Arrives (pix-in) with the results that made it.
        PixMotion { id: arrive; duration: 140 }
        opacity: arrive.opacity
        transform: Translate { y: arrive.shift }
        Component.onCompleted: arrive.play()
        Rectangle {
            visible: Theme.isPixel
            x: 3; y: 3; width: parent.width; height: parent.height
            color: Theme.pxShadow
        }
        Rectangle {
            anchors.fill: parent
            radius: Theme.isPixel ? 0 : 3
            color: Theme.surface
            border.width: 1
            border.color: hover.hovered ? Theme.lineStrong : Theme.line
        }
        Rectangle {
            visible: Theme.isPixel
            width: parent.width; height: 3
            color: Theme.pxCycle(item.tile)
        }
        HoverHandler { id: hover }
        ColumnLayout {
            id: inner
            x: 10; y: 10 + (Theme.isPixel ? 2 : 0)
            width: parent.width - 20
            spacing: 0
        }
    }

    // A link: .res-item a, 12px, underlined on hover, opened in the system browser.
    component Link: Text {
        property string url: ""
        Layout.fillWidth: true
        Layout.bottomMargin: 4
        color: Theme.txt
        font.family: Theme.mono
        font.pixelSize: 12
        font.underline: linkHover.hovered
        wrapMode: Text.WrapAnywhere
        HoverHandler { id: linkHover; cursorShape: Qt.PointingHandCursor }
        TapHandler { onTapped: App.openExternal(parent.url) }
    }

    // .research-col
    component ResearchCol: Rectangle {
        default property alias content: col.data
        color: Theme.panel
        radius: Theme.isPixel ? 0 : 4
        border.width: 1
        border.color: Theme.line
        ScrollArea {
            anchors.fill: parent
            anchors.margins: 12
            ColumnLayout {
                id: col
                width: parent.width
                spacing: 8
            }
        }
    }

    Micro { text: "Research" }
    // The web half asks the provider with its own search turned on, rather
    // than scraping a results page: no selectors against a page nobody
    // controls. The GitHub half uses the token already held for push.
    Hint {
        Layout.fillWidth: true
        text: "Asks your provider with web search on, and searches GitHub with your signed-in token. Research runs in a conversation of its own, so it does not disturb the one your build is using."
    }
    RowLayout {
        Layout.fillWidth: true
        spacing: Theme.sp3
        Field {
            id: query
            objectName: "researchQuery"
            Layout.fillWidth: true
            placeholderText: "e.g. Python Flask SQLite patterns"
            text: ShipStore.researchQuery
            onTextEdited: ShipStore.researchQuery = text
            onAccepted: ShipStore.research(text)
        }
        Btn { text: "Search"; variant: "invert"; enabled: !ShipStore.researching; onClicked: ShipStore.research(query.text) }
    }

    // #research-results
    RowLayout {
        Layout.fillWidth: true
        Layout.fillHeight: true
        Layout.topMargin: 8
        spacing: 14

        ResearchCol {
            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.preferredWidth: 1

            Micro { text: "Answer"; Layout.bottomMargin: 2 }
            Hint { visible: text !== ""; Layout.fillWidth: true; text: ShipStore.researchVia }
            Hint {
                Layout.fillWidth: true
                readonly property var w: ShipStore.researchWeb
                visible: w.state === "searching" || w.state === "error"
                text: w.state === "searching" ? "searching..." : w.error
            }
            // .res-answer: the provider's markdown, natively.
            TextEdit {
                objectName: "researchAnswer"
                Layout.fillWidth: true
                visible: ShipStore.researchWeb.state === "done"
                text: ShipStore.researchWeb.answer || ""
                textFormat: TextEdit.MarkdownText
                readOnly: true
                selectByMouse: true
                wrapMode: TextEdit.Wrap
                font.family: Theme.ui
                font.pixelSize: 13
                color: Theme.dim
                selectionColor: Theme.lineFocus
                onLinkActivated: function (link) { App.openExternal(link) }
            }
            Repeater {
                model: ShipStore.researchWeb.state === "done" ? ShipStore.researchWeb.sources : []
                ResItem {
                    required property var modelData
                    required property int index
                    Layout.fillWidth: true
                    // nth-child counts the answer above, so the first source is the second tile.
                    tile: index + 1
                    Link { url: String(modelData); text: String(modelData) }
                }
            }
            Hint {
                Layout.fillWidth: true
                visible: ShipStore.researchWeb.state === "done" && !(ShipStore.researchWeb.sources || []).length
                text: "The provider cited no sources for this answer."
            }
        }

        ResearchCol {
            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.preferredWidth: 1

            Micro { text: "GitHub repos"; Layout.bottomMargin: 2 }
            Hint {
                Layout.fillWidth: true
                readonly property var g: ShipStore.researchGh
                visible: g.state === "searching" || g.state === "error"
                text: g.state === "searching" ? "searching..." : g.error
            }
            Repeater {
                model: ShipStore.researchGh.state === "done" ? ShipStore.researchGh.items : []
                ResItem {
                    id: repo
                    required property var modelData
                    required property int index
                    Layout.fillWidth: true
                    tile: index
                    Link { url: repo.modelData.url; text: repo.modelData.fullName }
                    // .res-snippet
                    Text {
                        Layout.fillWidth: true
                        text: repo.modelData.description || ""
                        color: Theme.dim
                        font.family: Theme.ui
                        font.pixelSize: 11
                        lineHeight: 1.2
                        wrapMode: Text.Wrap
                    }
                    // .res-meta
                    Text {
                        Layout.fillWidth: true
                        Layout.topMargin: 4
                        text: (repo.modelData.stars || 0) + " stars" + (repo.modelData.language ? " · " + repo.modelData.language : "")
                        color: Theme.mut
                        font.family: Theme.ui
                        font.pixelSize: 10
                        font.letterSpacing: 0.8
                        font.capitalization: Font.AllUppercase
                        elide: Text.ElideRight
                    }
                    // .res-actions
                    RowLayout {
                        Layout.topMargin: Theme.sp3
                        spacing: Theme.sp2
                        // Kept from the old panel: it pulls the repo's README and file list into
                        // the next plan's context, which is the whole reason to search for a
                        // reference implementation rather than just read one.
                        Btn { text: "Use as reference"; small: true; onClicked: ShipStore.useAsReference({ url: repo.modelData.url }) }
                        // cloneRepo reads owner/repo off the URL, which is the one field a search
                        // result and a pasted link always agree on.
                        Btn { text: "Clone"; small: true; onClicked: ShipStore.cloneRepo({ url: repo.modelData.url, title: repo.modelData.fullName }) }
                    }
                }
            }
        }
    }
}
