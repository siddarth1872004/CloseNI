#pragma once

#include <QJSValue>
#include <QObject>
#include <QPointer>
#include <QProcess>
#include <QQmlEngine>
#include <QStringList>
#include <QVariantMap>

#include <memory>

/*
 * The program a build produced, run in a native console window. There is no
 * embedded browser: a web project's address is opened in the system browser.
 *
 * Ports desktop/main/run-window.js. Owner: agent-backend.
 * Asynchronous methods reply once through their callback (src/Js.h).
 *
 * The run console (qml/windows/) is the other half of run.html:
 *   windowRequested {command, cwd, gui, title}: open the console, or raise it
 *       if it is open. Electron opened it full screen. Its program starts just
 *       after, as `started`.
 *   started {run, command, cwd, gui}: a new run; clear the console. With gui,
 *       the program opens a window of its own: leave full screen and say so.
 *   output {run, stream: "out"|"err", text, plain, url, urlChanged}: text as
 *       the program wrote it, plain without terminal colour codes. url is the
 *       local server the output has announced so far (0.0.0.0 shown as
 *       localhost), or "": offer "Open in browser" (App.openExternal) when
 *       urlChanged. run.html waited 400 ms before loading it.
 *   exited {run, code, signal, current}: code is null when a signal ended it.
 *       A restart stops the old run after the new one has started, so an
 *       exit with current false belongs to the old run and must be ignored.
 *       Offer "Fix errors" unless code is 0 or a signal stopped it.
 *   runFix {cwd, command, prompt}: for the main window's agent; raise it.
 * The console calls close() when it is closed by any means, so the program
 * stops with it.
 */
class RunService : public QObject
{
    Q_OBJECT
    QML_NAMED_ELEMENT(Runner)
    QML_SINGLETON

public:
    explicit RunService(QObject *parent = nullptr);
    ~RunService() override;

    Q_INVOKABLE void openRunWindow(const QVariantMap &payload, QJSValue callback);
    Q_INVOKABLE void checkRun(const QVariantMap &payload, QJSValue callback);
    Q_INVOKABLE void restart(QJSValue callback);
    Q_INVOKABLE void stop(QJSValue callback);
    Q_INVOKABLE void input(const QString &text, QJSValue callback);
    Q_INVOKABLE void fix(QJSValue callback);
    Q_INVOKABLE void close(QJSValue callback);

signals:
    void runFix(const QVariantMap &detail);
    void started(const QVariantMap &detail);
    void output(const QVariantMap &chunk);
    void exited(const QVariantMap &detail);
    void windowRequested(const QVariantMap &payload);

private:
    /* This run's command as started, the end of its output, and how it ended. */
    struct Record {
        QString command;
        QString output;
        QVariant code;
        QVariant signal;
    };
    struct Job {
        QString command;
        QString cwd;
        bool gui = false;
    };

    void start();
    void stopProgram();

    bool m_hasJob = false;
    Job m_job;
    QPointer<QProcess> m_proc;
    std::shared_ptr<Record> m_last;
    int m_runId = 0;
};
