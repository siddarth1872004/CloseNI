/*
 * Reads for the renderer, which has no file access: the provider list, the
 * workspace's files, and its saved chats.
 *
 * Ports desktop/main/files.js.
 */
#include "FilesService.h"

#include "Js.h"
#include "NodeCompat.h"
#include "Paths.h"

#include <QCryptographicHash>
#include <QDateTime>
#include <QDir>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>

#include <algorithm>
#include <functional>

namespace {

/* fs.readdirSync's order: libuv sorts the names bytewise. */
QStringList readdir(const QString &dir)
{
    QStringList names = QDir(dir).entryList(QDir::AllEntries | QDir::Hidden | QDir::System | QDir::NoDotAndDotDot,
                                            QDir::Unsorted);
    std::sort(names.begin(), names.end(), [](const QString &a, const QString &b) { return a.toUtf8() < b.toUtf8(); });
    return names;
}

/* Must agree with storagePaths() in the agent: both sides read the same file,
   and the agent is told this location via CLOSENI_STORAGE. */
QString sessionsFile()
{
    return QDir(Paths::storageRoot()).filePath(QStringLiteral("sessions.json"));
}

QJsonObject loadSessions()
{
    QByteArray bytes;
    if (!NodeCompat::readBytes(sessionsFile(), &bytes))
        return {};
    const QJsonDocument doc = QJsonDocument::fromJson(bytes);
    return doc.isObject() ? doc.object() : QJsonObject();
}

bool saveSessions(const QJsonObject &sessions)
{
    const QString f = sessionsFile();
    // The order the agent's session-store builds an entry in, so the file it
    // shares with the agent reads the same whoever wrote it last.
    static const QStringList order = {
        QStringLiteral("chats"), QStringLiteral("activeChat"), QStringLiteral("activeChatProvider"),
        QStringLiteral("activeBuildThread"), QStringLiteral("buildLedger"), QStringLiteral("url"),
        QStringLiteral("title"), QStringLiteral("createdAt"), QStringLiteral("provider"), QStringLiteral("hash"),
        QStringLiteral("step"),
    };
    return NodeCompat::mkdirs(QFileInfo(f).absolutePath())
        && NodeCompat::writeText(f, NodeCompat::stringify(sessions, order));
}

QJsonObject entryFor(const QJsonObject &sessions, const QString &workspace)
{
    const QJsonValue entry = sessions.value(workspace);
    if (NodeCompat::truthy(entry) && entry.isObject())
        return entry.toObject();
    return {{QStringLiteral("chats"), QJsonArray()}, {QStringLiteral("activeChat"), QJsonValue::Null}};
}

/* The Chat panel's transcripts, one file per workspace, written by the app
   only: sessions.json is shared with the agent, and a transcript there could be
   lost to whichever side wrote the file last. */
QString transcriptFile(const QString &workspace)
{
    const QByteArray id = QCryptographicHash::hash(workspace.toUtf8(), QCryptographicHash::Sha1).toHex().left(16);
    return QDir(Paths::storageRoot()).filePath(QStringLiteral("chats/") + QString::fromLatin1(id) + QStringLiteral(".json"));
}

QJsonObject loadTranscripts(const QString &workspace)
{
    QByteArray bytes;
    if (!NodeCompat::readBytes(transcriptFile(workspace), &bytes))
        return {};
    const QJsonObject all = QJsonDocument::fromJson(bytes).object();
    // A hash collision, however unlikely, must not show another project's chat.
    if (all.value(QStringLiteral("workspace")).toString() != workspace)
        return {};
    return all.value(QStringLiteral("chats")).toObject();
}

bool saveTranscripts(const QString &workspace, const QJsonObject &chats)
{
    const QString f = transcriptFile(workspace);
    if (chats.isEmpty())
        return !QFileInfo::exists(f) || NodeCompat::removeFile(f);
    const QJsonObject all{{QStringLiteral("workspace"), workspace}, {QStringLiteral("chats"), chats}};
    return NodeCompat::mkdirs(QFileInfo(f).absolutePath())
        && NodeCompat::writeText(f, QString::fromUtf8(QJsonDocument(all).toJson(QJsonDocument::Compact)));
}

// Bounds on what one chat keeps: the newest messages, each cut to a size no
// answer reasonably reaches.
constexpr int kMaxMessages = 500;
constexpr int kMaxMessageChars = 200000;

QVariantMap failure(const QString &error)
{
    return {{QStringLiteral("ok"), false}, {QStringLiteral("error"), error}};
}

}

FilesService::FilesService(QObject *parent)
    : QObject(parent)
{
}

void FilesService::listProviders(QJSValue callback)
{
    // Four small JSON files; spawning the agent to read a directory would be absurd.
    QVariantList out;
    const QString agent = Paths::agentPath();
    if (!agent.isEmpty()) {
        // local-agent/dist/index.js -> local-agent/config/providers
        const QString dir = QDir::cleanPath(QFileInfo(agent).absolutePath() + QStringLiteral("/../config/providers"));
        for (const QString &f : readdir(dir)) {
            if (!f.endsWith(QLatin1String(".json")))
                continue;
            QByteArray bytes;
            if (!NodeCompat::readBytes(QDir(dir).filePath(f), &bytes))
                continue;
            // A malformed config is skipped, not fatal.
            const QJsonDocument doc = QJsonDocument::fromJson(bytes);
            if (!doc.isObject())
                continue;
            const QJsonObject cfg = doc.object();
            // `controls` goes to the renderer so the sidebar can offer them. The
            // selectors stay here: the agent reads those, the UI never needs them.
            // `termsUrl` is linked from the sign-in step.
            if (!NodeCompat::truthy(cfg.value(QStringLiteral("enabled"))) || !NodeCompat::truthy(cfg.value(QStringLiteral("id"))))
                continue;
            const QJsonValue id = cfg.value(QStringLiteral("id"));
            const QJsonValue name = cfg.value(QStringLiteral("name"));
            const QJsonValue controls = cfg.value(QStringLiteral("controls"));
            const QJsonValue terms = cfg.value(QStringLiteral("termsUrl"));
            const QJsonObject provider{
                {QStringLiteral("id"), id},
                {QStringLiteral("name"), NodeCompat::truthy(name) ? name : id},
                {QStringLiteral("controls"), NodeCompat::truthy(controls) ? controls : QJsonValue(QJsonArray())},
                {QStringLiteral("termsUrl"), NodeCompat::truthy(terms) ? terms : QJsonValue(QString())},
            };
            out << NodeCompat::toVariant(provider);
        }
    }
    Js::reply(this, callback, out);
}

void FilesService::listFiles(const QString &workspace, QJSValue callback)
{
    // The renderer has no directory access; entry point detection needs a listing.
    static const QStringList skip = {
        QStringLiteral("node_modules"), QStringLiteral(".git"), QStringLiteral(".agent-backups"),
        QStringLiteral("__pycache__"), QStringLiteral("dist"), QStringLiteral("build"),
        QStringLiteral("venv"), QStringLiteral(".venv"), QStringLiteral("target"),
    };
    QStringList out;
    std::function<void(const QString &, const QString &)> walkDir = [&](const QString &dir, const QString &prefix) {
        if (dir.isEmpty() || !QFileInfo(dir).isDir())
            return;
        for (const QString &name : readdir(dir)) {
            if (skip.contains(name) || name.startsWith(QLatin1Char('.')))
                continue;
            const QString rel = prefix.isEmpty() ? name : prefix + QLatin1Char('/') + name;
            const QFileInfo info(QDir(dir).filePath(name));
            // Dirent types: a symlink is not a directory, even when it points at one.
            if (info.isDir() && !info.isSymLink()) {
                if (rel.split(QLatin1Char('/')).size() < 4)
                    walkDir(info.filePath(), rel);
            } else {
                out << rel;
            }
        }
    };
    walkDir(workspace, QString());
    Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), true}, {QStringLiteral("files"), out}});
}

void FilesService::readFile(const QVariant &pathOrOptions, QJSValue callback)
{
    // Accepts a bare path (existing callers, capped) or { path, full }. Diffing a
    // truncated file would read every line past the cap as a deletion.
    const QJsonValue arg = NodeCompat::fromVariant(pathOrOptions);
    const QJsonValue absPath = arg.isString() ? arg : arg.toObject().value(QStringLiteral("path"));
    const bool full = arg.isObject() && NodeCompat::truthy(arg.toObject().value(QStringLiteral("full")));
    if (!absPath.isString()) {
        Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), false},
                                              {QStringLiteral("error"), QStringLiteral("The \"path\" argument must be of type string or an instance of Buffer or URL. Received undefined")}});
        return;
    }
    QString s;
    QString error;
    if (!NodeCompat::readText(absPath.toString(), &s, &error)) {
        Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), false}, {QStringLiteral("error"), error}});
        return;
    }
    if (full) {
        Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), true}, {QStringLiteral("text"), s}, {QStringLiteral("truncated"), false}});
        return;
    }
    Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), true},
                                          {QStringLiteral("text"), s.left(4000)},
                                          {QStringLiteral("truncated"), s.size() > 4000}});
}

void FilesService::getChats(const QString &workspace, QJSValue callback)
{
    const QVariantMap none{{QStringLiteral("chats"), QVariantList()}, {QStringLiteral("activeChat"), QVariant::fromValue(nullptr)}};
    if (workspace.isEmpty()) {
        Js::reply(this, callback, none);
        return;
    }
    const QJsonValue entry = loadSessions().value(workspace);
    if (!NodeCompat::truthy(entry)) {
        Js::reply(this, callback, none);
        return;
    }
    const QJsonValue chats = entry.toObject().value(QStringLiteral("chats"));
    const QJsonValue active = entry.toObject().value(QStringLiteral("activeChat"));
    Js::reply(this, callback, QVariantMap{
        {QStringLiteral("chats"), NodeCompat::truthy(chats) ? NodeCompat::toVariant(chats) : QVariantList()},
        {QStringLiteral("activeChat"), NodeCompat::truthy(active) ? NodeCompat::toVariant(active) : QVariant::fromValue(nullptr)},
    });
}

void FilesService::newChat(const QString &workspace, QJSValue callback)
{
    if (workspace.isEmpty()) {
        Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), false}, {QStringLiteral("error"), QStringLiteral("No workspace selected")}});
        return;
    }
    QJsonObject sessions = loadSessions();
    QJsonObject entry = entryFor(sessions, workspace);
    entry.insert(QStringLiteral("activeChat"), QJsonValue::Null);
    sessions.insert(workspace, entry);
    Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), saveSessions(sessions)}});
}

void FilesService::switchChat(const QString &workspace, const QString &url, QJSValue callback)
{
    if (workspace.isEmpty() || url.isEmpty()) {
        Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), false}, {QStringLiteral("error"), QStringLiteral("Missing workspace or chat url")}});
        return;
    }
    QJsonObject sessions = loadSessions();
    QJsonObject entry = entryFor(sessions, workspace);
    entry.insert(QStringLiteral("activeChat"), url);
    // The thread's provider goes with it, or the agent would take a chat made
    // on another provider for a stale one and start a new thread instead.
    const QJsonArray chats = entry.value(QStringLiteral("chats")).toArray();
    for (const QJsonValue &c : chats) {
        const QString owner = c.toObject().value(QStringLiteral("provider")).toString();
        if (c.toObject().value(QStringLiteral("url")).toString() == url && !owner.isEmpty())
            entry.insert(QStringLiteral("activeChatProvider"), owner);
    }
    sessions.insert(workspace, entry);
    Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), saveSessions(sessions)}});
}

void FilesService::nameChat(const QString &workspace, const QString &url, const QString &title, QJSValue callback)
{
    const QString name = title.simplified().left(80);
    if (workspace.isEmpty() || url.isEmpty() || name.isEmpty()) {
        Js::reply(this, callback, failure(QStringLiteral("Missing workspace, chat url or title")));
        return;
    }
    QJsonObject sessions = loadSessions();
    QJsonObject entry = entryFor(sessions, workspace);
    QJsonArray chats = entry.value(QStringLiteral("chats")).toArray();
    bool found = false;
    for (int i = 0; i < chats.size(); i++) {
        QJsonObject c = chats[i].toObject();
        if (c.value(QStringLiteral("url")).toString() != url)
            continue;
        c.insert(QStringLiteral("title"), name);
        chats[i] = c;
        found = true;
    }
    if (!found) {
        QJsonObject c{{QStringLiteral("url"), url}, {QStringLiteral("title"), name},
                      {QStringLiteral("createdAt"), QDateTime::currentDateTimeUtc().toString(Qt::ISODateWithMs)}};
        if (entry.value(QStringLiteral("activeChat")).toString() == url && entry.contains(QStringLiteral("activeChatProvider")))
            c.insert(QStringLiteral("provider"), entry.value(QStringLiteral("activeChatProvider")));
        chats.append(c);
    }
    entry.insert(QStringLiteral("chats"), chats);
    sessions.insert(workspace, entry);
    Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), saveSessions(sessions)}});
}

void FilesService::deleteChat(const QString &workspace, const QString &url, QJSValue callback)
{
    if (workspace.isEmpty() || url.isEmpty()) {
        Js::reply(this, callback, failure(QStringLiteral("Missing workspace or chat url")));
        return;
    }
    QJsonObject sessions = loadSessions();
    QJsonObject entry = entryFor(sessions, workspace);
    QJsonArray kept;
    for (const QJsonValue &c : entry.value(QStringLiteral("chats")).toArray())
        if (c.toObject().value(QStringLiteral("url")).toString() != url)
            kept.append(c);
    entry.insert(QStringLiteral("chats"), kept);
    if (entry.value(QStringLiteral("activeChat")).toString() == url) {
        entry.insert(QStringLiteral("activeChat"), QJsonValue::Null);
        entry.remove(QStringLiteral("activeChatProvider"));
    }
    sessions.insert(workspace, entry);
    QJsonObject transcripts = loadTranscripts(workspace);
    transcripts.remove(url);
    const bool ok = saveSessions(sessions) && saveTranscripts(workspace, transcripts);
    Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), ok}});
}

void FilesService::loadTranscript(const QString &workspace, const QString &key, QJSValue callback)
{
    const QJsonObject chat = workspace.isEmpty() ? QJsonObject() : loadTranscripts(workspace).value(key).toObject();
    const QJsonValue plan = chat.value(QStringLiteral("plan"));
    Js::reply(this, callback, QVariantMap{
        {QStringLiteral("ok"), true},
        {QStringLiteral("messages"), chat.value(QStringLiteral("messages")).toArray().toVariantList()},
        {QStringLiteral("plan"), plan.isObject() ? QVariant(plan.toObject().toVariantMap()) : QVariant::fromValue(nullptr)},
    });
}

void FilesService::saveTranscript(const QString &workspace, const QString &key, const QVariant &messages,
                                  const QVariant &plan, QJSValue callback)
{
    if (workspace.isEmpty()) {
        Js::reply(this, callback, failure(QStringLiteral("No workspace selected")));
        return;
    }
    QJsonArray kept;
    const QJsonArray all = NodeCompat::fromVariant(messages).toArray();
    for (qsizetype i = std::max<qsizetype>(0, all.size() - kMaxMessages); i < all.size(); i++) {
        const QJsonObject m = all[i].toObject();
        const QString role = m.value(QStringLiteral("role")).toString();
        if (role != QStringLiteral("user") && role != QStringLiteral("ai"))
            continue;
        kept.append(QJsonObject{{QStringLiteral("role"), role},
                                {QStringLiteral("text"), m.value(QStringLiteral("text")).toString().left(kMaxMessageChars)}});
    }
    const QJsonValue p = NodeCompat::fromVariant(plan);
    QJsonObject transcripts = loadTranscripts(workspace);
    if (kept.isEmpty() && !p.isObject()) {
        transcripts.remove(key);
    } else {
        QJsonObject chat{{QStringLiteral("messages"), kept},
                         {QStringLiteral("updatedAt"), QDateTime::currentDateTimeUtc().toString(Qt::ISODateWithMs)}};
        if (p.isObject())
            chat.insert(QStringLiteral("plan"), p);
        transcripts.insert(key, chat);
    }
    Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), saveTranscripts(workspace, transcripts)}});
}
