#pragma once

#include <QJSValue>
#include <QObject>
#include <QVariant>

#include <functional>

class QJSEngine;
class QQmlEngine;

/*
 * A service method's QML callback, made from C++: calls `fn` once with the
 * result. main.cpp and Bridge use it to call the services as QML does.
 */
class CallbackSink : public QObject
{
    Q_OBJECT

public:
    static QJSValue make(QJSEngine *engine, std::function<void(const QVariant &)> fn);

    Q_INVOKABLE void call(const QJSValue &result);

private:
    explicit CallbackSink(std::function<void(const QVariant &)> fn, QObject *parent);
    std::function<void(const QVariant &)> m_fn;
};

/*
 * --bridge: a test harness with no window. It drives the real Agent and Runner
 * singletons over stdin and stdout, so native/smoke.cjs can test them against
 * the mock provider without a display or a UI.
 *
 *   stdin:  {"id": 1, "service": "Agent", "method": "codeStart", "args": [{...}]}
 *   stdout: BRIDGE {"id": 1, "result": {...}}
 *   stdout: BRIDGE {"signal": "Agent.codeEvent", "args": [{...}]}
 *
 * A method's callback is added after `args`; a method without one replies
 * null at once. Other stdout lines (the "[agent] ..." mirror) pass through.
 * Closing stdin quits the app.
 */
class Bridge : public QObject
{
    Q_OBJECT

public:
    explicit Bridge(QQmlEngine *engine, QObject *parent = nullptr);

private:
    void handle(const QByteArray &line);
    void print(const QVariantMap &message);
    void forwardSignals();

    QQmlEngine *m_engine;
    QObject *m_agent;
    QObject *m_runner;
};
