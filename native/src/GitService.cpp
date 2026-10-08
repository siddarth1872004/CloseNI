#include "GitService.h"

#include "Js.h"

GitService::GitService(QObject *parent)
    : QObject(parent)
{
}

void GitService::git(const QVariantMap &payload, QJSValue callback)
{
    Q_UNUSED(payload);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Git.git"}});
}

void GitService::exportBranch(const QVariantMap &payload, QJSValue callback)
{
    Q_UNUSED(payload);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Git.exportBranch"}});
}
