#include "BuildRules.h"

#include "NodeCompat.h"

#include <QCryptographicHash>
#include <QDateTime>
#include <QDir>
#include <QJsonArray>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QSet>

#include <algorithm>
#include <cmath>

using NodeCompat::str;
using NodeCompat::truthy;

namespace {

const QStringList kStatuses = {
    QStringLiteral("pending"), QStringLiteral("running"), QStringLiteral("done"),
    QStringLiteral("failed"), QStringLiteral("blocked"), QStringLiteral("skipped"),
};

/* obj[key] as JavaScript reads it: undefined for anything that is not an object. */
QJsonValue prop(const QJsonValue &obj, const QString &key)
{
    return obj.isObject() ? obj.toObject().value(key) : QJsonValue(QJsonValue::Undefined);
}

bool isObjectLike(const QJsonValue &v)
{
    // typeof v === "object" && v !== null: arrays count, as they do in JS.
    return v.isObject() || v.isArray();
}

/*
 * A step's status, as it should be read back.
 *
 * "running" becomes "pending" deliberately. A step that was running when the
 * app closed is not running now, and restoring it as such would seed the
 * scheduler with a step it waits on forever.
 */
QString readStatus(const QJsonValue &v)
{
    if (v.isString() && v.toString() == QLatin1String("running"))
        return QStringLiteral("pending");
    return v.isString() && kStatuses.contains(v.toString()) ? v.toString() : QStringLiteral("pending");
}

/*
 * Timing as it should be stored, or absent.
 *
 * Every number is re-checked rather than trusted: this round-trips through JSON
 * on disk that a person can edit, and a NaN reaching formatDuration would put
 * "NaNms" in the report.
 */
QJsonValue readTiming(const QJsonValue &v)
{
    if (!isObjectLike(v))
        return QJsonValue(QJsonValue::Undefined);
    const double total = NodeCompat::toNumber(prop(v, QStringLiteral("totalMs")));
    if (!std::isfinite(total) || total < 0)
        return QJsonValue(QJsonValue::Undefined);
    QJsonObject phases;
    const QJsonValue src = prop(v, QStringLiteral("phases"));
    if (src.isObject()) {
        const QJsonObject o = src.toObject();
        for (auto it = o.begin(); it != o.end(); ++it) {
            const double n = NodeCompat::toNumber(it.value());
            if (std::isfinite(n) && n > 0)
                phases.insert(it.key(), NodeCompat::round(n));
        }
    } else if (src.isArray()) {
        const QJsonArray a = src.toArray();
        for (qsizetype i = 0; i < a.size(); ++i) {
            const double n = NodeCompat::toNumber(a.at(i));
            if (std::isfinite(n) && n > 0)
                phases.insert(QString::number(i), NodeCompat::round(n));
        }
    }
    return QJsonObject{{QStringLiteral("totalMs"), NodeCompat::round(total)}, {QStringLiteral("phases"), phases}};
}

QJsonArray stringsOnly(const QJsonValue &v)
{
    QJsonArray out;
    if (!v.isArray())
        return out;
    for (const QJsonValue &f : v.toArray()) {
        if (f.isString())
            out.append(f);
    }
    return out;
}

QJsonObject readStep(const QJsonValue &s)
{
    QJsonObject step;
    step.insert(QStringLiteral("title"), str(prop(s, QStringLiteral("title"))));
    step.insert(QStringLiteral("detail"), str(prop(s, QStringLiteral("detail"))));
    step.insert(QStringLiteral("files"), stringsOnly(prop(s, QStringLiteral("files"))));
    // Carried across on purpose. Losing it here would do to a resumed build
    // exactly what dropping it in setPlan did to every build: turn a declared
    // graph back into a chain, so one failure blocks everything behind it.
    const QJsonValue deps = prop(s, QStringLiteral("dependsOn"));
    if (deps.isArray())
        step.insert(QStringLiteral("dependsOn"), deps);
    if (prop(s, QStringLiteral("testable")) == QJsonValue(true))
        step.insert(QStringLiteral("testable"), true);
    const QJsonValue timing = readTiming(prop(s, QStringLiteral("timing")));
    if (!timing.isUndefined())
        step.insert(QStringLiteral("timing"), timing);
    step.insert(QStringLiteral("status"), readStatus(prop(s, QStringLiteral("status"))));
    return step;
}

QString clean(const QJsonValue &v)
{
    return v.isString() ? v.toString().trimmed() : QString();
}

}

namespace BuildState {

QStringList keyOrder()
{
    return {QStringLiteral("version"), QStringLiteral("summary"), QStringLiteral("runCommand"),
            QStringLiteral("provider"), QStringLiteral("startedAt"), QStringLiteral("updatedAt"),
            QStringLiteral("steps"), QStringLiteral("title"), QStringLiteral("detail"),
            QStringLiteral("files"), QStringLiteral("dependsOn"), QStringLiteral("testable"),
            QStringLiteral("timing"), QStringLiteral("totalMs"), QStringLiteral("phases"),
            QStringLiteral("status")};
}

QJsonObject serialise(const QJsonValue &plan, const QJsonValue &steps, const QJsonValue &provider,
                      const QJsonValue &startedAt, const QString &nowArg)
{
    const QString now = !nowArg.isEmpty() ? nowArg
                                          : QDateTime::currentDateTimeUtc().toString(Qt::ISODateWithMs);
    QJsonObject state;
    state.insert(QStringLiteral("version"), 1);
    state.insert(QStringLiteral("summary"), str(prop(plan, QStringLiteral("summary"))));
    const QString runCommand = str(prop(plan, QStringLiteral("runCommand")));
    if (!runCommand.isEmpty())
        state.insert(QStringLiteral("runCommand"), runCommand);
    if (truthy(provider))
        state.insert(QStringLiteral("provider"), provider);
    state.insert(QStringLiteral("startedAt"), truthy(startedAt) ? startedAt : QJsonValue(now));
    state.insert(QStringLiteral("updatedAt"), now);
    QJsonArray out;
    if (steps.isArray()) {
        for (const QJsonValue &s : steps.toArray())
            out.append(readStep(s));
    }
    state.insert(QStringLiteral("steps"), out);
    return state;
}

std::optional<QJsonObject> parse(const QJsonValue &obj)
{
    if (!obj.isObject())
        return std::nullopt;
    const QJsonObject o = obj.toObject();
    if (o.value(QStringLiteral("version")) != QJsonValue(1))
        return std::nullopt;
    const QJsonValue steps = o.value(QStringLiteral("steps"));
    if (!steps.isArray() || steps.toArray().isEmpty())
        return std::nullopt;

    QJsonArray out;
    for (const QJsonValue &s : steps.toArray()) {
        if (!isObjectLike(s))
            return std::nullopt;
        out.append(readStep(s));
    }

    QJsonObject state;
    state.insert(QStringLiteral("version"), 1);
    state.insert(QStringLiteral("summary"), str(o.value(QStringLiteral("summary"))));
    const QString runCommand = str(o.value(QStringLiteral("runCommand")));
    if (!runCommand.isEmpty())
        state.insert(QStringLiteral("runCommand"), runCommand);
    const QString provider = str(o.value(QStringLiteral("provider")));
    if (!provider.isEmpty())
        state.insert(QStringLiteral("provider"), provider);
    state.insert(QStringLiteral("startedAt"), str(o.value(QStringLiteral("startedAt"))));
    state.insert(QStringLiteral("updatedAt"), str(o.value(QStringLiteral("updatedAt"))));
    state.insert(QStringLiteral("steps"), out);
    return state;
}

std::optional<QJsonObject> parseText(const QString &raw)
{
    QJsonParseError err;
    const QJsonDocument doc = QJsonDocument::fromJson(raw.toUtf8(), &err);
    if (err.error != QJsonParseError::NoError || !doc.isObject())
        return std::nullopt;
    return parse(doc.object());
}

QJsonObject describeProgress(const std::optional<QJsonObject> &state)
{
    const QJsonArray steps = state ? state->value(QStringLiteral("steps")).toArray() : QJsonArray();
    int done = 0;
    for (const QJsonValue &s : steps) {
        const QString status = s.toObject().value(QStringLiteral("status")).toString();
        if (status == QLatin1String("done") || status == QLatin1String("skipped"))
            ++done;
    }
    const int total = int(steps.size());
    return {{QStringLiteral("done"), done}, {QStringLiteral("total"), total},
            {QStringLiteral("unfinished"), total > 0 && done < total}};
}

}

namespace Checkpoint {

QString hash(const QString &text)
{
    return QString::fromLatin1(QCryptographicHash::hash(text.toUtf8(), QCryptographicHash::Sha1).toHex().left(16));
}

QString checkpointName(int step)
{
    return QStringLiteral("step-") + QStringLiteral("%1").arg(step + 1, 3, 10, QLatin1Char('0')) + QStringLiteral(".json");
}

/* Absent, corrupt or wrong-version all read as "no checkpoint for this step". */
std::optional<Record> parse(const QString &raw)
{
    QJsonParseError err;
    const QJsonDocument doc = QJsonDocument::fromJson(raw.toUtf8(), &err);
    if (err.error != QJsonParseError::NoError || !doc.isObject())
        return std::nullopt;
    const QJsonObject o = doc.object();
    if (o.value(QStringLiteral("version")) != QJsonValue(1))
        return std::nullopt;
    const QJsonValue step = o.value(QStringLiteral("step"));
    if (!step.isDouble())
        return std::nullopt;
    const double n = step.toDouble();
    if (!std::isfinite(n) || std::floor(n) != n || n < 0)
        return std::nullopt;
    const QJsonValue files = o.value(QStringLiteral("files"));
    if (!files.isObject())
        return std::nullopt;

    Record cp;
    cp.step = int(n);
    const QJsonObject fo = files.toObject();
    for (auto it = fo.begin(); it != fo.end(); ++it) {
        const QJsonValue e = it.value();
        if (!isObjectLike(e))
            continue;
        Entry entry;
        const QJsonValue prior = prop(e, QStringLiteral("prior"));
        const QJsonValue after = prop(e, QStringLiteral("after"));
        if (prior.isString())
            entry.prior = prior.toString();
        if (after.isString())
            entry.after = after.toString();
        entry.tooLarge = truthy(prop(e, QStringLiteral("tooLarge")));
        cp.files.insert(it.key(), entry);
    }
    const QJsonValue title = o.value(QStringLiteral("title"));
    if (title.isString())
        cp.title = title.toString();
    cp.at = str(o.value(QStringLiteral("at")));
    return cp;
}

/*
 * What returning the workspace to just before `toStep` would take.
 *
 * Undoing a step means undoing everything after it too. Replaying the undos in
 * reverse is the same as taking, for each path, the record from the EARLIEST
 * step that touched it - that step's `prior` is by definition the state before
 * `toStep`. Drift is judged against the LATEST step to touch the file, which
 * holds what the build actually left there.
 *
 * A path missing from `current` is treated as not knowing, and no drift is
 * claimed: inventing one would block a rollback over a file nobody looked at.
 */
QJsonObject planRollback(QList<Record> checkpoints, double toStep, const Current &current)
{
    QList<Record> relevant;
    for (const Record &c : checkpoints) {
        if (c.step >= toStep)
            relevant << c;
    }
    std::stable_sort(relevant.begin(), relevant.end(), [](const Record &a, const Record &b) { return a.step < b.step; });

    QMap<QString, Entry> earliest;
    QMap<QString, Entry> latest;
    for (const Record &cp : relevant) {
        for (auto it = cp.files.begin(); it != cp.files.end(); ++it) {
            if (!earliest.contains(it.key()))
                earliest.insert(it.key(), it.value());
            latest.insert(it.key(), it.value());
        }
    }

    QJsonObject restore;
    QJsonArray remove;
    QStringList drifted;
    QJsonArray unrestorable;
    for (auto it = earliest.begin(); it != earliest.end(); ++it) {
        const QString &p = it.key();
        const Entry &first = it.value();
        if (first.tooLarge)
            unrestorable.append(p);
        else if (!first.prior)
            remove.append(p);
        else
            restore.insert(p, *first.prior);

        const Entry &left = latest[p];
        if (left.after && current.contains(p)) {
            // A file the build wrote and that no longer matches has been edited
            // since - or deleted. Either way the user should be told before it goes.
            const std::optional<QString> &now = current[p];
            if (!now || hash(*now) != *left.after)
                drifted << p;
        }
    }
    drifted.sort();

    QJsonArray steps;
    for (const Record &c : relevant)
        steps.append(c.step);
    return {
        {QStringLiteral("toStep"), std::isnan(toStep) ? QJsonValue(QJsonValue::Undefined) : QJsonValue(toStep)},
        {QStringLiteral("steps"), steps},
        {QStringLiteral("restore"), restore},
        {QStringLiteral("remove"), remove},
        {QStringLiteral("drifted"), QJsonArray::fromStringList(drifted)},
        {QStringLiteral("unrestorable"), unrestorable},
    };
}

QString dirFor(const QString &workspace)
{
    return QDir(workspace).filePath(BuildState::kDir + QLatin1Char('/') + kDir);
}

QList<Record> readAll(const QString &workspace)
{
    const QDir dir(dirFor(workspace));
    if (!dir.exists())
        return {};
    QList<Record> out;
    const QStringList names = dir.entryList(QDir::AllEntries | QDir::Hidden | QDir::System | QDir::NoDotAndDotDot);
    for (const QString &n : names) {
        if (!n.endsWith(QLatin1String(".json")))
            continue;
        QString raw;
        // A corrupt checkpoint is one step that cannot be undone.
        if (!NodeCompat::readText(dir.filePath(n), &raw))
            continue;
        if (const auto cp = parse(raw))
            out << *cp;
    }
    std::stable_sort(out.begin(), out.end(), [](const Record &a, const Record &b) { return a.step < b.step; });
    return out;
}

}

namespace Workspace {

QString inside(const QString &root, const QString &rel)
{
    const QString base = QDir::cleanPath(QDir(root).absolutePath());
    const QString abs = QDir::cleanPath(QDir(base).absoluteFilePath(rel));
    const QString r = QDir(base).relativeFilePath(abs);
    if (abs == base || r.isEmpty() || r == QLatin1String(".") || r.startsWith(QLatin1String("..")) || QDir::isAbsolutePath(r))
        return QString();
    return abs;
}

}

namespace RunManifest {

QStringList keyOrder()
{
    return {QStringLiteral("version"), QStringLiteral("run"), QStringLiteral("generatedBy"),
            QStringLiteral("userEdited"), QStringLiteral("install"), QStringLiteral("language")};
}

/*
 * Fold a new command into an existing manifest.
 *
 * A command the user edited is never replaced. Without that rule, correcting a
 * wrong command and then building again would silently undo the correction,
 * which is how people stop trusting a tool.
 */
QJsonObject merge(const QJsonValue &existing, const QJsonValue &run, bool userEdited,
                  const QJsonValue &install, const QJsonValue &language)
{
    const bool existingEdited = truthy(prop(existing, QStringLiteral("userEdited")));
    const bool keepUserRun = existingEdited && !userEdited;
    QJsonObject next;
    next.insert(QStringLiteral("version"), 1);
    if (keepUserRun) {
        next.insert(QStringLiteral("run"), prop(existing, QStringLiteral("run")));
    } else {
        const QString fresh = clean(run);
        next.insert(QStringLiteral("run"), !fresh.isEmpty() ? fresh : clean(prop(existing, QStringLiteral("run"))));
    }
    next.insert(QStringLiteral("generatedBy"), QStringLiteral("CloseNI"));
    if (userEdited || existingEdited)
        next.insert(QStringLiteral("userEdited"), true);
    const QJsonValue inst = truthy(install) ? install : prop(existing, QStringLiteral("install"));
    if (truthy(inst))
        next.insert(QStringLiteral("install"), inst);
    const QJsonValue lang = truthy(language) ? language : prop(existing, QStringLiteral("language"));
    if (truthy(lang))
        next.insert(QStringLiteral("language"), lang);
    return next;
}

/*
 * The script written beside the manifest, so the project runs without this app.
 *
 * The command is emitted verbatim. Quoting or escaping it would mangle
 * something like python3 -c "print(1)" into a script that fails for a reason
 * nobody could see.
 */
QString renderRunScript(const QJsonObject &manifest, bool windows)
{
    const QString install = clean(manifest.value(QStringLiteral("install")));
    const QString run = clean(manifest.value(QStringLiteral("run")));
    QStringList lines;
    if (windows)
        lines << QStringLiteral("@echo off") << QStringLiteral("REM Generated by CloseNI. Edit the command in the app, or here.");
    else
        lines << QStringLiteral("#!/bin/sh") << QStringLiteral("# Generated by CloseNI. Edit the command in the app, or here.")
              << QStringLiteral("set -e");
    if (!install.isEmpty())
        lines << install;
    lines << run << QString();
    return lines.join(windows ? QStringLiteral("\r\n") : QStringLiteral("\n"));
}

}

namespace ExportBranch {

/* Branch names come from a plan summary, which is arbitrary human text. */
QString branchName(const QString &summary)
{
    static const QRegularExpression nonAlnum(QStringLiteral("[^a-z0-9]+"));
    static const QRegularExpression edges(QStringLiteral("^-+|-+$"));
    static const QRegularExpression trailing(QStringLiteral("-+$"));
    QString slug = summary.toLower();
    slug.replace(nonAlnum, QStringLiteral("-"));
    slug.replace(edges, QString());
    slug = slug.left(40);
    slug.replace(trailing, QString());
    return QStringLiteral("closeni/") + (slug.isEmpty() ? QStringLiteral("build") : slug);
}

/* A commit subject that reads usefully in `git log --oneline`. */
QString commitMessage(int step, const QString &title)
{
    static const QRegularExpression space(QStringLiteral("\\s+"), QRegularExpression::UseUnicodePropertiesOption);
    QString clean = title;
    clean.replace(space, QStringLiteral(" "));
    clean = clean.trimmed().left(60);
    return QStringLiteral("step ") + QString::number(step + 1) + QStringLiteral(": ")
        + (clean.isEmpty() ? QStringLiteral("changes") : clean);
}

/*
 * What each commit should contain.
 *
 * A checkpoint records the state BEFORE its step, plus only a hash of what the
 * step left; the content of a file after step N is the `prior` recorded by the
 * NEXT step that touched it. For a file no later step touched, it is what is on
 * disk now. A path the caller did not read is unknown and left out rather than
 * guessed at.
 */
Plan planCommits(QList<Checkpoint::Record> checkpoints, const Checkpoint::Current &current,
                 const QHash<int, QString> &titles)
{
    QList<Checkpoint::Record> steps = checkpoints;
    std::stable_sort(steps.begin(), steps.end(),
                     [](const Checkpoint::Record &a, const Checkpoint::Record &b) { return a.step < b.step; });

    QStringList warnings;
    Plan plan;

    // For each path, the ordered list of steps that touched it. Built once: the
    // naive version rescans every later checkpoint per file per step.
    QMap<QString, QList<int>> touchedAt;
    for (const Checkpoint::Record &cp : steps) {
        for (auto it = cp.files.begin(); it != cp.files.end(); ++it)
            touchedAt[it.key()].append(cp.step);
    }
    QHash<int, Checkpoint::Record> byStep;
    for (const Checkpoint::Record &cp : steps)
        byStep.insert(cp.step, cp);

    // Every path the build touches anywhere, considered at every step. The
    // export refuses a dirty tree, so HEAD already holds every file; staging a
    // file that does not exist yet as a deletion is what keeps step 1's commit
    // from containing a module step 5 created.
    const QStringList allPaths = touchedAt.keys();

    for (const Checkpoint::Record &cp : steps) {
        Commit commit;
        commit.step = cp.step;
        for (const QString &p : allPaths) {
            const bool touched = cp.files.contains(p);
            if (touched && cp.files.value(p).tooLarge)
                warnings << p + QStringLiteral(" was too large to record, so its history is approximate");

            QList<int> later;
            for (int n : touchedAt.value(p)) {
                if (n > cp.step)
                    later << n;
            }
            std::sort(later.begin(), later.end());
            enum { Unknown, Absent, Present } state = Unknown;
            QString after;
            if (!later.isEmpty()) {
                const auto next = byStep.constFind(later.first());
                if (next != byStep.cend() && next->files.contains(p)) {
                    const std::optional<QString> &prior = next->files.value(p).prior;
                    state = prior ? Present : Absent;
                    if (prior)
                        after = *prior;
                }
            } else if (current.contains(p)) {
                const std::optional<QString> &now = current.value(p);
                state = now ? Present : Absent;
                if (now)
                    after = *now;
            }

            if (state == Unknown) {
                // Unknown rather than absent. Deleting a file because we failed
                // to read it would turn an export into data loss.
                if (touched)
                    warnings << p + QStringLiteral(" could not be read, so it is left as it is at step ") + QString::number(cp.step + 1);
                continue;
            }
            if (state == Absent)
                commit.deletes << p;
            else
                commit.writes.insert(p, after);
        }
        const QString override = titles.value(cp.step);
        commit.title = !override.isEmpty() ? override : cp.title.value_or(QString());
        commit.deletes.sort();
        plan.commits << commit;
    }

    QSet<QString> seen;
    for (const QString &w : warnings) {
        if (!seen.contains(w)) {
            seen.insert(w);
            plan.warnings << w;
        }
    }
    return plan;
}

}
