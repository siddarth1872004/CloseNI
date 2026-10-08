#include "Bridge.h"

#include "AgentService.h"
#include "Proc.h"
#include "RunService.h"

#include <QCoreApplication>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMetaMethod>
#include <QPointer>
#include <QQmlEngine>

#include <iostream>
#include <string>
#include <thread>

QJSValue CallbackSink::make(QJSEngine *engine, std::function<void(const QVariant &)> fn)
{
    // Parented to the engine, so it is never JavaScript's to collect; it
    // deletes itself once called.
    auto *sink = new CallbackSink(std::move(fn), engine);
    const QJSValue bind = engine->evaluate(QStringLiteral("(function (sink) { return function (r) { sink.call(r); }; })"));
    return bind.call({engine->toScriptValue(static_cast<QObject *>(sink))});
}

CallbackSink::CallbackSink(std::function<void(const QVariant &)> fn, QObject *parent)
    : QObject(parent)
    , m_fn(std::move(fn))
{
}

void CallbackSink::call(const QJSValue &result)
{
    auto fn = std::move(m_fn);
    m_fn = nullptr;
    deleteLater();
    if (fn)
        fn(result.toVariant());
}

Bridge::Bridge(QQmlEngine *engine, QObject *parent)
    : QObject(parent)
    , m_engine(engine)
    , m_agent(engine->singletonInstance<AgentService *>("CloseNI", "Agent"))
    , m_runner(engine->singletonInstance<RunService *>("CloseNI", "Runner"))
{
    forwardSignals();
    // A blocking read on a thread of its own: the only stdin reader that works
    // the same on every system. Detached, because it may be blocked on a read
    // when the app exits.
    QPointer<Bridge> self(this);
    std::thread([self] {
        std::string line;
        while (std::getline(std::cin, line)) {
            const QByteArray bytes = QByteArray::fromStdString(line);
            QMetaObject::invokeMethod(QCoreApplication::instance(), [self, bytes] {
                if (self)
                    self->handle(bytes);
            }, Qt::QueuedConnection);
        }
        QMetaObject::invokeMethod(QCoreApplication::instance(), [] { QCoreApplication::quit(); }, Qt::QueuedConnection);
    }).detach();
}

void Bridge::print(const QVariantMap &message)
{
    Proc::mirror(QStringLiteral("BRIDGE ") + QString::fromUtf8(QJsonDocument(QJsonObject::fromVariantMap(message)).toJson(QJsonDocument::Compact)));
}

void Bridge::forwardSignals()
{
    auto agent = qobject_cast<AgentService *>(m_agent);
    auto runner = qobject_cast<RunService *>(m_runner);
    auto out = [this](const QString &name, const QVariant &arg) {
        print({{QStringLiteral("signal"), name}, {QStringLiteral("args"), QVariantList{arg}}});
    };
    connect(agent, &AgentService::codeEvent, this, [out](const QVariantMap &v) { out(QStringLiteral("Agent.codeEvent"), v); });
    connect(agent, &AgentService::phase, this, [out](const QVariantMap &v) { out(QStringLiteral("Agent.phase"), v); });
    connect(agent, &AgentService::log, this, [out](const QString &v) { out(QStringLiteral("Agent.log"), v); });
    connect(agent, &AgentService::projectLog, this, [out](const QString &v) { out(QStringLiteral("Agent.projectLog"), v); });
    connect(agent, &AgentService::stepEvent, this, [out](const QVariantMap &v) { out(QStringLiteral("Agent.stepEvent"), v); });
    connect(agent, &AgentService::approvalRequest, this, [out](const QVariantMap &v) { out(QStringLiteral("Agent.approvalRequest"), v); });
    connect(agent, &AgentService::browserProgress, this, [out](const QString &v) { out(QStringLiteral("Agent.browserProgress"), v); });
    connect(runner, &RunService::runFix, this, [out](const QVariantMap &v) { out(QStringLiteral("Runner.runFix"), v); });
    connect(runner, &RunService::started, this, [out](const QVariantMap &v) { out(QStringLiteral("Runner.started"), v); });
    connect(runner, &RunService::output, this, [out](const QVariantMap &v) { out(QStringLiteral("Runner.output"), v); });
    connect(runner, &RunService::exited, this, [out](const QVariantMap &v) { out(QStringLiteral("Runner.exited"), v); });
    connect(runner, &RunService::windowRequested, this, [out](const QVariantMap &v) { out(QStringLiteral("Runner.windowRequested"), v); });
}

void Bridge::handle(const QByteArray &line)
{
    const QVariantMap msg = QJsonDocument::fromJson(line).object().toVariantMap();
    const QVariant id = msg.value(QStringLiteral("id"));
    const QString service = msg.value(QStringLiteral("service")).toString();
    const QString method = msg.value(QStringLiteral("method")).toString();
    QObject *target = service == QStringLiteral("Agent") ? m_agent : service == QStringLiteral("Runner") ? m_runner : nullptr;
    auto fail = [this, id](const QString &error) {
        print({{QStringLiteral("id"), id}, {QStringLiteral("error"), error}});
    };
    if (!target)
        return fail(QStringLiteral("no service ") + service);

    // Does the method end in a callback?
    bool async = false;
    bool found = false;
    const QMetaObject *meta = target->metaObject();
    for (int i = meta->methodOffset(); i < meta->methodCount(); ++i) {
        const QMetaMethod m = meta->method(i);
        if (m.methodType() != QMetaMethod::Method || m.name() != method.toUtf8())
            continue;
        found = true;
        async = m.parameterCount() > 0 && m.parameterMetaType(m.parameterCount() - 1) == QMetaType::fromType<QJSValue>();
    }
    if (!found)
        return fail(QStringLiteral("no method ") + service + u'.' + method);

    QJSValueList args;
    for (const QVariant &a : msg.value(QStringLiteral("args")).toList())
        args.append(m_engine->toScriptValue(a));
    if (async) {
        args.append(CallbackSink::make(m_engine, [this, id](const QVariant &result) {
            print({{QStringLiteral("id"), id}, {QStringLiteral("result"), result}});
        }));
    }
    const QJSValue self = m_engine->toScriptValue(target);
    const QJSValue r = self.property(method).callWithInstance(self, args);
    if (r.isError())
        return fail(r.toString());
    if (!async)
        print({{QStringLiteral("id"), id}, {QStringLiteral("result"), QVariant()}});
}
