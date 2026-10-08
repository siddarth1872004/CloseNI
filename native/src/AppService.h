#pragma once

#include <QObject>
#include <QQmlEngine>
#include <QString>

/*
 * What the renderer got from Electron itself: the platform, the version,
 * opening links in the system browser and copying text.
 */
class AppService : public QObject
{
    Q_OBJECT
    QML_NAMED_ELEMENT(App)
    QML_SINGLETON

    /* "win32", "darwin" or "linux", as process.platform said in the renderer. */
    Q_PROPERTY(QString platform READ platform CONSTANT)
    Q_PROPERTY(QString version READ version CONSTANT)
    Q_PROPERTY(QString storageRoot READ storageRoot CONSTANT)

public:
    explicit AppService(QObject *parent = nullptr);

    QString platform() const;
    QString version() const;
    QString storageRoot() const;

    /* A web page or a mailto: link, in the system's handler. */
    Q_INVOKABLE bool openExternal(const QString &url);
    /* A file or folder in the system's file manager. */
    Q_INVOKABLE bool openPath(const QString &path);
    Q_INVOKABLE void copyText(const QString &text);
};
