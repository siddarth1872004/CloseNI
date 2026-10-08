#include "RunService.h"

#include "Js.h"

RunService::RunService(QObject *parent)
    : QObject(parent)
{
}

void RunService::openRunWindow(const QVariantMap &payload, QJSValue callback)
{
    Q_UNUSED(payload);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Runner.openRunWindow"}});
}

void RunService::checkRun(const QVariantMap &payload, QJSValue callback)
{
    Q_UNUSED(payload);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Runner.checkRun"}});
}

void RunService::restart(QJSValue callback)
{
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Runner.restart"}});
}

void RunService::stop(QJSValue callback)
{
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Runner.stop"}});
}

void RunService::input(const QString &text, QJSValue callback)
{
    Q_UNUSED(text);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Runner.input"}});
}

void RunService::fix(QJSValue callback)
{
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Runner.fix"}});
}

void RunService::close(QJSValue callback)
{
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Runner.close"}});
}
