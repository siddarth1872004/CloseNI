#include "NodeCompat.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJSValue>
#include <QJsonArray>
#include <QJsonObject>
#include <QLocale>

#include <cmath>
#include <limits>

namespace {

QString quote(const QString &s)
{
    QString out;
    out.reserve(s.size() + 2);
    out += QLatin1Char('"');
    for (qsizetype i = 0; i < s.size(); ++i) {
        const char16_t c = s.at(i).unicode();
        switch (c) {
        case u'"': out += QLatin1String("\\\""); continue;
        case u'\\': out += QLatin1String("\\\\"); continue;
        case u'\b': out += QLatin1String("\\b"); continue;
        case u'\f': out += QLatin1String("\\f"); continue;
        case u'\n': out += QLatin1String("\\n"); continue;
        case u'\r': out += QLatin1String("\\r"); continue;
        case u'\t': out += QLatin1String("\\t"); continue;
        default: break;
        }
        if (c < 0x20) {
            out += QStringLiteral("\\u%1").arg(uint(c), 4, 16, QLatin1Char('0'));
            continue;
        }
        // Well-formed JSON.stringify: a lone surrogate is escaped, a pair is kept.
        if (QChar::isHighSurrogate(c)) {
            if (i + 1 < s.size() && QChar::isLowSurrogate(s.at(i + 1).unicode())) {
                out += s.at(i);
                out += s.at(++i);
                continue;
            }
            out += QStringLiteral("\\u%1").arg(uint(c), 4, 16, QLatin1Char('0'));
            continue;
        }
        if (QChar::isLowSurrogate(c)) {
            out += QStringLiteral("\\u%1").arg(uint(c), 4, 16, QLatin1Char('0'));
            continue;
        }
        out += s.at(i);
    }
    out += QLatin1Char('"');
    return out;
}

/* Number.prototype.toString(), which JSON.stringify uses for finite numbers. */
QString number(double d)
{
    if (!std::isfinite(d))
        return QStringLiteral("null");
    if (d == 0)
        return QStringLiteral("0");
    QString sign;
    if (d < 0) {
        sign = QStringLiteral("-");
        d = -d;
    }
    // Shortest round-trip digits, then laid out by the ECMAScript rules.
    const QString e = QString::number(d, 'e', QLocale::FloatingPointShortest);
    const qsizetype at = e.indexOf(QLatin1Char('e'));
    QString digits = e.left(at);
    digits.remove(QLatin1Char('.'));
    while (digits.size() > 1 && digits.endsWith(QLatin1Char('0')))
        digits.chop(1);
    const int k = int(digits.size());
    const int n = e.mid(at + 1).toInt() + 1;
    QString out;
    if (k <= n && n <= 21) {
        out = digits + QString(n - k, QLatin1Char('0'));
    } else if (0 < n && n <= 21) {
        out = digits.left(n) + QLatin1Char('.') + digits.mid(n);
    } else if (-6 < n && n <= 0) {
        out = QStringLiteral("0.") + QString(-n, QLatin1Char('0')) + digits;
    } else {
        const int exp = n - 1;
        out = digits.left(1);
        if (k > 1)
            out += QLatin1Char('.') + digits.mid(1);
        out += QLatin1Char('e') + QString(exp < 0 ? QStringLiteral("-") : QStringLiteral("+")) + QString::number(std::abs(exp));
    }
    return sign + out;
}

QStringList orderedKeys(const QJsonObject &o, const QStringList &keyOrder)
{
    QStringList keys;
    for (const QString &k : keyOrder) {
        if (o.contains(k))
            keys << k;
    }
    for (auto it = o.begin(); it != o.end(); ++it) {
        if (!keyOrder.contains(it.key()))
            keys << it.key();
    }
    return keys;
}

void write(QString &out, const QJsonValue &v, const QStringList &keyOrder, int indent, const QString &pad)
{
    const QString inner = pad + QString(indent, QLatin1Char(' '));
    const QString nl = indent > 0 ? QStringLiteral("\n") : QString();
    const QString colon = indent > 0 ? QStringLiteral(": ") : QStringLiteral(":");
    switch (v.type()) {
    case QJsonValue::Null:
    case QJsonValue::Undefined:
        out += QLatin1String("null");
        return;
    case QJsonValue::Bool:
        out += v.toBool() ? QLatin1String("true") : QLatin1String("false");
        return;
    case QJsonValue::Double:
        out += number(v.toDouble());
        return;
    case QJsonValue::String:
        out += quote(v.toString());
        return;
    case QJsonValue::Array: {
        const QJsonArray a = v.toArray();
        if (a.isEmpty()) {
            out += QLatin1String("[]");
            return;
        }
        out += QLatin1Char('[') + nl;
        for (qsizetype i = 0; i < a.size(); ++i) {
            out += inner;
            write(out, a.at(i), keyOrder, indent, inner);
            if (i + 1 < a.size())
                out += QLatin1Char(',');
            out += nl;
        }
        out += pad + QLatin1Char(']');
        return;
    }
    case QJsonValue::Object: {
        const QJsonObject o = v.toObject();
        QStringList keys;
        for (const QString &k : orderedKeys(o, keyOrder)) {
            if (!o.value(k).isUndefined())
                keys << k;
        }
        if (keys.isEmpty()) {
            out += QLatin1String("{}");
            return;
        }
        out += QLatin1Char('{') + nl;
        for (qsizetype i = 0; i < keys.size(); ++i) {
            out += inner + quote(keys.at(i)) + colon;
            write(out, o.value(keys.at(i)), keyOrder, indent, inner);
            if (i + 1 < keys.size())
                out += QLatin1Char(',');
            out += nl;
        }
        out += pad + QLatin1Char('}');
        return;
    }
    }
}

double parseNumber(const QString &raw)
{
    const QString s = raw.trimmed();
    if (s.isEmpty())
        return 0;
    if (s == QLatin1String("Infinity") || s == QLatin1String("+Infinity"))
        return std::numeric_limits<double>::infinity();
    if (s == QLatin1String("-Infinity"))
        return -std::numeric_limits<double>::infinity();
    bool ok = false;
    if (s.startsWith(QLatin1String("0x"), Qt::CaseInsensitive)) {
        const qulonglong n = s.mid(2).toULongLong(&ok, 16);
        return ok ? double(n) : std::numeric_limits<double>::quiet_NaN();
    }
    // C locale, and only plain decimal syntax: "1e3" and ".5" are numbers to
    // JavaScript, "1,5" and "nan" are not.
    for (const QChar c : s) {
        if (!(c.isDigit() || c == QLatin1Char('.') || c == QLatin1Char('e') || c == QLatin1Char('E')
              || c == QLatin1Char('+') || c == QLatin1Char('-')))
            return std::numeric_limits<double>::quiet_NaN();
    }
    const double d = QLocale::c().toDouble(s, &ok);
    return ok ? d : std::numeric_limits<double>::quiet_NaN();
}

QString nodeError(const QString &path, const QString &syscall, const QFileDevice &f)
{
    const QFileInfo info(path);
    if (!info.exists() && !info.isSymLink())
        return QStringLiteral("ENOENT: no such file or directory, %1 '%2'").arg(syscall, path);
    if (info.isDir())
        return QStringLiteral("EISDIR: illegal operation on a directory, read");
    if (f.error() == QFileDevice::PermissionsError || f.error() == QFileDevice::OpenError)
        return QStringLiteral("EACCES: permission denied, %1 '%2'").arg(syscall, path);
    return QStringLiteral("EIO: %1, %2 '%3'").arg(f.errorString(), syscall, path);
}

}

namespace NodeCompat {

QString stringify(const QJsonValue &value, const QStringList &keyOrder, int indent)
{
    QString out;
    write(out, value, keyOrder, indent, QString());
    return out;
}

bool truthy(const QJsonValue &v)
{
    switch (v.type()) {
    case QJsonValue::Null:
    case QJsonValue::Undefined:
        return false;
    case QJsonValue::Bool:
        return v.toBool();
    case QJsonValue::Double: {
        const double d = v.toDouble();
        return d != 0 && !std::isnan(d);
    }
    case QJsonValue::String:
        return !v.toString().isEmpty();
    case QJsonValue::Array:
    case QJsonValue::Object:
        return true;
    }
    return false;
}

double toNumber(const QJsonValue &v)
{
    switch (v.type()) {
    case QJsonValue::Null:
        return 0;
    case QJsonValue::Undefined:
    case QJsonValue::Object:
        return std::numeric_limits<double>::quiet_NaN();
    case QJsonValue::Bool:
        return v.toBool() ? 1 : 0;
    case QJsonValue::Double:
        return v.toDouble();
    case QJsonValue::String:
        return parseNumber(v.toString());
    case QJsonValue::Array: {
        // Number([]) is 0, Number([5]) is 5, Number([1, 2]) is NaN.
        const QJsonArray a = v.toArray();
        if (a.isEmpty())
            return 0;
        if (a.size() > 1)
            return std::numeric_limits<double>::quiet_NaN();
        const QJsonValue only = a.first();
        if (only.isNull() || only.isUndefined())
            return 0;
        if (only.isString())
            return parseNumber(only.toString());
        if (only.isDouble())
            return only.toDouble();
        if (only.isArray())
            return toNumber(only);
        return std::numeric_limits<double>::quiet_NaN();
    }
    }
    return std::numeric_limits<double>::quiet_NaN();
}

QString str(const QJsonValue &v)
{
    return v.isString() ? v.toString() : QString();
}

double round(double n)
{
    return std::floor(n + 0.5);
}

QJsonValue fromVariant(const QVariant &v)
{
    if (!v.isValid())
        return QJsonValue(QJsonValue::Undefined);
    if (v.metaType() == QMetaType::fromType<QJSValue>()) {
        const QJSValue js = v.value<QJSValue>();
        if (js.isUndefined())
            return QJsonValue(QJsonValue::Undefined);
        return fromVariant(js.toVariant());
    }
    if (v.metaType() == QMetaType::fromType<std::nullptr_t>())
        return QJsonValue(QJsonValue::Null);
    if (v.metaType() == QMetaType::fromType<QVariantMap>()) {
        QJsonObject o;
        const QVariantMap m = v.toMap();
        for (auto it = m.begin(); it != m.end(); ++it)
            o.insert(it.key(), fromVariant(it.value()));
        return o;
    }
    if (v.metaType() == QMetaType::fromType<QVariantList>()) {
        QJsonArray a;
        for (const QVariant &item : v.toList()) {
            const QJsonValue j = fromVariant(item);
            a.append(j.isUndefined() ? QJsonValue(QJsonValue::Null) : j);
        }
        return a;
    }
    if (v.metaType() == QMetaType::fromType<QStringList>())
        return QJsonArray::fromStringList(v.toStringList());
    return QJsonValue::fromVariant(v);
}

QVariant toVariant(const QJsonValue &v)
{
    if (v.isNull())
        return QVariant::fromValue(nullptr);
    return v.toVariant();
}

bool readBytes(const QString &path, QByteArray *bytes, QString *error)
{
    QFile f(path);
    if (QFileInfo(path).isDir()) {
        if (error)
            *error = QStringLiteral("EISDIR: illegal operation on a directory, read");
        return false;
    }
    if (path.isEmpty() || !f.open(QIODevice::ReadOnly)) {
        if (error)
            *error = path.isEmpty() ? QStringLiteral("ENOENT: no such file or directory, open ''") : nodeError(path, QStringLiteral("open"), f);
        return false;
    }
    *bytes = f.readAll();
    return true;
}

bool readText(const QString &path, QString *text, QString *error)
{
    QByteArray bytes;
    if (!readBytes(path, &bytes, error))
        return false;
    *text = QString::fromUtf8(bytes);
    return true;
}

bool writeBytes(const QString &path, const QByteArray &bytes, QString *error)
{
    QFile f(path);
    if (QFileInfo(path).isDir()) {
        if (error)
            *error = QStringLiteral("EISDIR: illegal operation on a directory, open '%1'").arg(path);
        return false;
    }
    if (path.isEmpty() || !f.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        if (error) {
            *error = !QFileInfo(QFileInfo(path).absolutePath()).isDir() || path.isEmpty()
                ? QStringLiteral("ENOENT: no such file or directory, open '%1'").arg(path)
                : QStringLiteral("EACCES: permission denied, open '%1'").arg(path);
        }
        return false;
    }
    if (f.write(bytes) != bytes.size()) {
        if (error)
            *error = QStringLiteral("EIO: %1, write").arg(f.errorString());
        return false;
    }
    return true;
}

bool writeText(const QString &path, const QString &text, QString *error)
{
    return writeBytes(path, text.toUtf8(), error);
}

bool removeFile(const QString &path, QString *error)
{
    const QFileInfo info(path);
    if (!info.exists() && !info.isSymLink())
        return true;
    if (info.isDir() && !info.isSymLink()) {
        if (error)
            *error = QStringLiteral("Path is a directory: rm returned EISDIR (is a directory) %1").arg(path);
        return false;
    }
    QFile f(path);
    if (!f.remove()) {
        if (error)
            *error = QStringLiteral("EACCES: permission denied, unlink '%1'").arg(path);
        return false;
    }
    return true;
}

bool mkdirs(const QString &dir, QString *error)
{
    if (QFileInfo(dir).isDir())
        return true;
    if (QDir().mkpath(dir))
        return true;
    if (error)
        *error = QFileInfo(dir).exists() ? QStringLiteral("EEXIST: file already exists, mkdir '%1'").arg(dir)
                                         : QStringLiteral("EACCES: permission denied, mkdir '%1'").arg(dir);
    return false;
}

QString jsString(const QJsonValue &v)
{
    switch (v.type()) {
    case QJsonValue::Undefined:
        return QStringLiteral("undefined");
    case QJsonValue::Null:
        return QStringLiteral("null");
    case QJsonValue::Bool:
        return v.toBool() ? QStringLiteral("true") : QStringLiteral("false");
    case QJsonValue::Double:
        return stringify(v);
    case QJsonValue::String:
        return v.toString();
    case QJsonValue::Array: {
        QStringList parts;
        for (const QJsonValue &x : v.toArray())
            parts << (x.isNull() || x.isUndefined() ? QString() : jsString(x));
        return parts.join(QLatin1Char(','));
    }
    case QJsonValue::Object:
        return QStringLiteral("[object Object]");
    }
    return QString();
}

QString errorString(const QString &message)
{
    return QStringLiteral("Error: ") + message;
}

}
