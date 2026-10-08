#pragma once

/*
 * Shared by the data-backend suites.
 *
 * CHECK counts every assertion, so a suite's total can be compared with the
 * JavaScript checks it translates (the local-agent/test .cjs suites). Harness drives a
 * service the way QML does: through a JS engine, with a callback, so the reply
 * is the value QML would see - JSON.stringify'd, so a null that became
 * undefined on the way would show.
 */
#include <QCoreApplication>
#include <QDeadlineTimer>
#include <QDir>
#include <QFile>
#include <QJSEngine>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QTemporaryDir>
#include <QTest>

inline int &checkCount()
{
    static int n = 0;
    return n;
}

#define CHECK(cond) \
    do { \
        ++checkCount(); \
        QVERIFY2((cond), #cond); \
    } while (false)

#define CHECK2(cond, detail) \
    do { \
        ++checkCount(); \
        QVERIFY2((cond), qPrintable(QStringLiteral(#cond " -- ") + (detail))); \
    } while (false)

#define REPORT_CHECKS() qInfo("checks passed: %d", checkCount())

/* A scratch storage root for the whole suite: Paths::storageRoot() reads it. */
class ScratchStorage
{
public:
    ScratchStorage()
    {
        qputenv("CLOSENI_STORAGE", m_dir.path().toUtf8());
    }
    QString path() const { return m_dir.path(); }
    QString file(const QString &rel) const { return QDir(m_dir.path()).filePath(rel); }

private:
    QTemporaryDir m_dir;
};

class Harness
{
public:
    Harness()
    {
        engine.evaluate(QStringLiteral(
            "var __replies = [];"
            "function __cb(r) { __replies.push(r === undefined ? '\"<undefined>\"' : JSON.stringify(r)); }"));
    }

    void expose(const QString &name, QObject *service)
    {
        QJSEngine::setObjectOwnership(service, QJSEngine::CppOwnership);
        engine.globalObject().setProperty(name, engine.newQObject(service));
    }

    /*
     * Evaluate `code`, in which `cb` is the reply callback, and wait for one
     * reply. Undefined when none came, or the code threw.
     */
    QJsonValue call(const QString &code, int timeoutMs = 15000)
    {
        const int before = count();
        const QJSValue r = engine.evaluate(QStringLiteral("(function () { var cb = __cb; ") + code + QStringLiteral("; })()"));
        if (r.isError()) {
            qWarning() << "JS error:" << r.toString();
            return QJsonValue(QJsonValue::Undefined);
        }
        QDeadlineTimer deadline(timeoutMs);
        while (count() == before && !deadline.hasExpired())
            QTest::qWait(5);
        if (count() == before)
            return QJsonValue(QJsonValue::Undefined);
        lastText = engine.evaluate(QStringLiteral("__replies[__replies.length - 1]")).toString();
        return QJsonDocument::fromJson("[" + lastText.toUtf8() + "]").array().at(0);
    }

    int count() { return engine.evaluate(QStringLiteral("__replies.length")).toInt(); }

    QJSEngine engine;
    QString lastText;
};

inline QString readAll(const QString &path)
{
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly))
        return QString();
    return QString::fromUtf8(f.readAll());
}

inline bool writeAll(const QString &path, const QByteArray &bytes)
{
    QDir().mkpath(QFileInfo(path).absolutePath());
    QFile f(path);
    if (!f.open(QIODevice::WriteOnly))
        return false;
    return f.write(bytes) == bytes.size();
}

inline QString compact(const QJsonValue &v)
{
    if (v.isObject())
        return QString::fromUtf8(QJsonDocument(v.toObject()).toJson(QJsonDocument::Compact));
    if (v.isArray())
        return QString::fromUtf8(QJsonDocument(v.toArray()).toJson(QJsonDocument::Compact));
    return QJsonDocument(QJsonArray{v}).toJson(QJsonDocument::Compact).mid(1).chopped(1);
}

/*
 * A reply as JSON text, parsed. Compared by value: a QVariantMap reply
 * serialises its keys sorted, where Electron kept insertion order, and no
 * caller reads the order.
 */
inline QJsonValue J(const char *text)
{
    return QJsonDocument::fromJson(QByteArray("[") + text + "]").array().at(0);
}

/* The repository checkout, for fixtures. */
inline QString repoRoot()
{
    const QString env = qEnvironmentVariable("CLOSENI_REPO");
    return env.isEmpty() ? QDir::currentPath() : QDir::cleanPath(env);
}
