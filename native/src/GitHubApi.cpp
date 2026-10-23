#include "GitHubApi.h"

#include "NodeCompat.h"

#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QRegularExpression>
#include <QUrl>

#include <algorithm>
#include <cmath>

namespace {

/* body[key], failing the way JavaScript does when body is null or undefined. */
bool member(const QJsonValue &body, const QString &key, QJsonValue *out, QString *error)
{
    if (body.isNull() || body.isUndefined()) {
        *error = QStringLiteral("Cannot read properties of %1 (reading '%2')")
                     .arg(body.isNull() ? QStringLiteral("null") : QStringLiteral("undefined"), key);
        return false;
    }
    *out = body.isObject() ? body.toObject().value(key) : QJsonValue(QJsonValue::Undefined);
    return true;
}

QJsonValue prop(const QJsonValue &v, const QString &key)
{
    return v.isObject() ? v.toObject().value(key) : QJsonValue(QJsonValue::Undefined);
}

QJsonValue orElse(const QJsonValue &v, const QJsonValue &fallback)
{
    return NodeCompat::truthy(v) ? v : fallback;
}

/* Buffer.from(String(content || ""), "base64").toString("utf-8") */
QString decodeBase64(const QJsonValue &content)
{
    const QString text = NodeCompat::jsString(orElse(content, QString()));
    return QString::fromUtf8(QByteArray::fromBase64(text.toLatin1()));
}

/* What a response body parses to: null when empty, the raw text's start when not JSON. */
QJsonValue parseBody(const QByteArray &raw)
{
    if (raw.isEmpty())
        return QJsonValue::Null;
    QJsonParseError err;
    // Wrapped, because QJsonDocument only takes an object or array at the top
    // and JSON.parse takes any value.
    const QJsonDocument doc = QJsonDocument::fromJson("[" + raw + "]", &err);
    if (err.error == QJsonParseError::NoError && doc.array().size() == 1)
        return doc.array().at(0);
    return QJsonObject{{QStringLiteral("message"), QString::fromUtf8(raw).left(200)}};
}

}

GitHubApi::GitHubApi(Request request)
    : m_request(std::move(request))
{
}

QString GitHubApi::baseUrl()
{
    QString base = qEnvironmentVariable("CLOSENI_GITHUB_API");
    if (base.isEmpty())
        base = QStringLiteral("https://api.github.com");
    while (base.endsWith(QLatin1Char('/')))
        base.chop(1);
    return base;
}

GitHubApi::Request GitHubApi::network(QNetworkAccessManager *nam, std::function<QString()> token)
{
    return [nam, token](const QString &method, const QString &path, const QJsonValue &body, Reply reply) {
        QNetworkRequest req(QUrl::fromEncoded((baseUrl() + path).toUtf8()));
        // Node's https.request never followed a redirect; a moved repository
        // answered 301 and was reported, not silently swapped for another.
        req.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
        req.setRawHeader("Accept", "application/vnd.github+json");
        req.setRawHeader("User-Agent", "CloseNI");
        req.setRawHeader("X-GitHub-Api-Version", "2022-11-28");
        const QString t = token ? token() : QString();
        if (!t.isEmpty())
            req.setRawHeader("Authorization", "Bearer " + t.toUtf8());
        QByteArray data;
        if (NodeCompat::truthy(body)) {
            data = NodeCompat::stringify(body, {QStringLiteral("name"), QStringLiteral("private"), QStringLiteral("ref")}, 0).toUtf8();
            req.setRawHeader("Content-Type", "application/json");
        }
        QNetworkReply *r = nam->sendCustomRequest(req, method.toLatin1(), data);
        QObject::connect(r, &QNetworkReply::finished, nam, [r, reply] {
            r->deleteLater();
            const QVariant status = r->attribute(QNetworkRequest::HttpStatusCodeAttribute);
            Response res;
            if (!status.isValid()) {
                res.error = r->errorString();
            } else {
                res.status = status.toInt();
                res.body = parseBody(r->readAll());
            }
            reply(res);
        });
    };
}

QString GitHubApi::describeFailure(int status, const QJsonValue &body)
{
    const QJsonValue m = prop(body, QStringLiteral("message"));
    const QString message = NodeCompat::truthy(m) ? NodeCompat::jsString(m) : QString();
    if (status == 401)
        return QStringLiteral("GitHub rejected the token (401): ") + message;
    // A rate limit is a wait, not a breakage, and saying which is the
    // difference between "try again later" and "something is wrong".
    static const QRegularExpression rateLimit(QStringLiteral("rate limit"), QRegularExpression::CaseInsensitiveOption);
    if (status == 403 && rateLimit.match(message).hasMatch())
        return QStringLiteral("GitHub rate limit reached: ") + message;
    if (status == 403)
        return QStringLiteral("GitHub refused (403), usually a missing scope: ") + message;
    if (status == 404)
        return QStringLiteral("Not found (404): ") + message;
    return QStringLiteral("GitHub returned %1: ").arg(status) + message;
}

QString GitHubApi::encodeURIComponent(const QString &s)
{
    return QString::fromLatin1(QUrl::toPercentEncoding(s, "!*'()"));
}

void GitHubApi::request(const QString &method, const QString &path, const QJsonValue &body,
                        std::function<void(const QJsonValue &)> ok, Done done) const
{
    m_request(method, path, body, [ok, done](const Response &res) {
        if (!res.error.isEmpty()) {
            done(false, QJsonValue(), res.error);
            return;
        }
        if (res.status < 200 || res.status >= 300) {
            done(false, QJsonValue(), describeFailure(res.status, res.body));
            return;
        }
        ok(res.body);
    });
}

bool GitHubApi::has(const QString &method) const
{
    static const QStringList known = {
        QStringLiteral("listRepos"), QStringLiteral("createRepo"), QStringLiteral("getReadme"),
        QStringLiteral("getFile"), QStringLiteral("getTree"), QStringLiteral("listRuns"),
        QStringLiteral("searchRepos"), QStringLiteral("dispatchWorkflow"),
    };
    return known.contains(method);
}

void GitHubApi::call(const QString &method, const QJsonArray &args, Done done) const
{
    auto a = [&args](int i) { return i < args.size() ? args.at(i) : QJsonValue(QJsonValue::Undefined); };
    if (method == QLatin1String("listRepos"))
        listRepos(done);
    else if (method == QLatin1String("createRepo"))
        createRepo(a(0), a(1), done);
    else if (method == QLatin1String("getReadme"))
        getReadme(a(0), a(1), done);
    else if (method == QLatin1String("getFile"))
        getFile(a(0), a(1), a(2), done);
    else if (method == QLatin1String("getTree"))
        getTree(a(0), a(1), done);
    else if (method == QLatin1String("listRuns"))
        listRuns(a(0), a(1), done);
    else if (method == QLatin1String("searchRepos"))
        searchRepos(a(0), a(1), done);
    else if (method == QLatin1String("dispatchWorkflow"))
        dispatchWorkflow(a(0), a(1), a(2), a(3), done);
    else
        done(false, QJsonValue(), QStringLiteral("Unknown call: ") + method);
}

void GitHubApi::listRepos(Done done) const
{
    request(QStringLiteral("GET"), QStringLiteral("/user/repos?sort=updated&per_page=50"), QJsonValue(QJsonValue::Undefined),
            [done](const QJsonValue &body) { done(true, body, QString()); }, done);
}

void GitHubApi::createRepo(const QJsonValue &name, const QJsonValue &isPrivate, Done done) const
{
    const QJsonObject body{{QStringLiteral("name"), name.isUndefined() ? QJsonValue(QJsonValue::Undefined) : name},
                           {QStringLiteral("private"), NodeCompat::truthy(isPrivate)}};
    request(QStringLiteral("POST"), QStringLiteral("/user/repos"), body,
            [done](const QJsonValue &b) { done(true, b, QString()); }, done);
}

void GitHubApi::getReadme(const QJsonValue &owner, const QJsonValue &repo, Done done) const
{
    request(QStringLiteral("GET"), QStringLiteral("/repos/") + NodeCompat::jsString(owner) + QLatin1Char('/') + NodeCompat::jsString(repo) + QStringLiteral("/readme"),
            QJsonValue(QJsonValue::Undefined),
            [done](const QJsonValue &body) {
                // The API returns base64; anything putting this in a prompt needs text.
                QJsonValue content;
                QString error;
                if (!member(body, QStringLiteral("content"), &content, &error)) {
                    done(false, QJsonValue(), error);
                    return;
                }
                done(true, decodeBase64(content), QString());
            },
            done);
}

void GitHubApi::getFile(const QJsonValue &owner, const QJsonValue &repo, const QJsonValue &filePath, Done done) const
{
    QStringList segments;
    for (const QString &s : NodeCompat::jsString(filePath).split(QLatin1Char('/')))
        segments << encodeURIComponent(s);
    request(QStringLiteral("GET"),
            QStringLiteral("/repos/") + NodeCompat::jsString(owner) + QLatin1Char('/') + NodeCompat::jsString(repo) + QStringLiteral("/contents/") + segments.join(QLatin1Char('/')),
            QJsonValue(QJsonValue::Undefined),
            [done](const QJsonValue &body) {
                QJsonValue content;
                QString error;
                if (!member(body, QStringLiteral("content"), &content, &error)) {
                    done(false, QJsonValue(), error);
                    return;
                }
                done(true, decodeBase64(content), QString());
            },
            done);
}

void GitHubApi::getTree(const QJsonValue &owner, const QJsonValue &repo, Done done) const
{
    request(QStringLiteral("GET"),
            QStringLiteral("/repos/") + NodeCompat::jsString(owner) + QLatin1Char('/') + NodeCompat::jsString(repo) + QStringLiteral("/git/trees/HEAD?recursive=1"),
            QJsonValue(QJsonValue::Undefined),
            [done](const QJsonValue &body) {
                QJsonValue tree;
                QString error;
                if (!member(body, QStringLiteral("tree"), &tree, &error)) {
                    done(false, QJsonValue(), error);
                    return;
                }
                QJsonArray out;
                for (const QJsonValue &t : tree.toArray()) {
                    if (prop(t, QStringLiteral("type")) == QJsonValue(QStringLiteral("blob"))) {
                        const QJsonValue p = prop(t, QStringLiteral("path"));
                        out.append(p.isUndefined() ? QJsonValue(QJsonValue::Null) : p);
                    }
                }
                done(true, out, QString());
            },
            done);
}

void GitHubApi::listRuns(const QJsonValue &owner, const QJsonValue &repo, Done done) const
{
    request(QStringLiteral("GET"),
            QStringLiteral("/repos/") + NodeCompat::jsString(owner) + QLatin1Char('/') + NodeCompat::jsString(repo) + QStringLiteral("/actions/runs?per_page=10"),
            QJsonValue(QJsonValue::Undefined),
            [done](const QJsonValue &body) {
                QJsonValue runs;
                QString error;
                if (!member(body, QStringLiteral("workflow_runs"), &runs, &error)) {
                    done(false, QJsonValue(), error);
                    return;
                }
                QJsonArray out;
                for (const QJsonValue &r : runs.toArray()) {
                    out.append(QJsonObject{
                        {QStringLiteral("name"), prop(r, QStringLiteral("name"))},
                        {QStringLiteral("status"), prop(r, QStringLiteral("status"))},
                        {QStringLiteral("conclusion"), prop(r, QStringLiteral("conclusion"))},
                        {QStringLiteral("url"), prop(r, QStringLiteral("html_url"))},
                    });
                }
                done(true, out, QString());
            },
            done);
}

/*
 * Repository search, through the user's token.
 *
 * Authenticated deliberately. The Research panel used an unauthenticated
 * call, which GitHub rate-limits to ten searches a minute across the
 * whole machine - so a second question in the same minute returned an
 * error that read as the feature being broken. The token is already held
 * for push and clone; using it here costs nothing and raises the limit to
 * thirty.
 *
 * Only the fields the panel shows are kept: a search response carries
 * about eighty per repository, and passing all of it to the renderer
 * would put a megabyte through to display four lines.
 */
void GitHubApi::searchRepos(const QJsonValue &query, const QJsonValue &limit, Done done) const
{
    const QString q = NodeCompat::jsString(orElse(query, QString())).trimmed();
    if (q.isEmpty()) {
        done(true, QJsonArray(), QString());
        return;
    }
    double n = NodeCompat::toNumber(limit);
    if (std::isnan(n) || n == 0)
        n = 8;
    n = std::min(std::max(n, 1.0), 30.0);
    request(QStringLiteral("GET"),
            QStringLiteral("/search/repositories?sort=stars&order=desc&per_page=") + NodeCompat::stringify(QJsonValue(n))
                + QStringLiteral("&q=") + encodeURIComponent(q),
            QJsonValue(QJsonValue::Undefined),
            [done](const QJsonValue &body) {
                QJsonValue items;
                QString error;
                if (!member(body, QStringLiteral("items"), &items, &error)) {
                    done(false, QJsonValue(), error);
                    return;
                }
                QJsonArray out;
                for (const QJsonValue &r : items.toArray()) {
                    out.append(QJsonObject{
                        {QStringLiteral("fullName"), prop(r, QStringLiteral("full_name"))},
                        {QStringLiteral("description"), orElse(prop(r, QStringLiteral("description")), QString())},
                        {QStringLiteral("stars"), orElse(prop(r, QStringLiteral("stargazers_count")), 0)},
                        {QStringLiteral("language"), orElse(prop(r, QStringLiteral("language")), QString())},
                        {QStringLiteral("url"), prop(r, QStringLiteral("html_url"))},
                        {QStringLiteral("updatedAt"), orElse(prop(r, QStringLiteral("pushed_at")),
                                                             orElse(prop(r, QStringLiteral("updated_at")), QString()))},
                    });
                }
                done(true, out, QString());
            },
            done);
}

void GitHubApi::dispatchWorkflow(const QJsonValue &owner, const QJsonValue &repo, const QJsonValue &workflowId,
                                 const QJsonValue &ref, Done done) const
{
    request(QStringLiteral("POST"),
            QStringLiteral("/repos/") + NodeCompat::jsString(owner) + QLatin1Char('/') + NodeCompat::jsString(repo) + QStringLiteral("/actions/workflows/")
                + NodeCompat::jsString(workflowId) + QStringLiteral("/dispatches"),
            QJsonObject{{QStringLiteral("ref"), orElse(ref, QStringLiteral("main"))}},
            [done](const QJsonValue &body) { done(true, body, QString()); }, done);
}
