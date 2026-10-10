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
    // A chat's title in the list; adds the chat when it is not listed yet.
    Q_INVOKABLE void nameChat(const QString &workspace, const QString &url, const QString &title, QJSValue callback);
    // Drops the chat from the list and its saved transcript; the provider's
    // own copy of the thread is left alone.
    Q_INVOKABLE void deleteChat(const QString &workspace, const QString &url, QJSValue callback);
    // What the Chat panel showed in a chat: { messages: [{ role, text }], plan }.
    // The key is the chat's url, or "" for a new chat not sent to yet.
    Q_INVOKABLE void loadTranscript(const QString &workspace, const QString &key, QJSValue callback);
    // Empty messages and no plan remove the key.
    Q_INVOKABLE void saveTranscript(const QString &workspace, const QString &key, const QVariant &messages,
                                    const QVariant &plan, QJSValue callback);
};
