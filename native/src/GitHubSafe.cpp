#include "GitHubSafe.h"

#include <QJsonArray>
#include <QRegularExpression>
#include <QUrl>

namespace GitHubSafe {

QString redactToken(const QString &text, const QString &token)
{
    if (token.isEmpty())
        return text;
    // Split/join rather than a regex: a token can contain regex metacharacters,
    // and building a pattern out of a secret is its own kind of bug.
    return text.split(token).join(QStringLiteral("[REDACTED]"));
}

bool safeGitArgs(const QJsonValue &args, QStringList *out, QString *error)
{
    if (!args.isArray()) {
        *error = QStringLiteral("git arguments must be a list");
        return false;
    }
    const QJsonArray a = args.toArray();
    QStringList list;
    for (qsizetype i = 0; i < a.size(); ++i) {
        if (!a.at(i).isString()) {
            *error = QStringLiteral("git argument %1 is not a string").arg(i);
            return false;
        }
        list << a.at(i).toString();
    }
    *out = list;
    return true;
}

namespace {

// Exact hosts only. A prefix or "contains" check would accept
// github.com.evil.test, which is a different site entirely.
bool isGitHubHost(const QString &host)
{
    const QString h = host.toLower();
    return h == QLatin1String("github.com") || h == QLatin1String("www.github.com");
}

}

std::optional<Repo> parseRepoUrl(const QString &url)
{
    const QString raw = url.trimmed();
    if (raw.isEmpty())
        return std::nullopt;

    // scp-like SSH form, which is not a URL and would not parse as one.
    static const QRegularExpression ssh(QStringLiteral("^git@([^:]+):([^/]+)/(.+?)(?:\\.git)?/?$"));
    const QRegularExpressionMatch m = ssh.match(raw);
    if (m.hasMatch()) {
        if (!isGitHubHost(m.captured(1)))
            return std::nullopt;
        return Repo{m.captured(2), m.captured(3)};
    }

    const QUrl parsed(raw, QUrl::StrictMode);
    if (!parsed.isValid() || parsed.isRelative())
        return std::nullopt;
    const QString scheme = parsed.scheme().toLower();
    if (scheme != QLatin1String("https") && scheme != QLatin1String("http"))
        return std::nullopt;
    if (!isGitHubHost(parsed.host()))
        return std::nullopt;

    QStringList parts;
    for (const QString &x : parsed.path(QUrl::FullyEncoded).split(QLatin1Char('/'))) {
        if (!x.isEmpty())
            parts << x;
    }
    if (parts.size() < 2)
        return std::nullopt;
    QString repo = parts.at(1);
    if (repo.endsWith(QLatin1String(".git")))
        repo.chop(4);
    return Repo{parts.at(0), repo};
}

bool shouldPersistToken(std::optional<bool> encryptionAvailable)
{
    return encryptionAvailable.has_value() && *encryptionAvailable;
}

}
