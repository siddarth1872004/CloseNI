#pragma once

/*
 * A stand-in for api.github.com on 127.0.0.1, aimed at with CLOSENI_GITHUB_API,
 * so no suite ever reaches GitHub. `respond` maps a request to a status and a
 * body; every request is recorded.
 */
#include <QHash>
#include <QMap>
#include <QNetworkProxy>
#include <QObject>
#include <QTcpServer>
#include <QTcpSocket>

#include <functional>

class MockGitHub : public QObject
{
public:
    struct Request {
        QString method;
        QString path;
        QMap<QString, QString> headers; // names lower-cased
        QByteArray body;
    };
    struct Response {
        int status = 200;
        QByteArray body;
    };

    explicit MockGitHub(std::function<Response(const Request &)> respond)
        : m_respond(std::move(respond))
    {
        QNetworkProxy::setApplicationProxy(QNetworkProxy::NoProxy);
        m_server.listen(QHostAddress::LocalHost);
        connect(&m_server, &QTcpServer::newConnection, this, [this] {
            while (QTcpSocket *s = m_server.nextPendingConnection()) {
                s->setParent(this);
                connect(s, &QTcpSocket::readyRead, this, [this, s] { onData(s); });
            }
        });
        qputenv("CLOSENI_GITHUB_API", url().toUtf8());
    }

    ~MockGitHub() override { qunsetenv("CLOSENI_GITHUB_API"); }

    QString url() const { return QStringLiteral("http://127.0.0.1:%1").arg(m_server.serverPort()); }

    QList<Request> requests;

private:
    void onData(QTcpSocket *s)
    {
        QByteArray &buf = m_buffers[s];
        buf += s->readAll();
        const qsizetype headerEnd = buf.indexOf("\r\n\r\n");
        if (headerEnd < 0)
            return;
        Request r;
        const QList<QByteArray> lines = buf.left(headerEnd).split('\n');
        const QList<QByteArray> first = lines.value(0).trimmed().split(' ');
        r.method = QString::fromLatin1(first.value(0));
        r.path = QString::fromLatin1(first.value(1));
        for (qsizetype i = 1; i < lines.size(); ++i) {
            const qsizetype colon = lines[i].indexOf(':');
            if (colon > 0)
                r.headers.insert(QString::fromLatin1(lines[i].left(colon)).trimmed().toLower(),
                                 QString::fromLatin1(lines[i].mid(colon + 1)).trimmed());
        }
        const qsizetype length = r.headers.value(QStringLiteral("content-length")).toLongLong();
        if (buf.size() < headerEnd + 4 + length)
            return;
        r.body = buf.mid(headerEnd + 4, length);
        m_buffers.remove(s);
        requests << r;
        const Response res = m_respond(r);
        s->write("HTTP/1.1 " + QByteArray::number(res.status)
                 + " Mock\r\nContent-Type: application/json\r\nContent-Length: " + QByteArray::number(res.body.size())
                 + "\r\nConnection: close\r\n\r\n" + res.body);
        s->disconnectFromHost();
    }

    QTcpServer m_server;
    QHash<QTcpSocket *, QByteArray> m_buffers;
    std::function<Response(const Request &)> m_respond;
};
