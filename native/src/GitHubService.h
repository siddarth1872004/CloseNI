#pragma once

#include <QJSValue>
#include <QObject>
#include <QQmlEngine>
#include <QStringList>
#include <QVariantMap>

#include <memory>

class GitHubApi;
class QNetworkAccessManager;

/*
 * GitHub sign-in and API calls. The token never reaches QML: it is kept in
 * the system's secret store (src/platform/SecretStore_*.cpp) and used here.
 *
 * Ports desktop/main/github.js, desktop/github-api.js, desktop/github-safe.js. Owner: data-backend.
 * Asynchronous methods reply once through their callback (src/Js.h).
 */
class GitHubService : public QObject
{
    Q_OBJECT
    QML_NAMED_ELEMENT(GitHub)
    QML_SINGLETON

public:
    explicit GitHubService(QObject *parent = nullptr);
    ~GitHubService() override;

    /*
     * { signedIn, encryptionAvailable, persisted, login }, as Electron's
     * gh-status. When signed out and the Electron app's encrypted token file
     * exists, also { legacyToken: true, message }: that token cannot be read
     * here, so the user signs in once more.
     */
    Q_INVOKABLE void status(QJSValue callback);
    Q_INVOKABLE void signIn(const QString &token, QJSValue callback);
    Q_INVOKABLE void signOut(QJSValue callback);
    /*
     * gh-call. `args` is the positional argument list, as window.api.ghCall
     * took it (an array; a map is read as no arguments).
     */
    Q_INVOKABLE void call(const QString &method, const QVariant &args, QJSValue callback);
    Q_INVOKABLE void clone(const QVariantMap &payload, QJSValue callback);

signals:
    /* "git> " + a redacted chunk of the clone's output: Electron's "project-log". */
    void projectLog(const QString &line);

private:
    QNetworkAccessManager *m_nam;
    std::unique_ptr<GitHubApi> m_api;
};
