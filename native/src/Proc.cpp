#include "Proc.h"

#include <QRegularExpression>
#include <QTimer>

#include <cstdio>

#ifdef Q_OS_UNIX
#include <csignal>
#endif

namespace Proc {

void startShell(QProcess *proc, const QString &command)
{
#ifdef Q_OS_WIN
    // What Node does for shell: true: the command line handed to cmd verbatim,
    // quoted once, so cmd's own rules decide how it splits.
    const QString comspec = qEnvironmentVariable("ComSpec");
    proc->setProgram(comspec.isEmpty() ? QStringLiteral("cmd.exe") : comspec);
    proc->setArguments({});
    proc->setNativeArguments(QStringLiteral("/d /s /c \"") + command + QStringLiteral("\""));
    proc->start();
#else
    proc->start(QStringLiteral("/bin/sh"), {QStringLiteral("-c"), command});
#endif
}

void ownProcessGroup(QProcess *proc)
{
#ifdef Q_OS_UNIX
    proc->setUnixProcessParameters(QProcess::UnixProcessFlag::CreateNewSession);
#else
    Q_UNUSED(proc);
#endif
}

void terminate(QProcess *proc)
{
    if (!proc || proc->state() == QProcess::NotRunning)
        return;
#ifdef Q_OS_WIN
    // terminate() posts WM_CLOSE, which a console program never sees.
    proc->kill();
#else
    proc->terminate();
#endif
}

void killGroup(QProcess *proc)
{
    if (!proc || proc->state() == QProcess::NotRunning)
        return;
    const qint64 pid = proc->processId();
    if (pid <= 0)
        return;
#ifdef Q_OS_WIN
    QProcess::execute(QStringLiteral("taskkill"), {QStringLiteral("/pid"), QString::number(pid), QStringLiteral("/T"), QStringLiteral("/F")});
#else
    ::kill(-pid_t(pid), SIGTERM);
    QTimer::singleShot(3000, [pid] { ::kill(-pid_t(pid), SIGKILL); });
#endif
}

QVariant null()
{
    return QVariant::fromValue(nullptr);
}

QVariant exitCode(int code, QProcess::ExitStatus status)
{
    return status == QProcess::CrashExit ? null() : QVariant(code);
}

QVariant exitSignal(int code, QProcess::ExitStatus status)
{
    if (status != QProcess::CrashExit)
        return null();
#ifdef Q_OS_UNIX
    // On Unix a crashed QProcess's exit code is the signal that ended it.
    switch (code) {
    case SIGHUP: return QStringLiteral("SIGHUP");
    case SIGINT: return QStringLiteral("SIGINT");
    case SIGQUIT: return QStringLiteral("SIGQUIT");
    case SIGILL: return QStringLiteral("SIGILL");
    case SIGTRAP: return QStringLiteral("SIGTRAP");
    case SIGABRT: return QStringLiteral("SIGABRT");
    case SIGBUS: return QStringLiteral("SIGBUS");
    case SIGFPE: return QStringLiteral("SIGFPE");
    case SIGKILL: return QStringLiteral("SIGKILL");
    case SIGUSR1: return QStringLiteral("SIGUSR1");
    case SIGSEGV: return QStringLiteral("SIGSEGV");
    case SIGUSR2: return QStringLiteral("SIGUSR2");
    case SIGPIPE: return QStringLiteral("SIGPIPE");
    case SIGALRM: return QStringLiteral("SIGALRM");
    case SIGTERM: return QStringLiteral("SIGTERM");
    default: return QStringLiteral("SIG") + QString::number(code);
    }
#else
    Q_UNUSED(code);
    return QStringLiteral("SIGKILL");
#endif
}

QString stripAnsi(const QString &text)
{
    static const QRegularExpression ansi(QStringLiteral("\\x{001b}\\[[0-9;]*[A-Za-z]"));
    QString out = text;
    return out.remove(ansi);
}

void mirror(const QString &line)
{
    const QByteArray bytes = line.toUtf8();
    std::fwrite(bytes.constData(), 1, size_t(bytes.size()), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}

}
