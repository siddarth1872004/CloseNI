#pragma once

#include <QByteArray>
#include <QObject>
#include <QProcess>
#include <QQmlEngine>
#include <QVariantMap>

/*
 * The coding agent as a long-lived session: the Qt side of desktop/main.js's
 * code-start.
 *
 * One `agent-session` process holds the provider and the loop. Messages go in
 * on stdin as JSON lines; events come out as `AGENT_EVENT: {...}` lines, and
 * everything else on stdout and stderr is narration for the log.
 */
class AgentProcess : public QObject
{
    Q_OBJECT
    QML_ELEMENT

    /* idle, starting, ready, closing or failed. */
    Q_PROPERTY(QString status READ status NOTIFY statusChanged)
    /* Why the last start failed; empty otherwise. */
    Q_PROPERTY(QString error READ error NOTIFY statusChanged)
    /* The `ready` event itself: provider, workspace, mode and memory. */
    Q_PROPERTY(QVariantMap readyInfo READ readyInfo NOTIFY statusChanged)
    Q_PROPERTY(QString nodePath READ nodePath CONSTANT)
    Q_PROPERTY(QString agentPath READ agentPath CONSTANT)
    Q_PROPERTY(QString storageRoot READ storageRoot CONSTANT)

public:
    explicit AgentProcess(QObject *parent = nullptr);
    ~AgentProcess() override;

    QString status() const { return m_status; }
    QString error() const { return m_error; }
    QVariantMap readyInfo() const { return m_readyInfo; }
    QString nodePath() const { return m_nodePath; }
    QString agentPath() const { return m_agentPath; }
    QString storageRoot() const { return m_storageRoot; }

    Q_INVOKABLE void start(const QString &workspace, const QString &provider, const QString &mode);
    /* One JSON line to the session. False when there is no session to take it. */
    Q_INVOKABLE bool send(const QVariantMap &message);
    /* Ask the session to end, and kill it if it has not within 20 seconds. */
    Q_INVOKABLE void close();

signals:
    void statusChanged();
    void agentEvent(const QVariantMap &event);
    void logLine(const QString &line);

private:
    void setStatus(const QString &status, const QString &error = QString());
    void readStdout();
    void readStderr();
    void handleLine(const QString &line);
    void finished(int exitCode, QProcess::ExitStatus exitStatus);

    QProcess *m_proc = nullptr;
    QByteArray m_stdoutBuf;
    QByteArray m_stderrBuf;
    QString m_status = QStringLiteral("idle");
    QString m_error;
    QVariantMap m_readyInfo;
    const QString m_nodePath;
    const QString m_agentPath;
    const QString m_storageRoot;
};
