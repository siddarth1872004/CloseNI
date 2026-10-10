/*
 * The Test, Research and Ship panels, end to end in the real window:
 * `CloseNI --self-test <dir> --self-test-flow Ship` runs qml/shell/ShipFlow.qml
 * against what this sets up, and this checks what reached the outside.
 *
 *   - a scratch git workspace holding a two-step build's checkpoints, so
 *     export has something to replay, and a bare repository beside it as the
 *     push remote;
 *   - the local GitHub mock (mock_github.h): sign-in, repositories, Actions
 *     runs, search, a README and a file tree. Nothing reaches github.com;
 *   - a provider directory with a mock provider that offers no web search, so
 *     research reports that rather than opening a browser;
 *   - a scratch CLOSENI_STORAGE, so the GitHub keyring account is namespaced
 *     and the flow signs out at the end.
 *
 * The flow's own checks print "ship-flow: ok ..."; any failure is a warning,
 * which fails the app's exit code. Nine screenshots land in
 * <build>/tests/ship-ui.
 */
#include "data_harness.h"
#include "mock_github.h"

#include "BuildRules.h"

#include <QProcess>
#include <QSignalSpy>

namespace {

QString runGit(const QString &cwd, const QStringList &args)
{
    QProcess p;
    p.setWorkingDirectory(cwd);
    p.setProcessChannelMode(QProcess::MergedChannels);
    p.start("git", args);
    p.waitForFinished(30000);
    return QString::fromUtf8(p.readAll());
}

MockGitHub::Response github(const MockGitHub::Request &r)
{
    if (r.headers.value("authorization") != QStringLiteral("Bearer ghp_mock_token"))
        return {401, R"({"message":"Bad credentials"})"};
    if (r.path == QStringLiteral("/user"))
        return {200, R"({"login":"mock-user"})"};
    if (r.method == "GET" && r.path.startsWith("/user/repos"))
        return {200, R"([{"full_name":"mock-user/demo","private":false,"clone_url":"https://github.com/mock-user/demo.git"},)"
                         R"({"full_name":"mock-user/secret","private":true,"clone_url":"https://github.com/mock-user/secret.git"}])"};
    if (r.method == "POST" && r.path == QStringLiteral("/user/repos"))
        return {201, R"({"full_name":"mock-user/new-one","clone_url":"https://github.com/mock-user/new-one.git"})"};
    if (r.path.startsWith("/repos/mock-user/demo/actions/runs"))
        return {200, R"({"workflow_runs":[)"
            R"({"name":"CI","status":"completed","conclusion":"success","html_url":"https://github.com/mock-user/demo/actions/runs/1"},)"
            R"({"name":"Release","status":"in_progress","conclusion":null,"html_url":"https://github.com/mock-user/demo/actions/runs/2"},)"
            R"({"name":"Lint","status":"completed","conclusion":"failure","html_url":"https://github.com/mock-user/demo/actions/runs/3"}]})"};
    if (r.method == "POST" && r.path.endsWith("/dispatches"))
        return {204, QByteArray()};
    if (r.path.startsWith("/search/repositories"))
        return {200, R"({"items":[)"
            R"({"full_name":"pallets/flask","description":"The Python micro framework for building web applications.","stargazers_count":69000,"language":"Python","html_url":"https://github.com/pallets/flask","updated_at":"2026-09-30T00:00:00Z"},)"
            R"({"full_name":"miguelgrinberg/microblog","description":"The microblogging application from the Flask Mega-Tutorial.","stargazers_count":4700,"language":"Python","html_url":"https://github.com/miguelgrinberg/microblog","updated_at":"2026-08-01T00:00:00Z"},)"
            R"({"full_name":"example/flask-sqlite-starter","description":null,"stargazers_count":12,"language":null,"html_url":"https://github.com/example/flask-sqlite-starter","updated_at":"2026-01-01T00:00:00Z"}]})"};
    if (r.path == QStringLiteral("/repos/pallets/flask/readme"))
        return {200, QByteArray(R"({"content":")") + QByteArray("# Flask\n\nA lightweight WSGI web application framework.\n").toBase64() + R"("})"};
    if (r.path.startsWith("/repos/pallets/flask/git/trees/"))
        return {200, R"({"tree":[{"path":"src/flask/app.py","type":"blob"},{"path":"src","type":"tree"},{"path":"pyproject.toml","type":"blob"}]})"};
    return {404, R"({"message":"Not Found"})"};
}

}

class TestShipUi : public QObject
{
    Q_OBJECT

private slots:
    void flow();
    void cleanupTestCase() { REPORT_CHECKS(); }
};

void TestShipUi::flow()
{
    QTemporaryDir root;
    const QDir d(root.path());
    const QString ws = d.filePath("ws");
    const QString remote = d.filePath("remote.git");
    const QString storage = d.filePath("storage");
    const QString providers = d.filePath("providers");
    const QString shots = QStringLiteral(CLOSENI_SHIP_SHOTS);
    QDir(shots).removeRecursively();

    // The finished build: step 1 wrote hello.js, step 2 added the start script
    // and a test. Committed with its .closeni, so the tree is clean.
    const QByteArray hello = "console.log('hello from the workspace')\n";
    const QByteArray pkg = R"({"name":"demo","version":"1.0.0","scripts":{"start":"node hello.js","test":"node test.js"}})" "\n";
    const QByteArray test = "require('assert').strictEqual(1 + 1, 2)\nconsole.log('1 test passed')\n";
    writeAll(QDir(ws).filePath("hello.js"), hello);
    writeAll(QDir(ws).filePath("package.json"), pkg);
    writeAll(QDir(ws).filePath("test.js"), test);
    const QString cps = Checkpoint::dirFor(ws);
    writeAll(QDir(cps).filePath(Checkpoint::checkpointName(0)),
             QStringLiteral("{\"version\":1,\"step\":0,\"at\":\"\",\"files\":{\"hello.js\":{\"prior\":null,\"after\":\"%1\"}}}")
                 .arg(Checkpoint::hash(QString::fromUtf8(hello))).toUtf8());
    writeAll(QDir(cps).filePath(Checkpoint::checkpointName(1)),
             QStringLiteral("{\"version\":1,\"step\":1,\"at\":\"\",\"files\":{\"package.json\":{\"prior\":null,\"after\":\"%1\"},"
                            "\"test.js\":{\"prior\":null,\"after\":\"%2\"}}}")
                 .arg(Checkpoint::hash(QString::fromUtf8(pkg)), Checkpoint::hash(QString::fromUtf8(test))).toUtf8());
    runGit(ws, {"init", "-q", "-b", "main"});
    runGit(ws, {"config", "user.name", "Ship Test"});
    runGit(ws, {"config", "user.email", "ship@test.invalid"});
    runGit(ws, {"config", "commit.gpgsign", "false"});
    runGit(ws, {"add", "-A"});
    runGit(ws, {"commit", "-q", "-m", "built"});
    runGit(d.path(), {"init", "-q", "--bare", "-b", "main", remote});

    // A provider with no web search control: research says so without a browser.
    writeAll(QDir(providers).filePath("mock.json"),
             R"({"id":"mock","name":"Mock Provider","kind":"web","baseUrl":"http://127.0.0.1:9/","requiresLogin":false,)"
                 R"("selectors":{"chatInput":"#input","sendButton":"#send","assistantMessage":".assistant-msg"},)"
                 R"("completionRules":{"waitForStopButtonDisappear":false,"maxWaitMs":5000}})");

    MockGitHub mock(github);

    QProcess app;
    QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    env.insert("CLOSENI_STORAGE", storage);
    env.insert("CLOSENI_GITHUB_API", mock.url());
    env.insert("AGENT_PROVIDER_DIR", providers);
    env.insert("QT_QPA_PLATFORM", "offscreen");
    env.insert("QT_FORCE_STDERR_LOGGING", "1");
    app.setProcessEnvironment(env);
    app.setProcessChannelMode(QProcess::MergedChannels);
    app.start(QStringLiteral(CLOSENI_EXE), {"--self-test", shots, "--self-test-flow", "Ship",
                                            "--workspace", ws, "--provider", "mock"});
    QVERIFY(app.waitForStarted());
    QSignalSpy done(&app, &QProcess::finished);
    // The mock answers on this thread, so wait in an event loop, not a block.
    QVERIFY(done.wait(280000));
    const QString out = QString::fromUtf8(app.readAll());
    const QStringList failures = out.split('\n').filter("ship-flow: FAIL");
    CHECK2(failures.isEmpty(), failures.join('\n'));
    qInfo("flow checks passed: %lld", static_cast<long long>(out.split('\n').filter("ship-flow: ok").size()));
    CHECK2(out.contains("ship-flow: 9 screenshots, 0 failed"), out.right(4000));
    CHECK2(app.exitStatus() == QProcess::NormalExit && app.exitCode() == 0, out.right(4000));

    // What reached GitHub: the account, the new repository, the dispatch, the search.
    bool created = false, dispatched = false, searched = false;
    for (const MockGitHub::Request &r : std::as_const(mock.requests)) {
        if (r.method == "POST" && r.path == "/user/repos")
            created = QJsonDocument::fromJson(r.body).object().value("name") == QStringLiteral("new-one");
        if (r.method == "POST" && r.path == "/repos/mock-user/demo/actions/workflows/release.yml/dispatches")
            dispatched = QJsonDocument::fromJson(r.body).object().value("ref") == QStringLiteral("main");
        if (r.path.startsWith("/search/repositories"))
            searched = true;
    }
    CHECK(created);
    CHECK(dispatched);
    CHECK(searched);

    // What reached git: the export branch, the commit, the push. The export
    // leaves the project on its new branch, so
    // the later "commit all" lands on top of the replayed steps.
    const QString branches = runGit(ws, {"branch", "--list", "closeni/*"});
    CHECK2(branches.contains("closeni/"), branches);
    const QString branch = branches.trimmed().remove('*').trimmed();
    CHECK2(runGit(ws, {"rev-parse", "--abbrev-ref", "HEAD"}).trimmed() == branch, branch);
    const QString exportLog = runGit(ws, {"log", "--format=%s", branch});
    CHECK2(exportLog.startsWith("ship flow: the run manifest\nstep 2: ") && exportLog.contains("\nstep 1: ")
               && exportLog.indexOf("step 2: ") < exportLog.indexOf("step 1: "),
           exportLog);
    CHECK2(runGit(remote, {"rev-parse", "main"}).trimmed() == runGit(ws, {"rev-parse", "main"}).trimmed(),
           runGit(remote, {"rev-parse", "main"}));

    for (const QString &panel : QStringList{"test", "research", "push"})
        for (const QString &theme : QStringList{"terminal", "paper", "pixel"})
            CHECK2(QFileInfo(QDir(shots).filePath("ship-" + panel + "-" + theme + ".png")).size() > 0, panel + "-" + theme);
}

QTEST_GUILESS_MAIN(TestShipUi)
#include "tst_ship_ui.moc"
