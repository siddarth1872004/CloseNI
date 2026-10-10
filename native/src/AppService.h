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
    /* The OS asked for less motion: CSS's prefers-reduced-motion, which the
       stylesheet honoured by stopping every animation. */
    Q_PROPERTY(bool reducedMotion READ reducedMotion NOTIFY reducedMotionChanged)

public:
    explicit AppService(QObject *parent = nullptr);
    ~AppService() override;

    QString platform() const;
    QString version() const;
    QString storageRoot() const;
    bool reducedMotion() const { return m_reducedMotion; }

    /* A web page or a mailto: link, in the system's handler. */
    Q_INVOKABLE bool openExternal(const QString &url);
    /* A file or folder in the system's file manager. */
    Q_INVOKABLE bool openPath(const QString &path);
    Q_INVOKABLE void copyText(const QString &text);

signals:
    void reducedMotionChanged();

private:
    void readReducedMotion();
    bool m_reducedMotion = false;
};
