#pragma once

#include <QJSValue>
#include <QObject>
#include <QQmlEngine>
#include <QStringList>
#include <QVariantMap>

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

    Q_INVOKABLE void status(QJSValue callback);
    Q_INVOKABLE void signIn(const QString &token, QJSValue callback);
    Q_INVOKABLE void signOut(QJSValue callback);
    Q_INVOKABLE void call(const QString &method, const QVariantMap &args, QJSValue callback);
    Q_INVOKABLE void clone(const QVariantMap &payload, QJSValue callback);
};
