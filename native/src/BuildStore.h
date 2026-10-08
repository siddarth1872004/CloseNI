#pragma once

#include <QJSValue>
#include <QObject>
#include <QQmlEngine>
#include <QStringList>
#include <QVariantMap>

/*
 * A build's plan, step statuses, checkpoints and manifest in the workspace.
 *
 * Ports desktop/main/build.js. Owner: data-backend.
 * Asynchronous methods reply once through their callback (src/Js.h).
 */
class BuildStore : public QObject
{
    Q_OBJECT
    QML_NAMED_ELEMENT(Builds)
    QML_SINGLETON

public:
    explicit BuildStore(QObject *parent = nullptr);

    Q_INVOKABLE void readBuildState(const QString &workspace, QJSValue callback);
    Q_INVOKABLE void writeBuildState(const QVariantMap &payload, QJSValue callback);
    Q_INVOKABLE void clearBuildState(const QString &workspace, QJSValue callback);
    Q_INVOKABLE void clearCheckpoints(const QString &workspace, QJSValue callback);
    Q_INVOKABLE void workspaceProgress(const QStringList &paths, QJSValue callback);
    Q_INVOKABLE void planRollback(const QString &workspace, int toStep, QJSValue callback);
    Q_INVOKABLE void applyRollback(const QString &workspace, const QVariantMap &plan, QJSValue callback);
    Q_INVOKABLE void readManifest(const QString &workspace, QJSValue callback);
    Q_INVOKABLE void writeManifest(const QVariantMap &payload, QJSValue callback);
};
