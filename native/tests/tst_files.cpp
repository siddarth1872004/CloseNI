/*
 * The Files service: providers, the file tree, reading
 * a file, and the per-workspace chat list in sessions.json.
 */
#include "data_harness.h"

#include "FilesService.h"

class TestFiles : public QObject
{
    Q_OBJECT

private slots:
    void initTestCase();
    void listProviders();
    void listFiles();
    void readFile();
    void chats();
    void cleanupTestCase() { REPORT_CHECKS(); }

private:
    ScratchStorage m_storage;
    QTemporaryDir m_agent;
    FilesService m_files;
    Harness h;
};

void TestFiles::initTestCase()
{
    // A stand-in agent checkout: dist/index.js beside config/providers.
    const QDir a(m_agent.path());
    writeAll(a.filePath("dist/index.js"), "// agent");
    writeAll(a.filePath("config/providers/b.json"), R"({"id":"b","name":"Bee","enabled":true,"controls":[{"id":"think"}],"termsUrl":"https://b.test/terms","selectors":{"x":"y"}})");
    writeAll(a.filePath("config/providers/a.json"), R"({"id":"a","enabled":true})");
    writeAll(a.filePath("config/providers/off.json"), R"({"id":"off","enabled":false})");
    writeAll(a.filePath("config/providers/noid.json"), R"({"enabled":true})");
    writeAll(a.filePath("config/providers/broken.json"), "{ nope");
    writeAll(a.filePath("config/providers/notes.txt"), R"({"id":"txt","enabled":true})");
    qputenv("CLOSENI_AGENT", a.filePath("dist/index.js").toUtf8());
    h.expose("Files", &m_files);
}

void TestFiles::listProviders()
{
    const QJsonValue r = h.call("Files.listProviders(cb)");
    const QJsonArray list = r.toArray();
    CHECK2(list.size() == 2, h.lastText);
    CHECK2(list[0].toObject().value("id") == QStringLiteral("a") && list[1].toObject().value("id") == QStringLiteral("b"), h.lastText);
    CHECK2(list[0].toObject().value("name") == QStringLiteral("a") && list[0].toObject().value("controls") == QJsonArray()
               && list[0].toObject().value("termsUrl") == QString(), h.lastText);
    CHECK(list[1].toObject().value("name") == QStringLiteral("Bee"));
    CHECK2(!list[1].toObject().contains("selectors"), h.lastText);
    CHECK(list[1].toObject().value("termsUrl") == QStringLiteral("https://b.test/terms"));
}

void TestFiles::listFiles()
{
    QTemporaryDir ws;
    const QDir d(ws.path());
    writeAll(d.filePath("app.py"), "x");
    writeAll(d.filePath("src/lib/util.py"), "x");
    writeAll(d.filePath("a/b/c/d/deep.py"), "x");
    writeAll(d.filePath("node_modules/m/index.js"), "x");
    writeAll(d.filePath("__pycache__/c.pyc"), "x");
    writeAll(d.filePath(".env"), "x");
    writeAll(d.filePath(".closeni/build.json"), "x");
    h.engine.globalObject().setProperty("WS", ws.path());

    const QJsonValue r = h.call("Files.listFiles(WS, cb)");
    QStringList files;
    for (const QJsonValue &f : r.toObject().value("files").toArray())
        files << f.toString();
    CHECK2(r.toObject().value("ok") == true, h.lastText);
    CHECK2(files.contains("app.py") && files.contains("src/lib/util.py"), files.join(","));
    CHECK2(!files.contains("a/b/c/d/deep.py"), files.join(","));
    CHECK2(!files.join(",").contains("node_modules") && !files.join(",").contains("__pycache__"), files.join(","));
    CHECK2(!files.contains(".env") && !files.join(",").contains(".closeni"), files.join(","));

    const QJsonValue missing = h.call("Files.listFiles(WS + '/nope', cb)");
    CHECK2(missing.toObject().value("ok") == true && missing.toObject().value("files").toArray().isEmpty(), h.lastText);
}

void TestFiles::readFile()
{
    QTemporaryDir ws;
    const QDir d(ws.path());
    writeAll(d.filePath("short.txt"), "hello");
    writeAll(d.filePath("long.txt"), QByteArray(5000, 'x'));
    h.engine.globalObject().setProperty("WS", ws.path());

    QJsonValue r = h.call("Files.readFile(WS + '/short.txt', cb)");
    CHECK2(r.toObject().value("text") == QStringLiteral("hello") && r.toObject().value("truncated") == false, h.lastText);
    r = h.call("Files.readFile(WS + '/long.txt', cb)");
    CHECK2(r.toObject().value("text").toString().size() == 4000 && r.toObject().value("truncated") == true, h.lastText.left(80));
    r = h.call("Files.readFile({ path: WS + '/long.txt', full: true }, cb)");
    CHECK(r.toObject().value("text").toString().size() == 5000 && r.toObject().value("truncated") == false);
    r = h.call("Files.readFile(WS + '/missing.txt', cb)");
    CHECK2(r.toObject().value("ok") == false
               && r.toObject().value("error").toString().startsWith("ENOENT: no such file or directory, open"), h.lastText);
}

void TestFiles::chats()
{
    h.engine.globalObject().setProperty("WS", QStringLiteral("/work/space"));
    QJsonValue r = h.call("Files.getChats(WS, cb)");
    CHECK2(r == J("{\"chats\":[],\"activeChat\":null}"), h.lastText);
    r = h.call("Files.newChat('', cb)");
    CHECK2(r.toObject().value("error") == QStringLiteral("No workspace selected"), h.lastText);
    r = h.call("Files.switchChat(WS, '', cb)");
    CHECK2(r.toObject().value("error") == QStringLiteral("Missing workspace or chat url"), h.lastText);

    // Sessions saved without a provider per chat are read as they are.
    writeAll(m_storage.file("sessions.json"),
             R"({"/work/space":{"chats":[{"url":"https://chat.test/1","title":"one"}],"activeChat":"https://chat.test/1","buildLedger":{"x":1}}})");
    r = h.call("Files.getChats(WS, cb)");
    CHECK2(r.toObject().value("activeChat") == QStringLiteral("https://chat.test/1") && r.toObject().value("chats").toArray().size() == 1, h.lastText);

    r = h.call("Files.switchChat(WS, 'https://chat.test/2', cb)");
    CHECK2(r.toObject().value("ok") == true, h.lastText);
    QString saved = readAll(m_storage.file("sessions.json"));
    CHECK2(saved.contains("\"activeChat\": \"https://chat.test/2\"") && saved.contains("\"buildLedger\""), saved);
    CHECK2(!saved.endsWith("\n"), saved.right(10));

    r = h.call("Files.newChat(WS, cb)");
    CHECK(r.toObject().value("ok") == true);
    r = h.call("Files.getChats(WS, cb)");
    CHECK2(r.toObject().value("activeChat").isNull() && r.toObject().value("chats").toArray().size() == 1, h.lastText);

    // Naming: an unlisted thread is added, a listed one renamed.
    r = h.call("Files.nameChat(WS, 'https://chat.test/2', '  Build   a todo app ', cb)");
    CHECK2(r.toObject().value("ok") == true, h.lastText);
    r = h.call("Files.nameChat(WS, 'https://chat.test/1', 'First', cb)");
    r = h.call("Files.getChats(WS, cb)");
    QJsonArray list = r.toObject().value("chats").toArray();
    CHECK2(list.size() == 2 && list[0].toObject().value("title") == QStringLiteral("First")
               && list[1].toObject().value("title") == QStringLiteral("Build a todo app")
               && !list[1].toObject().value("createdAt").toString().isEmpty(), h.lastText);
    r = h.call("Files.nameChat(WS, 'https://chat.test/1', '   ', cb)");
    CHECK2(r.toObject().value("ok") == false, h.lastText);

    // Switching takes the chat's provider along.
    writeAll(m_storage.file("sessions.json"),
             R"({"/work/space":{"chats":[{"url":"https://chat.test/1","title":"one","provider":"claude"}],"activeChat":null}})");
    r = h.call("Files.switchChat(WS, 'https://chat.test/1', cb)");
    saved = readAll(m_storage.file("sessions.json"));
    CHECK2(saved.contains("\"activeChatProvider\": \"claude\""), saved);

    // Transcripts: per chat, bounded, removed when emptied.
    r = h.call("Files.loadTranscript(WS, 'https://chat.test/1', cb)");
    CHECK2(r.toObject().value("messages").toArray().isEmpty() && r.toObject().value("plan").isNull(), h.lastText);
    r = h.call("Files.saveTranscript(WS, 'https://chat.test/1', [{ role: 'user', text: 'hi' }, { role: 'ai', text: 'hello' },"
               " { role: 'x', text: 'dropped' }], { summary: 's', steps: [{ title: 'a' }] }, cb)");
    CHECK2(r.toObject().value("ok") == true, h.lastText);
    r = h.call("Files.saveTranscript(WS, '', [{ role: 'user', text: 'draft' }], null, cb)");
    r = h.call("Files.loadTranscript(WS, 'https://chat.test/1', cb)");
    CHECK2(r.toObject().value("messages").toArray().size() == 2
               && r.toObject().value("messages").toArray()[1].toObject().value("text") == QStringLiteral("hello")
               && r.toObject().value("plan").toObject().value("steps").toArray().size() == 1, h.lastText);
    r = h.call("Files.loadTranscript('/other/space', 'https://chat.test/1', cb)");
    CHECK2(r.toObject().value("messages").toArray().isEmpty(), h.lastText);
    r = h.call("var many = []; for (var i = 0; i < 600; i++) many.push({ role: 'user', text: 'm' + i });"
               "Files.saveTranscript(WS, 'https://chat.test/9', many, null, function () {"
               " Files.loadTranscript(WS, 'https://chat.test/9', cb) })");
    CHECK2(r.toObject().value("messages").toArray().size() == 500
               && r.toObject().value("messages").toArray()[0].toObject().value("text") == QStringLiteral("m100"), h.lastText.left(200));
    r = h.call("Files.saveTranscript(WS, 'https://chat.test/9', [], null, cb)");
    r = h.call("Files.loadTranscript(WS, '', cb)");
    CHECK2(r.toObject().value("messages").toArray().size() == 1, h.lastText);

    // Deleting drops the chat, its transcript, and the open thread if it was it.
    r = h.call("Files.deleteChat(WS, 'https://chat.test/1', cb)");
    CHECK2(r.toObject().value("ok") == true, h.lastText);
    r = h.call("Files.getChats(WS, cb)");
    CHECK2(r.toObject().value("chats").toArray().isEmpty() && r.toObject().value("activeChat").isNull(), h.lastText);
    saved = readAll(m_storage.file("sessions.json"));
    CHECK2(!saved.contains("activeChatProvider"), saved);
    r = h.call("Files.loadTranscript(WS, 'https://chat.test/1', cb)");
    CHECK2(r.toObject().value("messages").toArray().isEmpty(), h.lastText);
    r = h.call("Files.saveTranscript(WS, '', [], null, cb)");
    CHECK2(r.toObject().value("ok") == true && QDir(m_storage.file("chats")).isEmpty(), h.lastText);
}

QTEST_GUILESS_MAIN(TestFiles)
#include "tst_files.moc"
