pragma Singleton
import QtQuick
import CloseNI
import "../js/renderer-logic.mjs" as R

/*
 * The conversation and the plan: desktop/renderer/plan.js, without the DOM.
 * The Chat panel draws the bubbles and the Plan panel the document; both live
 * here so a reply that arrives after the user has moved on still lands, and
 * coming back shows the conversation as it was.
 */
QtObject {
    id: ps

    // The chat column's bubbles: { bid, who: "user"|"ai", text, md }. md marks
    // an answer drawn as markdown. Bounded: the transcript the plan is made
    // from is AppState.chatHistory, so this is only what is on screen.
    property ListModel bubbles: ListModel {}
    readonly property int maxBubbles: 1000
    property int _nextBubble: 1

    // The chat input's text, kept while the panel is closed.
    property string draft: ""
    // "Suggest Changes": the next message revises the plan instead of chatting.
    property bool editingPlan: false
    property bool sidebarOpen: false
    property int busy: 0
    // A repository picked in Research rides along with the next plan, so the
    // plan is designed against how a real project of that kind is laid out:
    // { name, readme, files } (R.referenceFrom). Set by the Research panel.
    property var repoReference: null

    readonly property string inputPlaceholder: editingPlan ? "Describe changes to the plan..." : "Ask anything..."
    readonly property string sendLabel: editingPlan ? "Update Plan" : "Send"
    readonly property string editLabel: editingPlan ? "Cancel" : "Suggest Changes"

    function _countUsers() {
        var n = 0
        for (var i = 0; i < bubbles.count; i++) if (bubbles.get(i).who === "user") n++
        AppState.userMessages = n
    }
    function addBubble(who, text) {
        var bid = _nextBubble++
        bubbles.append({ bid: bid, who: who, text: String(text), md: who === "ai" && String(text).length > 40 })
        if (bubbles.count > maxBubbles) bubbles.remove(0, bubbles.count - maxBubbles)
        _countUsers()
        return bid
    }
    // By id, not index: the oldest bubbles may have been dropped meanwhile.
    function setBubble(bid, text, md) {
        for (var i = bubbles.count - 1; i >= 0; i--) {
            if (bubbles.get(i).bid === bid) {
                bubbles.set(i, { text: String(text), md: !!md })
                return
            }
        }
    }
    function _remember(role, text) {
        AppState.chatHistory = AppState.chatHistory.concat([{ role: role, text: text }])
    }

    function resetEditState() { editingPlan = false }

    /**
     * Show the plan document.
     *
     * `keepBuild` matters more than it looks. This ends by handing the plan to
     * the builder, which rebuilds its step list with every status set to
     * pending - correct for a plan that has just been generated, and
     * destructive for one that has just been RESTORED, where the statuses are
     * the whole point.
     *
     * That was a live bug from the moment resume landed: opening a workspace
     * with a half-finished build showed every step pending, so pressing Build
     * would have redone all of it. It went unnoticed because restoreBuild's own
     * log line said "7/18 already done" while the cards beside it said
     * otherwise.
     */
    function showPlan(plan, keepBuild) {
        AppState.currentPlan = plan
        sidebarOpen = true
        // Skipped when restoring: restoreBuild has already populated the
        // builder, statuses and all, and setPlan would reset every one of them
        // to pending.
        if (!keepBuild) BuildState.setPlan(plan)
    }
    function closePlan() { sidebarOpen = false }

    /**
     * Apply one edit to the plan in memory, then redraw.
     *
     * Every operation goes through plan-edit, which remaps dependsOn. Editing
     * the array here directly would leave indices pointing at whatever moved
     * into that slot - a graph that fails validation, falls back to the plain
     * chain, and silently undoes the scheduler work that lets independent steps
     * survive a failure.
     */
    function editPlanStep(act, i) {
        if (!AppState.currentPlan) return
        var res = R.applyPlanEdit(AppState.currentPlan, act, i)
        if (!res) return
        if (res.refused) { Notify.toast(res.refused, "err"); Notify.log("edit refused: " + res.refused, "err"); return }
        ;(res.notes || []).forEach(function (n) { Notify.log("plan: " + n, "step") })
        showPlan(res.plan, false)
    }

    function send(raw) {
        var text = String(raw || "").trim()
        if (!text) return
        var ws = AppState.workspace
        if (!ws) { Notify.toast("Pick a workspace first", "err"); return }
        var provider = Providers.current

        if (editingPlan && AppState.currentPlan) {
            addBubble("user", text)
            draft = ""
            var eph = addBubble("ai", "...")
            busy++
            AppState.setStatus("updating plan")
            BuildState.runAgent(["revise", text, ws, provider]).then(function (res) {
                ps.busy--
                AppState.setStatus("idle")
                if (res && res.plan && res.plan.steps) {
                    ps.showPlan(res.plan, false)
                    ps.setBubble(eph, "Plan updated: " + (res.plan.summary || "") + " (" + res.plan.steps.length + " steps)", false)
                    Notify.toast("Plan updated")
                } else {
                    ps.setBubble(eph, "Plan update failed: " + ((res && res.error) || "unknown"), false)
                    Notify.toast("Plan update failed", "err")
                }
                ps.resetEditState()
                ps._remember("user", text)
            })
            return
        }

        addBubble("user", text)
        draft = ""
        var ph = addBubble("ai", "...")
        busy++
        AppState.setStatus("agent working")
        BuildState.runAgent(["chat", text, ws, provider]).then(function (res) {
            ps.busy--
            AppState.setStatus("idle")
            var reply
            if (res && res.answer) {
                reply = res.answer
                ps.setBubble(ph, reply, true)
                var p = R.tryExtractPlan(res.answer)
                if (p) { ps.showPlan(p, false); Notify.toast("Plan detected") }
            } else {
                reply = "AI reply failed: " + ((res && res.error) || "unknown")
                ps.setBubble(ph, reply, false)
            }
            ps._remember("user", text)
            ps._remember("ai", reply)
        })
    }

    function generatePlan() {
        var ws = AppState.workspace
        if (!ws) { Notify.toast("Pick a workspace first", "err"); return }
        if (AppState.chatHistory.length === 0) { Notify.toast("Chat about your idea first", "err"); return }
        var request = R.planRequest(AppState.chatHistory, repoReference)
        AppState.setStatus("generating plan")
        addBubble("ai", "Generating implementation plan...")
        busy++
        BuildState.runAgent(["plan", request, ws, Providers.current]).then(function (res) {
            ps.busy--
            AppState.setStatus("idle")
            if (res && res.plan && res.plan.steps) {
                ps.showPlan(res.plan, false)
                Notify.toast("Plan ready: " + res.plan.steps.length + " steps")
            } else {
                Notify.toast("Plan failed: " + ((res && res.error) || "unknown"), "err")
            }
        })
    }

    /** True when editing was switched on, so the caller can focus the input. */
    function toggleEdit() {
        if (!AppState.currentPlan) { Notify.toast("No plan to edit", "err"); return false }
        editingPlan = !editingPlan
        return editingPlan
    }

    function buildWithPlan() {
        if (!AppState.currentPlan) { Notify.toast("No plan", "err"); return }
        AppState.switchTab("build")
        BuildState.setPlan(AppState.currentPlan)
        BuildState.startBuild()
    }

    property Connections _app: Connections {
        target: AppState
        // New chat: the conversation, the plan document and the sidebar go
        // (chats.js); AppState has already cleared the transcript and plan.
        function onChatCleared() {
            ps.bubbles.clear()
            AppState.userMessages = 0
            ps.sidebarOpen = false
            ps.resetEditState()
        }
        // The getting-started guide's "Use an example".
        function onExamplePromptRequested(text) { ps.draft = text }
    }
}
