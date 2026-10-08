#include "AgentProcess.h"

#include "Paths.h"

#include <QDir>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QProcessEnvironment>
#include <QTimer>

namespace {

const QString kEventPrefix = QStringLiteral("AGENT_EVENT: ");

}

AgentProcess::AgentProcess(QObject *parent)
    : QObject(parent)
    , m_nodePath(Paths::nodePath())
    , m_agentPath(Paths::agentPath())
    , m_storageRoot(Paths::storageRoot())
{
}

AgentProcess::~AgentProcess()
{
    if (!m_proc || m_proc->state() == QProcess::NotRunning)
        return;
    // Quitting the app ends the session the way the panel would, so the
    // browser profile is not left locked; a session that will not stop is killed.
    disconnect(m_proc, nullptr, this, nullptr);
    m_proc->write("{\"type\":\"close\"}\n");
    if (!m_proc->waitForFinished(5000)) {
        m_proc->kill();
        m_proc->waitForFinished(1000);
    }
}

void AgentProcess::setStatus(const QString &status, const QString &error)
{
    m_status = status;
    m_error = error;
    emit statusChanged();
}

void AgentProcess::start(const QString &workspace, const QString &provider, const QString &mode)
{
    if (m_proc)
        return;
    if (m_nodePath.isEmpty()) {
        setStatus(QStringLiteral("failed"), tr("Node was not found. Install Node 22 or set CLOSENI_NODE."));
        return;
    }
    if (m_agentPath.isEmpty()) {
        setStatus(QStringLiteral("failed"), tr("The agent was not found. Run `npm run build`, or set CLOSENI_AGENT."));
        return;
    }

    QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    env.insert(QStringLiteral("CLOSENI_STORAGE"), m_storageRoot);
    env.insert(QStringLiteral("AGENT_HEADED"), QStringLiteral("0"));
    // Bundled, Playwright must look inside the storage directory. From a
    // checkout it must not, or it stops seeing the browsers already in
    // ~/.cache/ms-playwright (see spawnAgent in desktop/main.js).
    if (Paths::agentIsBundled())
        env.insert(QStringLiteral("PLAYWRIGHT_BROWSERS_PATH"), QDir(m_storageRoot).filePath(QStringLiteral("browsers")));

    m_proc = new QProcess(this);
    m_proc->setProcessEnvironment(env);
    // local-agent/dist/index.js -> the directory holding local-agent/.
    m_proc->setWorkingDirectory(QFileInfo(m_agentPath).dir().absoluteFilePath(QStringLiteral("../..")));
    connect(m_proc, &QProcess::readyReadStandardOutput, this, &AgentProcess::readStdout);
    connect(m_proc, &QProcess::readyReadStandardError, this, &AgentProcess::readStderr);
    connect(m_proc, &QProcess::finished, this, &AgentProcess::finished);
    connect(m_proc, &QProcess::errorOccurred, this, [this](QProcess::ProcessError e) {
        // A crash or a kill also arrives through finished(); only a process
        // that never started has nothing else to report it.
        if (e == QProcess::FailedToStart) {
            m_proc->deleteLater();
            m_proc = nullptr;
            setStatus(QStringLiteral("failed"), tr("Node could not be started: %1").arg(m_nodePath));
        }
    });

    m_stdoutBuf.clear();
    m_stderrBuf.clear();
    m_readyInfo.clear();
    setStatus(QStringLiteral("starting"));
    m_proc->start(m_nodePath, {m_agentPath, QStringLiteral("agent-session"), workspace,
                               provider.isEmpty() ? QStringLiteral("deepseek") : provider,
                               mode.isEmpty() ? QStringLiteral("default") : mode});
}

bool AgentProcess::send(const QVariantMap &message)
{
    if (!m_proc || m_proc->state() != QProcess::Running)
        return false;
    m_proc->write(QJsonDocument(QJsonObject::fromVariantMap(message)).toJson(QJsonDocument::Compact) + "\n");
    return true;
}

void AgentProcess::close()
{
    if (!m_proc || m_status == QStringLiteral("closing"))
        return;
    send({{QStringLiteral("type"), QStringLiteral("close")}});
    setStatus(QStringLiteral("closing"));
    // Closing waits for a reply in flight; a stuck page must not hold the app.
    // The process is the timer's context, so the timer dies with it.
    QProcess *proc = m_proc;
    QTimer::singleShot(20000, proc, [proc] { proc->kill(); });
}

void AgentProcess::readStdout()
{
    m_stdoutBuf += m_proc->readAllStandardOutput();
    qsizetype idx;
    while ((idx = m_stdoutBuf.indexOf('\n')) != -1) {
        QString line = QString::fromUtf8(m_stdoutBuf.left(idx));
        m_stdoutBuf.remove(0, idx + 1);
        if (line.endsWith(u'\r'))
            line.chop(1);
        handleLine(line);
    }
}

void AgentProcess::readStderr()
{
    m_stderrBuf += m_proc->readAllStandardError();
    qsizetype idx;
    while ((idx = m_stderrBuf.indexOf('\n')) != -1) {
        QString line = QString::fromUtf8(m_stderrBuf.left(idx)).trimmed();
        m_stderrBuf.remove(0, idx + 1);
        if (!line.isEmpty())
            emit logLine(line);
    }
}

void AgentProcess::handleLine(const QString &line)
{
    if (line.trimmed().isEmpty())
        return;
    if (line.startsWith(kEventPrefix)) {
        const QJsonDocument doc = QJsonDocument::fromJson(line.mid(kEventPrefix.size()).toUtf8());
        if (!doc.isObject())
            return;
        const QVariantMap ev = doc.object().toVariantMap();
        if (ev.value(QStringLiteral("type")).toString() == QStringLiteral("ready") && m_status == QStringLiteral("starting")) {
            m_readyInfo = ev;
            setStatus(QStringLiteral("ready"));
        }
        emit agentEvent(ev);
        return;
    }
    // A failure before the session is ready arrives as the usual output block;
    // it is the reason the window needs to show.
    if (line.startsWith(QStringLiteral("{\"success\""))) {
        const QJsonObject r = QJsonDocument::fromJson(line.toUtf8()).object();
        if (m_status == QStringLiteral("starting") && r.value(QStringLiteral("success")) == QJsonValue(false))
            setStatus(QStringLiteral("failed"), r.value(QStringLiteral("error")).toString(tr("the agent stopped")));
        return;
    }
    // PHASE is a live status every two seconds, and the output markers frame
    // the block above; neither belongs in the log.
    if (line.startsWith(QStringLiteral("PHASE:")) || line.startsWith(QStringLiteral("AGENT_OUTPUT_START"))
        || line.startsWith(QStringLiteral("AGENT_OUTPUT_END")))
        return;
    emit logLine(line);
}

void AgentProcess::finished(int exitCode, QProcess::ExitStatus exitStatus)
{
    Q_UNUSED(exitStatus);
    m_proc->deleteLater();
    m_proc = nullptr;
    if (m_status == QStringLiteral("starting"))
        setStatus(QStringLiteral("failed"), tr("the agent exited before it was ready (exit code %1)").arg(exitCode));
    else if (m_status != QStringLiteral("failed"))
        setStatus(QStringLiteral("idle"));
    emit agentEvent({{QStringLiteral("type"), QStringLiteral("closed")}});
}
