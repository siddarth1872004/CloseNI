pragma Singleton
import QtQuick
import CloseNI
import "../js/api.mjs" as Api
import "../js/renderer-logic.mjs" as R

/*
 * What Settings decides that outlives the Settings panel: the permission
 * policy, the persona, the ticked skills and the preamble built from them, and
 * the panel's own drafts. The panel is a Loader that exists only while it is shown; the agent
 * panels read the policy and the preamble from here at any time.
 *
 * The theme and its decoration live in Theme, the provider, its controls and
 * Show Browser in Providers, the getting-started guide in AppState: Settings
 * is one of several places that change each of them.
 */
QtObject {
    id: store

    // ---- Sections -----------------------------------------------------------
    // Settings section switching, the same shape as switchTab, scoped to the
    // panel. Kept here so leaving Settings and coming back lands on the same
    // section, as it did when the panel was never destroyed. Not saved: the app
    // opened on Provider at every launch.
    readonly property var sections: [
        { id: "provider", label: "Provider" }, { id: "permissions", label: "Permissions" },
        { id: "skills", label: "Skills" }, { id: "appearance", label: "Appearance" },
        { id: "about", label: "About" }
    ]
    property string section: "provider"
    function showSection(id) {
        for (var i = 0; i < sections.length; i++) if (sections[i].id === id) { section = id; return }
    }

    // ---- Permission policy ----------------------------------------------------
    // Persist the permission policy: a setting that resets on restart is a nuisance.
    readonly property var autonomyOptions: R.AUTONOMY_OPTIONS
    property string autonomy: R.resolveAutonomy(Prefs.get("closeni.autonomy", ""))
    function setAutonomy(value) {
        autonomy = R.resolveAutonomy(value)
        Prefs.set("closeni.autonomy", autonomy)
    }

    // ---- Persona and skills ---------------------------------------------------
    /*
     * The persona and skills the user has ticked.
     *
     * Selections live in Prefs; the files on disk are the source of truth, so a
     * skill deleted outside the app simply stops being read rather than leaving
     * a dangling reference.
     */
    property string persona: Prefs.get("closeni.persona", "")
    property var skills: R.parseSkills(Prefs.get("closeni.skills", "[]"))

    function setPersona(name) {
        persona = String(name || "")
        Prefs.set("closeni.persona", persona)
    }
    function setSkill(name, on) {
        if (on === (skills.indexOf(name) !== -1)) return
        skills = R.toggleSkill(skills, name, on)
        Prefs.set("closeni.skills", JSON.stringify(skills))
    }
    function isSkillOn(name) { return skills.indexOf(name) !== -1 }

    // ---- The panel's drafts -----------------------------------------------------
    // What is typed into Skills but not saved yet. The panel goes when another
    // is shown, and a half-written skill must not go with it. Not saved: a
    // draft is gone after a restart.
    property string editorName: ""
    property string editorText: ""
    property string newSkillName: ""
    property string importPath: ""

    // ---- The preamble -----------------------------------------------------------
    /**
     * Everything the model should be told before the task, for this run, as a
     * Promise of { persona?, skills?, mcpContext? }.
     *
     * MCP tools run here - once, before the run - rather than per step. A tool
     * whose answer changes mid-build is therefore read once, which is recorded
     * in the design as the known cost of not paying a browser round-trip per
     * call.
     */
    function buildPreamble() {
        var picked = skills.slice()
        var personaReply = null
        var skillReplies = []
        var chain = persona ? Api.call(Library, "readSkill", "persona", persona) : Promise.resolve(null)
        chain = chain.then(function (r) { personaReply = r })
        picked.forEach(function (n) {
            chain = chain.then(function () { return Api.call(Library, "readSkill", "skill", n) })
                         .then(function (r) { skillReplies.push(r) })
        })
        return chain.then(function () { return Api.call(Library, "gatherMcpContext") })
            .then(function (mcp) {
                var notes = mcp && mcp.notes ? mcp.notes : []
                for (var i = 0; i < notes.length; i++) Notify.log("mcp: " + notes[i], "err")
                return R.composePreamble(personaReply, skillReplies, mcp)
            })
            .catch(function (e) {
                // A preamble that cannot be assembled means the behaviour before
                // any of this was configured, which is a working run.
                Notify.log("preamble unavailable: " + String(e), "err")
                return {}
            })
    }
}
