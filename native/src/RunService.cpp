#include "RunService.h"

#include "Js.h"
#include "Proc.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QProcessEnvironment>
#include <QRegularExpression>
#include <QTimer>

/*
 * "Run this project": the program in a CloseNI console of its own.
 *
 * One run console at a time. Asking to run again while it is open restarts the
 * program in it rather than stacking windows, each with its own process.
 */

namespace {

const QStringList kVenvs{QStringLiteral(".venv"), QStringLiteral("venv"), QStringLiteral("env")};
// Output kept for "Fix errors": the end is where the error is.
const qsizetype kKeep = 20000;
// How long a start check lets the program run: past its imports and first frame.
const int kCheckMs = 5000;
// The end of the output is where the error is; the start is mostly banners.
const qsizetype kFixTail = 6000;
// Node reports a shell that could not be spawned as a close with a negative errno.
const int kSpawnFailed = -2;

/*
 * The parts of desktop/run-target.js the process side needs. The renderer's
 * copy is ported to qml/js separately; these must agree with it.
 */

/*
 * The project's own interpreter, when it has one. The agent installs into a
 * venv because a PEP 668 system Python refuses pip, so `python3 game.py`
 * against the system interpreter dies on `import pygame`.
 */
QString venvCommand(const QString &command, const QString &venvPython)
{
    if (venvPython.isEmpty())
        return command;
    static const QRegularExpression interp(QStringLiteral("^(python3?|py -3)(?=\\s|$)"));
    const QRegularExpressionMatch m = interp.match(command);
    if (!m.hasMatch())
        return command;
    static const QRegularExpression space(QStringLiteral("\\s"));
    const QString quoted = venvPython.contains(space) ? u'"' + venvPython + u'"' : venvPython;
    return quoted + command.mid(m.capturedLength(0));
}

// Libraries that open a window of their own. A program using one is a game or
// an app, not a console program, and its output is only half the story.
const QRegularExpression &guiImport()
{
    static const QRegularExpression re(
        QStringLiteral("^\\s*(?:import|from)\\s+(?:pygame|tkinter|Tkinter|turtle|pyglet|arcade|kivy|PyQt[56]|PySide[26]|wx|raylib|pyray|ursina|panda3d|OpenGL)\\b"),
        QRegularExpression::MultilineOption);
    return re;
}

/* Does any of these source texts open a window? */
bool looksGraphical(const QStringList &sources)
{
    for (const QString &s : sources) {
        if (guiImport().match(s).hasMatch())
            return true;
    }
    return false;
}

/*
 * Can CloseNI start this program unseen, to check it gets past startup? Only a
 * program with a window, whose every toolkit runs without a screen: the agent
 * cannot easily check those itself, and a game does not act on the user's
 * files at startup the way a console script might.
 *
 * SDL draws to a dummy video driver and Qt to an offscreen platform, given
 * headlessEnv(); the rest would flash a window.
 */
bool checkableHeadless(const QStringList &sources)
{
    static const QRegularExpression noScreen(QStringLiteral("^(?:pygame|PyQt[56]|PySide[26])$"));
    static const QRegularExpression prefix(QStringLiteral("^\\s*(?:import|from)\\s+"));
    QStringList kits;
    for (const QString &s : sources) {
        auto it = guiImport().globalMatch(s);
        while (it.hasNext())
            kits.append(it.next().captured(0).remove(prefix));
    }
    if (kits.isEmpty())
        return false;
    for (const QString &k : kits) {
        if (!noScreen.match(k).hasMatch())
            return false;
    }
    return true;
}

void addHeadlessEnv(QProcessEnvironment &env)
{
    env.insert(QStringLiteral("SDL_VIDEODRIVER"), QStringLiteral("dummy"));
    env.insert(QStringLiteral("SDL_AUDIODRIVER"), QStringLiteral("dummy"));
    env.insert(QStringLiteral("QT_QPA_PLATFORM"), QStringLiteral("offscreen"));
}

QString codeString(const QVariant &code)
{
    return code.isNull() ? QStringLiteral("null") : code.toString();
}

/*
 * What the agent is asked after a run fails: the command, how it ended and the
 * end of its output. A program that opens a window is checked headless and
 * time-limited, since a plain bash call would sit until the timeout.
 */
QString fixPrompt(const QString &command, const QString &output, const QVariant &code, const QVariant &signal, bool gui)
{
    QString out = output;
    if (out.size() > kFixTail) {
        out = out.right(kFixTail);
        const qsizetype nl = out.indexOf(u'\n');
        if (nl != -1 && nl < 200)
            out = out.mid(nl + 1);
        out = QStringLiteral("...\n") + out;
    }
    while (!out.isEmpty() && out.back().isSpace())
        out.chop(1);
    const QString how = !signal.isNull() && !signal.toString().isEmpty()
        ? QStringLiteral("was stopped by ") + signal.toString()
        : QStringLiteral("exited with code ") + codeString(code);
    return QStringLiteral("Running the project with `") + command + QStringLiteral("` ") + how
        + QStringLiteral(". The end of its output:\n\n```\n") + out + QStringLiteral("\n```\n\n")
        + QStringLiteral("Find the cause and fix it, in the code or in the project's environment, whichever is at fault.")
        + (gui ? QStringLiteral(" The program opens its own window, which would hold a plain run until its timeout: to check a fix, start it "
                                "headless and time-limited, such as SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy timeout 5 ")
                    + command + QStringLiteral(", where exit code 124 means it stayed up. The user will run it for real.")
               : QString());
}

/* The project's venv interpreter, or empty. */
QString venvPython(const QString &cwd)
{
    for (const QString &d : kVenvs) {
#ifdef Q_OS_WIN
        const QString p = QDir(cwd).filePath(d + QStringLiteral("/Scripts/python.exe"));
#else
        const QString p = QDir(cwd).filePath(d + QStringLiteral("/bin/python"));
#endif
        if (QFileInfo::exists(p))
            return QDir::toNativeSeparators(p);
    }
    return QString();
}

/* The project's top-level and src/ sources, enough to tell a game from a script. */
QStringList sources(const QString &cwd)
{
    static const QRegularExpression source(QStringLiteral("\\.(py|js|mjs|ts|rb|go|rs|c|cpp|java|lua)$"));
    QStringList out;
    for (const QString &dir : {cwd, QDir(cwd).filePath(QStringLiteral("src"))}) {
        const QDir d(dir);
        for (const QString &n : d.entryList(QDir::Files | QDir::NoDotAndDotDot, QDir::Name)) {
            if (!source.match(n).hasMatch() || out.size() >= 40)
                continue;
            QFile f(d.filePath(n));
            if (f.open(QIODevice::ReadOnly))
                out.append(QString::fromUtf8(f.readAll()).left(20000));
        }
    }
    return out;
}

/*
 * run.html's previewTarget for output: the last local address printed. A
 * server that reprints its address as it restarts should not pin the page to
 * the first line it ever wrote, and a documentation link in a traceback is not
 * a server.
 */
QString serverUrl(const QString &output)
{
    static const QRegularExpression localUrl(
        QStringLiteral("https?://(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0)(?::\\d+)?[^\\s\"'<>)\\]]*"));
    QString last;
    auto it = localUrl.globalMatch(output);
    while (it.hasNext())
        last = it.next().captured(0);
    return last;
}

}

RunService::RunService(QObject *parent)
    : QObject(parent)
{
}

RunService::~RunService()
{
    // Quitting stops the program, as Electron's before-quit did.
    stopProgram();
}

/*
 * The whole process group: a shell running `python3 game.py` is two
 * processes, and killing only the shell leaves the game on screen.
 */
void RunService::stopProgram()
{
    QProcess *p = m_proc;
    if (!p)
        return;
    m_proc = nullptr;
    Proc::killGroup(p);
}

void RunService::start()
{
    stopProgram();
    const QString command = venvCommand(m_job.command, venvPython(m_job.cwd));
    auto run = std::make_shared<Record>();
    run->command = command;
    m_last = run;
    const int id = ++m_runId;
    emit started({{QStringLiteral("run"), id},
                  {QStringLiteral("command"), command},
                  {QStringLiteral("cwd"), m_job.cwd},
                  {QStringLiteral("gui"), m_job.gui}});

    auto *p = new QProcess(this);
    p->setWorkingDirectory(m_job.cwd);
    QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    // Unbuffered, or a Python program's prints arrive only when it exits.
    env.insert(QStringLiteral("PYTHONUNBUFFERED"), QStringLiteral("1"));
    p->setProcessEnvironment(env);
    Proc::ownProcessGroup(p);
    m_proc = p;

    // run.html's own record: the text it showed, and the address it loaded.
    auto shown = std::make_shared<QString>();
    auto shownUrl = std::make_shared<QString>();
    auto output = [this, run, id, shown, shownUrl](const QString &stream, const QString &text) {
        run->output = (run->output + text).right(kKeep);
        const QString plain = Proc::stripAnsi(text);
        *shown = (*shown + plain).right(kKeep);
        const QString url = serverUrl(*shown);
        const bool changed = !url.isEmpty() && url != *shownUrl;
        if (changed)
            *shownUrl = url;
        emit this->output({{QStringLiteral("run"), id},
                           {QStringLiteral("stream"), stream},
                           {QStringLiteral("text"), text},
                           {QStringLiteral("plain"), plain},
                           {QStringLiteral("url"), QString(*shownUrl).replace(QStringLiteral("0.0.0.0"), QStringLiteral("localhost"))},
                           {QStringLiteral("urlChanged"), changed}});
    };
    auto exited = [this, run, id](const QVariant &code, const QVariant &signal) {
        run->code = code;
        run->signal = signal;
        emit this->exited({{QStringLiteral("run"), id},
                           {QStringLiteral("code"), code},
                           {QStringLiteral("signal"), signal},
                           {QStringLiteral("current"), id == m_runId}});
    };
    connect(p, &QProcess::readyReadStandardOutput, this, [p, output] { output(QStringLiteral("out"), QString::fromUtf8(p->readAllStandardOutput())); });
    connect(p, &QProcess::readyReadStandardError, this, [p, output] { output(QStringLiteral("err"), QString::fromUtf8(p->readAllStandardError())); });
    connect(p, &QProcess::finished, this, [this, p, exited](int code, QProcess::ExitStatus status) {
        if (m_proc == p)
            m_proc = nullptr;
        exited(Proc::exitCode(code, status), Proc::exitSignal(code, status));
        p->deleteLater();
    });
    connect(p, &QProcess::errorOccurred, this, [this, p, output, exited](QProcess::ProcessError e) {
        if (e != QProcess::FailedToStart)
            return;
        output(QStringLiteral("err"), p->errorString() + u'\n');
        if (m_proc == p)
            m_proc = nullptr;
        exited(kSpawnFailed, Proc::null());
        p->deleteLater();
    });
    Proc::startShell(p, command);
}

void RunService::openRunWindow(const QVariantMap &payload, QJSValue callback)
{
    const QString command = payload.value(QStringLiteral("command")).toString().trimmed();
    const QString cwd = payload.value(QStringLiteral("cwd")).toString();
    if (command.isEmpty() || cwd.isEmpty()) {
        Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), false}, {QStringLiteral("error"), QStringLiteral("nothing to run")}});
        return;
    }
    m_job = Job{command, cwd, looksGraphical(sources(cwd))};
    m_hasJob = true;
    emit windowRequested({{QStringLiteral("command"), command},
                          {QStringLiteral("cwd"), cwd},
                          {QStringLiteral("gui"), m_job.gui},
                          {QStringLiteral("title"), QStringLiteral("Run - ") + QFileInfo(QDir::cleanPath(cwd)).fileName()}});
    // Once the console has had its turn to open and connect, as Electron
    // waited for the page to load.
    QMetaObject::invokeMethod(this, [this] { if (m_hasJob) start(); }, Qt::QueuedConnection);
    Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), true}});
}

/*
 * Before "Run this project" is offered: start a program with a window unseen
 * for a few seconds. The Sigma game passed every unit test and died on import;
 * this catches that before the user is told it is ready. stdin stays open and
 * unwritten, so a prompt for input waits rather than failing on end of file.
 */
void RunService::checkRun(const QVariantMap &payload, QJSValue callback)
{
    const QString cwd = payload.value(QStringLiteral("cwd")).toString();
    const QString asked = payload.value(QStringLiteral("command")).toString().trimmed();
    if (asked.isEmpty() || cwd.isEmpty() || !checkableHeadless(sources(cwd))) {
        Js::reply(this, callback, QVariantMap{{QStringLiteral("checked"), false}});
        return;
    }
    const QString command = venvCommand(asked, venvPython(cwd));
    auto *p = new QProcess(this);
    p->setWorkingDirectory(cwd);
    QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    env.insert(QStringLiteral("PYTHONUNBUFFERED"), QStringLiteral("1"));
    addHeadlessEnv(env);
    p->setProcessEnvironment(env);
    Proc::ownProcessGroup(p);

    auto run = std::make_shared<Record>();
    run->command = command;
    auto timedOut = std::make_shared<bool>(false);
    QPointer<RunService> self(this);
    auto finish = [self, p, run, timedOut, command, callback](const QVariant &code, const QVariant &signal) {
        run->code = code;
        run->signal = *timedOut ? Proc::null() : signal;
        // A start check passes when the program was still up at the limit, or ended cleanly.
        const bool ok = *timedOut || (!code.isNull() && code.toInt() == 0);
        if (self)
            Js::reply(self, callback, QVariantMap{
                {QStringLiteral("checked"), true},
                {QStringLiteral("ok"), ok},
                {QStringLiteral("command"), command},
                {QStringLiteral("prompt"), ok ? QString() : fixPrompt(run->command, run->output, run->code, run->signal, true)},
            });
        p->deleteLater();
    };
    QTimer::singleShot(kCheckMs, p, [p, timedOut] {
        *timedOut = true;
        Proc::killGroup(p);
    });
    auto output = [run](const QByteArray &d) { run->output = (run->output + QString::fromUtf8(d)).right(kKeep); };
    connect(p, &QProcess::readyReadStandardOutput, this, [p, output] { output(p->readAllStandardOutput()); });
    connect(p, &QProcess::readyReadStandardError, this, [p, output] { output(p->readAllStandardError()); });
    connect(p, &QProcess::finished, this, [finish](int code, QProcess::ExitStatus status) {
        finish(Proc::exitCode(code, status), Proc::exitSignal(code, status));
    });
    connect(p, &QProcess::errorOccurred, this, [p, output, finish](QProcess::ProcessError e) {
        if (e != QProcess::FailedToStart)
            return;
        output(p->errorString().toUtf8() + '\n');
        finish(kSpawnFailed, Proc::null());
    });
    Proc::startShell(p, command);
}

void RunService::restart(QJSValue callback)
{
    if (m_hasJob)
        start();
    Js::reply(this, callback);
}

void RunService::stop(QJSValue callback)
{
    stopProgram();
    Js::reply(this, callback);
}

void RunService::input(const QString &text, QJSValue callback)
{
    if (m_proc && m_proc->state() == QProcess::Running)
        m_proc->write(text.toUtf8());
    Js::reply(this, callback);
}

/* The failed run, as a request to the agent in the window that started it. */
void RunService::fix(QJSValue callback)
{
    if (!m_last || !m_hasJob) {
        Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), false}, {QStringLiteral("error"), QStringLiteral("nothing has run")}});
        return;
    }
    emit runFix({{QStringLiteral("cwd"), m_job.cwd},
                 {QStringLiteral("command"), m_job.command},
                 {QStringLiteral("prompt"), fixPrompt(m_last->command, m_last->output, m_last->code, m_last->signal, m_job.gui)}});
    Js::reply(this, callback, QVariantMap{{QStringLiteral("ok"), true}});
}

/* The console is closing: its program goes with it. */
void RunService::close(QJSValue callback)
{
    stopProgram();
    Js::reply(this, callback);
}
