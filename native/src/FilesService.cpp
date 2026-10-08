#include "FilesService.h"

#include "Js.h"

FilesService::FilesService(QObject *parent)
    : QObject(parent)
{
}

void FilesService::listProviders(QJSValue callback)
{
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Files.listProviders"}});
}

void FilesService::listFiles(const QString &workspace, QJSValue callback)
{
    Q_UNUSED(workspace);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Files.listFiles"}});
}

void FilesService::readFile(const QVariant &pathOrOptions, QJSValue callback)
{
    Q_UNUSED(pathOrOptions);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Files.readFile"}});
}

void FilesService::getChats(const QString &workspace, QJSValue callback)
{
    Q_UNUSED(workspace);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Files.getChats"}});
}

void FilesService::newChat(const QString &workspace, QJSValue callback)
{
    Q_UNUSED(workspace);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Files.newChat"}});
}

void FilesService::switchChat(const QString &workspace, const QString &url, QJSValue callback)
{
    Q_UNUSED(workspace);
    Q_UNUSED(url);
    Js::reply(this, callback, QVariantMap{{"ok", false}, {"success", false}, {"error", "not implemented yet: Files.switchChat"}});
}
