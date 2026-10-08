#include "AppService.h"

#include "Paths.h"

#include <QClipboard>
#include <QDesktopServices>
#include <QGuiApplication>
#include <QUrl>

AppService::AppService(QObject *parent)
    : QObject(parent)
{
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
