#include "AgentService.h"

#include "Js.h"
#include "Paths.h"
#include "Proc.h"

#include <QDateTime>
#include <QDesktopServices>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QPointer>
#include <QRegularExpression>
#include <QTimer>
#include <QUrl>

#include <memory>
#include <utility>
#include <optional>

namespace {

const QString kEventPrefix = QStringLiteral("AGENT_EVENT: ");
const QString kSessionPrefix = QStringLiteral("SESSION_EVENT: ");

/* A value from QML as plain data: a JS object nested in a map can arrive wrapped. */
QVariant plain(const QVariant &v)
{
    if (v.metaType() == QMetaType::fromType<QJSValue>())
        return v.value<QJSValue>().toVariant();
    return v;
}

/* JavaScript truthiness, for the payload fields main.js tested with `if (x)`. */
bool truthy(const QVariant &raw)
{
    const QVariant v = plain(raw);
    if (!v.isValid() || v.isNull())
        return false;
    switch (v.typeId()) {
    case QMetaType::Bool:
        return v.toBool();
    case QMetaType::QString:
        return !v.toString().isEmpty();
    case QMetaType::Int:
    case QMetaType::UInt:
    case QMetaType::LongLong:
    case QMetaType::ULongLong:
    case QMetaType::Double:
    case QMetaType::Float: {
        const double d = v.toDouble();
        return d != 0 && d == d;
    }
    default:
        return true;
    }
}

/* String(x) as JavaScript writes it, so an argument reads the same as before. */
QString jsString(const QVariant &raw)
{
    const QVariant v = plain(raw);
    if (!v.isValid())
        return QStringLiteral("undefined");
    if (v.isNull() && v.typeId() != QMetaType::QString)
        return QStringLiteral("null");
    if (v.typeId() == QMetaType::Bool)
        return v.toBool() ? QStringLiteral("true") : QStringLiteral("false");
    return v.toString();
}

/* `x || fallback` for a string field. */
QString orString(const QVariant &v, const QString &fallback)
{
    return truthy(v) ? jsString(v) : fallback;
}

QByteArray compactJson(const QVariant &v)
{
    return QJsonDocument::fromVariant(plain(v)).toJson(QJsonDocument::Compact);
}

QByteArray jsonLine(const QVariantMap &msg)
{
    return QJsonDocument(QJsonObject::fromVariantMap(msg)).toJson(QJsonDocument::Compact) + '\n';
}

std::optional<QVariantMap> parseObject(const QString &text)
{
    QJsonParseError err;
    const QJsonDocument doc = QJsonDocument::fromJson(text.toUtf8(), &err);
    if (err.error != QJsonParseError::NoError || !doc.isObject())
        return std::nullopt;
    return doc.object().toVariantMap();
}

/*
 * The result a one-shot run printed: the last JSON line between
 * AGENT_OUTPUT_START and AGENT_OUTPUT_END, as every handler in main.js read it.
 */
std::optional<QVariantMap> outputBlock(const QByteArray &output)
{
    const qsizetype start = output.indexOf("AGENT_OUTPUT_START");
    const qsizetype end = output.indexOf("AGENT_OUTPUT_END");
    if (start == -1 || end == -1)
        return std::nullopt;
    // substring() swaps its arguments when the end comes first.
    qsizetype a = start + 18;
    qsizetype b = end;
    if (b < a)
        std::swap(a, b);
    static const QRegularExpression newline(QStringLiteral("\\r?\\n"));
    const QStringList lines = QString::fromUtf8(output.mid(a, b - a)).split(newline);
    QString last;
    for (const QString &l : lines) {
        const QString t = l.trimmed();
        if (t.startsWith(u'{'))
            last = t;
    }
    if (last.isEmpty())
        return std::nullopt;
    return parseObject(last);
}

QString nodeError()
{
    return QObject::tr("Node was not found. Install Node 22 or set CLOSENI_NODE.");
}

/* browser-check.js hasChromium: only a full chromium can show a login page. */
bool hasChromium(const QStringList &entries)
{
    static const QRegularExpression chromium(QStringLiteral("^chromium-\\d+$"));
    for (const QString &e : entries) {
        if (chromium.match(e).hasMatch())
            return true;
    }
    return false;
}

/*
 * browser-check.js describeInstallFailure: why a browser download failed, in
 * one line a person can act on.
 *
 * The installer retries, then ends on "Failed to install browsers" and
 * "Download failure, code=1" - which say nothing. The specific reason comes
 * first and gets buried: a 403, a DNS failure, a full disk. Reporting only the
 * exit code left someone behind a proxy with no way to tell a firewall from a
 * broken build.
 */
QString describeInstallFailure(const QString &output, const QString &code)
{
    static const QRegularExpression newline(QStringLiteral("\\r?\\n"));
    static const QRegularExpression generic(
        QStringLiteral("^(Failed to install browsers|Error: Failed to download |Error: Download failure, code=)"));
    static const QRegularExpression errorHead(QStringLiteral("^Error:\\s*(Download failed:\\s*)?"));
    static const QRegularExpression blockedRe(
        QStringLiteral("\\b(403|407|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|blocked|proxy)\\b"),
        QRegularExpression::CaseInsensitiveOption);
    QString reason;
    bool found = false;
    for (const QString &raw : Proc::stripAnsi(output).split(newline)) {
        const QString l = raw.trimmed();
        // "Error: Download failed: server returned..." - the head below already
        // says the download failed, so only what follows is kept.
        if (l.startsWith(QStringLiteral("Error:")) && !generic.match(l).hasMatch()) {
            reason = l;
            reason.remove(errorHead);
            found = true;
            break;
        }
    }
    const QString head = QStringLiteral("Download failed (exit ") + code + QStringLiteral(")");
    if (!found)
        return head + QStringLiteral(". Check the connection and try again.");
    if (reason.size() > 240)
        reason = reason.left(237) + QStringLiteral("...");
    // Blocked by the network rather than broken: say where the file comes from,
    // because that is the one thing an administrator needs to allow.
    const bool blocked = blockedRe.match(reason).hasMatch();
    return head + QStringLiteral(": ") + reason
        + (blocked ? QStringLiteral(" The browser downloads from cdn.playwright.dev - a proxy or firewall has to allow it.") : QString());
}

}

AgentService::AgentService(QObject *parent)
    : QObject(parent)
{
}

AgentService::~AgentService()
{
    // Quitting the app ends the sessions the way their panels would, so the
    // browser profile is not left locked; a session that will not stop is killed.
    QList<QProcess *> sessions;
    for (QProcess *p : {m_codeProc, m_sessionProc}) {
        if (p && p->state() != QProcess::NotRunning) {
            disconnect(p, nullptr, this, nullptr);
            p->write(jsonLine({{QStringLiteral("type"), QStringLiteral("close")}}));
            sessions.append(p);
        }
    }
    // Every other run (the one-shot holding the profile, and the ones that do
    // not: the account check, health, the browser install) is stopped too, so
    // none outlives the app or is destroyed while still running.
    const auto children = findChildren<QProcess *>(Qt::FindDirectChildrenOnly);
    for (QProcess *p : children) {
        if (p == m_codeProc || p == m_sessionProc || p->state() == QProcess::NotRunning)
            continue;
        disconnect(p, nullptr, this, nullptr);
        Proc::terminate(p);
        sessions.append(p);
    }
    for (QProcess *p : sessions) {
        if (!p->waitForFinished(5000)) {
            p->kill();
            p->waitForFinished(1000);
        }
    }
}

AgentService::Reply AgentService::replier(const QJSValue &callback)
{
    QPointer<AgentService> self(this);
    return [self, callback](const QVariant &result) {
        if (self)
            Js::reply(self, callback, result);
    };
}

QString AgentService::spawnCwd() const
{
    // A real directory to spawn children in: the one holding local-agent/,
    // the checkout in development and the resources directory when bundled.
    const QString agent = Paths::agentPath();
    if (agent.isEmpty())
        return QDir::homePath();
    return QDir::cleanPath(QFileInfo(agent).dir().absoluteFilePath(QStringLiteral("../..")));
}

QString AgentService::browsersDir() const
{
    return QDir(Paths::storageRoot()).filePath(QStringLiteral("browsers"));
}

/*
 * Spawn the agent: configured, not started, so the caller can connect first.
 *
 * One helper for every call site, so a fix cannot reach three of them and miss
 * the fourth. The storage root goes in the environment: the agent is a
 * separate process and has no other way to learn where the app may write.
 */
QProcess *AgentService::spawnAgent(const QStringList &args, const Env &extraEnv, QString *error)
{
    const QString node = Paths::nodePath();
    const QString agent = Paths::agentPath();
    if (node.isEmpty()) {
        *error = nodeError();
        return nullptr;
    }
    if (agent.isEmpty()) {
        *error = tr("The agent was not found. Run `npm run build`, or set CLOSENI_AGENT.");
        return nullptr;
    }
    QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    env.insert(QStringLiteral("CLOSENI_STORAGE"), Paths::storageRoot());
    for (auto it = extraEnv.cbegin(); it != extraEnv.cend(); ++it)
        env.insert(it.key(), it.value());
    // Bundled, Playwright must look inside the storage directory. From a
    // checkout it must not, or it stops seeing the browsers already in
    // ~/.cache/ms-playwright and the developer is told to download 389MB they
    // already have.
    if (Paths::agentIsBundled())
        env.insert(QStringLiteral("PLAYWRIGHT_BROWSERS_PATH"), browsersDir());
    auto *proc = new QProcess(this);
    proc->setProcessEnvironment(env);
    proc->setWorkingDirectory(spawnCwd());
    proc->setProgram(node);
    proc->setArguments(QStringList{agent} + args);
    return proc;
}

/*
 * Provider settings ride on the environment rather than the argument list.
 * Every mode opens a conversation and every mode would otherwise need a new
 * positional argument threaded through it; the controller reads this once.
 * The preamble travels the same way.
 *
 * Returns only its own keys - spawnAgent does the merging.
 */
AgentService::Env AgentService::agentEnv(const QString &headed, const QVariant &controls, const QVariant &preamble)
{
    Env env{{QStringLiteral("AGENT_HEADED"), headed}};
    const QVariant c = plain(controls);
    if (c.typeId() == QMetaType::QVariantMap && !c.toMap().isEmpty())
        env.insert(QStringLiteral("AGENT_CONTROLS"), QString::fromUtf8(compactJson(c)));
    const QVariant p = plain(preamble);
    if (p.typeId() == QMetaType::QVariantMap && !p.toMap().isEmpty())
        env.insert(QStringLiteral("AGENT_PREAMBLE"), QString::fromUtf8(compactJson(p)));
    return env;
}

/*
 * One browser profile, one agent at a time.
 *
 * Every agent run calls launchPersistentContext on the same profile directory,
 * and Chromium locks that directory. Start a second run while the first is
 * still generating and it lands on a profile it cannot own: the page comes up
 * empty, the composer never appears, and the run dies with "Chat input not
 * found" - which reads like a broken selector rather than two processes
 * fighting. Observed exactly that way, with a plan launching while a chat was
 * still thinking at 97 seconds.
 *
 * So agent runs queue instead of overlapping. The wait is visible in the log
 * rather than silent, because a run that appears to do nothing for a minute
 * needs to say why.
 *
 * The Code panel's session holds the profile between messages. Anything else
 * that needs the browser gets it: the session yields, and the panel starts a
 * new one - rejoining the same conversation - on its next message.
 */
void AgentService::queueAgentRun(const QString &label, std::function<void(Done)> task)
{
    Q_UNUSED(label);
    m_queue.append(std::move(task));
    pumpQueue();
}

void AgentService::pumpQueue()
{
    if (m_queueBusy || m_queue.isEmpty())
        return;
    m_queueBusy = true;
    auto task = m_queue.takeFirst();
    releaseCode([this, task] {
        // The queue must survive a failed run, or one failure stalls every run
        // after it: each task says when it is over, however it ended.
        auto over = std::make_shared<bool>(false);
        task([this, over] {
            if (*over)
                return;
            *over = true;
            m_queueBusy = false;
            QMetaObject::invokeMethod(this, [this] { pumpQueue(); }, Qt::QueuedConnection);
        });
    });
}

/*
 * A build session holds the profile for as long as the build runs, and it is
 * not in the queue above - it cannot be, because it stays open across many
 * steps. So anything that would open the profile independently is refused
 * while one is live, with a message that says what is happening.
 *
 * Refusing beats queueing here: a chat waiting silently behind a twenty-minute
 * build looks identical to a chat that is broken.
 */
QVariant AgentService::refuseWhileBuilding(const QString &what) const
{
    if (!profileBusy())
        return QVariant();
    return QVariantMap{
        {QStringLiteral("success"), false},
        {QStringLiteral("error"), what + QStringLiteral(" cannot run while a build is using the browser. Stop the build, or wait for it to finish.")},
    };
}

/*
 * A phase is only true while the process that reported it is alive. Without
 * this the rail keeps showing "writing" after a run has exited, which is the
 * one thing a live status must never do.
 */
void AgentService::clearPhase()
{
    emit phase({{QStringLiteral("phase"), QStringLiteral("idle")}, {QStringLiteral("detail"), QString()}});
}

/*
 * One line of the agent's output, to wherever it belongs.
 *
 * The narration is mirrored to this process's stdout as well as the window:
 * when it only went to the log pane, the only way to see why a run misbehaved
 * was to copy the pane by hand, and a run that was still going could not be
 * diagnosed at all. PHASE lines are excluded because they arrive every two
 * seconds and are a live status, not a record.
 */
void AgentService::routeLine(const QString &line)
{
    if (line.trimmed().isEmpty())
        return;
    if (!line.startsWith(QStringLiteral("PHASE:")))
        Proc::mirror(QStringLiteral("[agent] ") + line);
    if (line.startsWith(QStringLiteral("APPROVAL_REQUEST:"))) {
        if (auto obj = parseObject(line.mid(17)))
            emit approvalRequest(*obj);
    } else if (line.startsWith(QStringLiteral("STEP_EVENT:"))) {
        if (auto obj = parseObject(line.mid(11)))
            emit stepEvent(*obj);
    } else if (line.startsWith(QStringLiteral("PHASE:"))) {
        // Kept out of the log pane on purpose: this is a live status, and one
        // line every two seconds would drown the narration it sits next to.
        if (auto obj = parseObject(line.mid(6)))
            emit phase(*obj);
    } else if (line.startsWith(QStringLiteral("AGENT_OUTPUT_START")) || line.startsWith(QStringLiteral("AGENT_OUTPUT_END"))) {
        return;
    } else if (line.startsWith(QStringLiteral("{\"success\""))) {
        return;
    } else if (line.startsWith(QStringLiteral("PROJ|"))) {
        emit projectLog(line.mid(5));
    } else {
        emit log(line);
    }
}

/*
 * A one-shot mode: start, route its output, resolve once with its result.
 * run-agent, suggest, ask-run, sign-in, authcheck and health differ only in
 * the options of `spec`.
 */
void AgentService::runOneShot(const OneShot &spec, const Reply &done)
{
    QString error;
    QProcess *proc = spawnAgent(spec.args, spec.env, &error);
    if (!proc) {
        done(spec.result(QByteArray(), error));
        return;
    }
    if (spec.holdsProfile)
        m_agentProc = proc;

    struct State {
        QByteArray output;
        Proc::LineSplitter lines;
        bool done = false;
    };
    auto st = std::make_shared<State>();

    auto finish = [this, proc, st, spec, done](bool killIt, const QString &startError) {
        if (st->done)
            return;
        st->done = true;
        if (m_agentProc == proc)
            m_agentProc = nullptr;
        if (spec.runAgent)
            clearPhase();
        done(spec.result(st->output, startError));
        if (killIt)
            Proc::terminate(proc);
    };

    auto readOut = [this, proc, st, spec, finish] {
        const QByteArray d = proc->readAllStandardOutput();
        st->output += d;
        if (!spec.route)
            return;
        st->lines.feed(d, [&](const QString &line) {
            routeLine(line);
            // The result is in; whatever the agent does after it (closing a
            // browser that will not close) must not hold the queue.
            if (spec.runAgent && line == QStringLiteral("AGENT_OUTPUT_END"))
                QTimer::singleShot(150, proc, [finish] { finish(true, QString()); });
        });
    };
    connect(proc, &QProcess::readyReadStandardOutput, this, readOut);
    connect(proc, &QProcess::readyReadStandardError, this, [this, proc, spec] {
        const QString chunk = QString::fromUtf8(proc->readAllStandardError());
        if (spec.stderrMode == OneShot::ErrLog)
            emit log(QStringLiteral("[err] ") + chunk);
        else if (spec.stderrMode == OneShot::ErrRoute)
            routeLine(chunk);
    });
    connect(proc, &QProcess::finished, this, [proc, readOut, finish] {
        readOut();
        finish(false, QString());
        proc->deleteLater();
    });
    connect(proc, &QProcess::errorOccurred, this, [proc, finish](QProcess::ProcessError e) {
        // A crash or a kill also arrives through finished(); only a process
        // that never started has nothing else to report it.
        if (e != QProcess::FailedToStart)
            return;
        finish(true, QStringLiteral("Error: ") + proc->errorString());
        proc->deleteLater();
    });
    proc->start();
}

void AgentService::runAgent(const QVariantMap &payload, QJSValue callback)
{
    const Reply done = replier(callback);
    Proc::mirror(QStringLiteral("run-agent called with payload: ") + QString::fromUtf8(compactJson(payload)).left(200));
    // payload.args || payload: the renderer always sends { args, headed, ... }.
    const QVariant argsValue = plain(payload.value(QStringLiteral("args")));
    if (argsValue.typeId() != QMetaType::QVariantList && argsValue.typeId() != QMetaType::QStringList) {
        done(QVariantMap{{QStringLiteral("success"), false}, {QStringLiteral("error"), QStringLiteral("No arguments for the agent.")}});
        return;
    }
    const QVariantList args = argsValue.toList();
    const QString headed = truthy(payload.value(QStringLiteral("headed"))) ? QStringLiteral("1") : QStringLiteral("0");
    const QString label = args.isEmpty() ? QStringLiteral("undefined") : jsString(args.first());
    const QVariant busy = refuseWhileBuilding(label == QStringLiteral("chat") ? QStringLiteral("Chat")
                                              : label == QStringLiteral("plan") ? QStringLiteral("Planning")
                                                                                 : QStringLiteral("That"));
    if (busy.isValid()) {
        done(busy);
        return;
    }
    if (m_agentProc)
        Proc::mirror(QStringLiteral("queued: ") + label + QStringLiteral(" is waiting for the current run to finish"));
    const QVariant controls = payload.value(QStringLiteral("controls"));
    const QVariant preamble = payload.value(QStringLiteral("preamble"));

    queueAgentRun(label, [this, args, headed, controls, preamble, done](Done over) {
        // Long prompts go to temp files, to avoid Windows ENAMETOOLONG.
        QStringList finalArgs;
        for (qsizetype idx = 0; idx < args.size(); ++idx) {
            const QString arg = jsString(args.at(idx));
            if (idx >= 1 && arg.size() > 8000) {
                const QString tmpFile = QDir(QDir::tempPath()).filePath(
                    QStringLiteral("agent-prompt-%1-%2.txt").arg(QDateTime::currentMSecsSinceEpoch()).arg(idx));
                QFile f(tmpFile);
                if (f.open(QIODevice::WriteOnly | QIODevice::Truncate) && f.write(arg.toUtf8()) >= 0) {
                    f.close();
                    finalArgs.append(tmpFile);
                    continue;
                }
            }
            finalArgs.append(arg);
        }
        OneShot spec;
        spec.args = finalArgs;
        spec.env = agentEnv(headed, controls, preamble);
        spec.stderrMode = OneShot::ErrLog;
        spec.runAgent = true;
        spec.result = [](const QByteArray &output, const QString &startError) {
            if (auto r = outputBlock(output))
                return *r;
            // Node or the agent missing: say so rather than "no output".
            if (!startError.isEmpty() && output.isEmpty() && !startError.startsWith(QStringLiteral("Error: ")))
                return QVariantMap{{QStringLiteral("success"), false}, {QStringLiteral("error"), startError}};
            const QString text = QString::fromUtf8(output);
            return QVariantMap{
                {QStringLiteral("success"), false},
                {QStringLiteral("error"), QStringLiteral("No structured output from agent.")},
                {QStringLiteral("raw"), text.mid(qMax<qsizetype>(0, text.size() - 1500))},
            };
        };
        runOneShot(spec, [done, over](const QVariant &r) {
            done(r);
            over();
        });
    });
}

void AgentService::respondApproval(bool approved)
{
    // A build may be running as a long-lived session rather than a per-step
    // process; the reply has to reach whichever one asked.
    QProcess *proc = m_sessionProc ? m_sessionProc : m_agentProc;
    if (proc && proc->state() == QProcess::Running)
        proc->write(jsonLine({{QStringLiteral("approved"), approved}}));
}

namespace {

/* suggest and ask-run: the block, or why there is none. */
QVariantMap blockOrError(const QByteArray &output, const QString &startError)
{
    if (!startError.isEmpty())
        return {{QStringLiteral("success"), false}, {QStringLiteral("error"), startError}};
    if (auto r = outputBlock(output))
        return *r;
    return {{QStringLiteral("success"), false}, {QStringLiteral("error"), QStringLiteral("No structured output from agent.")}};
}

}

void AgentService::suggest(const QVariantMap &payload, QJSValue callback)
{
    const Reply done = replier(callback);
    releaseCode([this, payload, done] {
        OneShot spec;
        spec.args = {QStringLiteral("suggest"), jsString(payload.value(QStringLiteral("workspace"))),
                     jsString(payload.value(QStringLiteral("provider"))), jsString(payload.value(QStringLiteral("stepIndex"))),
                     jsString(payload.value(QStringLiteral("text")))};
        spec.env = agentEnv(truthy(payload.value(QStringLiteral("headed"))) ? QStringLiteral("1") : QStringLiteral("0"),
                            payload.value(QStringLiteral("controls")), payload.value(QStringLiteral("preamble")));
        spec.result = blockOrError;
        runOneShot(spec, done);
    });
}

/*
 * Ask about a run. Same shape as "suggest" - the difference is entirely in what
 * the agent does with it, not in how the process is driven.
 */
void AgentService::askRun(const QVariantMap &payload, QJSValue callback)
{
    const Reply done = replier(callback);
    releaseCode([this, payload, done] {
        OneShot spec;
        spec.args = {QStringLiteral("ask"), jsString(payload.value(QStringLiteral("workspace"))),
                     jsString(payload.value(QStringLiteral("provider"))), jsString(payload.value(QStringLiteral("question"))),
                     orString(payload.value(QStringLiteral("command")), QString()),
                     orString(payload.value(QStringLiteral("output")), QString())};
        spec.env = agentEnv(truthy(payload.value(QStringLiteral("headed"))) ? QStringLiteral("1") : QStringLiteral("0"),
                            payload.value(QStringLiteral("controls")), payload.value(QStringLiteral("preamble")));
        spec.result = blockOrError;
        runOneShot(spec, done);
    });
}

/*
 * The coding agent's session: one long-lived process for the Code panel.
 *
 * It opens the same browser profile as everything else, so it never runs
 * beside a build or a one-off run. A build refuses to start it; anything
 * queued ends it first (see queueAgentRun), and the panel reopens it on its
 * next message.
 */
void AgentService::releaseCode(const Done &then)
{
    if (!m_codeProc) {
        if (m_codeClosing)
            m_codeCloseWaiters.append(then);
        else
            then();
        return;
    }
    QProcess *proc = m_codeProc;
    m_codeProc = nullptr;
    m_codeClosing = true;
    m_codeCloseWaiters.append(then);
    auto settled = std::make_shared<bool>(false);
    auto finish = [this, settled] {
        if (*settled)
            return;
        *settled = true;
        m_codeClosing = false;
        emit codeEvent({{QStringLiteral("type"), QStringLiteral("closed")}});
        const QList<Done> waiters = std::exchange(m_codeCloseWaiters, {});
        for (const Done &w : waiters)
            w();
    };
    connect(proc, &QProcess::finished, this, finish);
    if (proc->state() == QProcess::Running)
        proc->write(jsonLine({{QStringLiteral("type"), QStringLiteral("close")}}));
    // Closing waits for a reply in flight; a stuck page must not hold the app.
    // The process is the kill timer's context, so that timer dies with it.
    QTimer::singleShot(20000, proc, [proc] { Proc::terminate(proc); });
    QTimer::singleShot(25000, this, finish);
}

void AgentService::codeStart(const QVariantMap &payload, QJSValue callback)
{
    const Reply done = replier(callback);
    auto go = [this, payload, done] { codeStartNow(payload, done); };
    if (m_codeClosing)
        m_codeCloseWaiters.append(go);
    else
        go();
}

void AgentService::codeStartNow(const QVariantMap &payload, const Reply &done)
{
    auto fail = [&done](const QString &error) {
        done(QVariantMap{{QStringLiteral("ok"), false}, {QStringLiteral("error"), error}});
    };
    if (m_codeProc) {
        done(QVariantMap{{QStringLiteral("ok"), true}});
        return;
    }
    if (m_sessionProc || m_sessionClosing)
        return fail(QStringLiteral("A build is using the browser. Stop it, or wait for it to finish."));
    if (m_agentProc)
        return fail(QStringLiteral("Something else is using the browser. Try again in a moment."));

    QString error;
    QProcess *proc = spawnAgent({QStringLiteral("agent-session"), jsString(payload.value(QStringLiteral("workspace"))),
                                 orString(payload.value(QStringLiteral("provider")), QStringLiteral("deepseek")),
                                 orString(payload.value(QStringLiteral("mode")), QStringLiteral("default"))},
                                agentEnv(truthy(payload.value(QStringLiteral("headed"))) ? QStringLiteral("1") : QStringLiteral("0"),
                                         payload.value(QStringLiteral("controls")), payload.value(QStringLiteral("preamble"))),
                                &error);
    if (!proc)
        return fail(error);
    m_codeProc = proc;

    struct State {
        Proc::LineSplitter lines;
        bool settled = false;
    };
    auto st = std::make_shared<State>();

    auto readOut = [this, proc, st, done] {
        st->lines.feed(proc->readAllStandardOutput(), [&](const QString &line) {
            if (!line.startsWith(kEventPrefix)) {
                // A failure before the session is ready arrives as the usual
                // output block; it is the reason the panel needs to show. It is
                // no longer the session either: released, so the next start
                // waits for it to exit instead of being told one is already up.
                if (line.startsWith(QStringLiteral("{\"success\"")) && !st->settled) {
                    const auto r = parseObject(line);
                    if (r && r->value(QStringLiteral("success")) == QVariant(false)) {
                        st->settled = true;
                        if (m_codeProc == proc)
                            releaseCode([] {});
                        done(QVariantMap{{QStringLiteral("ok"), false},
                                         {QStringLiteral("error"), orString(r->value(QStringLiteral("error")), QStringLiteral("the agent stopped"))}});
                    }
                }
                routeLine(line);
                return;
            }
            const auto parsed = parseObject(line.mid(kEventPrefix.size()));
            if (!parsed)
                return;
            const QVariantMap &ev = *parsed;
            const QString type = jsString(ev.value(QStringLiteral("type")));
            if (type == QStringLiteral("ready") && !st->settled) {
                st->settled = true;
                QVariantMap r = ev;
                r.insert(QStringLiteral("ok"), true);
                done(r);
            }
            // The chat controller's last phase is "reading - extracting the
            // reply", and nothing after it in the agent loop sets another. Any
            // event past "thinking" means the page has been read, so the bar
            // would otherwise say "extracting" while the agent waits on an
            // approval, or is done. Reasoning arrives while the page is still
            // being watched, so it is not one of them.
            if (type != QStringLiteral("thinking") && type != QStringLiteral("reasoning"))
                clearPhase();
            // Mirrored like routeLine does the narration: these went only to
            // the window, so a run that stalled on a tool could not be diagnosed.
            if (type == QStringLiteral("tool") || type == QStringLiteral("done") || type == QStringLiteral("error")) {
                QString what;
                if (type == QStringLiteral("tool")) {
                    what = jsString(ev.value(QStringLiteral("name"))) + u' ' + orString(ev.value(QStringLiteral("title")), QString())
                        + QStringLiteral(" -> ") + jsString(ev.value(QStringLiteral("status")))
                        + (truthy(ev.value(QStringLiteral("summary"))) ? QStringLiteral(" (") + jsString(ev.value(QStringLiteral("summary"))) + u')' : QString());
                } else if (type == QStringLiteral("done")) {
                    what = QStringLiteral("turn ") + jsString(ev.value(QStringLiteral("reason")))
                        + (truthy(ev.value(QStringLiteral("error"))) ? QStringLiteral(": ") + jsString(ev.value(QStringLiteral("error"))) : QString());
                } else {
                    what = jsString(ev.value(QStringLiteral("message")));
                }
                Proc::mirror(QStringLiteral("[agent] AGENT ") + type + QStringLiteral(": ") + what.left(300));
            }
            emit codeEvent(ev);
        });
    };
    connect(proc, &QProcess::readyReadStandardOutput, this, readOut);
    connect(proc, &QProcess::readyReadStandardError, this, [this, proc] {
        routeLine(QString::fromUtf8(proc->readAllStandardError()));
    });
    connect(proc, &QProcess::finished, this, [this, proc, st, done, readOut] {
        readOut();
        if (m_codeProc == proc) {
            m_codeProc = nullptr;
            emit codeEvent({{QStringLiteral("type"), QStringLiteral("closed")}});
        }
        clearPhase();
        if (!st->settled) {
            st->settled = true;
            done(QVariantMap{{QStringLiteral("ok"), false}, {QStringLiteral("error"), QStringLiteral("the agent exited before it was ready")}});
        }
        proc->deleteLater();
    });
    connect(proc, &QProcess::errorOccurred, this, [this, proc, st, done](QProcess::ProcessError e) {
        if (e != QProcess::FailedToStart)
            return;
        if (m_codeProc == proc)
            m_codeProc = nullptr;
        if (!st->settled) {
            st->settled = true;
            done(QVariantMap{{QStringLiteral("ok"), false}, {QStringLiteral("error"), QStringLiteral("Error: ") + proc->errorString()}});
        }
        proc->deleteLater();
    });
    proc->start();
}

/* Everything the panel sends once the session is up is one JSON line. */
QVariantMap AgentService::codeSendMessage(const QVariantMap &msg)
{
    if (!m_codeProc || m_codeProc->state() != QProcess::Running)
        return {{QStringLiteral("ok"), false}, {QStringLiteral("error"), QStringLiteral("no session")}};
    m_codeProc->write(jsonLine(msg));
    return {{QStringLiteral("ok"), true}};
}

void AgentService::codeSend(const QString &text, QJSValue callback)
{
    Js::reply(this, callback, codeSendMessage({{QStringLiteral("type"), QStringLiteral("user")}, {QStringLiteral("text"), text}}));
}

void AgentService::codePermission(const QString &id, const QString &decision, const QString &feedback, QJSValue callback)
{
    QVariantMap msg{{QStringLiteral("type"), QStringLiteral("permission")}, {QStringLiteral("id"), id}, {QStringLiteral("decision"), decision}};
    // JSON.stringify left an undefined feedback out, and the agent reads an
    // empty one as none.
    if (!feedback.isEmpty())
        msg.insert(QStringLiteral("feedback"), feedback);
    Js::reply(this, callback, codeSendMessage(msg));
}

void AgentService::codeMode(const QString &mode, QJSValue callback)
{
    Js::reply(this, callback, codeSendMessage({{QStringLiteral("type"), QStringLiteral("mode")}, {QStringLiteral("mode"), mode}}));
}

void AgentService::codeInterrupt(QJSValue callback)
{
    Js::reply(this, callback, codeSendMessage({{QStringLiteral("type"), QStringLiteral("interrupt")}}));
}

void AgentService::codeRewind(QJSValue callback)
{
    Js::reply(this, callback, codeSendMessage({{QStringLiteral("type"), QStringLiteral("rewind")}}));
}

void AgentService::codeClear(QJSValue callback)
{
    Js::reply(this, callback, codeSendMessage({{QStringLiteral("type"), QStringLiteral("clear")}}));
}

void AgentService::codeCompact(QJSValue callback)
{
    Js::reply(this, callback, codeSendMessage({{QStringLiteral("type"), QStringLiteral("compact")}}));
}

void AgentService::codeEnd(QJSValue callback)
{
    const Reply done = replier(callback);
    releaseCode([done] { done(QVariant()); });
}

/*
 * The build session.
 *
 * end-session used to forget the process and return at once, so starting
 * another build a moment later spawned a second agent onto a Chromium profile
 * the first one still had open. Both then misbehaved: the dying session's
 * in-flight step failed with "Target page, context or browser has been closed",
 * and the new one reported "no session". Waiting for the old process to
 * actually exit (m_sessionClosing) is what makes back-to-back builds safe.
 */
void AgentService::startSession(const QVariantMap &payload, QJSValue callback)
{
    const Reply done = replier(callback);
    // Let the previous session release the profile before opening it again -
    // the Code panel's included.
    auto go = [this, payload, done] {
        releaseCode([this, payload, done] {
            if (m_sessionProc) {
                done(QVariantMap{{QStringLiteral("ok"), true}});
                return;
            }
            startSessionNow(payload, done);
        });
    };
    if (m_sessionClosing)
        m_sessionCloseWaiters.append(go);
    else
        go();
}

void AgentService::startSessionNow(const QVariantMap &payload, const Reply &done)
{
    const QString headed = truthy(payload.value(QStringLiteral("headed"))) ? QStringLiteral("1") : QStringLiteral("0");
    Env env = agentEnv(headed, payload.value(QStringLiteral("controls")), payload.value(QStringLiteral("preamble")));
    env.insert(QStringLiteral("AGENT_CONCURRENCY"), orString(payload.value(QStringLiteral("concurrency")), QStringLiteral("2")));
    // A resumed build keeps the ledger: the conversation it is rejoining has
    // already been shown these files, and wiping it would re-send the whole
    // project on the step it happens to stop at.
    env.insert(QStringLiteral("AGENT_RESUMING"), truthy(payload.value(QStringLiteral("resuming"))) ? QStringLiteral("1") : QStringLiteral("0"));
    QString error;
    QProcess *proc = spawnAgent({QStringLiteral("build-session"), jsString(payload.value(QStringLiteral("workspace"))),
                                 jsString(payload.value(QStringLiteral("provider"))),
                                 orString(payload.value(QStringLiteral("autonomy")), QStringLiteral("ask"))},
                                env, &error);
    if (!proc) {
        done(QVariantMap{{QStringLiteral("ok"), false}, {QStringLiteral("error"), error}});
        return;
    }
    m_sessionProc = proc;

    struct State {
        Proc::LineSplitter lines;
        bool settled = false;
    };
    auto st = std::make_shared<State>();

    auto readOut = [this, proc, st, done] {
        st->lines.feed(proc->readAllStandardOutput(), [&](const QString &line) {
            if (!line.startsWith(kSessionPrefix)) {
                routeLine(line);
                return;
            }
            const auto ev = parseObject(line.mid(kSessionPrefix.size()));
            if (!ev)
                return;
            const QString type = jsString(ev->value(QStringLiteral("type")));
            if (type == QStringLiteral("ready") && !st->settled) {
                st->settled = true;
                done(QVariantMap{{QStringLiteral("ok"), true}});
            }
            if (type == QStringLiteral("step-result")) {
                const qint64 index = ev->value(QStringLiteral("index")).toLongLong();
                const QList<Reply> waiting = m_pendingSteps.values(index);
                m_pendingSteps.remove(index);
                for (const Reply &r : waiting)
                    r(*ev);
            }
        });
    };
    connect(proc, &QProcess::readyReadStandardOutput, this, readOut);
    connect(proc, &QProcess::readyReadStandardError, this, [this, proc] {
        routeLine(QString::fromUtf8(proc->readAllStandardError()));
    });
    // Guarded on identity: an old session closing must never clear the handle
    // to the one that replaced it, or every step after it reports "no session".
    connect(proc, &QProcess::finished, this, [this, proc, st, done, readOut] {
        readOut();
        if (m_sessionProc == proc)
            m_sessionProc = nullptr;
        clearPhase();
        const QList<Reply> waiting = m_pendingSteps.values();
        m_pendingSteps.clear();
        for (const Reply &r : waiting)
            r(QVariantMap{{QStringLiteral("success"), false}, {QStringLiteral("error"), QStringLiteral("session ended")}});
        if (!st->settled) {
            st->settled = true;
            done(QVariantMap{{QStringLiteral("ok"), false}, {QStringLiteral("error"), QStringLiteral("session exited before ready")}});
        }
        proc->deleteLater();
    });
    connect(proc, &QProcess::errorOccurred, this, [this, proc, st, done](QProcess::ProcessError e) {
        if (e != QProcess::FailedToStart)
            return;
        if (m_sessionProc == proc)
            m_sessionProc = nullptr;
        if (!st->settled) {
            st->settled = true;
            done(QVariantMap{{QStringLiteral("ok"), false}, {QStringLiteral("error"), QStringLiteral("Error: ") + proc->errorString()}});
        }
        proc->deleteLater();
    });
    proc->start();
}

void AgentService::sendStep(const QVariantMap &payload, QJSValue callback)
{
    const Reply done = replier(callback);
    if (!m_sessionProc || m_sessionProc->state() != QProcess::Running) {
        done(QVariantMap{{QStringLiteral("success"), false}, {QStringLiteral("error"), QStringLiteral("no session")}});
        return;
    }
    const QVariant index = payload.value(QStringLiteral("index"));
    m_pendingSteps.insert(index.toLongLong(), done);
    QVariantMap msg{
        {QStringLiteral("type"), QStringLiteral("step")},
        {QStringLiteral("index"), index},
        {QStringLiteral("detail"), payload.value(QStringLiteral("detail"))},
        {QStringLiteral("goal"), payload.value(QStringLiteral("goal"))},
        {QStringLiteral("prompt"), payload.value(QStringLiteral("detail"))},
        // Whether the plan said this step has behaviour worth asserting.
        // Dropped here and the step is never asked for tests, silently - which
        // is exactly how dependsOn died between the plan and the scheduler.
        {QStringLiteral("testable"), truthy(payload.value(QStringLiteral("testable")))},
        {QStringLiteral("title"), orString(payload.value(QStringLiteral("title")), QString())},
    };
    // JSON.stringify left undefined fields out.
    for (const QString &k : {QStringLiteral("index"), QStringLiteral("detail"), QStringLiteral("goal"), QStringLiteral("prompt")}) {
        if (!msg.value(k).isValid())
            msg.remove(k);
    }
    m_sessionProc->write(jsonLine(msg));
}

void AgentService::closeSession(const Done &then)
{
    if (!m_sessionProc) {
        if (m_sessionClosing)
            m_sessionCloseWaiters.append(then);
        else
            then();
        return;
    }
    QProcess *proc = m_sessionProc;
    m_sessionProc = nullptr;
    m_sessionClosing = true;
    m_sessionCloseWaiters.append(then);
    auto settled = std::make_shared<bool>(false);
    auto finish = [this, settled] {
        if (*settled)
            return;
        *settled = true;
        m_sessionClosing = false;
        const QList<Done> waiters = std::exchange(m_sessionCloseWaiters, {});
        for (const Done &w : waiters)
            w();
    };
    // Resolves only once the process is really gone, so the Chromium profile
    // is free before anything else opens it.
    connect(proc, &QProcess::finished, this, finish);
    if (proc->state() == QProcess::Running)
        proc->write(jsonLine({{QStringLiteral("type"), QStringLiteral("close")}}));
    // The session closes its browser before exiting; kill only if it hangs.
    QTimer::singleShot(10000, proc, [proc] { Proc::terminate(proc); });
    // And never leave the interface waiting on a process that will not die.
    QTimer::singleShot(15000, this, finish);
}

void AgentService::endSession(QJSValue callback)
{
    const Reply done = replier(callback);
    closeSession([done] { done(QVariant()); });
}

void AgentService::runCommand(const QVariantMap &payload, QJSValue callback)
{
    const Reply done = replier(callback);
    auto *proc = new QProcess(this);
    proc->setWorkingDirectory(jsString(payload.value(QStringLiteral("cwd"))));
    auto out = std::make_shared<QString>();
    auto forward = [this, out](const QByteArray &bytes) {
        const QString text = QString::fromUtf8(bytes);
        out->append(text);
        emit projectLog(text.endsWith(u'\n') ? text.chopped(1) : text);
    };
    connect(proc, &QProcess::readyReadStandardOutput, this, [proc, forward] { forward(proc->readAllStandardOutput()); });
    connect(proc, &QProcess::readyReadStandardError, this, [proc, forward] { forward(proc->readAllStandardError()); });
    connect(proc, &QProcess::finished, this, [proc, out, done](int code, QProcess::ExitStatus status) {
        done(QVariantMap{{QStringLiteral("success"), status == QProcess::NormalExit && code == 0}, {QStringLiteral("output"), *out}});
        proc->deleteLater();
    });
    connect(proc, &QProcess::errorOccurred, this, [proc, out, done](QProcess::ProcessError e) {
        // Node reports a shell that never started as a close with a failing code.
        if (e != QProcess::FailedToStart)
            return;
        done(QVariantMap{{QStringLiteral("success"), false}, {QStringLiteral("output"), *out}});
        proc->deleteLater();
    });
    Proc::startShell(proc, jsString(payload.value(QStringLiteral("command"))));
}

/*
 * Is the provider signed in, and which conversation is it on?
 *
 * Queued like every other agent run - it opens the same browser profile, so
 * probing while a build is mid-answer would be the profile-contention bug all
 * over again, this time triggered by a status light.
 */
void AgentService::authStatus(const QString &providerId, const QString &workspace, QJSValue callback)
{
    const Reply done = replier(callback);
    const QVariant busy = refuseWhileBuilding(QStringLiteral("The account check"));
    if (busy.isValid()) {
        done(busy);
        return;
    }
    const QString provider = providerId.isEmpty() ? QStringLiteral("deepseek") : providerId;
    queueAgentRun(QStringLiteral("authcheck"), [this, provider, workspace, done](Done over) {
        OneShot spec;
        spec.args = {QStringLiteral("authcheck"), provider, workspace};
        spec.env = agentEnv(QStringLiteral("0"), QVariant(), QVariant());
        spec.route = false;
        spec.stderrMode = OneShot::ErrIgnore;
        spec.holdsProfile = false;
        spec.result = [](const QByteArray &output, const QString &startError) {
            if (!startError.isEmpty())
                return QVariantMap{{QStringLiteral("success"), false}, {QStringLiteral("error"), startError}};
            if (auto r = outputBlock(output))
                return *r;
            return QVariantMap{{QStringLiteral("success"), false}, {QStringLiteral("signedIn"), false},
                               {QStringLiteral("error"), QStringLiteral("no answer from the agent")}};
        };
        runOneShot(spec, [done, over](const QVariant &r) {
            done(r);
            over();
        });
    });
}

/*
 * Check a provider's selectors on demand.
 *
 * Same shape as auth-status, and queued for the same reason: it opens the
 * browser profile, and Chromium locks that directory - a second run landing on
 * a profile it cannot own comes up empty and reports "Chat input not found",
 * which reads like the very breakage this is meant to detect.
 */
void AgentService::providerHealth(const QString &providerId, const QString &workspace, QJSValue callback)
{
    const Reply done = replier(callback);
    const QVariant busy = refuseWhileBuilding(QStringLiteral("The selector check"));
    if (busy.isValid()) {
        done(busy);
        return;
    }
    const QString provider = providerId.isEmpty() ? QStringLiteral("deepseek") : providerId;
    queueAgentRun(QStringLiteral("health"), [this, provider, workspace, done](Done over) {
        OneShot spec;
        spec.args = {QStringLiteral("health"), provider, workspace};
        spec.env = agentEnv(QStringLiteral("0"), QVariant(), QVariant());
        spec.route = false;
        spec.stderrMode = OneShot::ErrIgnore;
        spec.holdsProfile = false;
        spec.result = [](const QByteArray &output, const QString &startError) {
            if (!startError.isEmpty())
                return QVariantMap{{QStringLiteral("success"), false}, {QStringLiteral("error"), startError}};
            if (auto r = outputBlock(output))
                return *r;
            return QVariantMap{{QStringLiteral("success"), false}, {QStringLiteral("error"), QStringLiteral("no answer from the agent")}};
        };
        runOneShot(spec, [done, over](const QVariant &r) {
            done(r);
            over();
        });
    });
}

/*
 * Sign out by deleting the provider's browser profile.
 *
 * The session lives in that directory as cookies; there is nothing else to
 * revoke. Refused while an agent is running, because removing a profile
 * Chromium currently has open corrupts it.
 */
void AgentService::signOutProvider(const QString &providerId, QJSValue callback)
{
    if (m_agentProc || m_sessionProc) {
        Js::reply(this, callback, QVariantMap{{QStringLiteral("success"), false},
                                              {QStringLiteral("error"), QStringLiteral("Something is still running. Let it finish first.")}});
        return;
    }
    static const QRegularExpression unsafe(QStringLiteral("[^a-z0-9-]"), QRegularExpression::CaseInsensitiveOption);
    const QString id = QString(providerId).remove(unsafe);
    // An id with nothing left would name browser-profiles itself, and sign
    // every provider out at once.
    if (id.isEmpty()) {
        Js::reply(this, callback, QVariantMap{{QStringLiteral("success"), false}, {QStringLiteral("error"), QStringLiteral("No provider to sign out of.")}});
        return;
    }
    QDir dir(QDir(Paths::storageRoot()).filePath(QStringLiteral("browser-profiles/") + id));
    if (dir.exists() && !dir.removeRecursively()) {
        Js::reply(this, callback, QVariantMap{{QStringLiteral("success"), false},
                                              {QStringLiteral("error"), QStringLiteral("Could not remove ") + dir.path()}});
        return;
    }
    Js::reply(this, callback, QVariantMap{{QStringLiteral("success"), true}});
}

/*
 * Open the saved conversation in the user's own browser.
 *
 * Only http(s), and only after the URL parses - the system handler would take
 * a file:// or a custom scheme straight to whatever program claims it.
 */
void AgentService::openThread(const QString &url, QJSValue callback)
{
    const QUrl u(url, QUrl::StrictMode);
    if (!u.isValid() || u.scheme().isEmpty()) {
        Js::reply(this, callback, QVariantMap{{QStringLiteral("success"), false}, {QStringLiteral("error"), QStringLiteral("Not a URL.")}});
        return;
    }
    const QString scheme = u.scheme().toLower();
    if (scheme != QStringLiteral("https") && scheme != QStringLiteral("http")) {
        Js::reply(this, callback, QVariantMap{{QStringLiteral("success"), false},
                                              {QStringLiteral("error"), QStringLiteral("Refusing to open a ") + scheme + QStringLiteral(": link.")}});
        return;
    }
    QDesktopServices::openUrl(u);
    Js::reply(this, callback, QVariantMap{{QStringLiteral("success"), true}});
}

void AgentService::signIn(const QString &providerId, QJSValue callback)
{
    const Reply done = replier(callback);
    releaseCode([this, providerId, done] {
        OneShot spec;
        spec.args = {QStringLiteral("signin"), providerId};
        spec.env = {{QStringLiteral("AGENT_HEADED"), QStringLiteral("1")}};
        spec.result = [](const QByteArray &output, const QString &startError) {
            if (!startError.isEmpty())
                return QVariantMap{{QStringLiteral("success"), false}, {QStringLiteral("error"), startError}};
            return QVariantMap{{QStringLiteral("success"), output.contains("\"success\":true")}};
        };
        runOneShot(spec, done);
    });
}

void AgentService::browserStatus(QJSValue callback)
{
    // Development uses the developer's own ~/.cache/ms-playwright, which
    // PLAYWRIGHT_BROWSERS_PATH deliberately does not override there.
    if (!Paths::agentIsBundled()) {
        Js::reply(this, callback, QVariantMap{{QStringLiteral("ready"), true},
                                              {QStringLiteral("path"), QStringLiteral("(development: system Playwright cache)")}});
        return;
    }
    const QStringList entries = QDir(browsersDir()).entryList(QDir::AllEntries | QDir::NoDotAndDotDot);
    Js::reply(this, callback, QVariantMap{{QStringLiteral("ready"), hasChromium(entries)}, {QStringLiteral("path"), browsersDir()}});
}

/*
 * Download Chromium through Playwright's own CLI.
 *
 * Reaching into playwright-core's internal registry would be shorter and would
 * break on the next Playwright upgrade. The CLI is the supported entry point,
 * and it already prints progress worth forwarding to the window.
 *
 * The CLI is found the way Node resolves playwright/package.json from the
 * agent: the nearest node_modules/playwright above it. It is checked to exist
 * so a genuinely missing file still reports honestly.
 */
void AgentService::installBrowser(QJSValue callback)
{
    const Reply done = replier(callback);
    QString cli;
    const QString agent = Paths::agentPath();
    if (!agent.isEmpty()) {
        QDir dir = QFileInfo(agent).dir();
        for (int i = 0; i < 8 && cli.isEmpty(); ++i) {
            if (QFileInfo::exists(dir.filePath(QStringLiteral("node_modules/playwright/package.json"))))
                cli = dir.filePath(QStringLiteral("node_modules/playwright/cli.js"));
            if (!dir.cdUp())
                break;
        }
    }
    if (cli.isEmpty() || !QFileInfo::exists(cli)) {
        done(QVariantMap{{QStringLiteral("ok"), false}, {QStringLiteral("error"), QStringLiteral("Playwright's installer was not found in this build.")}});
        return;
    }
    const QString node = Paths::nodePath();
    if (node.isEmpty()) {
        done(QVariantMap{{QStringLiteral("ok"), false}, {QStringLiteral("error"), nodeError()}});
        return;
    }
    auto *proc = new QProcess(this);
    QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    env.insert(QStringLiteral("PLAYWRIGHT_BROWSERS_PATH"), browsersDir());
    proc->setProcessEnvironment(env);
    proc->setWorkingDirectory(spawnCwd());
    // Kept whole, not just forwarded: the reason a download failed is printed
    // first and then buried under generic lines, and the dialog shows the last.
    auto output = std::make_shared<QString>();
    auto forward = [this, output](const QByteArray &bytes) {
        const QString d = QString::fromUtf8(bytes);
        output->append(d);
        if (output->size() > 65536)
            *output = output->right(65536);
        const QString line = Proc::stripAnsi(d).trimmed();
        if (!line.isEmpty())
            emit browserProgress(line);
    };
    connect(proc, &QProcess::readyReadStandardOutput, this, [proc, forward] { forward(proc->readAllStandardOutput()); });
    connect(proc, &QProcess::readyReadStandardError, this, [proc, forward] { forward(proc->readAllStandardError()); });
    connect(proc, &QProcess::finished, this, [proc, output, done](int code, QProcess::ExitStatus status) {
        if (status == QProcess::NormalExit && code == 0)
            done(QVariantMap{{QStringLiteral("ok"), true}});
        else
            done(QVariantMap{{QStringLiteral("ok"), false},
                             {QStringLiteral("error"), describeInstallFailure(*output, status == QProcess::NormalExit ? QString::number(code) : QStringLiteral("null"))}});
        proc->deleteLater();
    });
    connect(proc, &QProcess::errorOccurred, this, [proc, done](QProcess::ProcessError e) {
        if (e != QProcess::FailedToStart)
            return;
        done(QVariantMap{{QStringLiteral("ok"), false}, {QStringLiteral("error"), QStringLiteral("Error: ") + proc->errorString()}});
        proc->deleteLater();
    });
    proc->start(node, {cli, QStringLiteral("install"), QStringLiteral("chromium")});
}
