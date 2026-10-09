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
        QStringLiteral("title"), QStringLiteral("createdAt"), QStringLiteral("hash"), QStringLiteral("step"),
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
    sessions.insert(workspace, entry);
    Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), saveSessions(sessions)}});
}
