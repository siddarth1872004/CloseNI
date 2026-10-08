#pragma once

#include <QObject>
#include <QString>
#include <QStringList>

#include <functional>

/*
 * One git process, the way desktop/main/git.js and github.js spawned it:
 * no shell, git's environment from GitHubAuth::gitEnv(), stdout and stderr
 * read together as they arrive.
 *
 * No shell, because with one the arguments are concatenated into a shell
 * string rather than passed separately - so a commit message containing
 * "; rm -rf ~" would run it. Git needs no shell.
 */
namespace GitRunner {

struct Result {
    /* False when git could not be started at all; `error` is then String(e). */
    bool started = false;
    /* Exit code 0. A crash or a signal is not success. */
    bool success = false;
    QString error;
};

/*
 * Run git with `args` in `cwd` (the current directory when empty). `onOutput`
 * gets each decoded chunk of stdout or stderr; `done` is called once.
 * `context` owns the process: if it is destroyed first, nothing is called.
 */
void run(QObject *context, const QStringList &args, const QString &cwd,
         std::function<void(const QString &chunk)> onOutput, std::function<void(const Result &)> done);

}
