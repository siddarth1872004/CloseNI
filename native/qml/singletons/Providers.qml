pragma Singleton
import QtQuick
import CloseNI
import "../js/api.mjs" as Api
import "../js/renderer-logic.mjs" as R

/*
 * The provider, its account light and its live phase. The decisions live in js/renderer-logic.mjs; this holds the
 * state and talks to the services.
 *
 * The account check is a real headless visit, so it is never run
 * automatically more than once per launch or per explicit request - it opens
 * the browser profile and would otherwise fight whatever is running.
 */
QtObject {
    id: providers

    // [{ id, name, comingSoon, controls, termsUrl, ... }] from Files.listProviders.
    // The picker lists whatever is enabled in local-agent/config/providers, so
    // adding a provider is a JSON file rather than a markup edit.
    property var list: []
    property string current: "deepseek"
    readonly property var info: {
        for (var i = 0; i < list.length; i++) if (list[i].id === current) return list[i]
        return null
    }
    readonly property string fullName: info && info.name ? info.name : current
    readonly property string displayName: R.shortProviderName(fullName)
    function optionLabel(p) { return R.providerOptionLabel(p) }

    // The account light: "on" | "off" | "busy" | "unknown", and its words.
    property string acct: "unknown"
    property string acctText: "checking…"
    // { url, label } of the conversation being driven, or null.
    property var thread: null
    readonly property string threadText: R.threadLabel(thread)
    property bool signingIn: false
    property bool checkingSelectors: false

    // The live phase readout: { name, label, kind (idle|busy|work), detail }.
    property var phase: R.phaseLabel(null)
    // For the build panel's per-step timer. Every phase
    // is reported at the moment it was observed on the page, so the clock
    // there is measuring the real thing rather than an inference. The builder
    // owns the per-step timer; this only forwards the transition.
    signal phaseNoted(string name)

    // Show Browser: one setting, shown in the rail and in Settings, saved.
    property bool showBrowser: Prefs.get("closeni.showBrowser", "0") === "1"
    function setShowBrowser(on) {
        showBrowser = !!on
        Prefs.set("closeni.showBrowser", showBrowser ? "1" : "0")
    }

    // Bumped whenever a control is saved, so both copies redraw together.
    property int controlsRevision: 0

    function setPhase(p) {
        phase = R.phaseLabel(p)
        phaseNoted(phase.name)
    }
    function setAcct(state, text) {
        acct = state
        acctText = text
    }
    function setThread(t) { thread = t && t.url ? t : null }

    /**
     * Load the provider list and pick one (startup.js). `preferred` is
     * --provider from the command line: used for this run, not saved.
     */
    function load(preferred) {
        return Api.call(Files, "listProviders").then(function (r) {
            // Files replies with a list; Js::reply turns it into a real Array
            // (a bare sequence once failed this check and dropped every provider).
            function asArray(v) {
                return Array.isArray(v) ? v : null
            }
            var l = asArray(r) || (r && asArray(r.providers)) || []
            if (!l.length) l = [{ id: "deepseek", name: "DeepSeek Chat" }]
            var pick = R.pickProvider(l, preferred)
            if (!preferred || pick !== preferred) pick = R.pickProvider(l, Prefs.get("closeni.provider", ""))
            if (pick) current = pick
            list = l
            setAcct("unknown", "not checked")
            // One check at startup. It costs a headless browser launch, so it is
            // not on a timer - the light says "not checked" rather than pretending.
            refreshAccount(false)
        })
    }

    /** Switch provider (the Settings picker). */
    function select(id) {
        if (id === current) return
        current = id
        Prefs.set("closeni.provider", id)
        controlsRevision++
        // A different provider has a different session and thread; the previous
        // one's status would be actively misleading.
        setAcct("unknown", "not checked")
        setThread(null)
        refreshAccount(false)
    }

    /** What to ask the provider for on the next run; {} means "change nothing". */
    function desiredControls() {
        return R.desiredControls(list, current, Prefs.get(R.controlsKey(current), "{}"))
    }
    function saveControl(id, value) {
        var key = R.controlsKey(current)
        Prefs.set(key, R.saveControl(Prefs.get(key, "{}"), id, value))
        controlsRevision++
    }

    function refreshAccount(explicit) {
        var p = info
        if (p && p.comingSoon) { setAcct("unknown", "coming soon"); setThread(null); return }
        setAcct("busy", "checking…")
        Agent.authStatus(current, AppState.workspace, function (r) {
            var a = R.accountFromStatus(r)
            setAcct(a.state, a.text)
            if (!r || !r.success) {
                if (explicit) Notify.toast("Could not check the account", "err")
                return
            }
            setThread(r.thread)
            if (explicit) Notify.toast(r.signedIn ? "Signed in" : "Not signed in - use Sign in")
        })
    }

    function signIn() {
        if (signingIn) return
        signingIn = true
        Notify.toast("A browser window will open - sign in, then it closes itself")
        Agent.signIn(current, function (r) {
            signingIn = false
            if (r && r.success) {
                Notify.toast("Signed in to " + current)
                Notify.log("signed in to " + current, "ok")
                setAcct("on", "signed in")
            } else {
                Notify.toast("Sign-in did not complete", "err")
                Notify.log("sign-in failed: " + ((r && r.error) || "no chat input appeared"), "err")
                setAcct("off", "signed out")
            }
        })
    }

    function signOut() {
        Agent.signOutProvider(current, function (r) {
            if (r && r.success) {
                Notify.log("signed out of " + current + " (browser profile removed)", "ok")
                Notify.toast("Signed out")
                setAcct("off", "signed out")
                setThread(null)
            } else {
                Notify.toast((r && r.error) || "Could not sign out", "err")
            }
        })
    }

    /** Check the provider's selectors against a real page, on demand. */
    function checkSelectors() {
        if (checkingSelectors) return
        checkingSelectors = true
        Agent.providerHealth(current, AppState.workspace, function (r) {
            checkingSelectors = false
            if (!r || !r.success) {
                Notify.log("selector check failed: " + ((r && r.error) || "no answer"), "err")
                Notify.toast((r && r.error) || "Could not check", "err")
                return
            }
            var lines = R.healthLines(r)
            for (var i = 0; i < lines.length; i++) Notify.log(lines[i].text, lines[i].tone)
            Notify.toast(r.ok ? "Selectors look right" : "Selectors need attention", r.ok ? "" : "err")
        })
    }

    function openThread(url) {
        var target = url || (thread && thread.url)
        if (!target) return
        Agent.openThread(target, function (r) {
            if (!r || !r.success) Notify.toast((r && r.error) || "Could not open the conversation", "err")
        })
    }

    property Connections _agent: Connections {
        target: Agent
        function onPhase(p) { providers.setPhase(p) }
    }
}
