#pragma once

#include <QJsonObject>
#include <QObject>
#include <QQmlEngine>
#include <QVariant>

/*
 * The app's settings: string values under "closeni.*" keys, kept in
 * <storage>/native-prefs.json.
 *
 * Writes are batched to the next turn of the event loop, so a burst of set()
 * calls costs one write.
 */
class Prefs : public QObject
{
    Q_OBJECT
    QML_ELEMENT
    QML_SINGLETON

public:
    explicit Prefs(QObject *parent = nullptr);
    ~Prefs() override;

    /* The stored string, or `fallback` when there is none. */
    Q_INVOKABLE QString get(const QString &key, const QString &fallback = QString()) const;
    Q_INVOKABLE void set(const QString &key, const QString &value);
    Q_INVOKABLE void remove(const QString &key);

signals:
    /* Any key changed: bindings that depend on a value re-read it. */
    void changed(const QString &key);

private:
    void scheduleSave();
    void save();

    QJsonObject m_values;
    QString m_file;
    bool m_savePending = false;
};
