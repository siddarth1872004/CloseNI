/*
 * GitHub: the safety rules (desktop-unit.cjs "github safety"), the API call
 * shapes over an injected transport ("github api shapes"), and the service
 * against a local mock of api.github.com. Nothing here reaches GitHub, and no
 * token reaches the system keyring: the session bus is pointed at nothing, so
 * the secret store is unavailable and a token stays in memory.
 */
#include "data_harness.h"
#include "mock_github.h"

#include "GitHubApi.h"
#include "GitHubSafe.h"
#include "GitHubService.h"

#include <QSignalSpy>

using GitHubSafe::parseRepoUrl;
using GitHubSafe::redactToken;

namespace {

QStringList args(const QJsonValue &v, bool *ok)
{
    QStringList out;
    QString error;
    *ok = GitHubSafe::safeGitArgs(v, &out, &error);
    return out;
}

QString repoJson(const std::optional<GitHubSafe::Repo> &r)
{
    if (!r)
        return QStringLiteral("null");
    return QStringLiteral("{\"owner\":\"%1\",\"repo\":\"%2\"}").arg(r->owner, r->repo);
}

/* Await a GitHubApi call answered synchronously by a fake transport. */
struct Outcome {
    bool ok = false;
    QJsonValue result;
    QString error;
};
GitHubApi::Done into(Outcome *o)
{
    return [o](bool ok, const QJsonValue &result, const QString &error) {
        o->ok = ok;
        o->result = result;
        o->error = error;
    };
}

struct Call {
    QString method;
    QString path;
    QJsonValue body;
};

}

class TestGitHub : public QObject
{
    Q_OBJECT

private slots:
    void initTestCase();
    void safety();
    void apiShapes();
    void service();
    void legacyToken();
    void cloneGuards();
    void cleanupTestCase() { REPORT_CHECKS(); }

private:
    ScratchStorage m_storage;
};

void TestGitHub::initTestCase()
{
    // No secret service: a signed-in token is memory-only, never the keyring.
    qputenv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/nonexistent/closeni-test-bus");
}

void TestGitHub::safety()
{
    const QString T = QStringLiteral("ghp_abcdef1234567890");
    CHECK(!redactToken("using " + T + " now", T).contains(T));
    CHECK(redactToken("using " + T, T).contains("REDACTED"));
    CHECK(!redactToken(T + " and " + T, T).contains(T));
    CHECK(!redactToken("https://x-access-token:" + T + "@github.com/a/b", T).contains(T));
    CHECK(redactToken("using " + T, T).startsWith("using "));
    CHECK(redactToken("ghp_abc is short", T) == QStringLiteral("ghp_abc is short"));
    CHECK(redactToken("hello", "") == QStringLiteral("hello"));
    CHECK(redactToken("hello", QString()) == QStringLiteral("hello"));
    CHECK(redactToken("", T) == QString());
    CHECK(redactToken(QString(), T) == QString());
    CHECK(!redactToken("a b+c d", "b+c").contains("b+c"));

    bool ok = false;
    CHECK(args(QJsonArray{"commit", "-m", "hi"}, &ok) == QStringList({"commit", "-m", "hi"}) && ok);
    CHECK(args(QJsonArray{"commit", "-m", "fix; drop table"}, &ok).value(2) == QStringLiteral("fix; drop table"));
    CHECK(args(QJsonArray{"commit", "-m", "use `x`"}, &ok).value(2) == QStringLiteral("use `x`"));
    CHECK(args(QJsonArray{"commit", "-m", "cost $(x)"}, &ok).value(2) == QStringLiteral("cost $(x)"));
    CHECK(args(QJsonArray{}, &ok).isEmpty() && ok);

    int refused = 0;
    const QList<QJsonValue> bad{QJsonArray{1}, QJsonArray{QJsonValue::Null}, QJsonArray{QJsonValue(QJsonValue::Undefined)},
                                QJsonArray{QJsonObject{}}, QJsonValue("notalist"), QJsonValue(QJsonValue::Null)};
    for (const QJsonValue &b : bad) {
        args(b, &ok);
        refused += ok ? 0 : 1;
    }
    CHECK2(refused == 6, QString::number(refused));

    CHECK(repoJson(parseRepoUrl("https://github.com/pallets/flask")) == QStringLiteral("{\"owner\":\"pallets\",\"repo\":\"flask\"}"));
    CHECK(parseRepoUrl("https://github.com/pallets/flask.git")->repo == QStringLiteral("flask"));
    CHECK(parseRepoUrl("https://github.com/pallets/flask/")->repo == QStringLiteral("flask"));
    CHECK(parseRepoUrl("https://github.com/pallets/flask/tree/main")->repo == QStringLiteral("flask"));
    CHECK(repoJson(parseRepoUrl("git@github.com:pallets/flask.git")) == QStringLiteral("{\"owner\":\"pallets\",\"repo\":\"flask\"}"));
    CHECK(parseRepoUrl("https://www.github.com/pallets/flask")->owner == QStringLiteral("pallets"));

    CHECK(!parseRepoUrl("https://gitlab.com/a/b"));
    CHECK(!parseRepoUrl("https://github.com.evil.test/a/b"));
    CHECK(!parseRepoUrl("https://notgithub.com/a/b"));
    CHECK(!parseRepoUrl("https://raw.githubusercontent.com/a/b"));
    CHECK(!parseRepoUrl("https://github.com/pallets"));
    CHECK(!parseRepoUrl(""));
    CHECK(!parseRepoUrl(QString()));
    CHECK(!parseRepoUrl("just some words"));
    CHECK(!parseRepoUrl("javascript:alert(1)"));

    CHECK(GitHubSafe::shouldPersistToken(true) == true);
    CHECK(GitHubSafe::shouldPersistToken(false) == false);
    CHECK(GitHubSafe::shouldPersistToken(std::nullopt) == false);
    // linuxPasswordStore (4 checks) is not ported: it steered Chromium's safeStorage.
}

void TestGitHub::apiShapes()
{
    QList<Call> calls;
    GitHubApi api([&calls](const QString &method, const QString &path, const QJsonValue &body, GitHubApi::Reply reply) {
        calls << Call{method, path, body};
        if (path.contains("/readme"))
            return reply({200, QJsonObject{{"content", QString::fromLatin1(QByteArray("# Hi").toBase64())}}, {}});
        if (path.contains("/git/trees/"))
            return reply({200, QJsonObject{{"tree", QJsonArray{QJsonObject{{"path", "a.py"}, {"type", "blob"}},
                                                               QJsonObject{{"path", "src"}, {"type", "tree"}}}}}, {}});
        if (path.contains("/actions/runs"))
            return reply({200, QJsonObject{{"workflow_runs", QJsonArray{QJsonObject{{"name", "ci"}, {"status", "completed"},
                                                                                    {"conclusion", "success"}, {"html_url", "u"}}}}}, {}});
        reply({200, QJsonArray{QJsonObject{{"full_name", "me/x"}, {"private", false}}}, {}});
    });

    Outcome o;
    api.listRepos(into(&o));
    CHECK2(calls[0].path.startsWith("/user/repos"), calls[0].path);
    CHECK(calls[0].path.contains("sort=updated"));

    api.getReadme("pallets", "flask", into(&o));
    CHECK2(calls[1].path == QStringLiteral("/repos/pallets/flask/readme"), calls[1].path);
    CHECK2(o.result == QStringLiteral("# Hi"), compact(o.result));

    api.getTree("pallets", "flask", into(&o));
    CHECK2(calls[2].path.contains("recursive=1"), calls[2].path);
    CHECK2(compact(o.result) == QStringLiteral("[\"a.py\"]"), compact(o.result));

    api.listRuns("pallets", "flask", into(&o));
    CHECK(calls[3].path.startsWith("/repos/pallets/flask/actions/runs"));
    const QJsonObject run = o.result.toArray().at(0).toObject();
    CHECK2(run.value("name") == QStringLiteral("ci") && run.value("conclusion") == QStringLiteral("success"), compact(o.result));

    api.dispatchWorkflow("pallets", "flask", "ci.yml", "main", into(&o));
    CHECK(calls[4].method == QStringLiteral("POST"));
    CHECK2(calls[4].path == QStringLiteral("/repos/pallets/flask/actions/workflows/ci.yml/dispatches"), calls[4].path);
    CHECK(calls[4].body.toObject().value("ref") == QStringLiteral("main"));

    api.createRepo("newthing", true, into(&o));
    CHECK(calls[5].method == QStringLiteral("POST") && calls[5].path == QStringLiteral("/user/repos"));
    CHECK(calls[5].body.toObject().value("name") == QStringLiteral("newthing"));
    CHECK(calls[5].body.toObject().value("private") == true);

    auto failing = [](int status, const QString &message) {
        GitHubApi api([status, message](const QString &, const QString &, const QJsonValue &, GitHubApi::Reply reply) {
            reply({status, QJsonObject{{"message", message}}, {}});
        });
        Outcome o;
        api.listRepos(into(&o));
        return o.ok ? QString() : o.error;
    };
    const QString msg = failing(401, "Bad credentials");
    CHECK2(msg.contains("token", Qt::CaseInsensitive) || msg.contains("401"), msg);
    const QString rate = failing(403, "API rate limit exceeded");
    CHECK2(rate.contains("rate limit", Qt::CaseInsensitive), rate);
    const QString scope = failing(403, "Resource not accessible");
    CHECK2(scope.contains("scope", Qt::CaseInsensitive), scope);
}

void TestGitHub::service()
{
    MockGitHub mock([](const MockGitHub::Request &r) -> MockGitHub::Response {
        const bool good = r.headers.value("authorization") == QStringLiteral("Bearer good-token");
        if (r.path == QStringLiteral("/user"))
            return good ? MockGitHub::Response{200, R"({"login":"octo"})"} : MockGitHub::Response{401, R"({"message":"Bad credentials"})"};
        if (!good)
            return {401, R"({"message":"Bad credentials"})"};
        if (r.path.startsWith("/user/repos"))
            return {200, R"([{"full_name":"octo/x","private":false}])"};
        return {404, R"({"message":"Not Found"})"};
    });
    GitHubService gh;
    Harness h;
    h.expose("GitHub", &gh);

    QJsonValue r = h.call("GitHub.status(cb)");
    CHECK2(r == J("{\"signedIn\":false,\"encryptionAvailable\":false,\"persisted\":false,\"login\":null}"), h.lastText);

    r = h.call("GitHub.signIn('   ', cb)");
    CHECK2(r == J("{\"ok\":false,\"error\":\"No token given.\"}"), h.lastText);
    r = h.call("GitHub.signIn('bad-token', cb)");
    CHECK2(r.toObject().value("error") == QStringLiteral("GitHub rejected that token (401)."), h.lastText);
    r = h.call("GitHub.status(cb)");
    CHECK2(r.toObject().value("signedIn") == false, h.lastText);

    r = h.call("GitHub.signIn(' good-token ', cb)");
    CHECK2(r == J("{\"ok\":true,\"login\":\"octo\",\"persisted\":false}"), h.lastText);
    CHECK2(mock.requests.last().headers.value("authorization") == QStringLiteral("Bearer good-token"), mock.requests.last().headers.value("authorization"));
    r = h.call("GitHub.status(cb)");
    CHECK2(r == J("{\"signedIn\":true,\"encryptionAvailable\":false,\"persisted\":false,\"login\":\"octo\"}"), h.lastText);
    // The token is used, never returned.
    CHECK(!h.lastText.contains("good-token"));

    r = h.call("GitHub.call('listRepos', [], cb)");
    CHECK2(r == J("{\"ok\":true,\"result\":[{\"full_name\":\"octo/x\",\"private\":false}]}"), h.lastText);
    CHECK(mock.requests.last().path == QStringLiteral("/user/repos?sort=updated&per_page=50"));
    r = h.call("GitHub.call('getReadme', ['octo', 'missing'], cb)");
    CHECK2(r.toObject().value("ok") == false && r.toObject().value("error") == QStringLiteral("Not found (404): Not Found"), h.lastText);
    r = h.call("GitHub.call('createRepo', ['thing', true], cb)");
    CHECK2(mock.requests.last().method == QStringLiteral("POST")
               && QJsonDocument::fromJson(mock.requests.last().body).object().value("private") == true, QString::fromUtf8(mock.requests.last().body));
    r = h.call("GitHub.call('deleteEverything', [], cb)");
    CHECK2(r == J("{\"ok\":false,\"error\":\"Unknown call: deleteEverything\"}"), h.lastText);

    r = h.call("GitHub.signOut(cb)");
    CHECK2(r == J("{\"ok\":true}"), h.lastText);
    r = h.call("GitHub.status(cb)");
    CHECK2(r.toObject().value("signedIn") == false && r.toObject().value("login").isNull(), h.lastText);
    r = h.call("GitHub.call('listRepos', [], cb)");
    CHECK2(r.toObject().value("error") == QStringLiteral("GitHub rejected the token (401): Bad credentials"), h.lastText);
}

void TestGitHub::legacyToken()
{
    // Electron's safeStorage blob: present, unreadable here.
    writeAll(m_storage.file("github.token"), QByteArray("v11\x01\x02\x03", 6));
    GitHubService gh;
    Harness h;
    h.expose("GitHub", &gh);
    QJsonValue r = h.call("GitHub.status(cb)");
    CHECK2(r.toObject().value("signedIn") == false && r.toObject().value("legacyToken") == true, h.lastText);
    CHECK2(r.toObject().value("message").toString().contains("sign in again"), h.lastText);
    r = h.call("GitHub.signOut(cb)");
    CHECK(!QFile::exists(m_storage.file("github.token")));
    r = h.call("GitHub.status(cb)");
    CHECK2(!r.toObject().contains("legacyToken"), h.lastText);
}

void TestGitHub::cloneGuards()
{
    GitHubService gh;
    Harness h;
    h.expose("GitHub", &gh);
    QJsonValue r = h.call("GitHub.clone({ url: 'https://github.com.evil.test/a/b', workspace: '/tmp' }, cb)");
    CHECK2(r == J("{\"ok\":false,\"error\":\"Not a GitHub repository URL.\"}"), h.lastText);
    r = h.call("GitHub.clone({ workspace: '/tmp' }, cb)");
    CHECK2(r.toObject().value("error") == QStringLiteral("Not a GitHub repository URL."), h.lastText);
    r = h.call("GitHub.clone({ url: 'https://github.com/pallets/flask' }, cb)");
    CHECK2(r.toObject().value("error") == QStringLiteral("Error: git argument 4 is not a string"), h.lastText);
}

QTEST_GUILESS_MAIN(TestGitHub)
#include "tst_github.moc"
