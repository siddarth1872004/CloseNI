// Loads every module in qml/js into the QML engine and calls into each one.
//
// The unit suite (npm test) checks what the modules decide, under Node. This
// checks that the QML engine can load them at all: a module using syntax the
// engine lacks (async, object spread, Array.flat, ...) passes every Node test
// and fails here.
//
//   QT_QPA_PLATFORM=offscreen QT_FORCE_STDERR_LOGGING=1 \
//     qmltestrunner -input native/tests/tst_jsmodules.qml
import QtQuick
import QtTest

import "../qml/js/diff.mjs" as Diff
import "../qml/js/entrypoint.mjs" as Entry
import "../qml/js/controls-settings.mjs" as Controls
import "../qml/js/theme.mjs" as Theme
import "../qml/js/language-mark.mjs" as Lang
import "../qml/js/browser-check.mjs" as Browser
import "../qml/js/plan-scale.mjs" as Scale
import "../qml/js/preview-target.mjs" as Preview
import "../qml/js/scheduler.mjs" as Sched
import "../qml/js/plan-edit.mjs" as PlanEdit
import "../qml/js/step-timing.mjs" as Timing
import "../qml/js/recent-workspaces.mjs" as Recent
import "../qml/js/github-safe.mjs" as Git
import "../qml/js/onboarding.mjs" as Onboarding
import "../qml/js/flow.mjs" as Flow
import "../qml/js/code-view.mjs" as CodeView
import "../qml/js/run-target.mjs" as RunTarget
import "../qml/js/builder-logic.mjs" as Builder
import "../qml/js/code-logic.mjs" as Code
import "../qml/js/renderer-logic.mjs" as Renderer

TestCase {
    name: "JsModules"

    function test_diff() {
        var rows = Diff.diffLines("a\nb\n", "a\nc\n")
        compare(rows.map(function (r) { return r.type }).join(","), "same,remove,add")
    }

    function test_entrypoint() {
        compare(Entry.detectEntrypoint(["main.py"], null, null, "linux"), "python3 main.py")
        compare(Entry.detectEntrypoint(["index.js", "package.json"], { scripts: { start: "node index.js" } }, null, "linux"), "npm start")
    }

    function test_controls() {
        var spec = [{ id: "model", kind: "select", options: [{ value: "a" }, { value: "b" }], default: "a" }]
        compare(Controls.resolveControls(spec, { model: "b" }).model, "b")
        compare(Controls.resolveControls(spec, { model: "gone" }).model, undefined)
    }

    function test_theme() {
        compare(Theme.resolveTheme("paper"), "paper")
        compare(Theme.resolveTheme("dropped"), Theme.DEFAULT_THEME)
        compare(Theme.THEMES.length, 11)
        compare(Theme.THEME_KEY, "closeni.theme")
    }

    function test_language() {
        verify(Lang.languageMark("app.py") !== null)
        verify(Lang.languageToken("Python").indexOf("--lang-") === 0)
    }

    function test_browser() {
        compare(Browser.stripAnsi("\u001b[31mred\u001b[0m"), "red")
        verify(typeof Browser.describeInstallFailure("EACCES") === "string")
    }

    function test_scale() {
        verify(Scale.estimateDuration(12).length > 0)
    }

    function test_preview() {
        var t = Preview.previewTarget(" * Running on http://127.0.0.1:5000", [])
        compare(t.kind, "server")
        compare(Preview.previewTarget("", ["index.html"]).kind, "file")
    }

    function test_scheduler() {
        var steps = [{ title: "a", dependsOn: [] }, { title: "b", dependsOn: [0] }, { title: "c", dependsOn: [] }]
        var built = Sched.graphFor(steps)
        verify(built.declared)
        var state = Sched.seedState(steps)
        compare(Sched.runnableSteps(built.graph, state, 3).join(","), "0,2")
        compare(Sched.blockedBy(built.graph, [0]).join(","), "1")
    }

    function test_planEdit() {
        var res = PlanEdit.moveStep([{ title: "a" }, { title: "b", dependsOn: [0] }], 1, 0)
        verify(!!res.refused)
        compare(PlanEdit.deleteStep([{ title: "a" }, { title: "b" }], 0).steps.length, 1)
        compare(PlanEdit.mergeStepUp([{ title: "a" }, { title: "b" }], 1).steps.length, 1)
    }

    function test_timing() {
        var t = Timing.newTimer(0)
        Timing.markPhase(t, "thinking", 0)
        Timing.finish(t, 65000)
        var rec = Timing.toRecord(t)
        compare(Timing.formatDuration(rec.totalMs), "1m 05s")
        compare(Timing.summarise([rec]).steps, 1)
    }

    function test_recent() {
        var list = Recent.remember(Recent.parse(null), "/a")
        list = Recent.remember(list, "/b")
        compare(list.join(","), "/b,/a")
        compare(Recent.forget(list, "/a").join(","), "/b")
        compare(Recent.parse("not json").length, 0)
    }

    function test_githubSafe() {
        var p = Git.parseRepoUrl("https://github.com/owner/repo.git")
        compare(p.owner, "owner")
        compare(p.repo, "repo")
        compare(Git.parseRepoUrl("https://example.com/o/r"), null)
        compare(Git.redactToken("x tok y", "tok"), "x [REDACTED] y")
    }

    function test_onboarding() {
        var st = { browserReady: true, workspace: "", account: "unknown", providerName: "DeepSeek", chatted: false }
        compare(Onboarding.current(st), "workspace")
        compare(Onboarding.steps(st).length, 4)
    }

    function test_flow() {
        var list = Flow.stages(Renderer.flowSnapshot(1, true, { total: 2, done: 2 }, { tested: false }))
        compare(list.length, Flow.STAGES.length)
        compare(list[0].status, "done")
    }

    function test_codeView() {
        compare(CodeView.parseSlash("/mode plan").cmd, "/mode")
        compare(CodeView.modeFromWord("accept"), "acceptEdits")
        verify(CodeView.matchCommands("/he").length > 0)
        compare(CodeView.rankFiles(["src/app.py", "README.md"], "app", 5)[0], "src/app.py")
    }

    function test_runTarget() {
        verify(RunTarget.looksGraphical(["import pygame"]))
        verify(!RunTarget.looksGraphical(["print(1)"]))
    }

    function test_builderLogic() {
        var steps = Builder.stepsFromPlan([{ title: "a", dependsOn: [] }, { title: "b", testable: true }])
        compare(steps[0].status, "pending")
        verify(steps[1].testable)
        compare(Builder.stepPrompt({ summary: "s" }, { title: "a", detail: "d" }, ""),
                "Overall: s\n\nExecute ONLY this step: a. d")
        compare(Builder.timingText({ totalMs: 5000, phases: { thinking: 5000 } }).body, "thinking      5.0s")
        verify(Builder.buttonVisibility("running", steps).stop)
        compare(Builder.buildStats(steps, false).total, 2)
    }

    function test_codeLogic() {
        var rows = Code.numberDiff("a\nb\n", "a\nc\n")
        compare(rows.map(function (r) { return r.sign + r.ln }).join(","), " 1,-2,+2")
        compare(Code.shipModeInfo(true, "## dev\n").indexOf("on dev · clean"), 0)
        compare(Code.routeLine("research", "what is htmx", "").research, "what is htmx")
        compare(Code.historyUp(["a", "b"], -1).text, "b")
    }

    function test_rendererLogic() {
        verify(Renderer.renderMarkdown("**hi**").indexOf("<strong>hi</strong>") !== -1)
        compare(Renderer.planFiles({ steps: [{ files: ["b", "a", "b"] }] }).join(","), "a,b")
        compare(Renderer.planTechStack({ steps: [{ files: ["x.py"], detail: "react" }] }).join(","), "Python,React")
        compare(Renderer.tryExtractPlan('```json\n{"steps":[]}\n```').steps.length, 0)
        compare(Renderer.applyPlanEdit({ steps: [{ title: "a" }, { title: "b" }] }, "del", 0).plan.steps.length, 1)
        compare(Renderer.pickProvider([{ id: "a", comingSoon: true }, { id: "b" }], "a"), "b")
        compare(Renderer.desiredControls([{ id: "p", controls: [{ id: "m", kind: "toggle", default: false }] }], "p", "{\"m\":true}").m, true)
    }
}
