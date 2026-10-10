import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import CloseNI
import "../js/renderer-logic.mjs" as R

/*
 * The Settings panel (#panel-settings): a column of section tabs and the
 * open section - Provider, Permissions, Skills, Appearance, About. Ports
 * desktop/renderer/settings.js, the Settings half of providers.js and account.js
 * (the provider picker, its Sign in and its controls), and skills.js.
 *
 * Only the open section exists. What must outlive the panel - the permission
 * policy, the persona and skills, unsaved drafts and the open section - is in
 * SettingsStore; the theme in Theme; the provider and Show Browser in
 * Providers; the guide in AppState.
 *
 * The skill and persona lists are read from disk each time the panel opens,
 * as refreshSkills ran on every switch to Settings: the files on disk are the
 * source of truth and may have changed outside the app.
 */
RowLayout {
    id: panel
    objectName: "settingsPanel"

    spacing: Theme.sp5

    // From Library.listSkills, re-read on open and after every change.
    property var personaNames: []
    property var skillNames: []
    // The MCP editor, filled from disk on open. Unlike a skill draft it was
    // re-read from disk on every visit in Electron too.
    property string mcpText: ""
    // For the self-test: the open section, and the delete confirmation.
    readonly property alias sectionItem: body.item
    readonly property alias confirm: confirmModal

    Component.onCompleted: refreshSkills()

    function refreshSkills() {
        Library.listSkills(function (r) {
            if (!r || !r.ok) return
            panel.personaNames = r.personas || []
            panel.skillNames = r.skills || []
            Library.readMcpConfig(function (mcp) {
                if (mcp && mcp.ok) panel.mcpText = mcp.text || ""
            })
        })
    }

    function openSkill(name) {
        Library.readSkill("skill", name, function (got) {
            if (got && got.ok) {
                SettingsStore.editorText = got.text
                SettingsStore.editorName = name
            }
        })
    }

    function createSkill() {
        var name = SettingsStore.newSkillName.trim()
        if (!name) { Notify.toast("Name it first", "err"); return }
        // Creating writes an empty file, so reusing a name would wipe that skill.
        if (skillNames.indexOf(name) !== -1) {
            Notify.toast("A skill called " + name + " already exists - click its name to edit it", "err")
            return
        }
        Library.writeSkill("skill", name, "", function (r) {
            if (!r || !r.ok) { Notify.toast((r && r.error) || "Could not create", "err"); return }
            SettingsStore.newSkillName = ""
            SettingsStore.editorText = ""
            SettingsStore.editorName = name
            panel.refreshSkills()
        })
    }

    function saveSkill() {
        var name = SettingsStore.editorName
        if (!name) { Notify.toast("Select a skill first", "err"); return }
        Library.writeSkill("skill", name, SettingsStore.editorText, function (r) {
            var ok = !!(r && r.ok)
            Notify.toast(ok ? "Saved " + name : ((r && r.error) || "Could not save"), ok ? "" : "err")
        })
    }

    function askDeleteSkill() {
        var name = SettingsStore.editorName
        if (!name) return
        confirmModal.ask("Delete the skill \"" + name + "\"? The file is removed from disk.", function () {
            Library.deleteSkill("skill", name, function (r) {
                if (!r || !r.ok) { Notify.toast((r && r.error) || "Could not delete", "err"); return }
                if (SettingsStore.editorName === name) {
                    SettingsStore.editorText = ""
                    SettingsStore.editorName = ""
                }
                SettingsStore.setSkill(name, false)
                panel.refreshSkills()
            })
        })
    }

    function importSkill() {
        var req = R.parseSkillImport(SettingsStore.importPath)
        if (!req) { Notify.toast("Use owner/repo/path/to/file.md", "err"); return }
        Library.importSkill(req, function (r) {
            if (!r || !r.ok) {
                Notify.toast((r && r.error) || "Import failed", "err")
                Notify.log("skill import failed: " + (r && r.error), "err")
                return
            }
            SettingsStore.importPath = ""
            Notify.log("imported skill: " + r.name, "ok")
            panel.refreshSkills()
        })
    }

    function saveMcp(text) {
        // Parsed here so a typo is caught now rather than by a build that depends on it.
        var problem = R.mcpConfigError(text)
        if (problem) { Notify.toast(problem, "err"); return }
        Library.writeMcpConfig(text, function (r) {
            var ok = !!(r && r.ok)
            if (ok) panel.mcpText = text
            Notify.toast(ok ? "MCP configuration saved" : ((r && r.error) || "Could not save"), ok ? "" : "err")
        })
    }

    /** About's "Show the getting-started guide". */
    function showGuideAgain() {
        AppState.resetOnboarding()
        if (AppState.onboardingVisible) AppState.switchTab("chat")
        else Notify.toast("Nothing left to set up - every step is done")
    }

    // ---- #settings-nav ----------------------------------------------------------
    ColumnLayout {
        Layout.preferredWidth: 150
        Layout.maximumWidth: 150
        Layout.alignment: Qt.AlignTop
        spacing: 2
        Repeater {
            model: SettingsStore.sections
            NavButton {
                required property var modelData
                objectName: "settingsTab-" + modelData.id
                Layout.fillWidth: true
                text: modelData.label
                active: SettingsStore.section === modelData.id
                onClicked: SettingsStore.showSection(modelData.id)
            }
        }
    }

    // ---- #settings-body ---------------------------------------------------------
    Rectangle {
        Layout.fillWidth: true
        Layout.fillHeight: true
        color: Theme.panel
        radius: Theme.rLg
        border.width: 1
        border.color: Theme.line

        ScrollArea {
            id: scroll
            anchors.fill: parent
            anchors.margins: 1
            padding: Theme.sp6 - 1

            Loader {
                id: body
                // .settings-section{max-width:460px}
                width: Math.min(460, scroll.availableWidth)
                sourceComponent: SettingsStore.section === "permissions" ? permissionsSection
                               : SettingsStore.section === "skills" ? skillsSection
                               : SettingsStore.section === "appearance" ? appearanceSection
                               : SettingsStore.section === "about" ? aboutSection
                               : providerSection
            }
        }
    }

    // ---- Provider -----------------------------------------------------------------
    Component {
        id: providerSection
        ColumnLayout {
            spacing: Theme.sp3

            Micro { Layout.bottomMargin: 6; text: "Provider" }
            Select {
                id: providerSelect
                objectName: "settingsProvider"
                Layout.fillWidth: true
                /*
                 * Coming-soon providers are shown rather than hidden, so it is
                 * clear they are planned rather than missing - but they cannot
                 * be picked, and the agent refuses them too in case one arrives
                 * from somewhere other than this menu.
                 */
                model: Providers.list.map(function (p) {
                    return { value: p.id, label: Providers.optionLabel(p), disabled: !!p.comingSoon }
                })
                function follow() { selectValue(Providers.current) }
                onModelChanged: follow()
                Component.onCompleted: follow()
                Connections {
                    target: Providers
                    function onCurrentChanged() { providerSelect.follow() }
                }
                onActivated: function (i) {
                    var row = model[i]
                    // The keyboard steps onto disabled rows the list will not let a click reach.
                    if (!row || row.disabled) { follow(); return }
                    // Each provider offers different controls, so the controls
                    // below are rebuilt rather than left showing the last
                    // provider's models (ProviderControls follows Providers.info).
                    Providers.select(row.value)
                }
            }
            Btn {
                objectName: "settingsSignIn"
                block: true
                text: Providers.signingIn ? "Opening browser..." : "Sign in"
                enabled: !Providers.signingIn
                onClicked: Providers.signIn()
            }
            // Filled from the selected provider's config. A provider that
            // declares no controls shows nothing rather than an empty heading.
            ProviderControls { Layout.fillWidth: true }
        }
    }

    // ---- Permissions ----------------------------------------------------------------
    Component {
        id: permissionsSection
        ColumnLayout {
            spacing: Theme.sp3

            Micro { Layout.bottomMargin: 6; text: "Permissions" }
            Select {
                id: autonomySelect
                objectName: "settingsAutonomy"
                Layout.fillWidth: true
                model: SettingsStore.autonomyOptions
                Component.onCompleted: selectValue(SettingsStore.autonomy)
                onActivated: SettingsStore.setAutonomy(currentValue)
            }
            // Show Browser: one setting, here and in the rail, kept in step and
            // saved. Unsaved, it was off again after every restart, so a window
            // someone had asked for never opened.
            Check {
                objectName: "settingsShowBrowser"
                text: "Show Browser"
                checked: Providers.showBrowser
                onToggled: Providers.setShowBrowser(checked)
            }
            // The parallel-steps control was removed rather than left to sit
            // there doing nothing: chat, planning and building all share one
            // conversation now, and a conversation has one composer. A setting
            // that cannot change anything is worse than no setting.
            Hint {
                Layout.fillWidth: true
                Layout.topMargin: Theme.sp5
                text: "Chat, planning and building share one conversation with your provider, so build steps run one at a time. That keeps each step prompt small, because the model can already see the plan."
            }
        }
    }

    // ---- Skills -----------------------------------------------------------------------
    // Personas, skills and MCP. All three change what the model is told before
    // the task, and all three share one budget - see
    // local-agent/src/prompt-compose.ts for why that budget exists.
    Component {
        id: skillsSection
        ColumnLayout {
            spacing: Theme.sp3

            Micro { Layout.bottomMargin: 6; text: "Persona" }
            Hint { Layout.fillWidth: true; text: "A stance the model takes. One at a time, or none." }
            Select {
                id: personaSelect
                objectName: "settingsPersona"
                Layout.fillWidth: true
                model: [{ value: "", label: "(none)" }].concat(panel.personaNames.map(function (n) {
                    return { value: n, label: n }
                }))
                // A persona deleted outside the app reads as "(none)" here; the
                // saved name is kept and simply stops being read.
                function follow() { currentIndex = Math.max(0, indexOfValue(SettingsStore.persona)) }
                onModelChanged: follow()
                Component.onCompleted: follow()
                onActivated: SettingsStore.setPersona(currentValue)
            }

            Micro { Layout.topMargin: Theme.sp5; Layout.bottomMargin: 6; text: "Skills" }
            Hint {
                Layout.fillWidth: true
                text: "Practices to follow. Any number. Plain markdown files - the filename is the name. Click a name to edit it."
            }
            Hint {
                visible: panel.skillNames.length === 0
                Layout.fillWidth: true
                text: "No skills yet. Create one below, or import from GitHub."
            }
            ListView {
                id: skillList
                cacheBuffer: 0   // no async look-ahead in a Loader: ARCHITECTURE.md, Panels
                objectName: "settingsSkillList"
                visible: count > 0
                Layout.fillWidth: true
                // Ten rows, then the list scrolls inside itself.
                Layout.preferredHeight: Math.min(contentHeight, 10 * 26)
                clip: true
                interactive: contentHeight > height
                boundsBehavior: Flickable.StopAtBounds
                model: panel.skillNames
                ScrollBar.vertical: ThinScrollBar {}
                delegate: RowLayout {
                    id: skillRow
                    required property string modelData
                    width: skillList.width
                    height: 26
                    spacing: Theme.sp2
                    Check {
                        id: skillBox
                        objectName: "settingsSkill-" + skillRow.modelData
                        // The name, then "edit" right after it, as in a .settings-row.
                        Layout.maximumWidth: skillList.width - 60
                        text: skillRow.modelData
                        checked: SettingsStore.skills.indexOf(skillRow.modelData) !== -1
                        onToggled: {
                            SettingsStore.setSkill(skillRow.modelData, checked)
                            checked = Qt.binding(function () { return SettingsStore.skills.indexOf(skillRow.modelData) !== -1 })
                        }
                        // Clicking the name opens it, which is what people reach
                        // for; the click itself still toggles the box, so both
                        // gestures do something.
                        TapHandler { onDoubleTapped: panel.openSkill(skillRow.modelData) }
                    }
                    Btn {
                        objectName: "settingsSkillEdit-" + skillRow.modelData
                        small: true
                        text: "edit"
                        onClicked: panel.openSkill(skillRow.modelData)
                    }
                    Item { Layout.fillWidth: true }
                }
            }

            RowLayout {
                Layout.fillWidth: true
                Layout.topMargin: Theme.sp3
                spacing: 8
                Field {
                    objectName: "settingsSkillName"
                    Layout.fillWidth: true
                    placeholderText: "new skill name"
                    text: SettingsStore.newSkillName
                    onTextEdited: SettingsStore.newSkillName = text
                    onAccepted: panel.createSkill()
                }
                Btn { objectName: "settingsSkillCreate"; small: true; text: "Create"; onClicked: panel.createSkill() }
            }
            TextBox {
                objectName: "settingsSkillEditor"
                Layout.fillWidth: true
                // rows="8"
                Layout.preferredHeight: 8 * 17 + 18
                placeholderText: "Select a skill to edit it..."
                text: SettingsStore.editorText
                area.onTextChanged: SettingsStore.editorText = area.text
            }
            RowLayout {
                spacing: 8
                Btn { objectName: "settingsSkillSave"; small: true; text: "Save"; onClicked: panel.saveSkill() }
                Btn { objectName: "settingsSkillDelete"; small: true; text: "Delete"; onClicked: panel.askDeleteSkill() }
            }

            Micro { Layout.topMargin: Theme.sp5; Layout.bottomMargin: 6; text: "Import from GitHub" }
            RowLayout {
                Layout.fillWidth: true
                spacing: 8
                Field {
                    objectName: "settingsImportPath"
                    Layout.fillWidth: true
                    placeholderText: "owner/repo/path/to/skill.md"
                    text: SettingsStore.importPath
                    onTextEdited: SettingsStore.importPath = text
                    onAccepted: panel.importSkill()
                }
                Btn { objectName: "settingsImport"; small: true; text: "Import"; onClicked: panel.importSkill() }
            }

            Micro { Layout.topMargin: Theme.sp5; Layout.bottomMargin: 6; text: "MCP servers and calls" }
            Hint {
                Layout.fillWidth: true
                text: "Tools run once before a build and their text is folded into every step. An MCP server is a program this app will run."
            }
            TextBox {
                id: mcpBox
                objectName: "settingsMcp"
                Layout.fillWidth: true
                Layout.preferredHeight: 8 * 17 + 18
                placeholderText: "{\"servers\":{},\"calls\":[]}"
                text: panel.mcpText
            }
            Btn { objectName: "settingsMcpSave"; small: true; text: "Save"; onClicked: panel.saveMcp(mcpBox.text) }
        }
    }

    // ---- Appearance --------------------------------------------------------------------
    /*
     * The theme picker.
     *
     * A theme is one property on Theme; the styling follows from it. Theme reads
     * the saved one before the window is first drawn, so the app never paints
     * the default for a frame before switching.
     */
    Component {
        id: appearanceSection
        ColumnLayout {
            spacing: Theme.sp3

            Micro { Layout.bottomMargin: 6; text: "Theme" }
            GridLayout {
                id: grid
                Layout.fillWidth: true
                // repeat(auto-fill, minmax(150px, 1fr))
                columns: Math.max(1, Math.floor((width + columnSpacing) / (150 + columnSpacing)))
                columnSpacing: Theme.sp3
                rowSpacing: Theme.sp3
                Repeater {
                    model: Theme.themes
                    ThemeSwatch {
                        required property var modelData
                        // 1fr each: equal columns, whatever the names' lengths.
                        Layout.fillWidth: true
                        Layout.preferredWidth: (grid.width - (grid.columns - 1) * grid.columnSpacing) / grid.columns
                        theme: modelData
                    }
                }
            }
            // The decoration toggle is meaningless on a theme with no texture.
            Check {
                objectName: "settingsDecor"
                visible: Theme.hasDecor
                text: "Texture & glow"
                checked: Theme.decor
                onToggled: Theme.setDecor(checked)
            }
            Hint { Layout.fillWidth: true; text: "Themes style CloseNI only. Projects you build here are never touched." }
        }
    }

    // ---- About --------------------------------------------------------------------------
    Component {
        id: aboutSection
        ColumnLayout {
            spacing: Theme.sp3

            Micro { Layout.bottomMargin: 6; text: "About" }
            ColumnLayout {
                spacing: 0
                RowLayout {
                    spacing: Theme.sp5
                    BracketMark { size: 52; stroke: 2.4; color: Theme.txt }
                    ColumnLayout {
                        spacing: Theme.sp1
                        Text {
                            text: "CloseNI"
                            font.family: Theme.ui
                            font.pixelSize: 16
                            font.letterSpacing: 16 * 0.08
                            color: Theme.txt
                        }
                        Hint { text: "Drives web AI chats to plan and build software." }
                    }
                }
                Btn {
                    objectName: "settingsWelcomeReset"
                    Layout.topMargin: Theme.sp5
                    small: true
                    text: "Show the getting-started guide"
                    onClicked: panel.showGuideAgain()
                }
            }
        }
    }

    // ---- Confirmation -------------------------------------------------------------------
    // confirm() in Electron: nothing is deleted until it is answered.
    Modal {
        id: confirmModal
        objectName: "settingsConfirm"
        cardWidth: 420
        closePolicy: Popup.CloseOnEscape
        property string question: ""
        property var onYes: null
        function ask(text, yes) {
            question = text
            onYes = yes
            open()
        }
        function answer(yes) {
            var act = onYes
            onYes = null
            close()
            if (yes && act) act()
        }
        onClosed: onYes = null

        contentItem: ColumnLayout {
            spacing: 14
            Text {
                Layout.fillWidth: true
                text: confirmModal.question
                wrapMode: Text.Wrap
                font.family: Theme.ui
                font.pixelSize: 12
                color: Theme.txt
            }
            RowLayout {
                spacing: 8
                Btn { objectName: "settingsConfirmYes"; text: "Delete"; variant: "invert"; onClicked: confirmModal.answer(true) }
                Btn { text: "Cancel"; onClicked: confirmModal.answer(false) }
            }
        }
    }
}
