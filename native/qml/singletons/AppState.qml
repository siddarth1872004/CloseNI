pragma Singleton
import QtQuick
import CloseNI
import "../js/api.mjs" as Api
import "../js/flow.mjs" as Flow
import "../js/recent-workspaces.mjs" as Recent
import "../js/onboarding.mjs" as Onboarding
import "../js/renderer-logic.mjs" as R

/*
 * State every panel reads: the panels, the workspace, its chats and the
 * getting-started guide. Panels write it through the functions here, so the flow bar, the rail and
 * the getting-started guide all redraw from one place.
 */
QtObject {
    id: state

    // ---- Panels and the top bar ---------------------------------------------
    // R.MODE_TITLES and R.FLOW_MODES, plus the Plan panel, which also shows
    // inside Chat (whose title is already "PLAN").
    function titleFor(m) { return R.MODE_TITLES[m] || (m === "plan" ? "PLAN" : "") }
    function hasFlow(m) { return !!R.FLOW_MODES[m] || m === "plan" }
    // mode -> qml/panels/<name>Panel.qml
    readonly property var panels: [
        { mode: "code", name: "Code" }, { mode: "chat", name: "Chat" }, { mode: "plan", name: "Plan" },
        { mode: "build", name: "Build" }, { mode: "test", name: "Test" }, { mode: "research", name: "Research" },
        { mode: "push", name: "Push" }, { mode: "settings", name: "Settings" }
    ]
    // The rail: one window, and plan, build, test, research and ship are modes
    // of the agent, not tabs (index.html). Their panels open from the flow bar.
    readonly property var nav: [ { mode: "code", num: "01", label: "Agent" },
                                 { mode: "settings", num: "02", label: "Settings" } ]

    property string mode: "code"
    property string statusText: "idle"
    readonly property string modeTitle: titleFor(mode)
    readonly property bool flowVisible: hasFlow(mode)
    signal tabSwitched(string mode)

    function switchTab(m) {
        if (!titleFor(m)) return
        mode = m
        tabSwitched(m)
    }
    function setStatus(t) { statusText = String(t) }

    // ---- The project --------------------------------------------------------
    property string workspace: ""
    property string provider: Providers.current
    // Fired after a workspace is opened: the build store restores its plan here.
    signal workspaceOpened(string folder)
    signal browseRequested()
    // The onboarding "Use an example" step: the chat panel fills its input.
    signal examplePromptRequested(string text)

    property var recentWorkspaces: Recent.parse(Prefs.get("closeni.recent-workspaces", "[]"))
    // path -> { total, done, missing } from Builds.workspaceProgress.
    property var recentProgress: ({})

    function saveRecent() { Prefs.set("closeni.recent-workspaces", JSON.stringify(recentWorkspaces)) }
    function recentState(path) { return Recent.describe(recentProgress[path]) }
    function pathTail(p) { return R.recentLabel(String(p)) }
    function chatTitle(chat, i) { return R.chatTitle(chat, i) }

    function refreshRecent() {
        if (!recentWorkspaces.length) { recentProgress = {}; return }
        // One call for the whole list: eight round-trips to draw eight lines is waste.
        Builds.workspaceProgress(recentWorkspaces, function (r) {
            recentProgress = r && r.ok ? (r.progress || {}) : {}
        })
    }

    /**
     * Switch to a workspace: the one path Browse and the recent list both go
     * through, so a project opened either way is opened identically. Restoring
     * only - nothing runs until the user asks.
     */
    function openWorkspace(folder) {
        if (!folder) return
        // The old project's conversation goes before anything of the new one
        // arrives: a save in between would file it under the new project.
        _chatReady = false
        chatHistory = []
        currentPlan = null
        activeChat = ""
        chats = []
        chatCleared()
        workspace = folder
        // A different project has not been run or shipped from here yet.
        flowTested = false
        flowShipped = false
        Notify.log("workspace: " + folder, "ok")
        recentWorkspaces = Recent.remember(recentWorkspaces, folder)
        saveRecent()
        _openChat(folder, null)
        workspaceOpened(folder)
        refreshRecent()
    }
    function forgetWorkspace(path) {
        recentWorkspaces = Recent.forget(recentWorkspaces, path)
        saveRecent()
        refreshRecent()
    }
    function browse() { browseRequested() }

    // ---- Conversation ---------------------------------------------------------
    // The Chat panel's conversations in this workspace. The list and which one
    // is open live in sessions.json, shared with the agent (it adds a chat the
    // first time a message creates its thread); what the panel showed in each,
    // messages and plan, is kept by Files.saveTranscript. One chat is open at a
    // time, and its provider thread is the one Chat, Plan, Build and Code use.

    // [{ url, title, createdAt, provider }], oldest first.
    property var chats: []
    // The open chat's url; "" for a new chat that has not been sent to yet.
    property string activeChat: ""
    readonly property int currentChatIndex: _indexOf(chats, activeChat)
    // The chat transcript the next plan is built from (chat panel), and the plan.
    property var chatHistory: []
    property var currentPlan: null
    // A GitHub repository taken as reference from Research ({ name, readme, files },
    // R.referenceFrom): the next plan request folds it in (R.planRequest).
    property var repoReference: null
    // False while a workspace's chat is being loaded: nothing is saved until
    // the conversation on screen really is that chat's.
    property bool _chatReady: false
    signal chatCleared()
    // A chat's messages, put back on screen (PlanState draws them).
    signal chatRestored(var messages)

    function _indexOf(list, url) {
        if (!url) return -1
        for (var i = 0; i < list.length; i++) if (list[i].url === url) return i
        return -1
    }
    function loadChats(then) {
        var ws = workspace
        if (!ws) return
        Files.getChats(ws, function (res) {
            if (ws !== workspace) return
            chats = (res && res.chats) || []
            if (then) then((res && res.activeChat) || "")
        })
    }

    /**
     * Why the open chat cannot change now, or "". A reply on its way belongs to
     * the chat it was asked in, and a build or a Code turn is using its thread.
     */
    function chatBusyReason() {
        if (PlanState.busy > 0) return "Wait for the reply to finish"
        if (BuildState.running) return "Wait for the build to finish"
        if (CodeStore.busy || CodeStore.running) return "Wait for the Code panel to finish"
        return ""
    }
    function _guard() {
        if (!workspace) { Notify.toast("Pick a workspace", "err"); return false }
        var why = chatBusyReason()
        if (why) { Notify.toast(why, "err"); return false }
        return true
    }
    // The Code panel's session holds the old thread open in its browser: it
    // yields, and its next message reopens on the chat now open.
    function _releaseThread() {
        if (CodeStore.up) { Agent.codeEnd(function () {}); CodeStore.up = false }
    }

    /**
     * Show `key`'s saved messages and plan. `chat` is the list entry, for the
     * thread label; the plan is only taken when the build did not bring one
     * back, since the build's statuses are the ones that count.
     */
    function _openChat(ws, chat) {
        var load = function (key) {
            Files.loadTranscript(ws, key, function (t) {
                if (ws !== workspace) return
                activeChat = key
                chatHistory = (t && t.messages) || []
                if (t && t.plan && t.plan.steps) { if (chat || !currentPlan) PlanState.showPlan(t.plan, true) }
                else if (chat) currentPlan = null
                chatRestored(chatHistory)
                _showThread(key)
                _chatReady = true
            })
        }
        if (chat) { load(chat.url); return }
        loadChats(load)
    }

    // The rail's "Open chat in browser" and thread line follow the open chat.
    function _showThread(url) { Providers.setThread(url ? { url: url, label: R.describeThread(url) } : null) }

    function _saveNow() {
        if (!_chatReady || !workspace) return
        Files.saveTranscript(workspace, activeChat, chatHistory, currentPlan, function (r) {
            if (r && r.ok === false) Notify.log("Could not save the chat: " + (r.error || "write failed"), "err")
        })
    }
    onChatHistoryChanged: if (_chatReady) Qt.callLater(_saveNow)
    onCurrentPlanChanged: if (_chatReady) Qt.callLater(_saveNow)

    /**
     * After a reply: the agent may have opened a thread for a new chat (or
     * moved to a fresh one), so the list is read again, the transcript filed
     * under the thread it now belongs to, and an untitled chat named after its
     * first message.
     */
    function syncChat() {
        var ws = workspace
        loadChats(function (now) {
            if (now && now !== activeChat) {
                var from = activeChat
                activeChat = now
                _saveNow()
                if (!from) Files.saveTranscript(ws, "", [], null, function () {})
            }
            if (!now) return
            _showThread(now)
            var i = _indexOf(chats, now)
            if (i >= 0 && chats[i].title) return
            var first = ""
            for (var k = 0; k < chatHistory.length && !first; k++) if (chatHistory[k].role === "user") first = chatHistory[k].text
            Files.nameChat(ws, now, R.chatName(first) || ("Chat " + (chats.length + (i >= 0 ? 0 : 1))), function () { loadChats() })
        })
    }

    /** Open a saved chat: its messages, its plan and its provider thread. */
    function switchChat(url) {
        if (url === activeChat || !_guard()) return
        var chat = chats[_indexOf(chats, url)]
        if (!chat) return
        var ws = workspace
        Files.switchChat(ws, url, function (r) {
            if (!r || !r.ok) { Notify.toast((r && r.error) || "Could not open the chat", "err"); return }
            _releaseThread()
            // A chat lives on the provider it was made with.
            if (chat.provider && chat.provider !== Providers.current
                    && Providers.list.some(function (p) { return p.id === chat.provider })) Providers.select(chat.provider)
            _chatReady = false
            chatCleared()
            _openChat(ws, chat)
            Notify.log("Switched to chat: " + chatTitle(chat, _indexOf(chats, url)), "ok")
        })
    }

    /**
     * Start a new chat. Clearing activeChat in sessions.json is only half of it:
     * the transcript and the plan are cleared too, or the old conversation still
     * goes into the next plan. The chat it leaves stays in the list.
     */
    function newChat() {
        if (!_guard()) return
        if (!activeChat && chatHistory.length === 0 && !currentPlan) { Notify.toast("This is already a new chat"); return }
        var ws = workspace
        Files.newChat(ws, function (r) {
            if (!r || !r.ok) { Notify.toast((r && r.error) || "Could not start a new chat", "err"); return }
            _releaseThread()
            _chatReady = false
            activeChat = ""
            chatHistory = []
            currentPlan = null
            chatCleared()
            _showThread("")
            Files.saveTranscript(ws, "", [], null, function () { _chatReady = true })
            loadChats()
            Notify.toast("Started a new chat")
            Notify.log("new chat started - transcript cleared", "ok")
        })
    }

    function renameChat(url, title) {
        var name = String(title || "").trim()
        if (!workspace || !url || !name) return
        Files.nameChat(workspace, url, name, function (r) {
            if (!r || !r.ok) { Notify.toast("Could not rename the chat", "err"); return }
            loadChats()
        })
    }

    /** Drop a chat from the list. The provider's own copy of the thread stays. */
    function deleteChat(url) {
        if (!workspace || !url) return
        var open = url === activeChat
        if (open && !_guard()) return
        Files.deleteChat(workspace, url, function (r) {
            if (!r || !r.ok) { Notify.toast("Could not delete the chat", "err"); return }
            if (open) {
                _releaseThread()
                _chatReady = false
                activeChat = ""
                chatHistory = []
                currentPlan = null
                chatCleared()
                _showThread("")
                _chatReady = true
            }
            loadChats()
            Notify.toast("Chat removed")
        })
    }

    // ---- The flow bar ----------------------------------------------------------
    // Written where the state really changes, never on a timer.
    property int userMessages: 0
    // { total, done, failed, running } from the build panel.
    property var buildStats: ({})
    property bool flowTested: false
    property bool flowShipped: false
    function markTested() { flowTested = true }
    function markShipped() { flowShipped = true }

    readonly property var flowStages: Flow.stages(R.flowSnapshot(userMessages, !!currentPlan, buildStats,
                                                                 { tested: flowTested, shipped: flowShipped }))
    function flowMark(st, i) { return R.flowMark(st, i) }
    function flowTitle(st) { return R.flowTitle(st) }

    // ---- Browser and the getting-started guide ------------------------------
    // Written by the browser gate and the account light - never by the guide.
    property bool browserReady: true
    property bool gateOpen: false
    property string onboardingStored: Prefs.get(Onboarding.DISMISS_KEY, "")
    readonly property bool onboardingDismissed: Onboarding.isDismissed(onboardingStored)

    readonly property var onboardingState: R.onboardingState(Providers.list, Providers.current, browserReady,
                                                             workspace, Providers.acct, chatHistory.length, chats.length)
    readonly property var onboardingSteps: Onboarding.steps(onboardingState)
    readonly property string onboardingCurrent: Onboarding.current(onboardingState) || ""
    readonly property bool onboardingVisible: Onboarding.visible(onboardingState, onboardingDismissed)
    readonly property string examplePrompt: Onboarding.EXAMPLE_PROMPT

    function onboardingAction(id) {
        if (id === "browser") { gateOpen = true; return }
        if (id === "workspace") { browse(); return }
        if (id === "signin") {
            if (Providers.acct === "unknown") Providers.refreshAccount(true)
            else Providers.signIn()
            return
        }
        if (id === "prompt") {
            examplePromptRequested(Onboarding.EXAMPLE_PROMPT)
            Notify.toast("Example filled in - press Send")
        }
    }
    function dismissOnboarding() {
        Prefs.set(Onboarding.DISMISS_KEY, "dismissed")
        onboardingStored = "dismissed"
    }
    /** Settings' "Show the getting-started guide again". */
    function resetOnboarding() {
        Prefs.remove(Onboarding.DISMISS_KEY)
        onboardingStored = ""
    }

    /*
     * First run: without a browser the app can do nothing at all, so the gate
     * blocks rather than failing later at the first sign-in. A status that
     * cannot be read (a stub, an error) counts as ready.
     */
    function checkBrowser() {
        Agent.browserStatus(function (status) {
            if (!status || status.ready !== false) return
            browserReady = false
            gateOpen = true
        })
    }

    /** Launch work, in startup.js's order. */
    function start(initialWorkspace, initialProvider) {
        Providers.load(initialProvider)
        refreshRecent()
        if (initialWorkspace) openWorkspace(initialWorkspace)
        else if (recentWorkspaces.length) openWorkspace(recentWorkspaces[0])
        checkBrowser()
    }
}
