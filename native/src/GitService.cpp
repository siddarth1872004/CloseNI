/*
 * Git: exporting a build as one commit per step, and the Ship panel's buttons.
 *
 * Ports desktop/main/git.js.
 */
#include "GitService.h"

#include "BuildRules.h"
#include "GitHubAuth.h"
#include "GitHubSafe.h"
#include "GitRunner.h"
#include "Js.h"
#include "NodeCompat.h"

#include <QDir>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonObject>
#include <QPointer>

#include <functional>
#include <memory>

namespace {

QVariant fail(const QString &error)
{
    return QVariantMap{{QStringLiteral("ok"), false}, {QStringLiteral("error"), error}};
}

/* One git invocation, resolved rather than thrown, so a caller can branch on it. */
void runGit(QObject *context, const QStringList &args, const QString &cwd,
            std::function<void(bool ok, const QString &output)> done)
{
    auto out = std::make_shared<QString>();
    GitRunner::run(
        context, args, cwd, [out](const QString &chunk) { *out += chunk; },
        [out, done](const GitRunner::Result &r) {
            if (!r.started)
                done(false, r.error);
            else
                done(r.success, *out);
        });
}

/* An export in flight: the async steps of git.js's export-branch, in order. */
struct ExportJob : std::enable_shared_from_this<ExportJob> {
    QPointer<GitService> service;
    QJSValue callback;
    QString ws;
    QStringList currentOrder;
    Checkpoint::Current current;
    ExportBranch::Plan plan;
    QString branch;
    qsizetype next = 0;

    QString inside(const QString &rel) const { return Workspace::inside(ws, rel); }

    void start()
    {
        auto self = shared_from_this();
        runGit(service, {QStringLiteral("rev-parse"), QStringLiteral("--git-dir")}, ws, [self](bool ok, const QString &) {
            if (!ok) {
                runGit(self->service, {QStringLiteral("init")}, self->ws, [self](bool initOk, const QString &output) {
                    if (!initOk) {
                        self->finish(fail(QStringLiteral("could not create a repository here: ") + output));
                        return;
                    }
                    self->checkout();
                });
                return;
            }
            // Refused rather than stashed. The export writes files as it goes, so
            // uncommitted work would be swept into a step's commit and attributed to
            // the build.
            //
            // CloseNI's own folder does not count: the build state and checkpoints
            // are not the user's work, and the replay never stages them. A
            // workspace whose .closeni predates its self-ignoring .gitignore (or
            // was committed) would otherwise be refused right after the build.
            runGit(self->service,
                   {QStringLiteral("status"), QStringLiteral("--porcelain"), QStringLiteral("--"),
                    QStringLiteral(":(exclude)") + BuildState::kDir},
                   self->ws,
                   [self](bool statusOk, const QString &output) {
                       if (statusOk && !output.trimmed().isEmpty()) {
                           self->finish(fail(QStringLiteral("You have uncommitted changes. Commit or stash them first - "
                                                            "the export rewrites files as it replays the build, and would "
                                                            "otherwise mix your work into a step's commit.")));
                           return;
                       }
                       self->checkout();
                   });
        });
    }

    void checkout()
    {
        auto self = shared_from_this();
        runGit(service, {QStringLiteral("checkout"), QStringLiteral("-b"), branch}, ws, [self](bool ok, const QString &output) {
            if (!ok) {
                self->finish(fail(QStringLiteral("could not create ") + self->branch + QStringLiteral(": ") + output));
                return;
            }
            self->commitNext();
        });
    }

    /* One staging command over these paths, then then(); skipped when there are none. */
    void stage(const QStringList &command, const QStringList &paths, const ExportBranch::Commit &c, std::function<void()> then)
    {
        if (paths.isEmpty()) {
            then();
            return;
        }
        auto self = shared_from_this();
        runGit(service, command + paths, ws, [self, c, then](bool ok, const QString &output) {
            if (!ok) {
                self->finish(fail(QStringLiteral("git add failed at step %1: ").arg(c.step + 1) + output));
                return;
            }
            then();
        });
    }

    void commitNext()
    {
        auto self = shared_from_this();
        while (next < plan.commits.size()) {
            const ExportBranch::Commit c = plan.commits.at(next++);
            QStringList written;
            for (auto it = c.writes.begin(); it != c.writes.end(); ++it) {
                const QString abs = inside(it.key());
                if (abs.isEmpty())
                    continue;
                QString error;
                if (!NodeCompat::mkdirs(QFileInfo(abs).absolutePath(), &error) || !NodeCompat::writeText(abs, it.value(), &error)) {
                    finish(fail(NodeCompat::errorString(error)));
                    return;
                }
                written << it.key();
            }
            QStringList removed;
            for (const QString &rel : c.deletes) {
                const QString abs = inside(rel);
                if (abs.isEmpty())
                    continue;
                NodeCompat::removeFile(abs);
                removed << rel;
            }
            if (written.isEmpty() && removed.isEmpty())
                continue;
            // "--" so a path that looks like a flag is still treated as a path.
            stage(QStringList{QStringLiteral("add"), QStringLiteral("--")}, written, c, [self, c, removed] {
                // A removal is staged with rm --ignore-unmatch rather than add. A
                // file that appears at a later step is absent from every commit
                // before it, and git add refuses a path it neither tracks nor finds
                // on disk: in a repository the export had just created, step 1
                // failed on every file a later step added (and in an existing one,
                // the second step that had to keep such a file absent did).
                self->stage({QStringLiteral("rm"), QStringLiteral("--cached"), QStringLiteral("--ignore-unmatch"),
                             QStringLiteral("-q"), QStringLiteral("--")},
                            removed, c, [self, c] {
                                runGit(self->service,
                                       {QStringLiteral("commit"), QStringLiteral("-m"), ExportBranch::commitMessage(c.step, c.title),
                                        QStringLiteral("--allow-empty")},
                                       self->ws, [self, c](bool commitOk, const QString &commitOutput) {
                                           if (!commitOk) {
                                               self->finish(fail(QStringLiteral("git commit failed at step %1: ").arg(c.step + 1)
                                                                 + commitOutput));
                                               return;
                                           }
                                           self->commitNext();
                                       });
                            });
            });
            return;
        }
        finish(QVariantMap{{QStringLiteral("ok"), true},
                           {QStringLiteral("branch"), branch},
                           {QStringLiteral("commits"), int(plan.commits.size())},
                           {QStringLiteral("warnings"), plan.warnings}});
    }

    /* The finally: the project goes back to how it was found, whatever happened above. */
    void finish(const QVariant &result)
    {
        for (const QString &rel : currentOrder) {
            const QString abs = inside(rel);
            if (abs.isEmpty())
                continue;
            // The caller's own status check reports the result.
            const std::optional<QString> &now = current[rel];
            if (!now) {
                NodeCompat::removeFile(abs);
            } else if (NodeCompat::mkdirs(QFileInfo(abs).absolutePath())) {
                NodeCompat::writeText(abs, *now);
            }
        }
        if (service)
            Js::reply(service, callback, result);
    }
};

}

GitService::GitService(QObject *parent)
    : QObject(parent)
{
}

/*
 * Replay a build onto a branch of its own, one commit per step.
 *
 * The working tree is rewritten as it goes - each step's files are put back to
 * what that step left - so the final state is captured first and restored in a
 * finally. Without that, an export that failed halfway would leave the project
 * holding a version of itself from the middle of its own history, which is a
 * far worse outcome than a failed export.
 *
 * Only the paths a step touched are staged. Staging everything would put the
 * final state of every file into the first commit, which is exactly the history
 * this exists to avoid producing.
 */
void GitService::exportBranch(const QVariantMap &payloadMap, QJSValue callback)
{
    const QJsonObject payload = NodeCompat::fromVariant(payloadMap).toObject();
    const QString ws = NodeCompat::str(payload.value(QStringLiteral("workspace")));
    if (ws.isEmpty()) {
        Js::reply(this, callback, fail(QStringLiteral("no workspace")));
        return;
    }

    const QList<Checkpoint::Record> checkpoints = Checkpoint::readAll(ws);
    if (checkpoints.isEmpty()) {
        Js::reply(this, callback, fail(QStringLiteral("nothing to export - no build has run in this workspace")));
        return;
    }

    auto job = std::make_shared<ExportJob>();
    job->service = this;
    job->callback = callback;
    job->ws = ws;

    // Every path the build ever touched, as it is now.
    for (const Checkpoint::Record &cp : checkpoints) {
        for (auto it = cp.files.begin(); it != cp.files.end(); ++it) {
            const QString &rel = it.key();
            if (job->current.contains(rel))
                continue;
            QString text;
            if (NodeCompat::readText(QDir(ws).filePath(rel), &text))
                job->current.insert(rel, text);
            else
                job->current.insert(rel, std::nullopt);
            job->currentOrder << rel;
        }
    }

    QHash<int, QString> titles;
    const QJsonArray steps = payload.value(QStringLiteral("steps")).toArray();
    for (qsizetype i = 0; i < steps.size(); ++i) {
        if (NodeCompat::truthy(steps.at(i)))
            titles.insert(int(i), NodeCompat::jsString(steps.at(i)));
    }
    job->plan = ExportBranch::planCommits(checkpoints, job->current, titles);
    if (job->plan.commits.isEmpty()) {
        Js::reply(this, callback, fail(QStringLiteral("nothing to export")));
        return;
    }
    job->branch = ExportBranch::branchName(NodeCompat::str(payload.value(QStringLiteral("summary"))));
    job->start();
}

void GitService::git(const QVariantMap &payloadMap, QJSValue callback)
{
    const QJsonObject payload = NodeCompat::fromVariant(payloadMap).toObject();
    QStringList args;
    QString error;
    if (!GitHubSafe::safeGitArgs(payload.value(QStringLiteral("args")), &args, &error)) {
        Js::reply(this, callback, QVariantMap{{QStringLiteral("success"), false}, {QStringLiteral("output"), error}});
        return;
    }
    // No shell, because with one the arguments are concatenated into a shell
    // string rather than passed separately - so a commit message containing
    // "; rm -rf ~" would run it. Git needs no shell.
    auto out = std::make_shared<QString>();
    QPointer<GitService> self(this);
    GitRunner::run(
        this, args, NodeCompat::str(payload.value(QStringLiteral("cwd"))),
        [self, out](const QString &chunk) {
            const QString clean = GitHubSafe::redactToken(chunk, GitHubAuth::token());
            *out += clean;
            QString line = clean;
            if (line.endsWith(QLatin1Char('\n')))
                line.chop(1);
            if (self)
                emit self->projectLog(QStringLiteral("git> ") + line);
        },
        [self, out, callback](const GitRunner::Result &r) {
            if (!self)
                return;
            Js::reply(self, callback, QVariantMap{{QStringLiteral("success"), r.started && r.success},
                                                  {QStringLiteral("output"), r.started ? *out : r.error}});
        });
}
