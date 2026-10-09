#pragma once

#include <QHash>
#include <QJsonObject>
#include <QJsonValue>
#include <QList>
#include <QMap>
#include <QString>
#include <QStringList>

#include <optional>

/*
 * The agent's rules about a build's files, for the main-process side.
 *
 * desktop/main/build.js and git.js required these from local-agent/dist
 * (build-state.js, checkpoint.js, run-manifest.js, export-branch.js) so the
 * rules lived in one place. The native app has no Node in-process, so the
 * parts the main process used are ported here, function for function. The
 * TypeScript in local-agent/src is still the source of truth: a change there
 * must be mirrored here, and native/tests/tst_buildstore.cpp carries the
 * agent's own checks for these functions (build-unit.cjs) so the two copies
 * can be compared.
 */

/* local-agent/src/build-state.ts */
namespace BuildState {

inline const QString kDir = QStringLiteral(".closeni");
inline const QString kName = QStringLiteral("build.json");

/* The key order serialiseBuildState builds its objects in, for stringify. */
QStringList keyOrder();

/* What to write for the builder's current step list. `now` is for tests. */
QJsonObject serialise(const QJsonValue &plan, const QJsonValue &steps, const QJsonValue &provider,
                      const QJsonValue &startedAt, const QString &now = QString());

/* A build read back, or nothing: absent, corrupt, wrong version and empty alike. */
std::optional<QJsonObject> parse(const QJsonValue &raw);
std::optional<QJsonObject> parseText(const QString &raw);

/* { done, total, unfinished } */
QJsonObject describeProgress(const std::optional<QJsonObject> &state);

}

/* local-agent/src/checkpoint.ts (the parts the main process uses). */
namespace Checkpoint {

inline const QString kDir = QStringLiteral("checkpoints");

struct Entry {
    /* Contents before the step ran; nullopt means the step created the file. */
    std::optional<QString> prior;
    /* Hash of what the step left. */
    std::optional<QString> after;
    bool tooLarge = false;
};

struct Record {
    int step = 0;
    std::optional<QString> title;
    QString at;
    QMap<QString, Entry> files;
};

/* path -> contents now; nullopt means the file is gone. A path absent from the map is unknown. */
using Current = QHash<QString, std::optional<QString>>;

QString hash(const QString &text);
QString checkpointName(int step);
std::optional<Record> parse(const QString &raw);

/* RollbackPlan, as the JSON the renderer receives. `toStep` may be NaN (JS undefined). */
QJsonObject planRollback(QList<Record> checkpoints, double toStep, const Current &current);

/* <workspace>/.closeni/checkpoints */
QString dirFor(const QString &workspace);

/* Every checkpoint in this workspace, oldest step first (build.js readCheckpoints). */
QList<Record> readAll(const QString &workspace);

}

namespace Workspace {

/*
 * `rel` resolved against `root`, or empty when it would land on the root or
 * outside it. A checkpoint is a file on disk, and one that had been edited to
 * say "../../.bashrc" must not be able to write there.
 */
QString inside(const QString &root, const QString &rel);

}

/* local-agent/src/run-manifest.ts */
namespace RunManifest {

inline const QString kName = QStringLiteral("closeni.run.json");

QStringList keyOrder();

QJsonObject merge(const QJsonValue &existing, const QJsonValue &run, bool userEdited,
                  const QJsonValue &install, const QJsonValue &language);

/* `windows` picks run.bat's form over run.sh's. */
QString renderRunScript(const QJsonObject &manifest, bool windows);

}

/* local-agent/src/export-branch.ts */
namespace ExportBranch {

struct Commit {
    int step = 0;
    QString title;
    QMap<QString, QString> writes;
    QStringList deletes;
};

struct Plan {
    QList<Commit> commits;
    QStringList warnings;
};

QString branchName(const QString &summary);
QString commitMessage(int step, const QString &title);
Plan planCommits(QList<Checkpoint::Record> checkpoints, const Checkpoint::Current &current,
                 const QHash<int, QString> &titles = {});

}
