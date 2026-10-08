#pragma once

#include <QJSValue>
#include <QObject>
#include <QQmlEngine>
#include <QStringList>
#include <QVariantMap>

/*
 * Every agent run: the one-shot modes, the Code panel's session, the build
 * session, provider sign-in and health, and the Chromium install. Owns the run
 * queue and the one-profile-at-a-time rules.
 *
 * Ports desktop/main.js, desktop/main/browser.js. Owner: agent-backend.
 * Asynchronous methods reply once through their callback (src/Js.h).
 */
class AgentService : public QObject
{
    Q_OBJECT
    QML_NAMED_ELEMENT(Agent)
    QML_SINGLETON

public:
    explicit AgentService(QObject *parent = nullptr);

    Q_INVOKABLE void runAgent(const QVariantMap &payload, QJSValue callback);
    Q_INVOKABLE void suggest(const QVariantMap &payload, QJSValue callback);
    Q_INVOKABLE void askRun(const QVariantMap &payload, QJSValue callback);
    Q_INVOKABLE void codeStart(const QVariantMap &payload, QJSValue callback);
    Q_INVOKABLE void codeSend(const QString &text, QJSValue callback);
    Q_INVOKABLE void codePermission(const QString &id, const QString &decision, const QString &feedback, QJSValue callback);
    Q_INVOKABLE void codeMode(const QString &mode, QJSValue callback);
    Q_INVOKABLE void codeInterrupt(QJSValue callback);
    Q_INVOKABLE void codeRewind(QJSValue callback);
    Q_INVOKABLE void codeClear(QJSValue callback);
    Q_INVOKABLE void codeCompact(QJSValue callback);
    Q_INVOKABLE void codeEnd(QJSValue callback);
    Q_INVOKABLE void startSession(const QVariantMap &payload, QJSValue callback);
    Q_INVOKABLE void sendStep(const QVariantMap &payload, QJSValue callback);
    Q_INVOKABLE void endSession(QJSValue callback);
    Q_INVOKABLE void runCommand(const QVariantMap &payload, QJSValue callback);
    Q_INVOKABLE void signIn(const QString &providerId, QJSValue callback);
    Q_INVOKABLE void authStatus(const QString &providerId, const QString &workspace, QJSValue callback);
    Q_INVOKABLE void providerHealth(const QString &providerId, const QString &workspace, QJSValue callback);
    Q_INVOKABLE void signOutProvider(const QString &providerId, QJSValue callback);
    Q_INVOKABLE void openThread(const QString &url, QJSValue callback);
    Q_INVOKABLE void browserStatus(QJSValue callback);
    Q_INVOKABLE void installBrowser(QJSValue callback);
    Q_INVOKABLE void respondApproval(bool approved);

signals:
    void codeEvent(const QVariantMap &event);
    void phase(const QVariantMap &phase);
    void log(const QString &line);
    void projectLog(const QString &line);
    void stepEvent(const QVariantMap &event);
    void approvalRequest(const QVariantMap &request);
    void browserProgress(const QString &line);
};
