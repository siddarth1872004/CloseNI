import QtQuick
import CloseNI

/*
 * The rail's conversations end to end (loaded by --ui-script; driven by
 * native/tests/chats-e2e.cjs against the mock provider, which gives every new
 * chat a thread of its own):
 *
 *   send -> the chat is listed, named after its first message -> New Chat
 *   clears the screen and keeps it listed -> a second chat -> switching back
 *   shows the first chat's messages, and its next message goes to its thread
 *   -> a reply on its way keeps the chat from changing -> rename -> remove.
 *
 * With "phase=restore" it checks instead that a restart brings back the open
 * chat, its messages and its name. Screenshots go to the last argument.
 * Prints "E2E PASS" and exits 0, or "E2E FAIL <stage>" and exits 1.
 */
Item {
    id: flow

    property var root: null
    readonly property var args: Qt.application.arguments
    readonly property string shots: args[args.length - 1]
    readonly property bool restore: args.indexOf("phase=restore") !== -1

    property var stages: []
    property int at: -1
    property int ticks: 0
    property bool acted: false
    property string first: ""

    function find(item, name) {
        if (!item) return null
        if (item.objectName === name) return item
        var kids = item.children || []
        for (var i = 0; i < kids.length; i++) {
            var hit = find(kids[i], name)
            if (hit) return hit
        }
        return null
    }
    function main(name) { return find(root.contentItem, name) }
    function say(text) {
        flow.main("chatInput").text = text
        flow.main("chatSend").clicked()
    }
    function replied(n) {
        var b = PlanState.bubbles
        return PlanState.busy === 0 && b.count === n && b.get(b.count - 1).text !== "..."
    }
    function titles() { return AppState.chats.map(function (c) { return c.title }).join("|") }

    function stage(name, act, until, ms) { return { name: name, act: act, until: until, ms: ms || 60000 } }
    function shots2(what) {
        var s = []
        ;["terminal", "pixel"].forEach(function (t) {
            s.push(stage("theme " + t, function () { Theme.setTheme(t) }, function () { return flow.ticks >= 8 }))
            s.push(stage("shot " + what + " " + t, function () {
                flow.root.selfTestShot(flow.shots + "/chats-" + what + "-" + t + ".png")
            }, function () { return true }))
        })
        return s
    }

    function build() {
        var s = []
        s.push(stage("ready", function () {
            Theme.setTheme("terminal")
            AppState.switchTab("chat")
        }, function () {
            return AppState.workspace !== "" && Providers.list.length > 0 && flow.main("chatInput") !== null && AppState._chatReady
        }))
        s.push(stage("provider", function () { Providers.current = "mock" }, function () { return Providers.current === "mock" }))

        if (restore) {
            s.push(stage("restored", function () {}, function () {
                return AppState.chats.length === 1 && AppState.activeChat === AppState.chats[0].url
                    && AppState.chats[0].title === "Todo app"
                    && PlanState.bubbles.count === 6 && AppState.chatHistory.length === 6
                    && PlanState.bubbles.get(0).text === "Build a todo app with tags"
                    && Providers.thread !== null
            }, 20000))
            return s
        }

        s.push(stage("send1", function () { flow.say("Build a todo app with tags") }, function () {
            return flow.replied(2) && AppState.activeChat !== "" && AppState.chats.length === 1
                && AppState.chats[0].title === "Build a todo app with tags" && AppState.chats[0].url === AppState.activeChat
        }, 120000))
        s.push(stage("new", function () { flow.first = AppState.activeChat; AppState.newChat() }, function () {
            return AppState.activeChat === "" && PlanState.bubbles.count === 0 && AppState.chatHistory.length === 0
                && AppState.chats.length === 1 && Providers.thread === null
        }))
        s.push(stage("send2", function () { flow.say("A tiny weather CLI") }, function () {
            return flow.replied(2) && AppState.chats.length === 2 && AppState.activeChat === AppState.chats[1].url
                && AppState.chats[1].title === "A tiny weather CLI"
        }, 120000))
        s = s.concat(shots2("list"))
        s.push(stage("switch", function () { AppState.switchChat(flow.first) }, function () {
            return AppState.activeChat === flow.first && PlanState.bubbles.count === 2 && AppState.chatHistory.length === 2
                && PlanState.bubbles.get(0).text === "Build a todo app with tags"
        }))
        s.push(stage("continue", function () { flow.say("Add due dates") }, function () {
            return flow.replied(4) && AppState.activeChat === flow.first && AppState.chats.length === 2
        }, 120000))
        // A reply on its way: New Chat, switching and removing the open chat
        // all refuse, and the reply lands in the chat it was asked in.
        s.push(stage("guard", function () {
            flow.say("And a dark theme")
            AppState.newChat()
            AppState.switchChat(AppState.chats[1].url)
            AppState.deleteChat(flow.first)
        }, function () {
            return flow.replied(6) && AppState.activeChat === flow.first && AppState.chats.length === 2
                && AppState.chatHistory.length === 6
        }, 120000))
        s.push(stage("rename", function () { AppState.renameChat(flow.first, "  Todo app ") }, function () {
            return AppState.chats[0].title === "Todo app"
        }))
        s.push(stage("remove", function () { AppState.deleteChat(AppState.chats[1].url) }, function () {
            return AppState.chats.length === 1 && AppState.activeChat === flow.first && PlanState.bubbles.count === 6
        }))
        s = s.concat(shots2("open"))
        return s
    }

    Timer {
        interval: 50
        repeat: true
        running: flow.root !== null
        onTriggered: {
            if (flow.at < 0) { flow.stages = flow.build(); flow.at = 0; flow.ticks = 0; flow.acted = false; console.log("E2E stage " + flow.stages[0].name) }
            var st = flow.stages[flow.at]
            flow.ticks++
            if (!flow.acted) {
                if (flow.ticks < 3) return
                flow.acted = true
                flow.ticks = 0
                st.act()
                return
            }
            if (st.until()) {
                flow.at++
                flow.ticks = 0
                flow.acted = false
                if (flow.at >= flow.stages.length) {
                    stop()
                    console.log("E2E PASS")
                    Qt.exit(0)
                    return
                }
                console.log("E2E stage " + flow.stages[flow.at].name)
            } else if (flow.ticks * 50 > st.ms) {
                stop()
                console.log("E2E FAIL " + st.name + " (active " + AppState.activeChat + ", chats " + flow.titles()
                            + ", bubbles " + PlanState.bubbles.count + ", history " + AppState.chatHistory.length
                            + ", busy " + PlanState.busy + ")")
                var log = Notify.agentLog
                for (var i = Math.max(0, log.count - 25); i < log.count; i++)
                    console.log("E2E LOG " + log.get(i).line)
                Qt.exit(1)
            }
        }
    }
}
