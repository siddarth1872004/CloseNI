/*
 * BuildRules (the ported build-state, checkpoint and run-manifest logic) and
 * the Builds service. Translates the matching checks of
 * local-agent/test/build-unit.cjs ("run manifest", "a build survives closing
 * the app", "undoing a step", "a rollback returns a real workspace to where it
 * was"), then drives the service as QML does.
 */
#include "data_harness.h"

#include "BuildRules.h"
#include "BuildStore.h"
#include "NodeCompat.h"

#include <cmath>

namespace {

Checkpoint::Record sealed(int step, const QMap<QString, std::optional<QString>> &priors,
                          const QMap<QString, std::optional<QString>> &afters, const QStringList &tooLarge = {})
{
    Checkpoint::Record r;
    r.step = step;
    r.at = QStringLiteral("T");
    for (auto it = priors.begin(); it != priors.end(); ++it) {
        Checkpoint::Entry e;
        e.prior = it.value();
        e.tooLarge = tooLarge.contains(it.key());
        const auto left = afters.value(it.key());
        if (left)
            e.after = Checkpoint::hash(*left);
        r.files.insert(it.key(), e);
    }
    return r;
}

QStringList strings(const QJsonValue &v)
{
    QStringList out;
    for (const QJsonValue &x : v.toArray())
        out << (x.isString() ? x.toString() : NodeCompat::stringify(x, {}, 0));
    return out;
}

QJsonObject parsed(const char *json)
{
    const auto s = BuildState::parseText(QString::fromUtf8(json));
    return s ? *s : QJsonObject();
}

}

class TestBuildStore : public QObject
{
    Q_OBJECT

private slots:
    void runManifest();
    void buildState();
    void checkpoints();
    void service();
    void rollbackOnDisk();
    void manifestService();
    void cleanupTestCase() { REPORT_CHECKS(); }

private:
    ScratchStorage m_storage;
};

void TestBuildStore::runManifest()
{
    CHECK(RunManifest::kName == QStringLiteral("closeni.run.json"));

    // An edited command survives a rebuild.
    const QJsonObject mine{{"version", 1}, {"run", "python3 mine.py"}, {"userEdited", true}};
    const QJsonObject edited = RunManifest::merge(mine, QStringLiteral("python3 generated.py"), false, QJsonValue::Undefined, QJsonValue::Undefined);
    CHECK(edited.value("run") == QStringLiteral("python3 mine.py"));
    CHECK(edited.value("userEdited") == true);
    const QJsonObject old{{"version", 1}, {"run", "python3 old.py"}, {"userEdited", false}};
    CHECK(RunManifest::merge(old, QStringLiteral("python3 new.py"), false, QJsonValue::Undefined, QJsonValue::Undefined).value("run")
          == QStringLiteral("python3 new.py"));
    CHECK(RunManifest::merge(QJsonValue::Null, QStringLiteral("python3 x.py"), true, QJsonValue::Undefined, QJsonValue::Undefined)
              .value("userEdited") == true);
    CHECK(RunManifest::merge(QJsonValue::Null, QStringLiteral("python3 x.py"), false, QJsonValue::Undefined, QJsonValue::Undefined)
              .value("version") == 1);
    CHECK(RunManifest::merge(QJsonValue::Null, QStringLiteral("python3 x.py"), false, QStringLiteral("pip install -r requirements.txt"),
                             QJsonValue::Undefined).value("install") == QStringLiteral("pip install -r requirements.txt"));

    const QString sh = RunManifest::renderRunScript(QJsonObject{{"version", 1}, {"run", "python3 app.py"},
                                                                {"install", "pip install -r requirements.txt"}}, false);
    CHECK2(sh.startsWith("#!/bin/sh"), sh.left(20));
    CHECK(sh.indexOf("pip install") < sh.indexOf("python3 app.py"));
    CHECK(sh.contains("python3 app.py"));
    const QString bat = RunManifest::renderRunScript(QJsonObject{{"version", 1}, {"run", "python app.py"}}, true);
    CHECK2(bat.startsWith("@echo off"), bat.left(20));
    CHECK(bat.contains("python app.py"));
    const QString quoted = RunManifest::renderRunScript(QJsonObject{{"version", 1}, {"run", "python3 -c \"print(1)\""}}, false);
    CHECK2(quoted.contains("python3 -c \"print(1)\""), quoted);
}

void TestBuildStore::buildState()
{
    const QJsonObject plan{{"summary", "Flask habit tracker"}, {"runCommand", "python app.py"}};
    const QJsonArray steps{
        QJsonObject{{"title", "Scaffold"}, {"detail", "make dirs"}, {"files", QJsonArray{"app.py"}}, {"dependsOn", QJsonArray()}, {"status", "done"}},
        QJsonObject{{"title", "Schema"}, {"detail", "sqlite"}, {"files", QJsonArray{"db.py"}}, {"dependsOn", QJsonArray{0}}, {"status", "failed"}},
        QJsonObject{{"title", "Routes"}, {"detail", "crud"}, {"files", QJsonArray{"routes.py"}}, {"dependsOn", QJsonArray{0}}, {"status", "pending"}},
    };
    const QJsonObject state = BuildState::serialise(plan, steps, QStringLiteral("deepseek"), QJsonValue::Undefined,
                                                    QStringLiteral("2026-08-11T10:00:00.000Z"));
    CHECK(state.value("summary") == QStringLiteral("Flask habit tracker"));
    CHECK(state.value("runCommand") == QStringLiteral("python app.py"));
    CHECK(state.value("provider") == QStringLiteral("deepseek"));
    CHECK(state.value("startedAt") == QStringLiteral("2026-08-11T10:00:00.000Z"));
    QStringList deps;
    for (const QJsonValue &s : state.value("steps").toArray())
        deps << NodeCompat::stringify(s.toObject().value("dependsOn"), {}, 0);
    CHECK2(deps.join("|") == QStringLiteral("[]|[0]|[0]"), deps.join("|"));

    const auto back = BuildState::parseText(NodeCompat::stringify(state, BuildState::keyOrder()));
    CHECK(back.has_value());
    CHECK(back->value("steps") == state.value("steps"));
    CHECK(back->value("steps")[0].toObject().value("status") == QStringLiteral("done")
          && back->value("steps")[1].toObject().value("status") == QStringLiteral("failed"));

    const QJsonObject running = BuildState::serialise(plan, QJsonArray{QJsonObject{{"title", "x"}, {"detail", ""}, {"files", QJsonArray()}, {"status", "running"}}},
                                                      QJsonValue::Undefined, QJsonValue::Undefined);
    CHECK(BuildState::parseText(NodeCompat::stringify(running))->value("steps")[0].toObject().value("status") == QStringLiteral("pending"));

    CHECK(!BuildState::parseText("{{{"));
    CHECK(!BuildState::parse(QJsonValue::Null));
    CHECK(!BuildState::parseText("[1,2]"));
    CHECK(!BuildState::parseText("{\"version\":99,\"steps\":[{}]}"));
    CHECK(!BuildState::parseText("{\"version\":1,\"steps\":[]}"));
    CHECK(!BuildState::parseText("{\"version\":1,\"steps\":[5]}"));
    CHECK(parsed("{\"version\":1,\"steps\":[{\"status\":\"exploded\"}]}").value("steps")[0].toObject().value("status") == QStringLiteral("pending"));
    CHECK(parsed("{\"version\":1,\"steps\":[{\"title\":\"a\"}]}").value("steps")[0].toObject().value("files") == QJsonArray());
    CHECK(parsed("{\"version\":1,\"steps\":[{\"files\":[\"a\",7,null]}]}").value("steps")[0].toObject().value("files") == QJsonArray{"a"});

    const QJsonObject prog = BuildState::describeProgress(back);
    CHECK(prog.value("done") == 1 && prog.value("total") == 3);
    CHECK(prog.value("unfinished") == true);
    const auto allDone = BuildState::parseText(NodeCompat::stringify(BuildState::serialise(plan,
        QJsonArray{QJsonObject{{"title", "a"}, {"status", "done"}}, QJsonObject{{"title", "b"}, {"status", "skipped"}}},
        QJsonValue::Undefined, QJsonValue::Undefined)));
    CHECK(BuildState::describeProgress(allDone).value("unfinished") == false);
    CHECK(BuildState::describeProgress(std::nullopt).value("unfinished") == false);

    const QJsonObject timed = BuildState::serialise(plan, QJsonArray{QJsonObject{{"title", "a"}, {"status", "done"},
        {"timing", QJsonObject{{"totalMs", 104100}, {"phases", QJsonObject{{"writing", 78000}, {"checking", 23400}}}}}}},
        QJsonValue::Undefined, QJsonValue::Undefined);
    const QJsonObject timing = timed.value("steps")[0].toObject().value("timing").toObject();
    CHECK(timing.value("totalMs") == 104100);
    CHECK(timing.value("phases").toObject().value("writing") == 78000);
    CHECK(BuildState::parseText(NodeCompat::stringify(timed))->value("steps")[0].toObject().value("timing").toObject()
              .value("phases").toObject().value("checking") == 23400);
    CHECK(!parsed("{\"version\":1,\"steps\":[{\"timing\":{\"totalMs\":\"soon\"}}]}").value("steps")[0].toObject().contains("timing"));
    CHECK(NodeCompat::stringify(parsed("{\"version\":1,\"steps\":[{\"timing\":{\"totalMs\":5,\"phases\":{\"a\":-3,\"b\":7}}}]}")
              .value("steps")[0].toObject().value("timing").toObject().value("phases"), {}, 0) == QStringLiteral("{\"b\":7}"));
    CHECK(!parsed("{\"version\":1,\"steps\":[{\"title\":\"a\"}]}").value("steps")[0].toObject().contains("timing"));
    CHECK(BuildState::kDir == QStringLiteral(".closeni") && BuildState::kName == QStringLiteral("build.json"));
}

void TestBuildStore::checkpoints()
{
    using Opt = std::optional<QString>;
    const auto s4 = sealed(3, {{"streaks.py", Opt()}, {"app.py", Opt("APP v3")}, {"util.py", Opt()}},
                           {{"app.py", Opt("APP v4")}, {"streaks.py", Opt("S")}, {"util.py", Opt("U")}});
    const auto s5 = sealed(4, {{"app.py", Opt("APP v4")}, {"routes.py", Opt()}}, {{"app.py", Opt("APP v5")}, {"routes.py", Opt("R")}});

    Checkpoint::Current now{{"app.py", Opt("APP v5")}, {"streaks.py", Opt("S")}, {"util.py", Opt("U")}, {"routes.py", Opt("R")}};
    const QJsonObject plan = Checkpoint::planRollback({s4, s5}, 3, now);
    CHECK2(NodeCompat::stringify(plan.value("steps"), {}, 0) == QStringLiteral("[3,4]"), NodeCompat::stringify(plan, {}, 0));
    CHECK(plan.value("restore").toObject().value("app.py") == QStringLiteral("APP v3"));
    QStringList removed = strings(plan.value("remove"));
    removed.sort();
    CHECK2(removed == QStringList({"routes.py", "streaks.py", "util.py"}), removed.join(","));
    CHECK(plan.value("drifted").toArray().isEmpty());

    now["app.py"] = Opt("APP v5 + my fix");
    const QJsonObject edited = Checkpoint::planRollback({s4, s5}, 3, now);
    CHECK2(strings(edited.value("drifted")) == QStringList{"app.py"}, NodeCompat::stringify(edited.value("drifted"), {}, 0));
    CHECK(edited.value("restore").toObject().value("app.py") == QStringLiteral("APP v3"));
    now["app.py"] = Opt("APP v5");
    now["streaks.py"] = Opt();
    CHECK(strings(Checkpoint::planRollback({s4, s5}, 3, now).value("drifted")).contains("streaks.py"));
    CHECK(Checkpoint::planRollback({s4, s5}, 3, {}).value("drifted").toArray().isEmpty());

    const QJsonObject later = Checkpoint::planRollback({s4, s5}, 4, {{"app.py", Opt("APP v5")}, {"routes.py", Opt("R")}});
    CHECK(NodeCompat::stringify(later.value("steps"), {}, 0) == QStringLiteral("[4]"));
    CHECK(later.value("restore").toObject().value("app.py") == QStringLiteral("APP v4"));
    CHECK(!strings(later.value("remove")).contains("streaks.py"));

    const auto big = sealed(0, {{"data.bin", Opt()}}, {{"data.bin", Opt("y")}}, {"data.bin"});
    const QJsonObject bigPlan = Checkpoint::planRollback({big}, 0, {{"data.bin", Opt("y")}});
    CHECK(strings(bigPlan.value("unrestorable")) == QStringList{"data.bin"});
    CHECK(!bigPlan.value("restore").toObject().contains("data.bin") && !strings(bigPlan.value("remove")).contains("data.bin"));

    const QString json = QStringLiteral("{\"version\":1,\"step\":3,\"at\":\"T\",\"files\":{\"app.py\":{\"prior\":\"APP v3\",\"after\":\"%1\"},"
                                        "\"streaks.py\":{\"prior\":null,\"after\":null}}}").arg(Checkpoint::hash("APP v4"));
    const auto round = Checkpoint::parse(json);
    CHECK(round && round->step == 3 && round->files.value("app.py").prior == Opt("APP v3") && !round->files.value("streaks.py").prior);
    CHECK(!Checkpoint::parse("{{"));
    CHECK(!Checkpoint::parse("{\"version\":9,\"step\":0,\"files\":{}}"));
    CHECK(!Checkpoint::parse("{\"version\":1,\"files\":{}}"));
    CHECK(!Checkpoint::parse("{\"version\":1,\"step\":-2,\"files\":{}}"));
    CHECK(Checkpoint::planRollback({}, 0, {}).value("steps").toArray().isEmpty());
    CHECK(Checkpoint::checkpointName(0) == QStringLiteral("step-001.json") && Checkpoint::checkpointName(11) == QStringLiteral("step-012.json"));
    CHECK(std::isnan(NodeCompat::toNumber(QJsonValue::Undefined)));
}

void TestBuildStore::service()
{
    BuildStore builds;
    Harness h;
    h.expose("Builds", &builds);
    QTemporaryDir ws;
    h.engine.globalObject().setProperty("WS", ws.path());

    // Absent is null, as QML must see it - not undefined, not {}.
    QJsonValue r = h.call("Builds.readBuildState(WS, cb)");
    CHECK2(h.lastText == QStringLiteral("null"), h.lastText);
    r = h.call("Builds.writeBuildState({}, cb)");
    CHECK2(r.toObject().value("ok") == false && r.toObject().value("error") == QStringLiteral("no workspace"), h.lastText);

    r = h.call("Builds.writeBuildState({ workspace: WS, plan: { summary: 'S', runCommand: 'python app.py' },"
               " steps: [{ title: 'a', detail: 'd', files: ['a.py'], dependsOn: [], status: 'done' },"
               "         { title: 'b', detail: '', files: [], dependsOn: [0], status: 'running' }], provider: 'mock' }, cb)");
    CHECK2(r.toObject().value("ok") == true && r.toObject().value("startedAt").isString(), h.lastText);
    const QString onDisk = readAll(QDir(ws.path()).filePath(".closeni/build.json"));
    CHECK2(onDisk.startsWith("{\n  \"version\": 1,") && onDisk.endsWith("}\n"), onDisk.left(80));

    r = h.call("Builds.readBuildState(WS, cb)");
    CHECK2(r.toObject().value("steps").toArray().size() == 2, h.lastText);
    CHECK(r.toObject().value("steps")[1].toObject().value("status") == QStringLiteral("pending"));

    h.engine.globalObject().setProperty("GONE", QDir(ws.path()).filePath("missing"));
    r = h.call("Builds.workspaceProgress([WS, GONE, ''], cb)");
    const QJsonObject progress = r.toObject().value("progress").toObject();
    CHECK2(progress.value(ws.path()).toObject().value("done") == 1, h.lastText);
    CHECK2(progress.value(QDir(ws.path()).filePath("missing")).toObject().value("missing") == true, h.lastText);

    writeAll(QDir(ws.path()).filePath(".closeni/build.json"), "{ not json");
    h.call("Builds.readBuildState(WS, cb)");
    CHECK2(h.lastText == QStringLiteral("null"), h.lastText);
    r = h.call("Builds.clearBuildState(WS, cb)");
    CHECK2(r.toObject().value("ok") == true && !QFile::exists(QDir(ws.path()).filePath(".closeni/build.json")), h.lastText);

    r = h.call("Builds.planRollback('', 0, cb)");
    CHECK(r.toObject().value("error") == QStringLiteral("no workspace"));
    r = h.call("Builds.planRollback(WS, 0, cb)");
    CHECK2(r.toObject().value("error") == QStringLiteral("nothing recorded for this build yet"), h.lastText);
    r = h.call("Builds.applyRollback(WS, {}, cb)");
    CHECK2(r.toObject().value("error") == QStringLiteral("no plan"), h.lastText);
}

void TestBuildStore::rollbackOnDisk()
{
    BuildStore builds;
    Harness h;
    h.expose("Builds", &builds);
    QTemporaryDir ws;
    const QDir d(ws.path());
    h.engine.globalObject().setProperty("WS", ws.path());

    // Step 4 rewrote app.py and added streaks.py; step 5 rewrote app.py again
    // and added routes.py. The workspace is as step 5 left it.
    writeAll(d.filePath("app.py"), "print('v5')\n");
    writeAll(d.filePath("streaks.py"), "S=1\n");
    writeAll(d.filePath("routes.py"), "R=1\n");
    const QString cpDir = Checkpoint::dirFor(ws.path());
    writeAll(QDir(cpDir).filePath(Checkpoint::checkpointName(3)),
             QStringLiteral("{\"version\":1,\"step\":3,\"at\":\"T1\",\"files\":{\"app.py\":{\"prior\":\"print('v3')\\n\",\"after\":\"%1\"},"
                            "\"streaks.py\":{\"prior\":null,\"after\":\"%2\"}}}")
                 .arg(Checkpoint::hash("print('v4')\n"), Checkpoint::hash("S=1\n")).toUtf8());
    writeAll(QDir(cpDir).filePath(Checkpoint::checkpointName(4)),
             QStringLiteral("{\"version\":1,\"step\":4,\"at\":\"T2\",\"files\":{\"app.py\":{\"prior\":\"print('v4')\\n\",\"after\":\"%1\"},"
                            "\"routes.py\":{\"prior\":null,\"after\":\"%2\"}}}")
                 .arg(Checkpoint::hash("print('v5')\n"), Checkpoint::hash("R=1\n")).toUtf8());
    writeAll(QDir(cpDir).filePath("step-099.json"), "corrupt");

    QJsonValue r = h.call("Builds.planRollback(WS, 3, cb)");
    const QJsonObject plan = r.toObject().value("plan").toObject();
    CHECK2(r.toObject().value("ok") == true && plan.value("drifted").toArray().isEmpty(), h.lastText);
    h.engine.globalObject().setProperty("PLAN", h.engine.evaluate("(" + NodeCompat::stringify(plan, {}, 0) + ")"));

    r = h.call("Builds.applyRollback(WS, PLAN, cb)");
    CHECK2(r.toObject().value("ok") == true, h.lastText);
    CHECK2(readAll(d.filePath("app.py")) == QStringLiteral("print('v3')\n"), readAll(d.filePath("app.py")));
    CHECK(!QFile::exists(d.filePath("streaks.py")));
    CHECK(!QFile::exists(d.filePath("routes.py")));
    CHECK2(!QFile::exists(QDir(cpDir).filePath(Checkpoint::checkpointName(3))) && !QFile::exists(QDir(cpDir).filePath(Checkpoint::checkpointName(4))),
           QDir(cpDir).entryList(QDir::Files).join(","));

    // A plan naming a path outside the workspace is refused, not followed.
    r = h.call("Builds.applyRollback(WS, { toStep: 0, steps: [0], restore: { '../escape.txt': 'x' }, remove: ['../../etc/passwd'] }, cb)");
    CHECK2(r.toObject().value("refused").toArray().size() == 2, h.lastText);
    CHECK(!QFile::exists(QDir(ws.path()).filePath("../escape.txt")));

    r = h.call("Builds.clearCheckpoints(WS, cb)");
    CHECK2(r.toObject().value("ok") == true && !QDir(cpDir).exists(), h.lastText);
}

void TestBuildStore::manifestService()
{
    BuildStore builds;
    Harness h;
    h.expose("Builds", &builds);
    QTemporaryDir ws;
    const QDir d(ws.path());
    h.engine.globalObject().setProperty("WS", ws.path());

    h.call("Builds.readManifest(WS, cb)");
    CHECK2(h.lastText == QStringLiteral("null"), h.lastText);
    QJsonValue r = h.call("Builds.writeManifest({ workspace: WS, run: 'python3 app.py', install: 'pip install flask' }, cb)");
    CHECK2(r.toObject().value("ok") == true && r.toObject().value("manifest").toObject().value("run") == QStringLiteral("python3 app.py"), h.lastText);
    CHECK(QFileInfo(d.filePath("run.sh")).isExecutable());
    CHECK(readAll(d.filePath("run.bat")).startsWith("@echo off"));
    CHECK2(readAll(d.filePath("closeni.run.json")).endsWith("}\n"), readAll(d.filePath("closeni.run.json")));

    h.call("Builds.writeManifest({ workspace: WS, run: 'python3 mine.py', userEdited: true }, cb)");
    r = h.call("Builds.writeManifest({ workspace: WS, run: 'python3 generated.py' }, cb)");
    CHECK2(r.toObject().value("manifest").toObject().value("run") == QStringLiteral("python3 mine.py"), h.lastText);
    r = h.call("Builds.readManifest(WS, cb)");
    CHECK(r.toObject().value("userEdited") == true);
    r = h.call("Builds.writeManifest({ run: 'x' }, cb)");
    CHECK2(r.toObject().value("ok") == false && r.toObject().value("error").toString().contains("ERR_INVALID_ARG_TYPE"), h.lastText);
}

QTEST_GUILESS_MAIN(TestBuildStore)
#include "tst_buildstore.moc"
