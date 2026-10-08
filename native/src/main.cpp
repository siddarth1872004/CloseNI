#include "AgentProcess.h"

#include <QCommandLineParser>
#include <QDir>
#include <QGuiApplication>
#include <QJsonDocument>
#include <QJsonObject>
#include <QQmlApplicationEngine>
#include <QQuickStyle>

#include <cstdio>

namespace {

void print(const QString &line)
{
    std::fprintf(stdout, "%s\n", qPrintable(line));
    std::fflush(stdout);
}

/*
 * --exit-on-ready: report the session on stdout, close it once it is ready,
 * and exit 0 when it has closed, or 1 at once if it failed.
 */
void exitWhenReady(AgentProcess *agent)
{
    QObject::connect(agent, &AgentProcess::logLine, agent, [](const QString &line) { print("[agent] " + line); });
    auto check = [agent] {
        if (agent->status() == QStringLiteral("ready")) {
            const QJsonDocument info(QJsonObject::fromVariantMap(agent->readyInfo()));
            print("CloseNI: agent ready " + QString::fromUtf8(info.toJson(QJsonDocument::Compact)));
            agent->close();
        } else if (agent->status() == QStringLiteral("failed")) {
            print("CloseNI: agent failed: " + agent->error());
            QCoreApplication::exit(1);
        } else if (agent->status() == QStringLiteral("idle") && !agent->readyInfo().isEmpty()) {
            QCoreApplication::exit(0);
        }
    };
    QObject::connect(agent, &AgentProcess::statusChanged, agent, check);
    // A start that failed at once did so while the window was loading, and an
    // exit asked for before the event loop runs is ignored, so look once it is.
    QMetaObject::invokeMethod(agent, check, Qt::QueuedConnection);
}

}

int main(int argc, char *argv[])
{
    QGuiApplication app(argc, argv);
    QGuiApplication::setApplicationName(QStringLiteral("CloseNI"));
    QGuiApplication::setApplicationVersion(QStringLiteral(CLOSENI_VERSION));
    // Matches closeni.desktop, so Wayland shells show the app's icon.
    QGuiApplication::setDesktopFileName(QStringLiteral("closeni"));
    // Packages ship the Basic style only (native/package/stage.mjs). Without
    // this, an `import QtQuick.Controls` or the dialogs would pick the
    // platform's default style (Fusion, FluentWinUI3, macOS), which is not there.
    QQuickStyle::setStyle(QStringLiteral("Basic"));

    QCommandLineParser parser;
    parser.setApplicationDescription(QStringLiteral("CloseNI, the native app"));
    parser.addHelpOption();
    parser.addVersionOption();
    const QCommandLineOption workspace(QStringLiteral("workspace"), QStringLiteral("Project folder for the agent."),
                                       QStringLiteral("dir"), QDir::homePath());
    const QCommandLineOption provider(QStringLiteral("provider"), QStringLiteral("Provider id."),
                                      QStringLiteral("id"), QStringLiteral("deepseek"));
    const QCommandLineOption start(QStringLiteral("start"), QStringLiteral("Start the agent session on launch."));
    // For CI and scripts: the process exit code says whether the session came up.
    const QCommandLineOption exitOnReady(QStringLiteral("exit-on-ready"),
                                         QStringLiteral("Start the session, then exit 0 once it is ready or 1 if it fails."));
    parser.addOptions({workspace, provider, start, exitOnReady});
    parser.process(app);

    QQmlApplicationEngine engine;
    engine.setInitialProperties({
        {QStringLiteral("workspace"), QDir(parser.value(workspace)).absolutePath()},
        {QStringLiteral("provider"), parser.value(provider)},
        {QStringLiteral("autoStart"), parser.isSet(start) || parser.isSet(exitOnReady)},
    });
    QObject::connect(&engine, &QQmlApplicationEngine::objectCreationFailed, &app,
                     [] { QCoreApplication::exit(1); }, Qt::QueuedConnection);
    engine.loadFromModule("CloseNI", "Main");
    if (engine.rootObjects().isEmpty())
        return 1;

    if (parser.isSet(exitOnReady)) {
        auto *agent = engine.rootObjects().constFirst()->findChild<AgentProcess *>();
        if (!agent) {
            print("CloseNI: no agent in the window");
            return 1;
        }
        exitWhenReady(agent);
    }
    return app.exec();
}
