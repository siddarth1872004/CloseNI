#pragma once

#include <QJSValue>
#include <QObject>
#include <QQmlEngine>
#include <QStringList>
#include <QVariantMap>

#include <memory>

class GitHubApi;

/*
 * Skills, personas and MCP configuration.
 *
 * Ports desktop/main/settings.js. Owner: data-backend.
 * Asynchronous methods reply once through their callback (src/Js.h).
 */
class LibraryService : public QObject
{
    Q_OBJECT
    QML_NAMED_ELEMENT(Library)
    QML_SINGLETON

public:
    explicit LibraryService(QObject *parent = nullptr);
    ~LibraryService() override;

    Q_INVOKABLE void listSkills(QJSValue callback);
    Q_INVOKABLE void readSkill(const QString &kind, const QString &name, QJSValue callback);
    Q_INVOKABLE void writeSkill(const QString &kind, const QString &name, const QString &text, QJSValue callback);
    Q_INVOKABLE void deleteSkill(const QString &kind, const QString &name, QJSValue callback);
    Q_INVOKABLE void importSkill(const QVariantMap &payload, QJSValue callback);
    Q_INVOKABLE void readMcpConfig(QJSValue callback);
    Q_INVOKABLE void writeMcpConfig(const QString &text, QJSValue callback);
    Q_INVOKABLE void gatherMcpContext(QJSValue callback);

private:
    /* The GitHub client, made on the first import rather than at startup. */
    const GitHubApi &github();

    std::unique_ptr<GitHubApi> m_github;
};
