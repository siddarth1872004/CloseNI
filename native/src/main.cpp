#include "AgentService.h"
#include "Bridge.h"

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
    // For tests only: no window; drive the services over stdin and stdout (see Bridge.h).
    const QCommandLineOption bridge(QStringLiteral("bridge"), QStringLiteral("Test harness: drive the services over stdin and stdout."));
    parser.addOptions({workspace, provider, start, exitOnReady, bridge});
    parser.process(app);

    QQmlApplicationEngine engine;
    if (parser.isSet(bridge)) {
        Bridge harness(&engine);
        return app.exec();
    }

    engine.setInitialProperties({
        {QStringLiteral("workspace"), QDir(parser.value(workspace)).absolutePath()},
        {QStringLiteral("provider"), parser.value(provider)},
        {QStringLiteral("autoStart"), parser.isSet(start)},
    });
    QObject::connect(&engine, &QQmlApplicationEngine::objectCreationFailed, &app,
                     [] { QCoreApplication::exit(1); }, Qt::QueuedConnection);
    engine.loadFromModule("CloseNI", "Main");
    if (engine.rootObjects().isEmpty())
        return 1;

    // Queued: an exit asked for before the event loop runs is ignored, and a
    // start that fails at once replies at once.
    if (parser.isSet(exitOnReady)) {
        QMetaObject::invokeMethod(&app, [&engine, ws = QDir(parser.value(workspace)).absolutePath(), id = parser.value(provider)] {
            exitWhenReady(&engine, ws, id);
        }, Qt::QueuedConnection);
    }
    return app.exec();
}
