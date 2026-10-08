#pragma once

#include <QJSValue>
#include <QObject>
#include <QQmlEngine>
#include <QStringList>
#include <QVariantMap>

/*
 * Local git: the commands the Push panel runs, and exporting a branch.
 *
 * Ports desktop/main/git.js. Owner: data-backend.
 * Asynchronous methods reply once through their callback (src/Js.h).
 */
class GitService : public QObject
{
    Q_OBJECT
    QML_NAMED_ELEMENT(Git)
    QML_SINGLETON

public:
    explicit GitService(QObject *parent = nullptr);

    Q_INVOKABLE void git(const QVariantMap &payload, QJSValue callback);
    Q_INVOKABLE void exportBranch(const QVariantMap &payload, QJSValue callback);
};
