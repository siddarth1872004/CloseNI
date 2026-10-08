#include "AgentService.h"
#include "Bridge.h"

#include <QCommandLineParser>
#include <QDir>
#include <QGuiApplication>
#include <QJsonDocument>
#include <QJsonObject>
#include <QQmlApplicationEngine>
#include <QQuickItem>
#include <QQuickWindow>

#include <cstdio>

namespace {

void print(const QString &line)
{
    std::fprintf(stdout, "%s\n", qPrintable(line));
    std::fflush(stdout);
}

/*
 * --exit-on-ready: start a Code session through Agent, as the Code panel
 * does, report it on stdout, close it once it is ready, and exit 0 when it has
 * closed, or 1 at once if it failed.
 */
void exitWhenReady(QQmlEngine *engine, const QString &workspace, const QString &provider)
{
    auto *agent = engine->singletonInstance<AgentService *>("CloseNI", "Agent");
    const QVariantMap payload{
        {QStringLiteral("workspace"), workspace},
        {QStringLiteral("provider"), provider},
        {QStringLiteral("mode"), QStringLiteral("default")},
    };
    agent->codeStart(payload, CallbackSink::make(engine, [engine, agent](const QVariant &result) {
        const QVariantMap r = result.toMap();
        if (!r.value(QStringLiteral("ok")).toBool()) {
            print("CloseNI: agent failed: " + r.value(QStringLiteral("error")).toString());
            QCoreApplication::exit(1);
            return;
        }
        const QJsonDocument info(QJsonObject::fromVariantMap(r));
        print("CloseNI: agent ready " + QString::fromUtf8(info.toJson(QJsonDocument::Compact)));
        agent->codeEnd(CallbackSink::make(engine, [](const QVariant &) { QCoreApplication::exit(0); }));
    }));
}

/*
 * --self-test: every warning (a QML binding error, a missing file, a failed
 * screenshot) is counted, and any at all fails the run.
 */
int selfTestWarnings = 0;
QtMessageHandler previousHandler = nullptr;

void countWarnings(QtMsgType type, const QMessageLogContext &context, const QString &message)
{
    if (type == QtWarningMsg || type == QtCriticalMsg || type == QtFatalMsg)
        ++selfTestWarnings;
    if (previousHandler)
        previousHandler(type, context, message);
}

}

/*
 * --self-test screenshots: Main.qml's selfTestShot(path) lands here and the
 * whole window, popups included, is saved at once. QML's grabToImage cannot
 * reach the popups' layer.
 */
class ShotSaver : public QObject
{
    Q_OBJECT
public:
    explicit ShotSaver(QQuickWindow *window) : QObject(window), m_window(window) {}

public slots:
    void save(const QString &path)
    {
        if (m_window->grabWindow().save(path))
            print("CloseNI: self-test: saved " + path);
        else
            qWarning("CloseNI: self-test: could not save %s", qPrintable(path));
    }

private:
    QQuickWindow *m_window;
};

int main(int argc, char *argv[])
{
    QGuiApplication app(argc, argv);
    QGuiApplication::setApplicationName(QStringLiteral("CloseNI"));
    QGuiApplication::setApplicationVersion(QStringLiteral(CLOSENI_VERSION));

    QCommandLineParser parser;
    parser.setApplicationDescription(QStringLiteral("CloseNI, the native app"));
    parser.addHelpOption();
    parser.addVersionOption();
    // Without it the window reopens the last project; --start and
    // --exit-on-ready fall back to the home folder.
    const QCommandLineOption workspace(QStringLiteral("workspace"), QStringLiteral("Project folder for the agent."),
                                       QStringLiteral("dir"));
    const QCommandLineOption provider(QStringLiteral("provider"), QStringLiteral("Provider id."),
                                      QStringLiteral("id"), QStringLiteral("deepseek"));
    const QCommandLineOption start(QStringLiteral("start"), QStringLiteral("Start the agent session on launch."));
    // For CI and scripts: the process exit code says whether the session came up.
    const QCommandLineOption exitOnReady(QStringLiteral("exit-on-ready"),
                                         QStringLiteral("Start the session, then exit 0 once it is ready or 1 if it fails."));
    // For tests only: no window; drive the services over stdin and stdout (see Bridge.h).
    const QCommandLineOption bridge(QStringLiteral("bridge"), QStringLiteral("Test harness: drive the services over stdin and stdout."));
    // For tests only: walk the window through every theme and panel, save
    // screenshots to <dir>, and exit 1 on any warning.
    const QCommandLineOption selfTest(QStringLiteral("self-test"),
                                      QStringLiteral("Test harness: exercise the window, save screenshots to <dir>."),
                                      QStringLiteral("dir"));
    parser.addOptions({workspace, provider, start, exitOnReady, bridge, selfTest});
    parser.process(app);

    QQmlApplicationEngine engine;
    if (parser.isSet(bridge)) {
        Bridge harness(&engine);
        return app.exec();
    }

    const QString chosen = parser.isSet(workspace) ? QDir(parser.value(workspace)).absolutePath() : QString();
    const QString agentWorkspace = chosen.isEmpty() ? QDir::homePath() : chosen;
    const bool testing = parser.isSet(selfTest);
    if (testing) {
        QDir().mkpath(parser.value(selfTest));
        previousHandler = qInstallMessageHandler(countWarnings);
    }

    engine.setInitialProperties({
        {QStringLiteral("workspace"), parser.isSet(start) && chosen.isEmpty() ? agentWorkspace : chosen},
        // Unset: the window keeps the provider chosen last time.
        {QStringLiteral("provider"), parser.isSet(provider) ? parser.value(provider) : QString()},
        {QStringLiteral("autoStart"), parser.isSet(start)},
        {QStringLiteral("selfTestDir"), testing ? QDir(parser.value(selfTest)).absolutePath() : QString()},
    });
    QObject::connect(&engine, &QQmlApplicationEngine::objectCreationFailed, &app,
                     [] { QCoreApplication::exit(1); }, Qt::QueuedConnection);
    engine.loadFromModule("CloseNI", "Main");
    if (engine.rootObjects().isEmpty())
        return 1;
    if (testing) {
        auto *window = qobject_cast<QQuickWindow *>(engine.rootObjects().constFirst());
        QObject::connect(window, SIGNAL(selfTestShot(QString)), new ShotSaver(window), SLOT(save(QString)));
    }

    // Queued: an exit asked for before the event loop runs is ignored, and a
    // start that fails at once replies at once.
    if (parser.isSet(exitOnReady)) {
        QMetaObject::invokeMethod(&app, [&engine, ws = agentWorkspace, id = parser.value(provider)] {
            exitWhenReady(&engine, ws, id);
        }, Qt::QueuedConnection);
    }
    const int code = app.exec();
    if (testing && selfTestWarnings > 0) {
        std::fprintf(stderr, "CloseNI: self-test: %d warning(s)\n", selfTestWarnings);
        return 1;
    }
    return code;
}

#include "main.moc"
