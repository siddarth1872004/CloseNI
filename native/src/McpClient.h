#pragma once

#include <QJsonObject>
#include <QJsonValue>
#include <QList>
#include <QMap>
#include <QString>
#include <QStringList>

#include <functional>

class QObject;

/*
 * MCP over stdio, and the calls a build makes with it.
 *
 * Ports local-agent/src/mcp/mcp-client.ts and mcp-context.ts, so gathering
 * context before a build needs no Node process of its own. The agent keeps the
 * TypeScript copies; change both together.
 *
 * This needs exactly three methods - initialize, tools/list, tools/call -
 * against a well-specified protocol. Nothing here fails at the caller. A server
 * that will not start, one that answers with an error, one that never answers
 * at all: each comes back as ok:false with a message. A build must not fail
 * because an optional context source was unavailable - the model simply gets
 * less context.
 */
namespace Mcp {

inline constexpr int kTimeoutMs = 20000;

struct ServerSpec {
    QString command;
    QStringList args;
    QJsonObject env;
};

struct ToolResult {
    bool ok = false;
    QString text;
    QString error;
};

struct Call {
    QString server;
    QString tool;
    QJsonValue args;
    ServerSpec spec; // set by planCalls
};

struct Config {
    QMap<QString, ServerSpec> servers;
    QList<Call> calls;
};

/* The text blocks of an MCP tool result. Pure, so it is tested directly. */
QString textFromResult(const QJsonValue &result);

/*
 * One tools/call against a freshly started server.
 *
 * A process per call, deliberately. Keeping servers alive between calls means
 * owning their lifetime - restarting a crashed one, killing them when a build
 * ends, deciding what happens when the app closes mid-call - and these calls
 * happen once per build. A subprocess launch is cheaper than a process pool.
 *
 * `context` owns the process: if it goes, the call goes with it, unanswered.
 */
void callTool(QObject *context, const ServerSpec &server, const QString &tool, const QJsonValue &args,
              int timeoutMs, std::function<void(const ToolResult &)> done);

/*
 * What tools a server offers. callTool does not use it - a configured call
 * already names its tool - but a settings screen needs it to show the user
 * what they can call.
 */
void listTools(QObject *context, const ServerSpec &server, int timeoutMs,
               std::function<void(bool ok, const QStringList &tools, const QString &error)> done);

/* Anything unreadable is "no MCP configured", which is the common case. */
Config parseMcpConfig(const QJsonValue &raw);
Config parseMcpConfig(const QString &raw);

/* Only calls whose server actually exists, each carrying its server's spec. */
QList<Call> planCalls(const Config &config);

using Runner = std::function<void(const ServerSpec &, const QString &tool, const QJsonValue &args,
                                  std::function<void(const ToolResult &)> done)>;

/*
 * Run every planned call, one after another, and collect the text.
 *
 * Once per build, not per step. A schema or a page of documentation does not
 * change while a build runs, and re-fetching it twenty times would cost twenty
 * subprocess launches for identical text.
 *
 * `run` is injectable so the decisions here are tested without a subprocess.
 * Nothing propagates: a failure becomes a note, and the build gets less
 * context rather than no build.
 */
void gatherContext(const Config &config, Runner run,
                   std::function<void(const QStringList &texts, const QStringList &notes)> done);

/* The real runner: callTool with the default timeout, owned by `context`. */
Runner processRunner(QObject *context);

}
