#pragma once

#include <QJsonArray>
#include <QJsonValue>
#include <QString>

#include <functional>

class QNetworkAccessManager;
class QObject;

/*
 * The GitHub calls this app makes. Ports desktop/github-api.js.
 *
 * The transport is injected rather than built in, so every call shape is tested
 * without a token and without touching GitHub - which matters, because there is
 * no credential in the development environment and there will not be one.
 * network() is the real one.
 */
class GitHubApi
{
public:
    /* What a request came back with. `error` is set when there was no response at all. */
    struct Response {
        int status = 0;
        QJsonValue body;
        QString error;
    };
    using Reply = std::function<void(const Response &)>;
    /* `body` is undefined for a request without one. */
    using Request = std::function<void(const QString &method, const QString &path, const QJsonValue &body, Reply reply)>;
    /* A call's outcome: the decoded result, or the message an Error would carry. */
    using Done = std::function<void(bool ok, const QJsonValue &result, const QString &error)>;

    explicit GitHubApi(Request request);

    /*
     * HTTPS to api.github.com - or CLOSENI_GITHUB_API, so tests can aim it at a
     * local server. `token` is asked for on every request, so signing in or out
     * takes effect at once. Redirects are not followed, as Node's https did not.
     */
    static Request network(QNetworkAccessManager *nam, std::function<QString()> token);
    static QString baseUrl();

    /* The Error a failed status becomes, as its message. */
    static QString describeFailure(int status, const QJsonValue &body);

    /* Dispatch by name with positional arguments, for GitHub.call. */
    bool has(const QString &method) const;
    void call(const QString &method, const QJsonArray &args, Done done) const;

    void listRepos(Done done) const;
    void createRepo(const QJsonValue &name, const QJsonValue &isPrivate, Done done) const;
    void getReadme(const QJsonValue &owner, const QJsonValue &repo, Done done) const;
    /*
     * Any file in a repository, decoded.
     *
     * Importing a skill needs a path; getReadme only ever reaches one file.
     * Each path segment is encoded separately so a directory separator stays
     * a separator rather than becoming %2F.
     */
    void getFile(const QJsonValue &owner, const QJsonValue &repo, const QJsonValue &filePath, Done done) const;
    void getTree(const QJsonValue &owner, const QJsonValue &repo, Done done) const;
    void listRuns(const QJsonValue &owner, const QJsonValue &repo, Done done) const;
    void searchRepos(const QJsonValue &query, const QJsonValue &limit, Done done) const;
    void dispatchWorkflow(const QJsonValue &owner, const QJsonValue &repo, const QJsonValue &workflowId,
                          const QJsonValue &ref, Done done) const;

    /* encodeURIComponent */
    static QString encodeURIComponent(const QString &s);

private:
    /* A status outside 2xx fails with describeFailure; otherwise the body. */
    void request(const QString &method, const QString &path, const QJsonValue &body,
                 std::function<void(const QJsonValue &body)> ok, Done done) const;

    Request m_request;
};
