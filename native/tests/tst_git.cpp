/*
 * The Git service and the export-branch planning it
 * replays. Translates build-unit.cjs "a build replayed as one commit per
 * step", then runs git for real in a scratch repository.
 */
#include "data_harness.h"

#include "BuildRules.h"
#include "BuildStore.h"
#include "GitService.h"

#include <QProcess>
#include <QSignalSpy>
#include <QStandardPaths>

namespace {

using Opt = std::optional<QString>;

Checkpoint::Record cp(int step, const QMap<QString, Checkpoint::Entry> &files, const QString &title = QString())
{
    Checkpoint::Record r;
    r.step = step;
    if (!title.isNull())
        r.title = title;
    r.files = files;
    return r;
}

Checkpoint::Entry entry(Opt prior, Opt after, bool tooLarge = false)
{
    Checkpoint::Entry e;
    e.prior = prior;
    e.after = after;
    e.tooLarge = tooLarge;
    return e;
}

QString runGit(const QString &cwd, const QStringList &args)
{
    QProcess p;
    p.setWorkingDirectory(cwd);
    p.setProcessChannelMode(QProcess::MergedChannels);
    p.start("git", args);
    p.waitForFinished(30000);
    return QString::fromUtf8(p.readAll());
}

/*
 * A three-step build's checkpoints, and the files as it left them: step 1
 * writes app.py, step 2 rewrites it and adds routes.py, step 3 adds models.py.
 * Files that appear after step 1 are what the replay has to stage as absent
 * in the earlier commits.
 */
void writeThreeStepBuild(const QString &ws)
{
    const QDir d(ws);
    writeAll(d.filePath("app.py"), "v2\n");
    writeAll(d.filePath("routes.py"), "R\n");
    writeAll(d.filePath("models.py"), "M\n");
    const QDir cps(Checkpoint::dirFor(ws));
    writeAll(cps.filePath(Checkpoint::checkpointName(0)),
             QStringLiteral("{\"version\":1,\"step\":0,\"at\":\"\",\"files\":{\"app.py\":{\"prior\":null,\"after\":\"%1\"}}}")
                 .arg(Checkpoint::hash("v1\n")).toUtf8());
    writeAll(cps.filePath(Checkpoint::checkpointName(1)),
             QStringLiteral("{\"version\":1,\"step\":1,\"at\":\"\",\"files\":{\"app.py\":{\"prior\":\"v1\\n\",\"after\":\"%1\"},"
                            "\"routes.py\":{\"prior\":null,\"after\":\"%2\"}}}")
                 .arg(Checkpoint::hash("v2\n"), Checkpoint::hash("R\n")).toUtf8());
    writeAll(cps.filePath(Checkpoint::checkpointName(2)),
             QStringLiteral("{\"version\":1,\"step\":2,\"at\":\"\",\"files\":{\"models.py\":{\"prior\":null,\"after\":\"%1\"}}}")
                 .arg(Checkpoint::hash("M\n")).toUtf8());
}

QStringList treeAt(const QString &ws, const QString &rev)
{
    QStringList names = runGit(ws, {"ls-tree", "--name-only", rev}).trimmed().split('\n', Qt::SkipEmptyParts);
    names.sort();
    return names;
}

}

class TestGit : public QObject
{
    Q_OBJECT

private slots:
    void initTestCase();
    void exportPlanning();
    void gitHandler();
    void exportBranch();
    void exportFilesAppearingLater();
    void closeniIsNotAChange();
    void cleanupTestCase() { REPORT_CHECKS(); }

private:
    ScratchStorage m_storage;
};

void TestGit::initTestCase()
{
    if (QStandardPaths::findExecutable("git").isEmpty())
        QSKIP("git is not installed");
    // A scratch identity, so a commit works on a machine with none configured.
    qputenv("GIT_AUTHOR_NAME", "CloseNI Test");
    qputenv("GIT_AUTHOR_EMAIL", "test@closeni.invalid");
    qputenv("GIT_COMMITTER_NAME", "CloseNI Test");
    qputenv("GIT_COMMITTER_EMAIL", "test@closeni.invalid");
    qputenv("GIT_CONFIG_GLOBAL", m_storage.file("gitconfig").toUtf8());
    qputenv("GIT_CONFIG_NOSYSTEM", "1");
}

void TestGit::exportPlanning()
{
    CHECK(ExportBranch::branchName("Flask Habit Tracker!") == QStringLiteral("closeni/flask-habit-tracker"));
    CHECK(ExportBranch::branchName("") == QStringLiteral("closeni/build"));
    CHECK(ExportBranch::branchName("!!!") == QStringLiteral("closeni/build"));
    CHECK(!ExportBranch::branchName("a very long project summary that goes on and on and on and on").endsWith('-'));
    CHECK(ExportBranch::commitMessage(5, "Streak\ncalculation") == QStringLiteral("step 6: Streak calculation"));
    CHECK(ExportBranch::commitMessage(0, "") == QStringLiteral("step 1: changes"));

    const QList<Checkpoint::Record> checkpoints{
        cp(3, {{"app.py", entry(Opt("v3"), Opt("h4"))}, {"streaks.py", entry(Opt(), Opt("hs"))}}, "Streaks"),
        cp(4, {{"app.py", entry(Opt("v4"), Opt("h5"))}, {"routes.py", entry(Opt(), Opt("hr"))}}, "Routes"),
    };
    const Checkpoint::Current current{{"app.py", Opt("v5")}, {"streaks.py", Opt("S")}, {"routes.py", Opt("R")}};
    const auto plan = ExportBranch::planCommits(checkpoints, current);
    CHECK(plan.commits.size() == 2);
    CHECK(plan.commits[0].step == 3 && plan.commits[1].step == 4);
    CHECK(plan.commits[0].writes.value("app.py") == QStringLiteral("v4"));
    CHECK(plan.commits[0].writes.value("streaks.py") == QStringLiteral("S"));
    CHECK(plan.commits[1].writes.value("app.py") == QStringLiteral("v5"));
    CHECK(!plan.commits[0].writes.contains("routes.py"));
    CHECK(plan.commits[0].title == QStringLiteral("Streaks"));
    CHECK(ExportBranch::planCommits(checkpoints, current, {{3, "Better name"}}).commits[0].title == QStringLiteral("Better name"));
    CHECK2(plan.warnings.isEmpty(), plan.warnings.join(" "));
    CHECK2(plan.commits[0].deletes.contains("routes.py"), plan.commits[0].deletes.join(","));
    CHECK(plan.commits[1].writes.value("routes.py") == QStringLiteral("R"));
    CHECK(plan.commits[1].writes.value("streaks.py") == QStringLiteral("S"));

    const auto gone = ExportBranch::planCommits(checkpoints, {{"app.py", Opt("v5")}, {"streaks.py", Opt()}, {"routes.py", Opt("R")}});
    CHECK(gone.commits[0].deletes.contains("streaks.py"));
    CHECK(!gone.commits[0].writes.contains("streaks.py"));

    const auto unread = ExportBranch::planCommits(checkpoints, {{"app.py", Opt("v5")}, {"routes.py", Opt("R")}});
    CHECK(!unread.commits[0].writes.contains("streaks.py") && !unread.commits[0].deletes.contains("streaks.py"));
    CHECK2(unread.warnings.join(" ").contains("streaks.py"), unread.warnings.join(" "));

    const auto big = ExportBranch::planCommits({cp(0, {{"data.bin", entry(Opt(), Opt(), true)}})}, {{"data.bin", Opt("x")}});
    CHECK2(big.warnings.join(" ").contains("too large"), big.warnings.join(" "));
    CHECK(ExportBranch::planCommits({}, {}).commits.isEmpty());
}

void TestGit::gitHandler()
{
    GitService git;
    Harness h;
    h.expose("Git", &git);
    QSignalSpy log(&git, &GitService::projectLog);
    QTemporaryDir repo;
    h.engine.globalObject().setProperty("REPO", repo.path());

    QJsonValue r = h.call("Git.git({ args: 'status', cwd: REPO }, cb)");
    CHECK2(r.toObject().value("success") == false && r.toObject().value("output") == QStringLiteral("git arguments must be a list"), h.lastText);
    r = h.call("Git.git({ args: ['status', 5], cwd: REPO }, cb)");
    CHECK2(r.toObject().value("output") == QStringLiteral("git argument 1 is not a string"), h.lastText);

    r = h.call("Git.git({ args: ['init', '-q'], cwd: REPO }, cb)");
    CHECK2(r.toObject().value("success") == true, h.lastText);
    // An argument is data, not syntax: no shell runs it.
    r = h.call("Git.git({ args: ['commit', '--allow-empty', '-m', 'fix; touch pwned $(id)'], cwd: REPO }, cb)");
    CHECK2(r.toObject().value("success") == true, h.lastText);
    CHECK(!QFile::exists(QDir(repo.path()).filePath("pwned")));
    CHECK2(runGit(repo.path(), {"log", "-1", "--format=%s"}).trimmed() == QStringLiteral("fix; touch pwned $(id)"),
           runGit(repo.path(), {"log", "-1", "--format=%s"}));
    CHECK2(!log.isEmpty() && log.last().at(0).toString().startsWith("git> "), QString::number(log.size()));

    r = h.call("Git.git({ args: ['status'], cwd: REPO + '/missing' }, cb)");
    CHECK2(r.toObject().value("success") == false && r.toObject().value("output") == QStringLiteral("Error: spawn git ENOENT"), h.lastText);
    r = h.call("Git.git({ args: ['no-such-command'], cwd: REPO }, cb)");
    CHECK2(r.toObject().value("success") == false && r.toObject().value("output").toString().contains("not a git command"), h.lastText);
}

void TestGit::exportBranch()
{
    GitService git;
    Harness h;
    h.expose("Git", &git);
    QTemporaryDir ws;
    const QDir d(ws.path());
    h.engine.globalObject().setProperty("WS", ws.path());

    QJsonValue r = h.call("Git.exportBranch({}, cb)");
    CHECK2(r.toObject().value("error") == QStringLiteral("no workspace"), h.lastText);
    r = h.call("Git.exportBranch({ workspace: WS }, cb)");
    CHECK2(r.toObject().value("error") == QStringLiteral("nothing to export - no build has run in this workspace"), h.lastText);

    // The finished build, committed with its .closeni: step 1 wrote app.py,
    // step 2 rewrote it and added routes.py. (A workspace that is not a repo
    // yet, and an untracked .closeni, are exportFilesAppearingLater and
    // closeniIsNotAChange.)
    writeAll(d.filePath("app.py"), "v2\n");
    writeAll(d.filePath("routes.py"), "R\n");
    const QString cps = Checkpoint::dirFor(ws.path());
    writeAll(QDir(cps).filePath(Checkpoint::checkpointName(0)),
             QStringLiteral("{\"version\":1,\"step\":0,\"at\":\"\",\"files\":{\"app.py\":{\"prior\":null,\"after\":\"%1\"}}}")
                 .arg(Checkpoint::hash("v1\n")).toUtf8());
    writeAll(QDir(cps).filePath(Checkpoint::checkpointName(1)),
             QStringLiteral("{\"version\":1,\"step\":1,\"at\":\"\",\"files\":{\"app.py\":{\"prior\":\"v1\\n\",\"after\":\"%1\"},"
                            "\"routes.py\":{\"prior\":null,\"after\":\"%2\"}}}")
                 .arg(Checkpoint::hash("v2\n"), Checkpoint::hash("R\n")).toUtf8());
    runGit(ws.path(), {"init", "-q"});
    runGit(ws.path(), {"add", "-A"});
    runGit(ws.path(), {"commit", "-q", "-m", "built"});

    r = h.call("Git.exportBranch({ workspace: WS, summary: 'Habit Tracker', steps: ['Scaffold', 'Routes'] }, cb)", 60000);
    CHECK2(r.toObject().value("ok") == true && r.toObject().value("branch") == QStringLiteral("closeni/habit-tracker")
               && r.toObject().value("commits") == 2, h.lastText);
    const QString log = runGit(ws.path(), {"log", "--format=%s", "closeni/habit-tracker"});
    CHECK2(log.startsWith("step 2: Routes\nstep 1: Scaffold"), log);
    CHECK2(runGit(ws.path(), {"show", "closeni/habit-tracker~1:app.py"}) == QStringLiteral("v1\n"),
           runGit(ws.path(), {"show", "closeni/habit-tracker~1:app.py"}));
    CHECK2(runGit(ws.path(), {"ls-tree", "--name-only", "closeni/habit-tracker~1"}).trimmed().split('\n').contains("app.py")
               && !runGit(ws.path(), {"ls-tree", "--name-only", "closeni/habit-tracker~1"}).contains("routes.py"),
           runGit(ws.path(), {"ls-tree", "--name-only", "closeni/habit-tracker~1"}));
    // The workspace is left as the build left it.
    CHECK(readAll(d.filePath("app.py")) == QStringLiteral("v2\n") && readAll(d.filePath("routes.py")) == QStringLiteral("R\n"));

    // A dirty tree is refused rather than swept into the export.
    writeAll(d.filePath("app.py"), "edited\n");
    r = h.call("Git.exportBranch({ workspace: WS, summary: 'Habit Tracker' }, cb)", 60000);
    CHECK2(r.toObject().value("ok") == false && r.toObject().value("error").toString().startsWith("You have uncommitted changes."), h.lastText);
}

/*
 * Files that appear after step 1, in a workspace that is not a repository yet
 * and in one that is. Step 1's commit stages routes.py and models.py as
 * absent, and git refuses to add a path it neither tracks nor finds on disk:
 * the export failed at step 1 in a new repository, and at step 2 in an
 * existing one (step 1's commit had already dropped models.py from the index).
 */
void TestGit::exportFilesAppearingLater()
{
    GitService git;
    Harness h;
    h.expose("Git", &git);

    // Not a repository: the export creates one.
    QTemporaryDir fresh;
    writeThreeStepBuild(fresh.path());
    h.engine.globalObject().setProperty("WS", fresh.path());
    QJsonValue r = h.call("Git.exportBranch({ workspace: WS, summary: 'Shop', steps: ['App', 'Routes', 'Models'] }, cb)", 60000);
    CHECK2(r.toObject().value("ok") == true && r.toObject().value("commits") == 3, h.lastText);
    const QString log = runGit(fresh.path(), {"log", "--format=%s", "closeni/shop"});
    CHECK2(log == QStringLiteral("step 3: Models\nstep 2: Routes\nstep 1: App\n"), log);
    CHECK2(treeAt(fresh.path(), "closeni/shop~2") == QStringList{"app.py"}, treeAt(fresh.path(), "closeni/shop~2").join(","));
    CHECK2(treeAt(fresh.path(), "closeni/shop~1") == (QStringList{"app.py", "routes.py"}), treeAt(fresh.path(), "closeni/shop~1").join(","));
    CHECK2(treeAt(fresh.path(), "closeni/shop") == (QStringList{"app.py", "models.py", "routes.py"}),
           treeAt(fresh.path(), "closeni/shop").join(","));
    CHECK(runGit(fresh.path(), {"show", "closeni/shop~2:app.py"}) == QStringLiteral("v1\n"));
    const QDir f(fresh.path());
    CHECK(readAll(f.filePath("app.py")) == QStringLiteral("v2\n") && readAll(f.filePath("routes.py")) == QStringLiteral("R\n")
          && readAll(f.filePath("models.py")) == QStringLiteral("M\n"));

    // An existing repository holding the finished build.
    QTemporaryDir repo;
    writeThreeStepBuild(repo.path());
    runGit(repo.path(), {"init", "-q"});
    runGit(repo.path(), {"add", "-A"});
    runGit(repo.path(), {"commit", "-q", "-m", "built"});
    h.engine.globalObject().setProperty("WS", repo.path());
    r = h.call("Git.exportBranch({ workspace: WS, summary: 'Shop' }, cb)", 60000);
    CHECK2(r.toObject().value("ok") == true && r.toObject().value("commits") == 3, h.lastText);
    CHECK2(treeAt(repo.path(), "closeni/shop~1").contains("routes.py") && !treeAt(repo.path(), "closeni/shop~1").contains("models.py")
               && treeAt(repo.path(), "closeni/shop").contains("models.py"),
           treeAt(repo.path(), "closeni/shop~1").join(","));
}

/*
 * .closeni is CloseNI's own folder: the build state and checkpoints. It must
 * not make a committed project count as having uncommitted changes, refuse
 * the export, or be swept into a commit.
 */
void TestGit::closeniIsNotAChange()
{
    GitService git;
    BuildStore builds;
    Harness h;
    h.expose("Git", &git);
    h.expose("Builds", &builds);

    // A committed project with a build's checkpoints beside it, untracked and
    // with nothing telling git to ignore them (as an older CloseNI left them).
    QTemporaryDir repo;
    writeThreeStepBuild(repo.path());
    runGit(repo.path(), {"init", "-q"});
    runGit(repo.path(), {"add", "--", "app.py", "routes.py", "models.py"});
    runGit(repo.path(), {"commit", "-q", "-m", "built"});
    CHECK2(runGit(repo.path(), {"status", "--porcelain"}).contains(".closeni"), runGit(repo.path(), {"status", "--porcelain"}));
    h.engine.globalObject().setProperty("WS", repo.path());
    QJsonValue r = h.call("Git.exportBranch({ workspace: WS, summary: 'Shop' }, cb)", 60000);
    CHECK2(r.toObject().value("ok") == true && r.toObject().value("commits") == 3, h.lastText);
    CHECK2(!runGit(repo.path(), {"log", "--name-only", "--format=", "closeni/shop"}).contains(".closeni"),
           runGit(repo.path(), {"log", "--name-only", "--format=", "closeni/shop"}));
    // The user's own uncommitted work still counts.
    writeAll(QDir(repo.path()).filePath("notes.txt"), "mine\n");
    r = h.call("Git.exportBranch({ workspace: WS, summary: 'Other' }, cb)", 60000);
    CHECK2(r.toObject().value("ok") == false && r.toObject().value("error").toString().startsWith("You have uncommitted changes."), h.lastText);

    // Writing the build state marks the folder as ignored from inside it, so
    // git status, the Push panel's Commit (add -A) and the Code panel's
    // changed-file count leave it out too, without touching the project's
    // own .gitignore.
    QTemporaryDir ws;
    runGit(ws.path(), {"init", "-q"});
    writeAll(QDir(ws.path()).filePath("main.py"), "print(1)\n");
    runGit(ws.path(), {"add", "-A"});
    runGit(ws.path(), {"commit", "-q", "-m", "start"});
    h.engine.globalObject().setProperty("WS", ws.path());
    r = h.call("Builds.writeBuildState({ workspace: WS, plan: { summary: 'S' }, steps: [{ title: 'a', status: 'done' }] }, cb)");
    CHECK2(r.toObject().value("ok") == true, h.lastText);
    CHECK(QFile::exists(QDir(ws.path()).filePath(".closeni/build.json")));
    const QString status = runGit(ws.path(), {"status", "--porcelain", "--untracked-files=all"});
    CHECK2(status.isEmpty(), status);
    CHECK(!QFile::exists(QDir(ws.path()).filePath(".gitignore")));
    runGit(ws.path(), {"add", "-A"});
    CHECK2(runGit(ws.path(), {"diff", "--cached", "--name-only"}).isEmpty(), runGit(ws.path(), {"diff", "--cached", "--name-only"}));
    // A marker the user edited is theirs: it is not rewritten.
    const QString marker = QDir(ws.path()).filePath(".closeni/.gitignore");
    writeAll(marker, "checkpoints/\n");
    h.call("Builds.writeBuildState({ workspace: WS, plan: { summary: 'S' }, steps: [{ title: 'a', status: 'done' }] }, cb)");
    CHECK(readAll(marker) == QStringLiteral("checkpoints/\n"));
}

QTEST_GUILESS_MAIN(TestGit)
#include "tst_git.moc"
