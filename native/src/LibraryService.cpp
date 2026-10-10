#include "LibraryService.h"

#include "GitHubApi.h"
#include "GitHubAuth.h"
#include "GitHubSafe.h"
#include "Js.h"
#include "McpClient.h"
#include "NodeCompat.h"
#include "Paths.h"
#include "SkillStore.h"

#include <QDir>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QRegularExpression>

/*
 * What the Settings panel reads and writes: skills and personas, and the MCP
 * servers whose context goes into a run.
 */

namespace {

QString skillDirFor(const QString &kind)
{
    return kind == QStringLiteral("persona") ? SkillStore::personasDir(Paths::storageRoot())
                                            : SkillStore::skillsDir(Paths::storageRoot());
}

QString mcpConfigPath()
{
    return QDir(Paths::storageRoot()).filePath(QStringLiteral("mcp.json"));
}

QVariantMap failed(const QString &error)
{
    return QVariantMap{{QStringLiteral("ok"), false}, {QStringLiteral("error"), error}};
}

QVariantMap ok()
{
    return QVariantMap{{QStringLiteral("ok"), true}};
}

}

LibraryService::LibraryService(QObject *parent)
    : QObject(parent)
{
}

LibraryService::~LibraryService() = default;

const GitHubApi &LibraryService::github()
{
    if (!m_github)
        m_github = std::make_unique<GitHubApi>(
            GitHubApi::network(new QNetworkAccessManager(this), [] { return GitHubAuth::token(); }));
    return *m_github;
}

void LibraryService::listSkills(QJSValue callback)
{
    const QString root = Paths::storageRoot();
    Js::reply(this, callback,
              QVariantMap{{QStringLiteral("ok"), true},
                          {QStringLiteral("personas"), SkillStore::listMarkdown(SkillStore::personasDir(root))},
                          {QStringLiteral("skills"), SkillStore::listMarkdown(SkillStore::skillsDir(root))}});
}

void LibraryService::readSkill(const QString &kind, const QString &name, QJSValue callback)
{
    if (!SkillStore::isSafeName(name)) {
        Js::reply(this, callback, failed(QStringLiteral("bad name")));
        return;
    }
    QString text, error;
    if (!NodeCompat::readText(QDir(skillDirFor(kind)).filePath(name + QStringLiteral(".md")), &text, &error)) {
        Js::reply(this, callback, failed(NodeCompat::errorString(error)));
        return;
    }
    Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), true}, {QStringLiteral("text"), text}});
}

void LibraryService::writeSkill(const QString &kind, const QString &name, const QString &text, QJSValue callback)
{
    // Refused rather than sanitised: a sanitised name writes a different file
    // than the one the user asked for, and the name arrives from QML.
    if (!SkillStore::isSafeName(name)) {
        Js::reply(this, callback, failed(QStringLiteral("A name may only contain letters, numbers, dot, dash and underscore, and cannot start with a dot.")));
        return;
    }
    const QString dir = skillDirFor(kind);
    QString error;
    if (!NodeCompat::mkdirs(dir, &error) || !NodeCompat::writeText(QDir(dir).filePath(name + QStringLiteral(".md")), text, &error)) {
        Js::reply(this, callback, failed(NodeCompat::errorString(error)));
        return;
    }
    Js::reply(this, callback, ok());
}

void LibraryService::deleteSkill(const QString &kind, const QString &name, QJSValue callback)
{
    if (!SkillStore::isSafeName(name)) {
        Js::reply(this, callback, failed(QStringLiteral("bad name")));
        return;
    }
    QString error;
    if (!NodeCompat::removeFile(QDir(skillDirFor(kind)).filePath(name + QStringLiteral(".md")), &error)) {
        Js::reply(this, callback, failed(NodeCompat::errorString(error)));
        return;
    }
    Js::reply(this, callback, ok());
}

void LibraryService::importSkill(const QVariantMap &payload, QJSValue callback)
{
    const QJsonObject p = NodeCompat::fromVariant(QVariant(payload)).toObject();
    const QJsonValue kind = p.value(QStringLiteral("kind"));
    const QJsonValue path = p.value(QStringLiteral("path"));
    github().getFile(p.value(QStringLiteral("owner")), p.value(QStringLiteral("repo")), path,
                     [this, callback, kind, path](bool fetched, const QJsonValue &result, const QString &error) {
        if (!fetched) {
            Js::reply(this, callback, failed(GitHubSafe::redactToken(error, GitHubAuth::token())));
            return;
        }
        static const QRegularExpression mdSuffix(QStringLiteral("\\.md$"), QRegularExpression::CaseInsensitiveOption);
        const QString name = NodeCompat::jsString(path).split(QLatin1Char('/')).last().replace(mdSuffix, QString());
        if (!SkillStore::isSafeName(name)) {
            Js::reply(this, callback, failed(QStringLiteral("That file's name cannot be used as a skill name.")));
            return;
        }
        const QString dir = skillDirFor(NodeCompat::truthy(kind) ? NodeCompat::jsString(kind) : QStringLiteral("skill"));
        QString writeError;
        if (!NodeCompat::mkdirs(dir, &writeError)
            || !NodeCompat::writeText(QDir(dir).filePath(name + QStringLiteral(".md")), result.toString(), &writeError)) {
            Js::reply(this, callback, failed(GitHubSafe::redactToken(writeError, GitHubAuth::token())));
            return;
        }
        Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), true}, {QStringLiteral("name"), name}});
    });
}

void LibraryService::readMcpConfig(QJSValue callback)
{
    QString text;
    if (!NodeCompat::readText(mcpConfigPath(), &text))
        text.clear();
    Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), true}, {QStringLiteral("text"), text}});
}

void LibraryService::writeMcpConfig(const QString &text, QJSValue callback)
{
    QString error;
    if (!NodeCompat::mkdirs(Paths::storageRoot(), &error) || !NodeCompat::writeText(mcpConfigPath(), text, &error)) {
        Js::reply(this, callback, failed(NodeCompat::errorString(error)));
        return;
    }
    Js::reply(this, callback, ok());
}

/*
 * Run the configured MCP calls once, before a build.
 *
 * An MCP server is an arbitrary subprocess the user configured, and this is
 * where the app runs one. That is what MCP is, but it is a new category of
 * thing this app executes and it is worth naming: a malicious mcp.json is a
 * malicious program.
 *
 * Nothing here can fail a build - gatherContext returns notes instead of
 * failing, and no configuration at all is the common case.
 */
void LibraryService::gatherMcpContext(QJSValue callback)
{
    QString raw;
    if (!NodeCompat::readText(mcpConfigPath(), &raw)) {
        Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), true},
                                              {QStringLiteral("texts"), QStringList()},
                                              {QStringLiteral("notes"), QStringList()}});
        return;
    }
    Mcp::gatherContext(Mcp::parseMcpConfig(raw), Mcp::processRunner(this),
                       [this, callback](const QStringList &texts, const QStringList &notes) {
        Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), true},
                                              {QStringLiteral("texts"), texts},
                                              {QStringLiteral("notes"), notes}});
    });
}
