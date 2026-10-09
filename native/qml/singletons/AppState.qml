pragma Singleton
import QtQuick
import CloseNI
import "../js/api.mjs" as Api
import "../js/flow.mjs" as Flow
import "../js/recent-workspaces.mjs" as Recent
import "../js/onboarding.mjs" as Onboarding
import "../js/renderer-logic.mjs" as R

/*
 * State every panel reads, from desktop/renderer/core.js, workspace.js,
 * chats.js, the onboarding half of account.js and window.CN in startup.js.
 * Panels write it through the functions here, so the flow bar, the rail and
 * the getting-started guide all redraw from one place.
 */
QtObject {
    id: state

    // ---- Panels and the top bar ---------------------------------------------
    // R.MODE_TITLES and R.FLOW_MODES, plus the Plan panel, which Electron drew
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
        workspace = folder
        // A different project has not been run or shipped from here yet.
        flowTested = false
        flowShipped = false
        Notify.log("workspace: " + folder, "ok")
        recentWorkspaces = Recent.remember(recentWorkspaces, folder)
        saveRecent()
        loadChats()
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
    // [{ title, url, ... }] saved for this workspace; -1 is "+ New Chat".
    property var chats: []
    property int currentChatIndex: -1
    // The chat transcript the next plan is built from (chat panel), and the plan.
    property var chatHistory: []
    property var currentPlan: null
    // A GitHub repository taken as reference from Research ({ name, readme, files },
    // R.referenceFrom): the next plan request folds it in (R.planRequest).
    property var repoReference: null
    signal chatCleared()

    function loadChats() {
        if (!workspace) return
        Files.getChats(workspace, function (res) {
            chats = (res && res.chats) || []
            currentChatIndex = -1
        })
    }
    /** The rail's chat select: "new" or an index into chats. */
    function selectChat(value) {
        if (value === "new") {
            Files.newChat(workspace, function (r) {
                if (r && r.ok === false && r.error) { Notify.log("Could not start new chat: " + r.error, "err"); return }
                currentChatIndex = -1
                Notify.toast("Started new chat")
                Notify.log("New chat started", "ok")
            })
            return
        }
        var i = parseInt(value)
        var chat = chats[i]
        if (!chat) return
        currentChatIndex = i
        Files.switchChat(workspace, chat.url, function (r) {
            if (r && r.ok === false && r.error) { Notify.log("Could not switch chat: " + r.error, "err"); return }
            Notify.toast("Switched to: " + chat.title)
            Notify.log("Switched to chat: " + chat.title, "ok")
        })
    }
    /**
     * Start a new chat. Clearing activeChat in sessions.json is only half of it:
     * the transcript and the plan are cleared too, or the old conversation still
     * goes into the next plan.
     */
    function newChat() {
        if (!workspace) { Notify.toast("Pick a workspace", "err"); return }
        Files.newChat(workspace, function (r) {
            if (!r || !r.ok) { Notify.toast((r && r.error) || "Could not start a new chat", "err"); return }
            chatHistory = []
            currentChatIndex = -1
            currentPlan = null
            chatCleared()
            loadChats()
            Notify.toast("Started new chat")
            Notify.log("new chat started - transcript cleared", "ok")
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
     * cannot be read (a stub, an error) counts as ready, as in Electron.
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
