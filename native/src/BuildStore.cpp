#include "BuildStore.h"

#include "Js.h"

BuildStore::BuildStore(QObject *parent)
    : QObject(parent)
{
}

void BuildStore::readBuildState(const QString &workspace, QJSValue callback)
{
    Q_UNUSED(workspace);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Builds.readBuildState"}});
}

void BuildStore::writeBuildState(const QVariantMap &payload, QJSValue callback)
{
    Q_UNUSED(payload);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Builds.writeBuildState"}});
}

void BuildStore::clearBuildState(const QString &workspace, QJSValue callback)
{
    Q_UNUSED(workspace);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Builds.clearBuildState"}});
}

void BuildStore::clearCheckpoints(const QString &workspace, QJSValue callback)
{
    Q_UNUSED(workspace);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Builds.clearCheckpoints"}});
}

void BuildStore::workspaceProgress(const QStringList &paths, QJSValue callback)
{
    Q_UNUSED(paths);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Builds.workspaceProgress"}});
}

void BuildStore::planRollback(const QString &workspace, int toStep, QJSValue callback)
{
    Q_UNUSED(workspace);
    Q_UNUSED(toStep);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Builds.planRollback"}});
}

void BuildStore::applyRollback(const QString &workspace, const QVariantMap &plan, QJSValue callback)
{
    Q_UNUSED(workspace);
    Q_UNUSED(plan);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Builds.applyRollback"}});
}

void BuildStore::readManifest(const QString &workspace, QJSValue callback)
{
    Q_UNUSED(workspace);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Builds.readManifest"}});
}

void BuildStore::writeManifest(const QVariantMap &payload, QJSValue callback)
{
    Q_UNUSED(payload);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Builds.writeManifest"}});
}
