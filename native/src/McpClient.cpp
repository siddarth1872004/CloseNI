#include "McpClient.h"

#include "NodeCompat.h"

#include <QCoreApplication>
#include <QFileInfo>
#include <QHash>
#include <QJsonArray>
#include <QJsonDocument>
#include <QPointer>
#include <QProcess>
#include <QStandardPaths>
#include <QTimer>

#include <exception>
#include <memory>

namespace Mcp {

namespace {

const QStringList kWireOrder = {
    QStringLiteral("jsonrpc"), QStringLiteral("id"), QStringLiteral("method"), QStringLiteral("params"),
    QStringLiteral("protocolVersion"), QStringLiteral("capabilities"), QStringLiteral("clientInfo"),
    QStringLiteral("name"), QStringLiteral("version"), QStringLiteral("arguments"),
};

struct RpcResult {
    bool ok = false;
    QJsonValue result;
    QString error;
};

/* `x.message || fallback`, as the JS read it off an error object. */
QString messageOf(const QJsonValue &error, const QString &fallback)
{
    const QJsonValue m = error.isObject() ? error.toObject().value(QStringLiteral("message")) : QJsonValue(QJsonValue::Undefined);
    return NodeCompat::truthy(m) ? NodeCompat::jsString(m) : fallback;
}

/* What Node's spawn error says for a command that will not start. */
QString spawnError(const QString &command)
{
    const QString found = command.contains(QLatin1Char('/')) ? command : QStandardPaths::findExecutable(command);
    const bool exists = !found.isEmpty() && QFileInfo::exists(found);
    return QStringLiteral("spawn ") + command + (exists ? QStringLiteral(" EACCES") : QStringLiteral(" ENOENT"));
}

/*
 * One request against a freshly started server: initialize, the initialized
 * notification, then `method`. Deletes itself once its process is gone.
 */
class Rpc : public QObject
{
public:
    Rpc(QObject *parent, const ServerSpec &server, const QString &method, const QJsonValue &params,
        int timeoutMs, std::function<void(const RpcResult &)> done)
        : QObject(parent)
        , m_server(server)
        , m_method(method)
        , m_params(params)
        , m_timeoutMs(timeoutMs)
        , m_done(std::move(done))
        , m_proc(new QProcess(this))
    {
    }

    void start()
    {
        m_timer.setSingleShot(true);
        QObject::connect(&m_timer, &QTimer::timeout, this, [this] {
            finish({false, {}, QStringLiteral("the MCP server timed out after %1ms").arg(m_timeoutMs)});
        });
        m_timer.start(m_timeoutMs);

        QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
        const QJsonObject extra = m_server.env;
        for (auto it = extra.begin(); it != extra.end(); ++it)
            env.insert(it.key(), NodeCompat::jsString(it.value()));
        m_proc->setProcessEnvironment(env);
        // Nothing reads the server's stderr, and a pipe nobody drains would
        // eventually stall a chatty server.
        m_proc->setStandardErrorFile(QProcess::nullDevice());

        QObject::connect(m_proc, &QProcess::errorOccurred, this, [this](QProcess::ProcessError e) {
            if (e == QProcess::FailedToStart)
                finish({false, {}, QStringLiteral("could not start the MCP server: ") + spawnError(m_server.command)});
        });
        QObject::connect(m_proc, &QProcess::finished, this, [this](int code, QProcess::ExitStatus status) {
            readLines();
            finish({false, {}, QStringLiteral("the MCP server exited (code ")
                                   + (status == QProcess::CrashExit ? QStringLiteral("null") : QString::number(code))
                                   + QStringLiteral(") before answering")});
        });
        QObject::connect(m_proc, &QProcess::readyReadStandardOutput, this, [this] { readLines(); });
        QObject::connect(m_proc, &QProcess::started, this, [this] { handshake(); });

        m_proc->start(m_server.command, m_server.args);
    }

private:
    void handshake()
    {
        send(QStringLiteral("initialize"),
             QJsonObject{{QStringLiteral("protocolVersion"), QStringLiteral("2024-11-05")},
                         {QStringLiteral("capabilities"), QJsonObject()},
                         {QStringLiteral("clientInfo"), QJsonObject{{QStringLiteral("name"), QStringLiteral("CloseNI")},
                                                                    {QStringLiteral("version"), QCoreApplication::applicationVersion()}}}},
             [this](const QJsonObject &init) {
                 if (m_settled)
                     return;
                 if (NodeCompat::truthy(init.value(QStringLiteral("error")))) {
                     finish({false, {}, QStringLiteral("initialize failed: ") + messageOf(init.value(QStringLiteral("error")), QString())});
                     return;
                 }
                 write(QJsonObject{{QStringLiteral("jsonrpc"), QStringLiteral("2.0")},
                                   {QStringLiteral("method"), QStringLiteral("notifications/initialized")}});
                 send(m_method, m_params, [this](const QJsonObject &answer) {
                     if (m_settled)
                         return;
                     if (NodeCompat::truthy(answer.value(QStringLiteral("error")))) {
                         finish({false, {}, messageOf(answer.value(QStringLiteral("error")), QStringLiteral("the server returned an error"))});
                         return;
                     }
                     finish({true, answer.value(QStringLiteral("result")), QString()});
                 });
             });
    }

    void write(const QJsonObject &message)
    {
        // A write to a server that has gone is reported by the finished handler.
        m_proc->write(NodeCompat::stringify(message, kWireOrder, 0).toUtf8() + '\n');
    }

    void send(const QString &method, const QJsonValue &params, std::function<void(const QJsonObject &)> answer)
    {
        const int id = m_nextId++;
        m_pending.insert(id, std::move(answer));
        write(QJsonObject{{QStringLiteral("jsonrpc"), QStringLiteral("2.0")}, {QStringLiteral("id"), id},
                          {QStringLiteral("method"), method}, {QStringLiteral("params"), params}});
    }

    void readLines()
    {
        if (m_settled)
            return;
        m_buffer += m_proc->readAllStandardOutput();
        qsizetype nl;
        while (!m_settled && (nl = m_buffer.indexOf('\n')) != -1) {
            const QByteArray line = m_buffer.left(nl);
            m_buffer.remove(0, nl + 1);
            if (line.trimmed().isEmpty())
                continue;
            // Malformed output is skipped rather than fatal: the timeout is what
            // eventually reports a server that only ever emits noise.
            QJsonParseError err;
            const QJsonDocument doc = QJsonDocument::fromJson(line, &err);
            if (err.error != QJsonParseError::NoError || !doc.isObject())
                continue;
            const QJsonObject msg = doc.object();
            const QJsonValue id = msg.value(QStringLiteral("id"));
            if (!id.isDouble() || id.toDouble() != double(id.toInt()))
                continue;
            auto waiter = m_pending.find(id.toInt());
            if (waiter == m_pending.end())
                continue;
            auto answer = std::move(waiter.value());
            m_pending.erase(waiter);
            answer(msg);
        }
    }

    void finish(const RpcResult &r)
    {
        if (m_settled)
            return;
        m_settled = true;
        m_timer.stop();
        m_pending.clear();
        auto done = std::move(m_done);
        // The process is stopped as Node's kill() stopped it: SIGTERM, with a
        // SIGKILL for one that ignores it. This object goes once it has.
        if (m_proc->state() == QProcess::NotRunning) {
            deleteLater();
        } else {
            QObject::disconnect(m_proc, nullptr, this, nullptr);
            QObject::connect(m_proc, &QProcess::finished, this, &QObject::deleteLater);
            QObject::connect(m_proc, &QProcess::errorOccurred, this, [this](QProcess::ProcessError e) {
                if (e == QProcess::FailedToStart)
                    deleteLater();
            });
            m_proc->terminate();
            QPointer<QProcess> proc = m_proc;
            QTimer::singleShot(3000, this, [proc] {
                if (proc && proc->state() != QProcess::NotRunning)
                    proc->kill();
            });
        }
        if (done)
            done(r);
    }

    ServerSpec m_server;
    QString m_method;
    QJsonValue m_params;
    int m_timeoutMs;
    std::function<void(const RpcResult &)> m_done;
    QProcess *m_proc;
    QTimer m_timer;
    bool m_settled = false;
    QByteArray m_buffer;
    int m_nextId = 1;
    QHash<int, std::function<void(const QJsonObject &)>> m_pending;
};

void rpc(QObject *context, const ServerSpec &server, const QString &method, const QJsonValue &params,
         int timeoutMs, std::function<void(const RpcResult &)> done)
{
    auto *call = new Rpc(context, server, method, params, timeoutMs, std::move(done));
    call->start();
}

}

QString textFromResult(const QJsonValue &result)
{
    if (!result.isObject())
        return {};
    const QJsonValue content = result.toObject().value(QStringLiteral("content"));
    if (!content.isArray())
        return {};
    QStringList parts;
    for (const QJsonValue &c : content.toArray()) {
        const QJsonObject o = c.toObject();
        if (c.isObject() && o.value(QStringLiteral("type")) == QJsonValue(QStringLiteral("text"))
            && o.value(QStringLiteral("text")).isString())
            parts << o.value(QStringLiteral("text")).toString();
    }
    return parts.join(QLatin1Char('\n'));
}

void callTool(QObject *context, const ServerSpec &server, const QString &tool, const QJsonValue &args,
              int timeoutMs, std::function<void(const ToolResult &)> done)
{
    const QJsonObject params{{QStringLiteral("name"), tool},
                             {QStringLiteral("arguments"), NodeCompat::truthy(args) ? args : QJsonValue(QJsonObject())}};
    rpc(context, server, QStringLiteral("tools/call"), params, timeoutMs, [done](const RpcResult &r) {
        if (!r.ok) {
            done({false, QString(), r.error});
            return;
        }
        const QString text = textFromResult(r.result);

        // A tool failure arrives as a SUCCESSFUL JSON-RPC result carrying
        // isError, with the message as ordinary text content. JSON-RPC's own
        // error field is reserved for protocol failures, so checking only that
        // misses every tool that ran and went wrong.
        //
        // Found against @modelcontextprotocol/server-everything: asking for a
        // tool that does not exist returned ok:true with "MCP error -32602: Tool
        // not found" as the text, which this app would then have folded into
        // every step's prompt as if it were fetched context. The scripted fake
        // could not have shown it - it only ever returned a JSON-RPC error,
        // because that is what I assumed.
        if (r.result.isObject() && NodeCompat::truthy(r.result.toObject().value(QStringLiteral("isError")))) {
            done({false, QString(), text.isEmpty() ? QStringLiteral("the tool reported an error") : text});
            return;
        }
        if (!text.isEmpty())
            done({true, text, QString()});
        else
            done({false, QString(), QStringLiteral("the tool returned no text content")});
    });
}

void listTools(QObject *context, const ServerSpec &server, int timeoutMs,
               std::function<void(bool ok, const QStringList &tools, const QString &error)> done)
{
    rpc(context, server, QStringLiteral("tools/list"), QJsonObject(), timeoutMs, [done](const RpcResult &r) {
        if (!r.ok) {
            done(false, {}, r.error);
            return;
        }
        QStringList tools;
        const QJsonValue list = r.result.isObject() ? r.result.toObject().value(QStringLiteral("tools")) : QJsonValue();
        for (const QJsonValue &t : list.toArray()) {
            const QJsonValue name = t.toObject().value(QStringLiteral("name"));
            if (name.isString() && !name.toString().isEmpty())
                tools << name.toString();
        }
        done(true, tools, QString());
    });
}

Config parseMcpConfig(const QString &raw)
{
    QJsonParseError err;
    const QJsonDocument doc = QJsonDocument::fromJson(raw.toUtf8(), &err);
    if (err.error != QJsonParseError::NoError)
        return {};
    return parseMcpConfig(doc.isObject() ? QJsonValue(doc.object()) : QJsonValue(doc.array()));
}

Config parseMcpConfig(const QJsonValue &raw)
{
    if (raw.isString())
        return parseMcpConfig(raw.toString());
    if (!raw.isObject())
        return {};
    const QJsonObject obj = raw.toObject();

    Config config;
    const QJsonObject src = obj.value(QStringLiteral("servers")).toObject();
    for (auto it = src.begin(); it != src.end(); ++it) {
        const QJsonObject s = it.value().toObject();
        const QJsonValue command = s.value(QStringLiteral("command"));
        if (!command.isString() || command.toString().trimmed().isEmpty())
            continue;
        ServerSpec spec;
        spec.command = command.toString().trimmed();
        for (const QJsonValue &a : s.value(QStringLiteral("args")).toArray())
            if (a.isString())
                spec.args << a.toString();
        const QJsonValue env = s.value(QStringLiteral("env"));
        if (env.isObject()) {
            spec.env = env.toObject();
        } else if (env.isArray()) {
            // Object.assign({}, process.env, [..]) adds the indices as keys.
            const QJsonArray a = env.toArray();
            for (qsizetype i = 0; i < a.size(); ++i)
                spec.env.insert(QString::number(i), a.at(i));
        }
        config.servers.insert(it.key(), spec);
    }

    for (const QJsonValue &v : obj.value(QStringLiteral("calls")).toArray()) {
        const QJsonObject c = v.toObject();
        if (!v.isObject() || !c.value(QStringLiteral("server")).isString() || !c.value(QStringLiteral("tool")).isString())
            continue;
        const QJsonValue args = c.value(QStringLiteral("args"));
        config.calls << Call{c.value(QStringLiteral("server")).toString(), c.value(QStringLiteral("tool")).toString(),
                             NodeCompat::truthy(args) ? args : QJsonValue(QJsonObject()), ServerSpec()};
    }
    return config;
}

QList<Call> planCalls(const Config &config)
{
    QList<Call> out;
    for (const Call &c : config.calls) {
        auto server = config.servers.constFind(c.server);
        if (server == config.servers.constEnd())
            continue;
        Call planned = c;
        planned.spec = server.value();
        out << planned;
    }
    return out;
}

void gatherContext(const Config &config, Runner run,
                   std::function<void(const QStringList &texts, const QStringList &notes)> done)
{
    struct State {
        QList<Call> calls;
        QStringList texts;
        QStringList notes;
        Runner run;
        std::function<void(const QStringList &, const QStringList &)> done;
        std::function<void(qsizetype)> step;
    };
    auto state = std::make_shared<State>();
    state->calls = planCalls(config);
    state->run = std::move(run);
    state->done = std::move(done);
    std::weak_ptr<State> weak = state;
    state->step = [weak](qsizetype i) {
        auto s = weak.lock();
        if (!s)
            return;
        if (i >= s->calls.size()) {
            auto finished = std::move(s->done);
            const QStringList texts = s->texts, notes = s->notes;
            finished(texts, notes);
            return;
        }
        const Call call = s->calls.at(i);
        const QString label = call.server + QLatin1Char('/') + call.tool + QStringLiteral(": ");
        try {
            s->run(call.spec, call.tool, call.args, [s, i, label](const ToolResult &r) {
                if (r.ok && !r.text.isEmpty())
                    s->texts << r.text;
                else
                    s->notes << label + (r.error.isEmpty() ? QStringLiteral("no text returned") : r.error);
                s->step(i + 1);
            });
        } catch (const std::exception &e) {
            s->notes << label + QString::fromUtf8(e.what());
            s->step(i + 1);
        }
    };
    // A pending call's callback holds the state; the step function holds it
    // only weakly, so the two do not keep each other alive.
    state->step(0);
}

Runner processRunner(QObject *context)
{
    QPointer<QObject> owner = context;
    return [owner](const ServerSpec &spec, const QString &tool, const QJsonValue &args,
                   std::function<void(const ToolResult &)> done) {
        if (!owner)
            return;
        callTool(owner, spec, tool, args, kTimeoutMs, std::move(done));
    };
}

}
