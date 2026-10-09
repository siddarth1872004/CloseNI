import QtQuick
import CloseNI

/*
 * The Settings part of --self-test: drives the panel's real controls - every
 * section, every setting, skills create / edit / save / tick / delete, the
 * persona, the import guard, the MCP editor and the preamble built from all of
 * them - and checks each change reached Prefs (native-prefs.json) or disk.
 *
 * A failed check is a console.warn, which main.cpp counts, so it fails the
 * run. The settings are left changed and a marker saved; the next run over the
 * same storage first checks they survived the restart, then puts them back
 * before changing them again. tests/CMakeLists.txt runs it twice over a fresh
 * storage (settings_restart), with mcp.json pointing at the fake MCP server.
 *
 * steps() returns step functions for SelfTest's ticker. A step that returns
 * false is still waiting and is run again on the next tick.
 */
QtObject {
    id: check

    required property var root

    readonly property string marker: "closeni.selftest.settings"
    readonly property string skill: "selftest-skill"
    readonly property string temp: "selftest-temp"
    readonly property string persona: "selftest-persona"
    readonly property string skillText: "Write the test first."
    readonly property string personaText: "Be terse."

    property var panel: null
    property var pending: null      // the answer an async step waits for
    property string mcpOnDisk: ""
    property int controlsChecked: 0

    function fail(what) { console.warn("self-test: settings: " + what) }
    function expect(ok, what) { if (!ok) fail(what); return ok }

    function find(item, name) {
        if (!item) return null
        if (item.objectName === name) return item
        // A window has no children of its own, only a content item.
        var kids = item.children || (item.contentItem ? [item.contentItem] : [])
        for (var i = 0; i < kids.length; i++) {
            var hit = find(kids[i], name)
            if (hit) return hit
        }
        return null
    }
    function findText(item, type, text) {
        if (!item) return null
        if (item.text === text && String(item).indexOf(type) === 0) return item
        var kids = item.children || []
        for (var i = 0; i < kids.length; i++) {
            var hit = findText(kids[i], type, text)
            if (hit) return hit
        }
        return null
    }
    function visibleOf(item, type, out) {
        if (!item || !item.visible) return out
        if (String(item).indexOf(type) === 0 && item.objectName === "") out.push(item)
        var kids = item.children || []
        for (var i = 0; i < kids.length; i++) visibleOf(kids[i], type, out)
        return out
    }
    function control(name) {
        var c = find(panel, name)
        if (!c) fail("no control " + name + " in " + SettingsStore.section)
        return c
    }
    function click(name) { var b = control(name); if (b) b.clicked() }
    function toggle(c) { if (c) { c.toggle(); c.toggled() } }
    function choose(sel, value) {
        if (!sel) return
        var i = sel.indexOfValue(value)
        if (!expect(i >= 0, sel.objectName + " has no " + value)) return
        sel.currentIndex = i
        sel.activated(i)
    }
    function section(id) {
        return function () {
            SettingsStore.showSection(id)
            return !!check.panel.sectionItem
        }
    }
    function call(make) {
        return function () { check.pending = undefined; make(function (r) { check.pending = r }) }
    }
    function arrived() { return check.pending !== undefined }

    function steps() {
        var s = []
        s.push(function () { AppState.switchTab("settings") })
        s.push(function () {
            check.panel = check.find(check.root, "settingsPanel")
            return !!check.panel
        })

        // ---- Did the last run's settings survive the restart? ----------------
        s.push(function () {
            if (Prefs.get(check.marker, "") !== "1") {
                console.log("self-test: settings: nothing to verify (first run on this storage)")
                return
            }
            check.expect(SettingsStore.autonomy === "never", "autonomy did not survive a restart: " + SettingsStore.autonomy)
            check.expect(SettingsStore.persona === check.persona, "persona did not survive a restart: " + SettingsStore.persona)
            check.expect(SettingsStore.isSkillOn(check.skill), "ticked skill did not survive a restart")
            check.expect(!SettingsStore.isSkillOn(check.temp), "a deleted skill came back ticked")
            check.expect(Providers.showBrowser, "Show Browser did not survive a restart")
            var picked = Prefs.get("closeni.selftest.provider", "")
            if (picked) check.expect(Providers.current === picked, "the provider did not survive a restart: " + Providers.current)
            var saved = Prefs.get("closeni.selftest.controls", "")
            if (saved) check.expect(JSON.stringify(Providers.desiredControls()) === saved,
                                    "provider controls did not survive a restart: " + JSON.stringify(Providers.desiredControls()))
            console.log("self-test: settings: verified the previous run")
            // Back to the defaults, so this run changes every one of them again.
            SettingsStore.setAutonomy("ask")
            SettingsStore.setPersona("")
            SettingsStore.setSkill(check.skill, false)
            Providers.setShowBrowser(false)
            Prefs.remove(check.marker)
        })
        s.push(call(function (done) { Library.deleteSkill("skill", check.skill, done) }))
        s.push(arrived)

        // ---- Provider --------------------------------------------------------------
        s.push(section("provider"))
        s.push(function () {
            var sel = check.control("settingsProvider")
            if (!sel) return
            check.expect(sel.count === Providers.list.length, "provider list has " + sel.count + " entries")
            check.expect(sel.currentValue === Providers.current, "provider select is not on " + Providers.current)
            // A coming-soon provider is listed but cannot be picked.
            for (var i = 0; i < Providers.list.length; i++) {
                if (!Providers.list[i].comingSoon) continue
                var was = Providers.current
                sel.currentIndex = i
                sel.activated(i)
                check.expect(Providers.current === was, "a coming-soon provider was picked")
                check.expect(sel.currentValue === was, "the select stayed on a coming-soon provider")
                break
            }
            // Pick another provider: a different one each run, so the restart
            // check sees a real change. Its controls are then the ones shown.
            for (var j = 0; j < Providers.list.length; j++) {
                var other = Providers.list[j]
                if (other.comingSoon || other.id === Providers.current) continue
                check.choose(sel, other.id)
                check.expect(Providers.current === other.id && Prefs.get("closeni.provider", "") === other.id,
                             "the provider was not saved")
                check.expect(sel.currentValue === other.id, "the provider select did not follow")
                Prefs.set("closeni.selftest.provider", other.id)
                break
            }
            var signIn = check.control("settingsSignIn")
            if (signIn) check.expect(signIn.text === "Sign in", "sign-in button reads " + signIn.text)
        })
        s.push(function () {
            // The provider's own controls, the Settings copy. Each toggle is
            // flipped and each select moved, and the saved value must follow.
            var controls = Providers.info && Providers.info.controls ? Providers.info.controls : []
            // The provider's selects, in declaration order (the picker itself is named).
            var selects = check.visibleOf(check.panel.sectionItem, "Select", [])
            var s = 0
            for (var i = 0; i < controls.length; i++) {
                var c = controls[i]
                if (c.kind === "select") {
                    var box = selects[s++]
                    var opts = c.options || []
                    if (!check.expect(!!box && box.count === opts.length, "no select for " + c.label)) continue
                    var now = Providers.desiredControls()[c.id]
                    var next = opts[(box.indexOfValue(now) + 1) % opts.length].value
                    check.choose(box, next)
                    check.expect(Providers.desiredControls()[c.id] === next, c.label + " was not saved")
                    check.controlsChecked++
                    continue
                }
                if (c.kind !== "toggle") continue
                var tick = check.findText(check.panel.sectionItem, "Check", c.label)
                if (!check.expect(!!tick, "no toggle for " + c.label)) continue
                var before = Providers.desiredControls()[c.id] === true
                check.toggle(tick)
                check.expect(Providers.desiredControls()[c.id] === !before, c.label + " was not saved")
                check.expect(Prefs.get("closeni.controls." + Providers.current, "").indexOf(c.id) !== -1,
                             c.label + " is not in Prefs")
                check.controlsChecked++
            }
            if (controls.length) Prefs.set("closeni.selftest.controls", JSON.stringify(Providers.desiredControls()))
            else Prefs.remove("closeni.selftest.controls")
        })

        // ---- Permissions ---------------------------------------------------------
        s.push(section("permissions"))
        s.push(function () {
            check.choose(check.control("settingsAutonomy"), "never")
            check.expect(SettingsStore.autonomy === "never" && Prefs.get("closeni.autonomy", "") === "never",
                         "autonomy was not saved")
            var box = check.control("settingsShowBrowser")
            check.expect(box && !box.checked, "Show Browser starts ticked")
            check.toggle(box)
            check.expect(Providers.showBrowser && Prefs.get("closeni.showBrowser", "") === "1", "Show Browser was not saved")
        })

        // ---- Skills: the persona -----------------------------------------------
        s.push(call(function (done) { Library.writeSkill("persona", check.persona, check.personaText, done) }))
        s.push(arrived)
        s.push(section("skills"))
        s.push(function () { check.panel.refreshSkills() })
        s.push(function () { return check.panel.personaNames.indexOf(check.persona) !== -1 })
        s.push(function () {
            check.choose(check.control("settingsPersona"), check.persona)
            check.expect(SettingsStore.persona === check.persona && Prefs.get("closeni.persona", "") === check.persona,
                         "persona was not saved")
        })

        // ---- Skills: create, edit, save, tick ------------------------------------
        s.push(function () {
            SettingsStore.editorName = ""
            SettingsStore.editorText = ""
            var name = check.control("settingsSkillName")
            if (name) name.text = check.skill
            SettingsStore.newSkillName = check.skill
            check.click("settingsSkillCreate")
        })
        s.push(function () { return check.panel.skillNames.indexOf(check.skill) !== -1 })
        s.push(function () {
            check.expect(SettingsStore.editorName === check.skill, "a new skill does not open in the editor")
            check.expect(SettingsStore.newSkillName === "", "the name field was not cleared")
            // Creating it again would wipe it: refused, and the editor is left alone.
            SettingsStore.editorText = "kept"
            SettingsStore.newSkillName = check.skill
            check.click("settingsSkillCreate")
            check.expect(SettingsStore.editorText === "kept", "creating an existing skill replaced the editor")
            SettingsStore.newSkillName = ""
            var editor = check.control("settingsSkillEditor")
            if (editor) editor.text = check.skillText
            check.expect(SettingsStore.editorText === check.skillText, "the editor does not reach the draft")
            check.click("settingsSkillSave")
        })
        s.push(call(function (done) { Library.readSkill("skill", check.skill, done) }))
        s.push(arrived)
        s.push(function () {
            check.expect(check.pending && check.pending.text === check.skillText, "the skill was not saved to disk")
            // "edit" reads it back from disk.
            SettingsStore.editorName = ""
            SettingsStore.editorText = ""
            check.click("settingsSkillEdit-" + check.skill)
        })
        s.push(function () { return SettingsStore.editorName === check.skill })
        s.push(function () {
            check.expect(SettingsStore.editorText === check.skillText, "edit did not load the skill")
            var box = check.control("settingsSkill-" + check.skill)
            check.toggle(box)
            check.expect(SettingsStore.isSkillOn(check.skill), "ticking a skill did nothing")
            check.toggle(box)
            check.expect(!SettingsStore.isSkillOn(check.skill), "unticking a skill did nothing")
            check.toggle(box)
            check.expect(box && box.checked && Prefs.get("closeni.skills", "").indexOf(check.skill) !== -1,
                         "the ticked skill was not saved")
        })

        // ---- Skills: delete, cancelled then confirmed ------------------------------
        s.push(function () {
            SettingsStore.newSkillName = check.temp
            check.click("settingsSkillCreate")
        })
        s.push(function () { return check.panel.skillNames.indexOf(check.temp) !== -1 })
        s.push(function () {
            check.toggle(check.control("settingsSkill-" + check.temp))
            check.click("settingsSkillDelete")
            check.expect(check.panel.confirm.opened || check.panel.confirm.visible, "delete did not ask first")
            check.panel.confirm.answer(false)
            check.expect(SettingsStore.editorName === check.temp, "cancelling the delete closed the skill")
        })
        s.push(call(function (done) { Library.listSkills(done) }))
        s.push(arrived)
        s.push(function () {
            check.expect(check.pending.skills.indexOf(check.temp) !== -1, "a cancelled delete removed the file")
            check.click("settingsSkillDelete")
            var yes = check.find(check.panel.confirm.contentItem, "settingsConfirmYes")
            if (check.expect(!!yes, "no Delete in the confirmation")) yes.clicked()
        })
        s.push(function () { return check.panel.skillNames.indexOf(check.temp) === -1 })
        s.push(function () {
            check.expect(SettingsStore.editorName === "" && SettingsStore.editorText === "", "the deleted skill stayed open")
            check.expect(!SettingsStore.isSkillOn(check.temp), "the deleted skill is still ticked")
            check.expect(SettingsStore.isSkillOn(check.skill), "deleting one skill unticked another")
            // An import that is not owner/repo/path.md is refused before any request.
            SettingsStore.importPath = "not-a-path"
            check.click("settingsImport")
            check.expect(SettingsStore.importPath === "not-a-path", "a refused import cleared the field")
            SettingsStore.importPath = ""
        })

        // ---- MCP ------------------------------------------------------------------
        s.push(call(function (done) { Library.readMcpConfig(done) }))
        s.push(arrived)
        s.push(function () {
            check.mcpOnDisk = check.pending && check.pending.ok ? check.pending.text : ""
            check.expect(check.panel.mcpText === check.mcpOnDisk, "the MCP editor does not show mcp.json")
            var box = check.control("settingsMcp")
            if (!box) return
            box.text = "{ not json"
            check.click("settingsMcpSave")
        })
        s.push(call(function (done) { Library.readMcpConfig(done) }))
        s.push(arrived)
        s.push(function () {
            check.expect(check.pending.text === check.mcpOnDisk, "invalid MCP JSON was saved")
            var box = check.control("settingsMcp")
            if (box) box.text = check.mcpOnDisk || "{\"servers\":{},\"calls\":[]}"
            check.click("settingsMcpSave")
        })
        s.push(call(function (done) { Library.readMcpConfig(done) }))
        s.push(arrived)
        s.push(function () {
            check.expect(check.pending.text === (check.mcpOnDisk || "{\"servers\":{},\"calls\":[]}"), "valid MCP JSON was not saved")
        })

        // ---- The preamble the agent panels will send --------------------------------
        s.push(function () {
            check.pending = undefined
            SettingsStore.buildPreamble().then(function (p) { check.pending = p })
        })
        s.push(arrived)
        s.push(function () {
            var p = check.pending || {}
            check.expect(p.persona === check.personaText, "the preamble has no persona")
            check.expect(!!p.skills && p.skills.indexOf(check.skillText) !== -1, "the preamble has no skill")
            if (check.mcpOnDisk.indexOf("fake-mcp-server") !== -1) {
                check.expect(!!p.mcpContext && p.mcpContext.length > 0 && p.mcpContext[0].indexOf("ARGS:") !== -1,
                             "the preamble has no MCP context: " + JSON.stringify(p.mcpContext))
                console.log("self-test: settings: MCP context from the fake server: " + p.mcpContext.length)
            }
        })

        // ---- Appearance --------------------------------------------------------------
        s.push(section("appearance"))
        s.push(function () {
            check.click("themeSwatch-paper")
            check.expect(Theme.current === "paper" && Prefs.get("closeni.theme", "") === "paper", "the paper swatch did not apply")
            check.expect(!check.find(check.panel.sectionItem, "settingsDecor").visible, "Texture & glow shown on a theme without it")
            check.click("themeSwatch-pixel")
            check.expect(Theme.current === "pixel", "the pixel swatch did not apply")
            var decor = check.control("settingsDecor")
            check.expect(decor && decor.visible && decor.checked === Theme.decor, "Texture & glow is not shown for pixel")
            var was = Theme.decor
            check.toggle(decor)
            check.expect(Theme.decor === !was && Prefs.get("closeni.theme.decor", "") === (was ? "off" : "on"), "Texture & glow was not saved")
            check.toggle(decor)
        })

        // ---- About ---------------------------------------------------------------
        s.push(section("about"))
        s.push(function () {
            check.click("settingsWelcomeReset")
            check.expect(AppState.mode === "chat" || !AppState.onboardingVisible, "the guide did not come back")
            AppState.switchTab("settings")
        })
        s.push(function () { check.panel = check.find(check.root, "settingsPanel"); return !!check.panel })
        s.push(function () {
            SettingsStore.showSection("provider")
            Prefs.set(check.marker, "1")
            console.log("self-test: settings: exercised, " + check.controlsChecked + " provider control(s)")
        })
        return s
    }
}
