#include "GitHubService.h"

#include "Js.h"

GitHubService::GitHubService(QObject *parent)
    : QObject(parent)
{
}

void GitHubService::status(QJSValue callback)
{
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: GitHub.status"}});
}

void GitHubService::signIn(const QString &token, QJSValue callback)
{
    Q_UNUSED(token);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: GitHub.signIn"}});
}

void GitHubService::signOut(QJSValue callback)
{
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: GitHub.signOut"}});
}

void GitHubService::call(const QString &method, const QVariantMap &args, QJSValue callback)
{
    Q_UNUSED(method);
    Q_UNUSED(args);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: GitHub.call"}});
}

void GitHubService::clone(const QVariantMap &payload, QJSValue callback)
{
    Q_UNUSED(payload);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: GitHub.clone"}});
}
