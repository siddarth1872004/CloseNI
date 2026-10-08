#pragma once

#include <QJSValue>
#include <QObject>
#include <QQmlEngine>
#include <QStringList>
#include <QVariantMap>

/*
 * Providers, workspace files and the per-workspace chat threads.
 *
 * Ports desktop/main/files.js. Owner: data-backend.
 * Asynchronous methods reply once through their callback (src/Js.h).
 */
class FilesService : public QObject
{
    Q_OBJECT
    QML_NAMED_ELEMENT(Files)
    QML_SINGLETON

public:
    explicit FilesService(QObject *parent = nullptr);

    Q_INVOKABLE void listProviders(QJSValue callback);
    Q_INVOKABLE void listFiles(const QString &workspace, QJSValue callback);
    Q_INVOKABLE void readFile(const QVariant &pathOrOptions, QJSValue callback);
    Q_INVOKABLE void getChats(const QString &workspace, QJSValue callback);
    Q_INVOKABLE void newChat(const QString &workspace, QJSValue callback);
    Q_INVOKABLE void switchChat(const QString &workspace, const QString &url, QJSValue callback);
};
