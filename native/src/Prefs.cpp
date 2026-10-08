#include "Prefs.h"

#include "LocalStorageImport.h"
#include "Paths.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QSaveFile>
#include <QTimer>

Prefs::Prefs(QObject *parent)
    : QObject(parent)
    , m_file(QDir(Paths::storageRoot()).filePath(QStringLiteral("native-prefs.json")))
{
    QFile f(m_file);
    if (f.open(QIODevice::ReadOnly)) {
        m_values = QJsonDocument::fromJson(f.readAll()).object();
        return;
    }
    if (f.exists())
        return;

    // First run: carry the Electron app's settings over, once. Read-only and
    // best-effort (LocalStorageImport.h); once anything is saved here, that
    // database is never read again.
    const QMap<QString, QString> imported = LocalStorageImport::read(
        QDir(Paths::storageRoot()).filePath(QStringLiteral("Local Storage/leveldb")));
    for (auto it = imported.cbegin(); it != imported.cend(); ++it)
        m_values.insert(it.key(), it.value());
    if (!m_values.isEmpty())
        save();
}

Prefs::~Prefs()
{
    if (m_savePending)
        save();
}

QString Prefs::get(const QString &key, const QString &fallback) const
{
    const QJsonValue v = m_values.value(key);
    return v.isString() ? v.toString() : fallback;
}

void Prefs::set(const QString &key, const QString &value)
{
    if (m_values.value(key) == QJsonValue(value))
        return;
    m_values.insert(key, value);
    scheduleSave();
    emit changed(key);
}

void Prefs::remove(const QString &key)
{
    if (!m_values.contains(key))
        return;
    m_values.remove(key);
    scheduleSave();
    emit changed(key);
}

void Prefs::scheduleSave()
{
    if (m_savePending)
        return;
    m_savePending = true;
    QTimer::singleShot(0, this, &Prefs::save);
}

void Prefs::save()
{
    m_savePending = false;
    QDir().mkpath(QFileInfo(m_file).absolutePath());
    // Written whole and renamed into place, so a crash mid-write cannot leave
    // half a file that loses every setting.
    QSaveFile f(m_file);
    if (!f.open(QIODevice::WriteOnly))
        return;
    f.write(QJsonDocument(m_values).toJson(QJsonDocument::Indented));
    f.commit();
}
