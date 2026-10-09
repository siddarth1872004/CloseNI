import QtQuick
import CloseNI
import "../../js/code-logic.mjs" as C

/*
 * One transcript entry, drawn by kind (see CodeStore for the kinds). `rev`
 * changes whenever CodeStore replaces the entry, which re-reads it here, so
 * only the entry that changed redraws.
 *
 * Margins are styles.css's: a user line opens a new exchange (14px above),
 * notes sit 2ch in under the ⎿ elbow, tool results under their tool.
 */
Item {
    id: root

    required property int uid
    required property string kind
    required property int rev
    required property int index

    readonly property var e: { rev; return CodeStore.entry(uid) || ({}) }
    readonly property real ch: fm.averageCharacterWidth
    readonly property bool shown: ListView.view ? ListView.view.visible : true

    width: ListView.view ? ListView.view.width - ListView.view.leftMargin - ListView.view.rightMargin : 0
    height: loader.y + loader.height + bottomGap

    readonly property int topGap: kind === "user" ? 14 : kind === "note" ? 4 : kind === "help" ? 6 : kind === "plan" ? 8 : kind === "card" ? 8 : 10
    readonly property int bottomGap: kind === "user" ? 8 : kind === "note" ? 4 : kind === "help" ? 6 : kind === "plan" ? 4 : kind === "card" ? 8 : 10
    readonly property real indent: kind === "note" || kind === "help" || kind === "plan" || kind === "card" ? 2 * ch : 0

    FontMetrics { id: fm; font.family: Theme.mono; font.pixelSize: 13 }

    Loader {
        id: loader
        x: root.indent
        y: root.topGap
        width: root.width - root.indent
        sourceComponent: ({ note: noteC, user: userC, help: helpC, msg: msgC, think: thinkC, tool: toolC,
                            plan: planC, card: cardC })[root.kind] || null
    }

    // A dot that blinks while its work runs (phase-blink, 1s in two steps),
    // and only while it can be seen and decor is on: no timer runs idle.
    component Blink: Text {
        property bool blinking: false
        opacity: 1
        Timer {
            interval: 500
            repeat: true
            running: parent.blinking
            onTriggered: parent.opacity = parent.opacity === 1 ? 0.15 : 1
            onRunningChanged: if (!running) parent.opacity = 1
        }
    }

    Component {
        id: noteC
        Row {
            spacing: root.ch
            Text { id: elbow; text: "⎿"; font: fm.font; color: Theme.mut }
            Text {
                width: parent.width - elbow.width - parent.spacing
                text: String(root.e.text || "")
                textFormat: Text.PlainText
                wrapMode: Text.WrapAtWordBoundaryOrAnywhere
                font: fm.font
                color: root.e.tone === "err" ? Theme.err : root.e.tone === "warn" ? Theme.warn
                     : root.e.tone === "dim" ? Theme.mut : Theme.dim
            }
        }
    }

    Component {
        id: userC
        Rectangle {
            implicitHeight: row.implicitHeight + 12
            color: Theme.surfaceRaised
            opacity: root.e.queued ? 0.6 : 1
            Rectangle { width: 2; height: parent.height; color: Theme.lineStrong }
            Row {
                id: row
                x: 10; y: 6
                width: parent.width - 20
                spacing: root.ch
                Text { id: caret; text: ">"; font: fm.font; color: Theme.mut }
                Text {
                    width: parent.width - caret.width - parent.spacing - (tag.visible ? tag.width + parent.spacing : 0)
                    text: String(root.e.text || "")
                    textFormat: Text.PlainText
                    wrapMode: Text.WrapAtWordBoundaryOrAnywhere
                    font: fm.font
                    color: Theme.dim
                }
                Text {
                    id: tag
                    visible: !!root.e.queued
                    text: "queued"
                    font.family: Theme.mono
                    font.pixelSize: 11
                    color: Theme.mut
                }
            }
        }
    }

    Component {
        id: helpC
        TextEdit {
            text: String(root.e.text || "")
            textFormat: TextEdit.PlainText
            readOnly: true
            selectByMouse: true
            wrapMode: TextEdit.WrapAtWordBoundaryOrAnywhere
            font: fm.font
            color: Theme.dim
            selectionColor: Theme.lineFocus
            selectedTextColor: Theme.inverse
        }
    }

    Component {
        id: msgC
        Row {
            spacing: root.ch
            Text { id: dot; text: "⏺"; font.family: Theme.mono; font.pixelSize: 11; color: Theme.txt; topPadding: 2 }
            CodeMarkdown {
                width: parent.width - dot.width - parent.spacing
                markdown: String(root.e.text || "")
            }
        }
    }

    Component {
        id: thinkC
        Column {
            spacing: 6
            Row {
                spacing: root.ch
                Blink {
                    text: "✻"
                    font: fm.font
                    color: Theme.mut
                    blinking: !!root.e.live && root.shown && Theme.animate
                }
                Text {
                    text: root.e.live ? "Thinking…" : "Thought"
                    font.family: Theme.mono
                    font.pixelSize: 13
                    font.italic: true
                    color: Theme.dim
                }
                HoverHandler { cursorShape: Qt.PointingHandCursor }
                TapHandler { onTapped: CodeStore.toggleThink(root.uid) }
            }
            // The reasoning: 2ch in, a rule on its left, 320px at most, kept
            // scrolled to its end while it grows.
            Item {
                visible: !!root.e.open
                x: 2 * root.ch
                width: parent.width - x
                height: visible ? Math.min(320, body.implicitHeight) : 0
                Rectangle { width: 2; height: parent.height; color: Theme.line }
                Flickable {
                    id: flick
                    x: 2 + 1.5 * root.ch
                    width: parent.width - x
                    height: parent.height
                    clip: true
                    contentWidth: width
                    contentHeight: body.implicitHeight
                    boundsBehavior: Flickable.StopAtBounds
                    interactive: contentHeight > height
                    onContentHeightChanged: if (root.e.live) contentY = Math.max(0, contentHeight - height)
                    CodeMarkdown {
                        id: body
                        width: flick.width
                        markdown: String(root.e.text || "")
                        font.pixelSize: 12
                        color: Theme.dim
                    }
                }
            }
        }
    }

    Component {
        id: toolC
        Column {
            id: tool
            readonly property var more: root.e.more
            spacing: 0
            Item {
                width: parent.width
                height: Math.max(dot.implicitHeight, title.implicitHeight)
                Blink {
                    id: dot
                    text: "⏺"
                    font.family: Theme.mono
                    font.pixelSize: 11
                    topPadding: 2
                    blinking: root.e.tone === "run" && root.shown && Theme.animate
                    color: root.e.tone === "ok" ? Theme.ok : root.e.tone === "err" ? Theme.err
                         : root.e.tone === "run" ? Theme.dim : Theme.mut
                }
                Text {
                    id: title
                    x: dot.width + root.ch
                    width: parent.width - x
                    text: "<b>" + esc(root.e.verb) + "</b>" + (root.e.arg ? "(" + esc(root.e.arg) + ")" : "")
                    textFormat: Text.StyledText
                    wrapMode: Text.WrapAtWordBoundaryOrAnywhere
                    font: fm.font
                    color: Theme.txt
                }
                HoverHandler { cursorShape: Qt.PointingHandCursor }
                TapHandler { onTapped: CodeStore.toggleMore(root.uid) }
            }
            Row {
                x: 2 * root.ch
                width: parent.width - x
                spacing: root.ch
                Text { id: elbow; text: "⎿"; font: fm.font; color: Theme.mut }
                Text {
                    width: parent.width - elbow.width - parent.spacing
                    text: String(root.e.summary || "")
                    textFormat: Text.PlainText
                    wrapMode: Text.WrapAtWordBoundaryOrAnywhere
                    font: fm.font
                    color: root.e.tone === "err" ? Theme.err : Theme.dim
                }
                HoverHandler { cursorShape: Qt.PointingHandCursor }
                TapHandler { onTapped: CodeStore.toggleMore(root.uid) }
            }
            // What the line folds out: the diff, the output, the todo list.
            Item { visible: !!tool.more && !!root.e.moreOpen; width: 1; height: 6 }
            Loader {
                active: !!tool.more && !!root.e.moreOpen
                visible: active
                x: 4 * root.ch
                width: parent.width - x
                sourceComponent: !tool.more ? null : tool.more.kind === "diff" ? diffC : tool.more.kind === "todos" ? todosC : outC
            }
            // The permission prompt, under the tool that asks.
            Loader {
                active: !!root.e.perm
                visible: active
                x: 2 * root.ch
                width: parent.width - x
                sourceComponent: permC
            }
            Component { id: diffC; Item { implicitHeight: d.implicitHeight; CodeDiff { id: d; width: parent.width; rows: tool.more.rows } } }
            Component { id: todosC; Item { implicitHeight: t.implicitHeight; CodeTodos { id: t; width: parent.width; items: tool.more.items } } }
            Component { id: outC; Item { implicitHeight: o.implicitHeight; CodeOut { id: o; width: parent.width; text: tool.more.text } } }
        }
    }

    Component {
        id: permC
        Item {
            implicitHeight: prompt.implicitHeight + 12
            CodePrompt {
                id: prompt
                y: 8
                width: parent.width
                readonly property var p: root.e.perm || ({})
                question: p.question || ""
                body: p.body || null
                opts: p.opts || []
                sel: p.sel || 0
                feedback: !!p.feedback
                answered: p.answered || ""
                onChosen: function (i) { CodeStore.choosePermission(i) }
                onFeedbackSent: function (text) { CodeStore.answerPermission("deny", text) }
            }
        }
    }

    Component {
        id: planC
        CodePrompt {
            question: "Ready to code?"
            ask: "Would you like to proceed with this plan?"
            opts: root.e.opts || C.PLAN_OFFER_OPTIONS
            sel: 0
            answered: root.e.answered || ""
            onChosen: function (i) { CodeStore.choosePlan(root.uid, i) }
        }
    }

    Component {
        id: cardC
        CodeCard { uid: root.uid; entry: root.e }
    }

    function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") }
}
