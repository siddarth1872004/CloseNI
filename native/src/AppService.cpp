#include "AppService.h"

#include "Paths.h"

#include <QClipboard>
#include <QDesktopServices>
#include <QDir>
#include <QGuiApplication>
#include <QProcess>
#include <QSettings>
#include <QStandardPaths>
#include <QUrl>

#ifdef Q_OS_WIN
#include <windows.h>
#endif

AppService::AppService(QObject *parent)
    : QObject(parent)
{
    readReducedMotion();
}

/*
 * Where Chromium read prefers-reduced-motion on each platform, read once at
 * start. CLOSENI_REDUCED_MOTION=1 or 0 overrides it (for testing, or for a
 * desktop the lookup does not know).
 */
void AppService::readReducedMotion()
{
    const QByteArray forced = qgetenv("CLOSENI_REDUCED_MOTION");
    if (!forced.isEmpty()) {
        m_reducedMotion = forced != "0";
        return;
    }
#if defined(Q_OS_WIN)
    // "Show animations in Windows" (SPI_GETCLIENTAREAANIMATION); off means reduce.
    BOOL on = TRUE;
    if (SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &on, 0))
        m_reducedMotion = !on;
#elif defined(Q_OS_MACOS)
    // Accessibility, Display, Reduce motion.
    const QSettings ua(QDir::homePath() + QStringLiteral("/Library/Preferences/com.apple.universalaccess.plist"),
                       QSettings::NativeFormat);
    m_reducedMotion = ua.value(QStringLiteral("reduceMotion")).toBool();
#else
    // GTK's gtk-enable-animations, which GNOME keeps in gsettings. Asked in
    // the background so start-up never waits on it; a desktop without
    // gsettings simply keeps the motion.
    const QString gsettings = QStandardPaths::findExecutable(QStringLiteral("gsettings"));
    if (gsettings.isEmpty())
        return;
    auto *p = new QProcess(this);
    connect(p, &QProcess::finished, this, [this, p](int code, QProcess::ExitStatus status) {
        const bool reduce = status == QProcess::NormalExit && code == 0
                            && p->readAllStandardOutput().trimmed() == "false";
        p->deleteLater();
        if (reduce != m_reducedMotion) {
            m_reducedMotion = reduce;
            emit reducedMotionChanged();
        }
    });
    connect(p, &QProcess::errorOccurred, p, &QObject::deleteLater);
    p->start(gsettings, {QStringLiteral("get"), QStringLiteral("org.gnome.desktop.interface"),
                         QStringLiteral("enable-animations")});
#endif
}

QString AppService::platform() const
{
#if defined(Q_OS_WIN)
    return QStringLiteral("win32");
#elif defined(Q_OS_MACOS)
    return QStringLiteral("darwin");
#else
    return QStringLiteral("linux");
#endif
}

QString AppService::version() const
{
    return QStringLiteral(CLOSENI_VERSION);
}

QString AppService::storageRoot() const
{
    return Paths::storageRoot();
}

bool AppService::openExternal(const QString &url)
{
    const QUrl u(url);
    // Only links meant for a browser or a mail client; never a local program.
    const QString scheme = u.scheme().toLower();
    if (scheme != QStringLiteral("http") && scheme != QStringLiteral("https") && scheme != QStringLiteral("mailto"))
        return false;
    return QDesktopServices::openUrl(u);
}

bool AppService::openPath(const QString &path)
{
    return QDesktopServices::openUrl(QUrl::fromLocalFile(path));
}

void AppService::copyText(const QString &text)
{
    QGuiApplication::clipboard()->setText(text);
}
