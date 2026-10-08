/*
 * A build's records in the workspace: the run manifest, the saved build state,
 * and the checkpoints that rollback restores.
 *
 * Ports desktop/main/build.js. The rules it borrowed from the agent's compiled
 * modules (build-state, checkpoint, run-manifest) are in BuildRules.
 */
#include "BuildStore.h"

#include "BuildRules.h"
#include "Js.h"
#include "NodeCompat.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>

#include <algorithm>
#include <cmath>

using NodeCompat::errorString;

namespace {

QString manifestPath(const QString &workspace)
{
    return QDir(workspace).filePath(RunManifest::kName);
}

QString buildStatePath(const QString &workspace)
{
    return QDir(workspace).filePath(BuildState::kDir + QLatin1Char('/') + BuildState::kName);
}

QString checkpointDir(const QString &workspace)
{
    return Checkpoint::dirFor(workspace);
}

QVariant fail(const QString &error)
{
    return QVariantMap{{QStringLiteral("ok"), false}, {QStringLiteral("error"), error}};
}

QVariant null()
{
    return QVariant::fromValue(nullptr);
}

/* JSON.parse of a file: false for absent and corrupt alike. */
bool readJson(const QString &file, QJsonValue *out)
{
    QByteArray bytes;
    if (!NodeCompat::readBytes(file, &bytes))
        return false;
    QJsonParseError err;
    // QJsonDocument only takes objects and arrays at the top; wrapping keeps
    // a file holding a bare value (valid to JSON.parse) parseable too.
    const QJsonDocument doc = QJsonDocument::fromJson("[" + bytes + "]", &err);
    if (err.error != QJsonParseError::NoError || doc.array().size() != 1)
        return false;
    *out = doc.array().at(0);
    return true;
}

}

BuildStore::BuildStore(QObject *parent)
    : QObject(parent)
{
}

static QList<Checkpoint::Record> readCheckpoints(const QString &workspace)
{
    return Checkpoint::readAll(workspace);
}

void BuildStore::readBuildState(const QString &workspace, QJSValue callback)
{
    if (workspace.isEmpty()) {
        Js::reply(this, callback, null());
        return;
    }
    // parseBuildState treats absent, corrupt, wrong-version and empty alike:
    // there is no build here. A malformed file must not stop a workspace from
    // opening - that would make resuming worse than not having it.
    QString raw;
    if (!NodeCompat::readText(buildStatePath(workspace), &raw)) {
        Js::reply(this, callback, null());
        return;
    }
    const auto state = BuildState::parseText(raw);
    Js::reply(this, callback, state ? NodeCompat::toVariant(*state) : null());
}

/*
 * Save the build so closing the app does not lose the plan.
 *
 * Written whole rather than merged. The run manifest merges because it has a
 * field the user edits; this file has none, and merging would be a way to keep
 * a status that is no longer true.
 */
void BuildStore::writeBuildState(const QVariantMap &payloadMap, QJSValue callback)
{
    const QJsonObject payload = NodeCompat::fromVariant(payloadMap).toObject();
    const QString workspace = NodeCompat::str(payload.value(QStringLiteral("workspace")));
    if (!NodeCompat::truthy(payload.value(QStringLiteral("workspace")))) {
        Js::reply(this, callback, fail(QStringLiteral("no workspace")));
        return;
    }
    const QJsonValue plan = payload.value(QStringLiteral("plan"));
    const QJsonValue steps = payload.value(QStringLiteral("steps"));
    const QJsonObject state = BuildState::serialise(NodeCompat::truthy(plan) ? plan : QJsonValue(QJsonValue::Null),
                                                    NodeCompat::truthy(steps) ? steps : QJsonValue(QJsonArray()),
                                                    payload.value(QStringLiteral("provider")),
                                                    payload.value(QStringLiteral("startedAt")));
    const QString file = buildStatePath(workspace);
    QString error;
    if (!NodeCompat::mkdirs(QFileInfo(file).absolutePath(), &error)
        || !NodeCompat::writeText(file, NodeCompat::stringify(state, BuildState::keyOrder()) + QLatin1Char('\n'), &error)) {
        // A build must not fail because its bookkeeping could not be written -
        // a read-only workspace should cost the resume, not the run.
        Js::reply(this, callback, fail(errorString(error)));
        return;
    }
    Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), true},
                                          {QStringLiteral("startedAt"), state.value(QStringLiteral("startedAt")).toVariant()}});
}

/*
 * Drop the checkpoints for a build that is being replaced.
 *
 * A checkpoint is addressed by step number. Keeping last week's alongside a new
 * plan means "roll back to step 4" could restore a file from a build that has
 * nothing to do with this one - and it would look like it worked.
 */
void BuildStore::clearCheckpoints(const QString &workspace, QJSValue callback)
{
    if (!workspace.isEmpty()) {
        const QString dir = checkpointDir(workspace);
        const QFileInfo info(dir);
        bool ok = true;
        if (info.isDir() && !info.isSymLink())
            ok = QDir(dir).removeRecursively();
        else if (info.exists() || info.isSymLink())
            ok = QFile::remove(dir);
        if (!ok) {
            Js::reply(this, callback, fail(errorString(QStringLiteral("EACCES: permission denied, rm '%1'").arg(dir))));
            return;
        }
    }
    Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), true}});
}

void BuildStore::clearBuildState(const QString &workspace, QJSValue callback)
{
    QString error;
    if (!workspace.isEmpty() && !NodeCompat::removeFile(buildStatePath(workspace), &error)) {
        Js::reply(this, callback, fail(errorString(error)));
        return;
    }
    Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), true}});
}

/*
 * How far along each remembered workspace is.
 *
 * One call for the whole list rather than one per entry: the rail redraws on
 * every switch, and eight round-trips to render eight lines is waste.
 *
 * A path that is gone reports missing rather than absent. A deleted folder and
 * a folder never built in are different situations, and telling them apart is
 * the difference between "I moved that" and "the app lost my project".
 */
void BuildStore::workspaceProgress(const QStringList &paths, QJSValue callback)
{
    QVariantMap out;
    for (const QString &ws : paths) {
        if (ws.trimmed().isEmpty())
            continue;
        if (!QFileInfo::exists(ws)) {
            out.insert(ws, QVariantMap{{QStringLiteral("missing"), true}});
            continue;
        }
        QString raw;
        // Present but with no readable build: a real workspace nobody has built
        // in yet, which is not an error.
        const auto state = NodeCompat::readText(buildStatePath(ws), &raw) ? BuildState::parseText(raw) : std::nullopt;
        out.insert(ws, state ? BuildState::describeProgress(state).toVariantMap() : null());
    }
    Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), true}, {QStringLiteral("progress"), out}});
}

/*
 * What rolling back to before `toStep` would do, without doing any of it.
 *
 * Split from the apply deliberately: the renderer shows the drifted files and
 * waits for an answer, and a plan computed twice could differ from the one the
 * user agreed to. The plan it confirms is the plan that runs.
 */
void BuildStore::planRollback(const QString &workspace, int toStep, QJSValue callback)
{
    if (workspace.isEmpty()) {
        Js::reply(this, callback, fail(QStringLiteral("no workspace")));
        return;
    }
    const QList<Checkpoint::Record> checkpoints = readCheckpoints(workspace);
    if (checkpoints.isEmpty()) {
        Js::reply(this, callback, fail(QStringLiteral("nothing recorded for this build yet")));
        return;
    }

    // Only the files the plan would touch are read, so a large workspace costs
    // nothing here.
    QStringList touched;
    for (const Checkpoint::Record &cp : checkpoints) {
        if (cp.step < toStep)
            continue;
        for (auto it = cp.files.begin(); it != cp.files.end(); ++it) {
            if (!touched.contains(it.key()))
                touched << it.key();
        }
    }
    Checkpoint::Current current;
    for (const QString &rel : touched) {
        QString text;
        if (NodeCompat::readText(QDir(workspace).filePath(rel), &text))
            current.insert(rel, text);
        else
            current.insert(rel, std::nullopt);
    }
    const QJsonObject plan = Checkpoint::planRollback(checkpoints, toStep, current);
    Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), true}, {QStringLiteral("plan"), NodeCompat::toVariant(plan)}});
}

/*
 * Put the workspace back to just before a step.
 *
 * Restores before removing, so a failure part-way leaves files present rather
 * than a project with holes in it. Every path is resolved and checked against
 * the workspace root: a checkpoint is a file on disk, and one that had been
 * edited to say "../../.bashrc" must not be able to write there.
 */
void BuildStore::applyRollback(const QString &workspace, const QVariantMap &planMap, QJSValue callback)
{
    // A null plan arrives from QML as an empty map.
    const QJsonValue plan = NodeCompat::fromVariant(planMap);
    if (workspace.isEmpty() || planMap.isEmpty()) {
        Js::reply(this, callback, fail(QStringLiteral("no plan")));
        return;
    }
    auto inside = [&workspace](const QString &rel) { return Workspace::inside(workspace, rel); };

    QStringList restored;
    QStringList removed;
    QStringList refused;

    const QJsonObject restore = plan.toObject().value(QStringLiteral("restore")).toObject();
    for (auto it = restore.begin(); it != restore.end(); ++it) {
        const QString rel = it.key();
        const QString abs = inside(rel);
        if (abs.isEmpty()) {
            refused << rel;
            continue;
        }
        if (!it.value().isString()) {
            Js::reply(this, callback, fail(QStringLiteral("TypeError [ERR_INVALID_ARG_TYPE]: The \"data\" argument must be of type string or an instance of Buffer, TypedArray, or DataView.")));
            return;
        }
        QString error;
        if (!NodeCompat::mkdirs(QFileInfo(abs).absolutePath(), &error) || !NodeCompat::writeText(abs, it.value().toString(), &error)) {
            Js::reply(this, callback, fail(errorString(error)));
            return;
        }
        restored << rel;
    }
    for (const QJsonValue &v : plan.toObject().value(QStringLiteral("remove")).toArray()) {
        const QString rel = v.toString();
        const QString abs = inside(rel);
        if (abs.isEmpty()) {
            refused << rel;
            continue;
        }
        if (NodeCompat::removeFile(abs))
            removed << rel;
    }

    // The checkpoints for the undone steps go too: they describe a history that
    // no longer happened, and keeping them would let a second rollback restore
    // a state that was already rolled back.
    const double toStep = NodeCompat::toNumber(plan.toObject().value(QStringLiteral("toStep")));
    for (const Checkpoint::Record &cp : readCheckpoints(workspace)) {
        if (cp.step < toStep)
            continue;
        NodeCompat::removeFile(QDir(checkpointDir(workspace)).filePath(Checkpoint::checkpointName(cp.step)));
    }

    Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), true},
                                          {QStringLiteral("restored"), restored},
                                          {QStringLiteral("removed"), removed},
                                          {QStringLiteral("refused"), refused}});
}

void BuildStore::readManifest(const QString &workspace, QJSValue callback)
{
    // Absent and corrupt both mean "no manifest". A malformed file must not
    // stop the panel from loading.
    QJsonValue manifest;
    if (workspace.isEmpty() || !readJson(manifestPath(workspace), &manifest)) {
        Js::reply(this, callback, null());
        return;
    }
    Js::reply(this, callback, NodeCompat::toVariant(manifest));
}

/*
 * Write the manifest and the scripts beside it.
 *
 * The scripts are regenerated every time, so they cannot drift from the
 * manifest the app actually reads.
 */
void BuildStore::writeManifest(const QVariantMap &payloadMap, QJSValue callback)
{
    const QJsonObject payload = NodeCompat::fromVariant(payloadMap).toObject();
    const QString workspace = NodeCompat::str(payload.value(QStringLiteral("workspace")));
    if (workspace.isEmpty()) {
        // path.join(undefined, ...) throws in Node.
        Js::reply(this, callback, fail(QStringLiteral("TypeError [ERR_INVALID_ARG_TYPE]: The \"path\" argument must be of type string. Received undefined")));
        return;
    }
    QJsonValue existing(QJsonValue::Null);
    readJson(manifestPath(workspace), &existing);
    const QJsonObject merged = RunManifest::merge(existing, payload.value(QStringLiteral("run")),
                                                  NodeCompat::truthy(payload.value(QStringLiteral("userEdited"))),
                                                  payload.value(QStringLiteral("install")),
                                                  payload.value(QStringLiteral("language")));
    QString error;
    if (!NodeCompat::writeText(manifestPath(workspace), NodeCompat::stringify(merged, RunManifest::keyOrder()) + QLatin1Char('\n'), &error)) {
        Js::reply(this, callback, fail(errorString(error)));
        return;
    }

    const QString sh = QDir(workspace).filePath(QStringLiteral("run.sh"));
    if (!NodeCompat::writeText(sh, RunManifest::renderRunScript(merged, false), &error)) {
        Js::reply(this, callback, fail(errorString(error)));
        return;
    }
    // chmod is meaningless on Windows.
    QFile::setPermissions(sh, QFile::ReadOwner | QFile::WriteOwner | QFile::ExeOwner | QFile::ReadGroup | QFile::ExeGroup
                              | QFile::ReadOther | QFile::ExeOther);
    if (!NodeCompat::writeText(QDir(workspace).filePath(QStringLiteral("run.bat")), RunManifest::renderRunScript(merged, true), &error)) {
        Js::reply(this, callback, fail(errorString(error)));
        return;
    }

    Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), true}, {QStringLiteral("manifest"), NodeCompat::toVariant(merged)}});
}
