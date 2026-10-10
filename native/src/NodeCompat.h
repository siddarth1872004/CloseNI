#pragma once

#include <QByteArray>
#include <QJsonValue>
#include <QString>
#include <QStringList>
#include <QVariant>

/*
 * The few Node behaviours the ported main-process code leans on, so the native
 * services write the same files and answer with the same shapes.
 *
 * - JSON.stringify(value, null, 2): the workspace files (build.json,
 *   closeni.run.json) are shared with the agent and are often committed, so
 *   they are written byte for byte as Node writes them.
 *   QJsonDocument sorts keys; `keyOrder` restores the order the JS objects
 *   were built in.
 * - JavaScript truthiness and Number(), which the ported guards are written in.
 * - fs.readFileSync / writeFileSync / rmSync({force}) with Node-style messages.
 */
namespace NodeCompat {

/*
 * JSON.stringify(value, null, indent). Object keys listed in `keyOrder` come
 * first, in that order, at every depth; any others follow in sorted order.
 */
QString stringify(const QJsonValue &value, const QStringList &keyOrder = {}, int indent = 2);

/* `!!v` */
bool truthy(const QJsonValue &v);
/* Number(v); NaN where JavaScript gives NaN. */
double toNumber(const QJsonValue &v);
/* typeof v === "string" ? v : "" */
QString str(const QJsonValue &v);
/* Math.round */
double round(double n);

/* A JS value from QML (QVariant, possibly wrapping a QJSValue) as JSON. */
QJsonValue fromVariant(const QVariant &v);
/* For Js::reply: null stays null rather than becoming undefined. */
QVariant toVariant(const QJsonValue &v);

/* fs.readFileSync(path, "utf-8"). False and `error` set on failure. */
bool readText(const QString &path, QString *text, QString *error = nullptr);
/* fs.readFileSync(path) */
bool readBytes(const QString &path, QByteArray *bytes, QString *error = nullptr);
/* fs.writeFileSync(path, text) */
bool writeText(const QString &path, const QString &text, QString *error = nullptr);
bool writeBytes(const QString &path, const QByteArray &bytes, QString *error = nullptr);
/* fs.rmSync(path, { force: true }): a missing file is fine, a directory is not. */
bool removeFile(const QString &path, QString *error = nullptr);
/* fs.mkdirSync(dir, { recursive: true }) */
bool mkdirs(const QString &dir, QString *error = nullptr);

/* String(v), as JavaScript would concatenate it into a path or message. */
QString jsString(const QJsonValue &v);

/* String(e) for an Error: "Error: <message>". */
QString errorString(const QString &message);

}
