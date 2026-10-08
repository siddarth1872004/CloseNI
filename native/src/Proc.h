#pragma once

#include <QByteArray>
#include <QProcess>
#include <QString>
#include <QVariant>

/*
 * What desktop/main.js and the desktop/main modules got from Node's child_process,
 * shared by the services that start processes.
 */
namespace Proc {

/*
 * A stream cut into lines the way main.js's lineBuf loops cut it: on "\n",
 * with one trailing "\r" dropped and an unfinished last line kept for the
 * next chunk. Lines are decoded whole, so a character split across two chunks
 * is not mangled.
 */
class LineSplitter
{
public:
    template<class Each>
    void feed(const QByteArray &bytes, Each &&each)
    {
        m_buf += bytes;
        qsizetype idx;
        while ((idx = m_buf.indexOf('\n')) != -1) {
            QString line = QString::fromUtf8(m_buf.constData(), idx);
            m_buf.remove(0, idx + 1);
            if (line.endsWith(u'\r'))
                line.chop(1);
            each(line);
        }
    }

private:
    QByteArray m_buf;
};

/* spawn(command, { shell: true }): /bin/sh -c on Unix, cmd.exe /d /s /c on Windows. */
void startShell(QProcess *proc, const QString &command);

/* Node's `detached: true` on Unix: the child leads a process group of its own. */
void ownProcessGroup(QProcess *proc);

/* Node's proc.kill(): SIGTERM on Unix, TerminateProcess on Windows. */
void terminate(QProcess *proc);

/*
 * The whole tree: taskkill /T /F on Windows; elsewhere SIGTERM to the process
 * group, then SIGKILL three seconds later for anything that ignored it. The
 * process must have been started with ownProcessGroup().
 */
void killGroup(QProcess *proc);

/* Node's (code, signal) for a finished process: null code when a signal ended it. */
QVariant exitCode(int code, QProcess::ExitStatus status);
QVariant exitSignal(int code, QProcess::ExitStatus status);

/* JavaScript null, which QVariant() is not: that arrives as undefined. */
QVariant null();

/* browser-check.js stripAnsi: terminal colour codes out. */
QString stripAnsi(const QString &text);

/* A line to this process's stdout, as main.js's console.log and process.stdout.write. */
void mirror(const QString &line);

}
