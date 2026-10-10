#pragma once

#include <QHash>
#include <QJSValue>
#include <QList>
#include <QObject>
#include <QProcess>
#include <QQmlEngine>
#include <QStringList>
#include <QVariantMap>

#include <functional>

/*
 * Every agent run: the one-shot modes, the Code panel's session, the build
 * session, provider sign-in and health, and the Chromium install. Owns the run
 * queue and the one-profile-at-a-time rules.
 *
 * Asynchronous methods reply once through their callback (src/Js.h).
 */
class AgentService : public QObject
{
    Q_OBJECT
    QML_NAMED_ELEMENT(Agent)
    QML_SINGLETON

public:
    explicit AgentService(QObject *parent = nullptr);
    ~AgentService() override;

    Q_INVOKABLE void runAgent(const QVariantMap &payload, QJSValue callback);
    Q_INVOKABLE void suggest(const QVariantMap &payload, QJSValue callback);
    Q_INVOKABLE void askRun(const QVariantMap &payload, QJSValue callback);
    Q_INVOKABLE void codeStart(const QVariantMap &payload, QJSValue callback);
    Q_INVOKABLE void codeSend(const QString &text, QJSValue callback);
    Q_INVOKABLE void codePermission(const QString &id, const QString &decision, const QString &feedback, QJSValue callback);
    Q_INVOKABLE void codeMode(const QString &mode, QJSValue callback);
    Q_INVOKABLE void codeInterrupt(QJSValue callback);
    Q_INVOKABLE void codeRewind(QJSValue callback);
    Q_INVOKABLE void codeClear(QJSValue callback);
    Q_INVOKABLE void codeCompact(QJSValue callback);
    Q_INVOKABLE void codeEnd(QJSValue callback);
    Q_INVOKABLE void startSession(const QVariantMap &payload, QJSValue callback);
    Q_INVOKABLE void sendStep(const QVariantMap &payload, QJSValue callback);
    Q_INVOKABLE void endSession(QJSValue callback);
    Q_INVOKABLE void runCommand(const QVariantMap &payload, QJSValue callback);
    Q_INVOKABLE void signIn(const QString &providerId, QJSValue callback);
    Q_INVOKABLE void authStatus(const QString &providerId, const QString &workspace, QJSValue callback);
    Q_INVOKABLE void providerHealth(const QString &providerId, const QString &workspace, QJSValue callback);
    Q_INVOKABLE void signOutProvider(const QString &providerId, QJSValue callback);
    Q_INVOKABLE void openThread(const QString &url, QJSValue callback);
    Q_INVOKABLE void browserStatus(QJSValue callback);
    Q_INVOKABLE void installBrowser(QJSValue callback);
    Q_INVOKABLE void respondApproval(bool approved);

signals:
    void codeEvent(const QVariantMap &event);
    void phase(const QVariantMap &phase);
    void log(const QString &line);
    void projectLog(const QString &line);
    void stepEvent(const QVariantMap &event);
    void approvalRequest(const QVariantMap &request);
    void browserProgress(const QString &line);

private:
    using Done = std::function<void()>;
    using Reply = std::function<void(const QVariant &)>;
    using Env = QHash<QString, QString>;

    /* One run of a one-shot mode: how its output is routed and what it resolves with. */
    struct OneShot {
        QStringList args;
        Env env;
        /* stdout lines through routeLine (authcheck and health only collect). */
        bool route = true;
        enum { ErrLog, ErrRoute, ErrIgnore } stderrMode = ErrRoute;
        /* Held as agentProc, the one-shot run approvals and sign-out look at. */
        bool holdsProfile = true;
        /* run-agent: kill 150 ms after AGENT_OUTPUT_END, and clear the phase. */
        bool runAgent = false;
        /* The result from all of stdout, or from the reason the start failed. */
        std::function<QVariantMap(const QByteArray &output, const QString &startError)> result;
    };

    QProcess *spawnAgent(const QStringList &args, const Env &extraEnv, QString *error);
    static Env agentEnv(const QString &headed, const QVariant &controls, const QVariant &preamble);
    void runOneShot(const OneShot &spec, const Reply &done);
    void queueAgentRun(const QString &label, std::function<void(Done)> task);
    void pumpQueue();
    void releaseCode(const Done &then);
    QVariant refuseWhileBuilding(const QString &what) const;
    bool profileBusy() const { return m_sessionProc || m_sessionClosing; }
    void routeLine(const QString &line);
    void clearPhase();
    QVariantMap codeSendMessage(const QVariantMap &msg);
    void codeStartNow(const QVariantMap &payload, const Reply &done);
    void startSessionNow(const QVariantMap &payload, const Reply &done);
    void closeSession(const Done &then);
    QString spawnCwd() const;
    QString browsersDir() const;
    /* A QML callback as a C++ one, so internal code need not care which it has. */
    Reply replier(const QJSValue &callback);

    /* The one-shot run (run-agent, suggest, ask-run, sign-in) holding the profile. */
    QProcess *m_agentProc = nullptr;

    /* The run queue: one task at a time, each after the Code session has yielded. */
    QList<std::function<void(Done)>> m_queue;
    bool m_queueBusy = false;

    /* The Code panel's session, and the callers waiting for one to finish closing. */
    QProcess *m_codeProc = nullptr;
    bool m_codeClosing = false;
    QList<Done> m_codeCloseWaiters;

    /* The build session, its closing, and the steps waiting on a result. */
    QProcess *m_sessionProc = nullptr;
    bool m_sessionClosing = false;
    QList<Done> m_sessionCloseWaiters;
    QMultiHash<qint64, Reply> m_pendingSteps;
};
