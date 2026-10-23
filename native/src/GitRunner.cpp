#include "GitRunner.h"

#include "GitHubAuth.h"

#include <QFileInfo>
#include <QProcess>
#include <QStringDecoder>

#include <memory>

namespace GitRunner {

void run(QObject *context, const QStringList &args, const QString &cwd,
         std::function<void(const QString &)> onOutput, std::function<void(const Result &)> done)
{
    auto *proc = new QProcess(context);
    proc->setProgram(QStringLiteral("git"));
    proc->setArguments(args);
    proc->setProcessEnvironment(GitHubAuth::gitEnv());
    proc->setProcessChannelMode(QProcess::MergedChannels);
    if (!cwd.isEmpty())
        proc->setWorkingDirectory(cwd);

    auto decoder = std::make_shared<QStringDecoder>(QStringDecoder::Utf8);
    auto finished = std::make_shared<bool>(false);
    auto finish = [proc, done, finished](const Result &r) {
        if (*finished)
            return;
        *finished = true;
        proc->deleteLater();
        done(r);
    };

    QObject::connect(proc, &QProcess::readyRead, proc, [proc, decoder, onOutput] {
        const QString chunk = (*decoder)(proc->readAll());
        if (!chunk.isEmpty() && onOutput)
            onOutput(chunk);
    });
    QObject::connect(proc, &QProcess::errorOccurred, proc, [finish](QProcess::ProcessError e) {
        if (e != QProcess::FailedToStart)
            return;
        // What Node's spawn reported: a missing git and a missing cwd both
        // surface as ENOENT.
        Result r;
        r.error = QStringLiteral("Error: spawn git ENOENT");
        finish(r);
    });
    QObject::connect(proc, &QProcess::finished, proc, [proc, decoder, onOutput, finish](int code, QProcess::ExitStatus status) {
        const QString rest = (*decoder)(proc->readAll());
        if (!rest.isEmpty() && onOutput)
            onOutput(rest);
        Result r;
        r.started = true;
        r.success = status == QProcess::NormalExit && code == 0;
        finish(r);
    });

    if (!cwd.isEmpty() && !QFileInfo(cwd).isDir()) {
        // QProcess would start git somewhere else; Node failed the spawn.
        Result r;
        r.error = QStringLiteral("Error: spawn git ENOENT");
        finish(r);
        return;
    }
    proc->start();
    // Git is never fed anything, and an open stdin is one more way to hang.
    proc->closeWriteChannel();
}

}
