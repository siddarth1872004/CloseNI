#include "AgentService.h"

#include "Js.h"

AgentService::AgentService(QObject *parent)
    : QObject(parent)
{
}

void AgentService::runAgent(const QVariantMap &payload, QJSValue callback)
{
    Q_UNUSED(payload);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Agent.runAgent"}});
}

void AgentService::suggest(const QVariantMap &payload, QJSValue callback)
{
    Q_UNUSED(payload);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Agent.suggest"}});
}

void AgentService::askRun(const QVariantMap &payload, QJSValue callback)
{
    Q_UNUSED(payload);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Agent.askRun"}});
}

void AgentService::codeStart(const QVariantMap &payload, QJSValue callback)
{
    Q_UNUSED(payload);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Agent.codeStart"}});
}

void AgentService::codeSend(const QString &text, QJSValue callback)
{
    Q_UNUSED(text);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Agent.codeSend"}});
}

void AgentService::codePermission(const QString &id, const QString &decision, const QString &feedback, QJSValue callback)
{
    Q_UNUSED(id);
    Q_UNUSED(decision);
    Q_UNUSED(feedback);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Agent.codePermission"}});
}

void AgentService::codeMode(const QString &mode, QJSValue callback)
{
    Q_UNUSED(mode);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Agent.codeMode"}});
}

void AgentService::codeInterrupt(QJSValue callback)
{
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Agent.codeInterrupt"}});
}

void AgentService::codeRewind(QJSValue callback)
{
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Agent.codeRewind"}});
}

void AgentService::codeClear(QJSValue callback)
{
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Agent.codeClear"}});
}

void AgentService::codeCompact(QJSValue callback)
{
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Agent.codeCompact"}});
}

void AgentService::codeEnd(QJSValue callback)
{
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Agent.codeEnd"}});
}

void AgentService::startSession(const QVariantMap &payload, QJSValue callback)
{
    Q_UNUSED(payload);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Agent.startSession"}});
}

void AgentService::sendStep(const QVariantMap &payload, QJSValue callback)
{
    Q_UNUSED(payload);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Agent.sendStep"}});
}

void AgentService::endSession(QJSValue callback)
{
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Agent.endSession"}});
}

void AgentService::runCommand(const QVariantMap &payload, QJSValue callback)
{
    Q_UNUSED(payload);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Agent.runCommand"}});
}

void AgentService::signIn(const QString &providerId, QJSValue callback)
{
    Q_UNUSED(providerId);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Agent.signIn"}});
}

void AgentService::authStatus(const QString &providerId, const QString &workspace, QJSValue callback)
{
    Q_UNUSED(providerId);
    Q_UNUSED(workspace);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Agent.authStatus"}});
}

void AgentService::providerHealth(const QString &providerId, const QString &workspace, QJSValue callback)
{
    Q_UNUSED(providerId);
    Q_UNUSED(workspace);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Agent.providerHealth"}});
}

void AgentService::signOutProvider(const QString &providerId, QJSValue callback)
{
    Q_UNUSED(providerId);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Agent.signOutProvider"}});
}

void AgentService::openThread(const QString &url, QJSValue callback)
{
    Q_UNUSED(url);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Agent.openThread"}});
}

void AgentService::browserStatus(QJSValue callback)
{
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Agent.browserStatus"}});
}

void AgentService::installBrowser(QJSValue callback)
{
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Agent.installBrowser"}});
}

void AgentService::respondApproval(bool approved)
{
    Q_UNUSED(approved);
}
