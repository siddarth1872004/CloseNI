import QtQuick
import QtQuick.Layouts
import CloseNI
import "../../js/code-transcript.mjs" as T

/*
 * .cc-card: what a mode's action found - tests, a run, research, git - left in
 * the transcript. Kind and summary on top, then its groups (research has a web
 * group and a GitHub group under a rule). Parts are the card's own, as
 * CodeStore built them:
 *   row      a check's verdict, language, command and first detail line
 *   out      output folded under "show output" / "hide output"
 *   hint     a quiet line
 *   actions  buttons
 *   title    a small uppercase heading
 *   answer   the web answer, markdown
 *   source   [n] url
 *   repo     a GitHub repository with its buttons
 *   gitdiff  git diff output in colour
 *   pre      any other git output
 * A card holds a bounded set: at most a project's checks, eight repositories,
 * the answer's sources.
 */
Rectangle {
    id: card

    property int uid: 0
    property var entry: ({})

    readonly property color mode: CodeStore.modeColor(entry.cardKind, Theme.lineStrong)
    readonly property string tone: entry.tone || ""
    readonly property real ch: fm.averageCharacterWidth

    implicitHeight: col.implicitHeight + 18
    color: Theme.panel
    radius: Theme.rMd
    border.width: 1
    border.color: Theme.line

    FontMetrics { id: fm; font.family: Theme.mono; font.pixelSize: 13 }

    // The left edge in the mode's colour, or pass/fail once there is a verdict.
    Rectangle {
        x: 0; y: 0
        width: 2
        height: parent.height
        radius: 0
        color: card.tone === "pass" ? Theme.ok : card.tone === "fail" ? Theme.err : card.mode
    }

    Column {
        id: col
        x: 12; y: 8
        width: card.width - 24
        spacing: 6

        Row {
            width: parent.width
            spacing: 1.5 * card.ch
            Text {
                id: kind
                text: String(card.entry.title || "")
                font.family: Theme.mono
                font.pixelSize: 11
                font.bold: true
                font.letterSpacing: 0.66
                font.capitalization: Font.AllUppercase
                color: CodeStore.modeColor(card.entry.cardKind, Theme.txt)
                anchors.baseline: sum.baseline
            }
            Text {
                id: sum
                width: parent.width - kind.width - parent.spacing
                text: String(card.entry.summary || "")
                textFormat: Text.PlainText
                elide: Text.ElideRight
                font: fm.font
                color: card.tone === "pass" ? Theme.ok : card.tone === "fail" ? Theme.err : Theme.dim
            }
        }

        Repeater {
            model: card.entry.groups || []
            Column {
                id: group
                required property var modelData
                required property int index
                width: col.width
                spacing: 6
                visible: modelData.parts.length > 0
                topPadding: modelData.sep ? 4 : 0

                Rectangle { visible: group.modelData.sep; width: parent.width; height: 1; color: Theme.line }

                Repeater {
                    model: group.modelData.parts
                    Loader {
                        id: part
                        required property var modelData
                        required property int index
                        width: group.width
                        sourceComponent: ({
                            row: rowC, out: outC, hint: hintC, actions: actionsC, title: titleC, answer: answerC,
                            source: sourceC, repo: repoC, gitdiff: gitdiffC, pre: preC,
                        })[modelData.t] || null
                        readonly property var p: modelData
                        readonly property int gi: group.index
                    }
                }
            }
        }
    }

    function langColor(language) {
        return Theme.langColor(T.langToken(language).replace("--lang-", ""))
    }

    Component {
        id: rowC
        RowLayout {
            readonly property var p: parent.p
            spacing: card.ch
            Text {
                Layout.preferredWidth: 2 * card.ch
                Layout.alignment: Qt.AlignTop
                text: p.mark
                font: fm.font
                color: p.kind === "pass" ? Theme.ok : p.kind === "fail" ? Theme.err : Theme.mut
            }
            Text {
                visible: !!p.lang
                Layout.alignment: Qt.AlignTop
                text: p.lang || ""
                font: fm.font
                color: card.langColor(p.lang)
            }
            Text {
                Layout.fillWidth: true
                Layout.alignment: Qt.AlignTop
                text: p.command
                textFormat: Text.PlainText
                wrapMode: Text.WrapAnywhere
                font: fm.font
                color: p.kind === "skip" ? Theme.mut : Theme.txt
            }
            Text {
                visible: !!p.detail
                Layout.maximumWidth: card.width * 0.5
                Layout.alignment: Qt.AlignTop
                text: p.detail || ""
                textFormat: Text.PlainText
                horizontalAlignment: Text.AlignRight
                wrapMode: Text.WrapAtWordBoundaryOrAnywhere
                font: fm.font
                color: Theme.mut
            }
        }
    }

    Component {
        id: outC
        Column {
            readonly property var p: parent.p
            readonly property int gi: parent.gi
            readonly property int pi: parent.index
            spacing: 4
            Text {
                text: p.open ? "hide output" : "show output"
                font.family: Theme.mono
                font.pixelSize: 11
                color: tap.hovered ? Theme.txt : Theme.mut
                HoverHandler { id: tap; cursorShape: Qt.PointingHandCursor }
                TapHandler { onTapped: CodeStore.toggleCardOut(card.uid, gi, pi) }
            }
            Loader {
                active: p.open
                visible: active
                width: parent.width
                sourceComponent: CodeOut { text: p.text; maxHeight: 320 }
            }
        }
    }

    Component {
        id: hintC
        Text {
            text: parent.p.text
            textFormat: Text.PlainText
            wrapMode: Text.WrapAtWordBoundaryOrAnywhere
            font: fm.font
            color: Theme.mut
        }
    }

    Component {
        id: actionsC
        Flow {
            readonly property var p: parent.p
            spacing: 6
            topPadding: 4
            Repeater {
                model: p.buttons
                CodeBtn {
                    required property var modelData
                    text: modelData.label
                    tip: modelData.tip || ""
                    onClicked: CodeStore.act(modelData)
                }
            }
        }
    }

    Component {
        id: titleC
        Text {
            text: parent.p.text
            font.family: Theme.mono
            font.pixelSize: 10
            font.letterSpacing: 1
            font.capitalization: Font.AllUppercase
            color: Theme.mut
        }
    }

    Component {
        id: answerC
        CodeMarkdown { markdown: parent.p.text }
    }

    Component {
        id: sourceC
        Text {
            readonly property var p: parent.p
            text: "<span style=\"color:" + card.mode + "\">[" + p.n + "]</span> <a href=\"" + encodeURI(p.url) + "\" style=\"color:" + Theme.txt + "\">" +
                  String(p.url).replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</a>"
            textFormat: Text.StyledText
            wrapMode: Text.WrapAnywhere
            font.family: Theme.mono
            font.pixelSize: 11
            color: Theme.dim
            linkColor: Theme.txt
            onLinkActivated: function () { App.openExternal(p.url) }
            HoverHandler { cursorShape: parent.hoveredLink ? Qt.PointingHandCursor : Qt.ArrowCursor }
        }
    }

    Component {
        id: repoC
        Column {
            readonly property var p: parent.p
            spacing: 2
            bottomPadding: 6
            topPadding: 6
            Flow {
                width: parent.width
                spacing: card.ch
                Text {
                    text: p.name
                    font.family: Theme.mono
                    font.pixelSize: 13
                    font.weight: Font.DemiBold
                    font.underline: true
                    color: Theme.txt
                    HoverHandler { cursorShape: Qt.PointingHandCursor }
                    TapHandler { onTapped: App.openExternal(p.url) }
                }
                Row {
                    Text { text: p.meta; font.family: Theme.mono; font.pixelSize: 11; color: Theme.mut; anchors.baseline: lang.baseline }
                    Text { id: lang; visible: !!p.lang; text: p.lang; font: fm.font; color: card.langColor(p.lang) }
                }
            }
            Text {
                visible: !!p.desc
                width: parent.width
                text: p.desc
                textFormat: Text.PlainText
                wrapMode: Text.WrapAtWordBoundaryOrAnywhere
                font: fm.font
                color: Theme.dim
            }
            Flow {
                width: parent.width
                spacing: 6
                topPadding: 4
                Repeater {
                    model: p.buttons
                    CodeBtn {
                        required property var modelData
                        text: modelData.label
                        tip: modelData.tip || ""
                        onClicked: CodeStore.act(modelData)
                    }
                }
            }
            // .cc-repo's dashed rule, drawn as a quiet line.
            Rectangle { width: parent.width; height: 1; color: Theme.line }
        }
    }

    Component {
        id: gitdiffC
        CodeGitDiff { lines: parent.p.lines; modeColor: card.mode }
    }

    Component {
        id: preC
        CodeOut { text: parent.p.text; maxHeight: 320 }
    }
}
