/*
 * GitHub: the token, git's environment, and the API calls the Ship panel makes.
 *
 * The token itself is GitHubAuth's; the calls
 * are GitHubApi's; the safety rules are GitHubSafe's.
 */
#include "GitHubService.h"

#include "GitHubApi.h"
#include "GitHubAuth.h"
#include "GitHubSafe.h"
#include "GitRunner.h"
#include "Js.h"
#include "NodeCompat.h"

#include <QDir>
#include <QJsonArray>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QPointer>

#include <memory>

namespace {

QVariant fail(const QString &error)
{
    return QVariantMap{{QStringLiteral("ok"), false}, {QStringLiteral("error"), error}};
}

QString logLine(const QString &clean)
{
    QString line = clean;
    if (line.endsWith(QLatin1Char('\n')))
        line.chop(1);
    return QStringLiteral("git> ") + line;
}

}

GitHubService::GitHubService(QObject *parent)
    : QObject(parent)
    , m_nam(new QNetworkAccessManager(this))
    , m_api(std::make_unique<GitHubApi>(GitHubApi::network(m_nam, [] { return GitHubAuth::token(); })))
{
}

GitHubService::~GitHubService() = default;

void GitHubService::status(QJSValue callback)
{
    const QString token = GitHubAuth::token();
    const bool encryption = GitHubAuth::encryptionAvailable();
    QVariantMap out{
        {QStringLiteral("signedIn"), !token.isEmpty()},
        {QStringLiteral("encryptionAvailable"), encryption},
        {QStringLiteral("persisted"), !token.isEmpty() && GitHubSafe::shouldPersistToken(encryption)},
        {QStringLiteral("login"), NodeCompat::toVariant(GitHubAuth::login())},
    };
    Js::reply(this, callback, out);
}

void GitHubService::signIn(const QString &token, QJSValue callback)
{
    const QString trimmed = token.trimmed();
    if (trimmed.isEmpty()) {
        Js::reply(this, callback, fail(QStringLiteral("No token given.")));
        return;
    }
    const QString previous = GitHubAuth::token();
    GitHubAuth::setToken(trimmed);
    QPointer<GitHubService> self(this);
    GitHubApi::network(m_nam, [] { return GitHubAuth::token(); })(
        QStringLiteral("GET"), QStringLiteral("/user"), QJsonValue(QJsonValue::Undefined),
        [self, callback, previous, trimmed](const GitHubApi::Response &me) {
            if (!self)
                return;
            if (!me.error.isEmpty()) {
                GitHubAuth::setToken(previous);
                // Redacted even though the token rides in a header rather than the URL.
                // The habit is the point: the next error path may not be so careful.
                Js::reply(self, callback, fail(GitHubSafe::redactToken(me.error, trimmed)));
                return;
            }
            if (me.status != 200) {
                GitHubAuth::setToken(previous);
                Js::reply(self, callback, fail(QStringLiteral("GitHub rejected that token (%1).").arg(me.status)));
                return;
            }
            // me.body && me.body.login
            GitHubAuth::setLogin(me.body.isObject() ? me.body.toObject().value(QStringLiteral("login"))
                                 : me.body.isNull() ? QJsonValue(QJsonValue::Null)
                                                    : QJsonValue(QJsonValue::Undefined));
            bool persisted = false;
            QString error;
            if (!GitHubAuth::saveToken(trimmed, &persisted, &error)) {
                GitHubAuth::setToken(previous);
                Js::reply(self, callback, fail(GitHubSafe::redactToken(error, trimmed)));
                return;
            }
            Js::reply(self, callback, QVariantMap{{QStringLiteral("ok"), true},
                                                  {QStringLiteral("login"), NodeCompat::toVariant(GitHubAuth::login())},
                                                  {QStringLiteral("persisted"), persisted}});
        });
}

void GitHubService::signOut(QJSValue callback)
{
    GitHubAuth::clearToken();
    Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), true}});
}

/*
 * Clone a repository into the workspace.
 *
 * Into the workspace when it is empty, otherwise into a subdirectory named
 * after the repository - and the caller is told which. Scattering someone
 * else's files through a project already under way, without saying so, would be
 * its own kind of bug.
 */
void GitHubService::clone(const QVariantMap &payloadMap, QJSValue callback)
{
    const QJsonObject payload = NodeCompat::fromVariant(payloadMap).toObject();
    const QJsonValue urlValue = payload.value(QStringLiteral("url"));
    const auto parsed = GitHubSafe::parseRepoUrl(NodeCompat::truthy(urlValue) ? NodeCompat::jsString(urlValue) : QString());
    if (!parsed) {
        Js::reply(this, callback, fail(QStringLiteral("Not a GitHub repository URL.")));
        return;
    }
    const QString workspace = NodeCompat::str(payload.value(QStringLiteral("workspace")));
    if (workspace.isEmpty()) {
        // The path Node would have spawned with is undefined, which safeGitArgs refuses.
        Js::reply(this, callback, fail(QStringLiteral("Error: git argument 4 is not a string")));
        return;
    }
    const QStringList entries = QDir(workspace).entryList(QDir::AllEntries | QDir::Hidden | QDir::System | QDir::NoDotAndDotDot);
    bool visible = false;
    for (const QString &e : entries) {
        if (!e.startsWith(QLatin1Char('.')))
            visible = true;
    }
    const QString into = !visible ? workspace : QDir::cleanPath(QDir(workspace).filePath(parsed->repo));
    const QString url = QStringLiteral("https://github.com/") + parsed->owner + QLatin1Char('/') + parsed->repo + QStringLiteral(".git");

    auto out = std::make_shared<QString>();
    QPointer<GitHubService> self(this);
    GitRunner::run(
        this, {QStringLiteral("clone"), QStringLiteral("--depth"), QStringLiteral("1"), url, into}, workspace,
        [self, out](const QString &chunk) {
            const QString clean = GitHubSafe::redactToken(chunk, GitHubAuth::token());
            *out += clean;
            if (self)
                emit self->projectLog(logLine(clean));
        },
        [self, out, callback, into](const GitRunner::Result &r) {
            if (!self)
                return;
            if (!r.started) {
                Js::reply(self, callback, fail(r.error));
                return;
            }
            if (r.success)
                Js::reply(self, callback, QVariantMap{{QStringLiteral("ok"), true}, {QStringLiteral("into"), into}});
            else
                Js::reply(self, callback, fail(out->right(300)));
        });
}

void GitHubService::call(const QString &method, const QVariant &args, QJSValue callback)
{
    const QJsonValue list = NodeCompat::fromVariant(args);
    QPointer<GitHubService> self(this);
    m_api->call(method, list.isArray() ? list.toArray() : QJsonArray(),
                [self, callback](bool ok, const QJsonValue &result, const QString &error) {
                    if (!self)
                        return;
                    if (!ok) {
                        Js::reply(self, callback, fail(GitHubSafe::redactToken(error, GitHubAuth::token())));
                        return;
                    }
                    Js::reply(self, callback, QVariantMap{{QStringLiteral("ok"), true},
                                                          {QStringLiteral("result"), NodeCompat::toVariant(result)}});
                });
}
