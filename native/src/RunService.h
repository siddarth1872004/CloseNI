#pragma once

#include <QJSValue>
#include <QObject>
#include <QQmlEngine>
#include <QStringList>
#include <QVariantMap>

/*
 * The program a build produced, run in a native console window. There is no
 * embedded browser: a web project's address is opened in the system browser.
 *
 * Ports desktop/main/run-window.js. Owner: agent-backend.
 * Asynchronous methods reply once through their callback (src/Js.h).
 */
class RunService : public QObject
{
    Q_OBJECT
    QML_NAMED_ELEMENT(Runner)
    QML_SINGLETON

public:
    explicit RunService(QObject *parent = nullptr);

    Q_INVOKABLE void openRunWindow(const QVariantMap &payload, QJSValue callback);
    Q_INVOKABLE void checkRun(const QVariantMap &payload, QJSValue callback);
    Q_INVOKABLE void restart(QJSValue callback);
    Q_INVOKABLE void stop(QJSValue callback);
    Q_INVOKABLE void input(const QString &text, QJSValue callback);
    Q_INVOKABLE void fix(QJSValue callback);
    Q_INVOKABLE void close(QJSValue callback);

signals:
    void runFix(const QVariantMap &detail);
    void started(const QVariantMap &detail);
    void output(const QVariantMap &chunk);
    void exited(const QVariantMap &detail);
    void windowRequested(const QVariantMap &payload);
};
