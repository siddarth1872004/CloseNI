#include "LibraryService.h"

#include "Js.h"

LibraryService::LibraryService(QObject *parent)
    : QObject(parent)
{
}

void LibraryService::listSkills(QJSValue callback)
{
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Library.listSkills"}});
}

void LibraryService::readSkill(const QString &kind, const QString &name, QJSValue callback)
{
    Q_UNUSED(kind);
    Q_UNUSED(name);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Library.readSkill"}});
}

void LibraryService::writeSkill(const QString &kind, const QString &name, const QString &text, QJSValue callback)
{
    Q_UNUSED(kind);
    Q_UNUSED(name);
    Q_UNUSED(text);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Library.writeSkill"}});
}

void LibraryService::deleteSkill(const QString &kind, const QString &name, QJSValue callback)
{
    Q_UNUSED(kind);
    Q_UNUSED(name);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Library.deleteSkill"}});
}

void LibraryService::importSkill(const QVariantMap &payload, QJSValue callback)
{
    Q_UNUSED(payload);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Library.importSkill"}});
}

void LibraryService::readMcpConfig(QJSValue callback)
{
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Library.readMcpConfig"}});
}

void LibraryService::writeMcpConfig(const QString &text, QJSValue callback)
{
    Q_UNUSED(text);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Library.writeMcpConfig"}});
}

void LibraryService::gatherMcpContext(QJSValue callback)
{
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Library.gatherMcpContext"}});
}
