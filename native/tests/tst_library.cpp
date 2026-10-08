/*
 * The Library service (desktop/main/settings.js) and what it is built on:
 * skill-store, mcp-client and mcp-context. Translates desktop-unit.cjs
 * "personas and skills are just files", "MCP, spoken by hand over stdio" and
 * "MCP context, gathered once before a build"; the MCP server is the same
 * fixture, local-agent/test/fixtures/fake-mcp-server.js, run with node.
 */
#include "data_harness.h"
#include "mock_github.h"

#include "LibraryService.h"
#include "McpClient.h"
#include "SkillStore.h"

#include <QElapsedTimer>
#include <QStandardPaths>

#include <stdexcept>

namespace {

template<typename Pred>
void waitUntil(Pred done, int ms = 30000)
{
    QDeadlineTimer deadline(ms);
    while (!done() && !deadline.hasExpired())
        QTest::qWait(5);
}

Mcp::ToolResult callTool(const Mcp::ServerSpec &spec, const QString &tool, const QJsonValue &args, int timeoutMs = Mcp::kTimeoutMs)
{
    QObject context;
    bool finished = false;
    Mcp::ToolResult out;
    Mcp::callTool(&context, spec, tool, args, timeoutMs, [&](const Mcp::ToolResult &r) {
        out = r;
        finished = true;
    });
    waitUntil([&] { return finished; });
    if (!finished)
        out.error = QStringLiteral("<no answer>");
    return out;
}

struct Gathered {
    QStringList texts;
    QStringList notes;
    bool finished = false;
};

Gathered gather(const Mcp::Config &config, Mcp::Runner run)
{
    Gathered g;
    Mcp::gatherContext(config, std::move(run), [&g](const QStringList &texts, const QStringList &notes) {
        g.texts = texts;
        g.notes = notes;
        g.finished = true;
    });
    waitUntil([&] { return g.finished; });
    return g;
}

QJsonObject json(const char *text)
{
    return QJsonDocument::fromJson(text).object();
}

}

class TestLibrary : public QObject
{
    Q_OBJECT

private slots:
    void initTestCase();
    void skillStore();
    void mcpClient();
    void mcpContext();
    void skills();
    void importSkill();
    void mcpConfig();
    void cleanupTestCase() { REPORT_CHECKS(); }

private:
    Mcp::ServerSpec spec(const QString &mode) const
    {
        return Mcp::ServerSpec{m_node, {m_fixture}, QJsonObject{{"FAKE_MCP_MODE", mode}}};
    }

    ScratchStorage m_storage;
    QString m_node;
    QString m_fixture;
};

void TestLibrary::initTestCase()
{
    m_node = QStandardPaths::findExecutable("node");
    m_fixture = QDir(repoRoot()).filePath("local-agent/test/fixtures/fake-mcp-server.js");
}

void TestLibrary::skillStore()
{
    QTemporaryDir root;
    const QString sd = SkillStore::skillsDir(root.path());
    writeAll(QDir(sd).filePath("pytest.md"), "Always write pytest tests.");
    writeAll(QDir(sd).filePath("stdlib.md"), "Prefer the standard library.");
    writeAll(QDir(sd).filePath("notes.txt"), "not a skill");
    QDir().mkpath(QDir(sd).filePath("adir.md"));

    CHECK(sd == QDir(root.path()).filePath("skills") && SkillStore::personasDir(root.path()) == QDir(root.path()).filePath("personas"));
    const QStringList names = SkillStore::listMarkdown(sd);
    CHECK2(names == QStringList({"pytest", "stdlib"}), names.join(","));
    CHECK(!names.contains("notes"));
    CHECK(!names.contains("adir"));
    CHECK(SkillStore::listMarkdown(QDir(root.path()).filePath("nope")).isEmpty());

    const QStringList read = SkillStore::readSelected(sd, {"pytest", "missing", "stdlib"});
    CHECK2(read.size() == 2, read.join("|"));
    CHECK(read.value(0) == QStringLiteral("Always write pytest tests."));
    CHECK(!read.join(" ").contains("missing"));
    CHECK(read.value(1) == QStringLiteral("Prefer the standard library."));

    CHECK(SkillStore::isSafeName("pytest"));
    CHECK(SkillStore::isSafeName("py.test-1_x"));
    CHECK(!SkillStore::isSafeName("../../etc/passwd"));
    CHECK(!SkillStore::isSafeName("a/b") && !SkillStore::isSafeName("a\\b"));
    CHECK(!SkillStore::isSafeName("/etc/passwd"));
    CHECK(!SkillStore::isSafeName("") && !SkillStore::isSafeName("   "));
    CHECK(!SkillStore::isSafeName(".hidden"));
    CHECK(SkillStore::readSelected(sd, {"../../etc/passwd"}).isEmpty());
}

void TestLibrary::mcpClient()
{
    CHECK(Mcp::textFromResult(json(R"({"content":[{"type":"text","text":"hello"}]})")) == QStringLiteral("hello"));
    CHECK(Mcp::textFromResult(json(R"({"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]})")) == QStringLiteral("a\nb"));
    CHECK(Mcp::textFromResult(json(R"({"content":[{"type":"image","data":"..."},{"type":"text","text":"t"}]})")) == QStringLiteral("t"));
    CHECK(Mcp::textFromResult(json(R"({"nope":1})")) == QString());
    CHECK(Mcp::textFromResult(QJsonValue(QJsonValue::Null)) == QString());
    CHECK(Mcp::kTimeoutMs == 20000);

    const Mcp::ToolResult missing = callTool({"definitely-not-a-real-command-xyz", {}, {}}, "fetch", QJsonObject{}, 2000);
    CHECK2(!missing.ok && missing.error.startsWith("could not start the MCP server"), missing.error);

    if (m_node.isEmpty() || !QFile::exists(m_fixture))
        QSKIP("node or the fake MCP server fixture is missing");

    const Mcp::ToolResult good = callTool(spec("ok"), "fetch", QJsonObject{{"url", "https://x.test"}});
    CHECK2(good.ok, good.error);
    CHECK2(good.text.contains("\"url\":\"https://x.test\""), good.text);

    const Mcp::ToolResult errored = callTool(spec("error"), "fetch", QJsonObject{});
    CHECK(!errored.ok);
    CHECK2(errored.error.contains("tool exploded"), errored.error);

    const Mcp::ToolResult dead = callTool(spec("exit"), "fetch", QJsonObject{});
    CHECK(!dead.ok);
    CHECK2(!dead.error.isEmpty(), dead.error);

    QElapsedTimer t;
    t.start();
    const Mcp::ToolResult silent = callTool(spec("silent"), "fetch", QJsonObject{}, 1200);
    CHECK(!silent.ok);
    CHECK2(silent.error.contains("timed out", Qt::CaseInsensitive) && t.elapsed() < 10000, silent.error);

    const Mcp::ToolResult junk = callTool(spec("garbage"), "fetch", QJsonObject{}, 1200);
    CHECK(!junk.ok);

    QObject context;
    bool listed = false, listOk = false;
    QStringList tools;
    Mcp::listTools(&context, spec("ok"), Mcp::kTimeoutMs, [&](bool ok, const QStringList &t, const QString &) {
        listOk = ok;
        tools = t;
        listed = true;
    });
    waitUntil([&] { return listed; });
    CHECK2(listOk && tools.contains("fetch"), tools.join(","));
    CHECK2(tools.size() == 2, tools.join(","));

    const Mcp::ToolResult toolErr = callTool(spec("toolerror"), "nope", QJsonObject{});
    CHECK(!toolErr.ok);
    CHECK2(toolErr.error.contains("Tool not found"), toolErr.error);
    CHECK2(toolErr.text.isEmpty(), toolErr.text);

    listed = false;
    listOk = true;
    Mcp::listTools(&context, spec("exit"), Mcp::kTimeoutMs, [&](bool ok, const QStringList &t, const QString &) {
        listOk = ok;
        tools = t;
        listed = true;
    });
    waitUntil([&] { return listed; });
    CHECK(listed && !listOk && tools.isEmpty());
}

void TestLibrary::mcpContext()
{
    const QJsonObject raw = json(R"({"servers":{"fetch":{"command":"uvx","args":["mcp-server-fetch"]}},
                                     "calls":[{"server":"fetch","tool":"fetch","args":{"url":"https://x.test"}}]})");
    const Mcp::Config cfg = Mcp::parseMcpConfig(raw);
    CHECK(cfg.servers.value("fetch").command == QStringLiteral("uvx"));
    CHECK(cfg.calls.size() == 1 && cfg.calls[0].tool == QStringLiteral("fetch"));
    CHECK(Mcp::parseMcpConfig(QStringLiteral("{{")).servers.isEmpty());
    CHECK(Mcp::parseMcpConfig(QJsonValue(QJsonValue::Null)).calls.isEmpty());
    CHECK(Mcp::parseMcpConfig(json(R"({"servers":{"a":{}}})")).servers.isEmpty());
    CHECK(Mcp::planCalls(Mcp::parseMcpConfig(json(R"({"servers":{},"calls":[{"server":"gone","tool":"t"}]})"))).isEmpty());

    const QList<Mcp::Call> planned = Mcp::planCalls(cfg);
    CHECK(planned.value(0).spec.command == QStringLiteral("uvx"));

    auto answer = [](Mcp::ToolResult r) {
        return [r](const Mcp::ServerSpec &, const QString &, const QJsonValue &, std::function<void(const Mcp::ToolResult &)> done) {
            done(r);
        };
    };
    const Gathered ok = gather(cfg, answer({true, "DOCS", {}}));
    CHECK2(ok.texts.join("") == QStringLiteral("DOCS"), ok.texts.join("|"));
    CHECK(ok.notes.isEmpty());

    const Gathered failed = gather(cfg, answer({false, {}, "server exploded"}));
    CHECK(failed.texts.isEmpty());
    CHECK2(failed.notes.join(" ").contains("server exploded"), failed.notes.join("|"));
    CHECK(failed.finished);

    const Gathered threw = gather(cfg, [](const Mcp::ServerSpec &, const QString &, const QJsonValue &,
                                          std::function<void(const Mcp::ToolResult &)>) { throw std::runtime_error("boom"); });
    CHECK2(threw.finished && threw.texts.isEmpty() && threw.notes.size() == 1, threw.notes.join("|"));

    const Gathered empty = gather(Mcp::parseMcpConfig(QJsonValue(QJsonValue::Null)), answer({true, "DOCS", {}}));
    CHECK(empty.finished && empty.texts.isEmpty() && empty.notes.isEmpty());
}

void TestLibrary::skills()
{
    LibraryService lib;
    Harness h;
    h.expose("Library", &lib);

    QJsonValue r = h.call("Library.listSkills(cb)");
    CHECK2(r == J("{\"ok\":true,\"personas\":[],\"skills\":[]}"), h.lastText);

    r = h.call("Library.writeSkill('skill', 'pytest', 'Always write pytest tests.', cb)");
    CHECK2(r == J("{\"ok\":true}"), h.lastText);
    r = h.call("Library.writeSkill('persona', 'reviewer', 'You review.', cb)");
    CHECK(readAll(m_storage.file("personas/reviewer.md")) == QStringLiteral("You review."));
    CHECK(readAll(m_storage.file("skills/pytest.md")) == QStringLiteral("Always write pytest tests."));
    r = h.call("Library.listSkills(cb)");
    CHECK2(r == J("{\"ok\":true,\"personas\":[\"reviewer\"],\"skills\":[\"pytest\"]}"), h.lastText);

    r = h.call("Library.readSkill('skill', 'pytest', cb)");
    CHECK2(r == J("{\"ok\":true,\"text\":\"Always write pytest tests.\"}"), h.lastText);
    r = h.call("Library.readSkill('skill', '../../etc/passwd', cb)");
    CHECK2(r == J("{\"ok\":false,\"error\":\"bad name\"}"), h.lastText);
    r = h.call("Library.readSkill('skill', 'gone', cb)");
    CHECK2(r.toObject().value("ok") == false && r.toObject().value("error").toString().startsWith("Error: ENOENT: no such file or directory, open"), h.lastText);

    r = h.call("Library.writeSkill('skill', '.hidden', 'x', cb)");
    CHECK2(r.toObject().value("error")
               == QStringLiteral("A name may only contain letters, numbers, dot, dash and underscore, and cannot start with a dot."),
           h.lastText);
    CHECK(!QFile::exists(m_storage.file("skills/.hidden.md")));

    r = h.call("Library.deleteSkill('skill', 'a/b', cb)");
    CHECK2(r.toObject().value("error") == QStringLiteral("bad name"), h.lastText);
    r = h.call("Library.deleteSkill('skill', 'pytest', cb)");
    CHECK2(r == J("{\"ok\":true}") && !QFile::exists(m_storage.file("skills/pytest.md")), h.lastText);
}

void TestLibrary::importSkill()
{
    MockGitHub mock([](const MockGitHub::Request &r) -> MockGitHub::Response {
        if (r.path == QStringLiteral("/repos/octo/kit/contents/skills/My%20Tests.MD"))
            return {200, QByteArray(R"({"content":")") + QByteArray("Write tests first.").toBase64() + "\"}"};
        if (r.path == QStringLiteral("/repos/octo/kit/contents/.secret.md"))
            return {200, QByteArray(R"({"content":")") + QByteArray("x").toBase64() + "\"}"};
        return {404, R"({"message":"Not Found"})"};
    });
    LibraryService lib;
    Harness h;
    h.expose("Library", &lib);

    QJsonValue r = h.call("Library.importSkill({ owner: 'octo', repo: 'kit', path: 'skills/My Tests.MD' }, cb)");
    // "My Tests" has a space: refused as a name, though the fetch worked.
    CHECK2(r.toObject().value("error") == QStringLiteral("That file's name cannot be used as a skill name."), h.lastText);
    CHECK2(mock.requests.size() == 1 && mock.requests[0].path == QStringLiteral("/repos/octo/kit/contents/skills/My%20Tests.MD"),
           mock.requests.value(0).path);

    r = h.call("Library.importSkill({ owner: 'octo', repo: 'kit', path: 'nope.md' }, cb)");
    CHECK2(r.toObject().value("ok") == false && r.toObject().value("error") == QStringLiteral("Not found (404): Not Found"), h.lastText);
    r = h.call("Library.importSkill({ owner: 'octo', repo: 'kit', path: '.secret.md', kind: 'persona' }, cb)");
    CHECK2(r.toObject().value("error") == QStringLiteral("That file's name cannot be used as a skill name."), h.lastText);
}

void TestLibrary::mcpConfig()
{
    LibraryService lib;
    Harness h;
    h.expose("Library", &lib);

    QJsonValue r = h.call("Library.readMcpConfig(cb)");
    CHECK2(r == J("{\"ok\":true,\"text\":\"\"}"), h.lastText);
    r = h.call("Library.gatherMcpContext(cb)");
    CHECK2(r == J("{\"notes\":[],\"ok\":true,\"texts\":[]}"), h.lastText);

    if (m_node.isEmpty() || !QFile::exists(m_fixture))
        QSKIP("node or the fake MCP server fixture is missing");

    const QJsonObject config{
        {"servers", QJsonObject{{"fake", QJsonObject{{"command", m_node}, {"args", QJsonArray{m_fixture}},
                                                     {"env", QJsonObject{{"FAKE_MCP_MODE", "ok"}}}}},
                                {"broken", QJsonObject{{"command", m_node}, {"args", QJsonArray{m_fixture}},
                                                       {"env", QJsonObject{{"FAKE_MCP_MODE", "error"}}}}}}},
        {"calls", QJsonArray{QJsonObject{{"server", "fake"}, {"tool", "fetch"}, {"args", QJsonObject{{"url", "https://x.test"}}}},
                             QJsonObject{{"server", "broken"}, {"tool", "fetch"}}}},
    };
    h.engine.globalObject().setProperty("CONFIG", QString::fromUtf8(QJsonDocument(config).toJson()));
    r = h.call("Library.writeMcpConfig(CONFIG, cb)");
    CHECK2(r == J("{\"ok\":true}"), h.lastText);
    r = h.call("Library.readMcpConfig(cb)");
    CHECK(r.toObject().value("text").toString() == QString::fromUtf8(QJsonDocument(config).toJson()));

    r = h.call("Library.gatherMcpContext(cb)", 60000);
    const QJsonObject g = r.toObject();
    CHECK2(g.value("ok") == true && g.value("texts").toArray().size() == 1
               && g.value("texts").toArray().at(0).toString().contains("https://x.test"), h.lastText);
    CHECK2(g.value("notes").toArray().size() == 1 && g.value("notes").toArray().at(0).toString().contains("tool exploded"), h.lastText);
}

QTEST_GUILESS_MAIN(TestLibrary)
#include "tst_library.moc"
