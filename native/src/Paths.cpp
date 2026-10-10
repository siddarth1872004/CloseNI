#include "Paths.h"

#include <QCoreApplication>
#include <QDir>
#include <QFileInfo>
#include <QStandardPaths>

namespace {

const char *kAppName = "CloseNI";

QString existing(const QString &path)
{
    return QFileInfo(path).isFile() ? QDir::cleanPath(path) : QString();
}

/*
 * Bundled files sit beside the executable on Windows and Linux, and in
 * Contents/Resources inside a macOS bundle.
 */
QString resourcesDir()
{
    const QString appDir = QCoreApplication::applicationDirPath();
#ifdef Q_OS_MACOS
    return QDir::cleanPath(appDir + "/../Resources");
#else
    return appDir;
#endif
}

QString bundledAgent()
{
    return existing(resourcesDir() + "/local-agent/dist/index.js");
}

/*
 * A development build lives somewhere under the checkout (build-native/, or
 * build-native/CloseNI.app/Contents/MacOS on macOS), so walk up until the
 * compiled agent turns up.
 */
QString checkoutAgent()
{
    QDir dir(QCoreApplication::applicationDirPath());
    for (int i = 0; i < 8; ++i) {
        const QString found = existing(dir.filePath("local-agent/dist/index.js"));
        if (!found.isEmpty())
            return found;
        if (!dir.cdUp())
            break;
    }
    return QString();
}

}

namespace Paths {

QString storageRoot()
{
    const QString override = qEnvironmentVariable("CLOSENI_STORAGE");
    if (!override.isEmpty())
        return override;
    // appData/<productName>, where appData differs by system in ways
    // QStandardPaths does not line up with: on Windows it is the
    // roaming profile, which Qt's generic locations never return.
#if defined(Q_OS_WIN)
    return QDir::cleanPath(qEnvironmentVariable("APPDATA") + "/" + kAppName);
#elif defined(Q_OS_MACOS)
    return QDir::cleanPath(QStandardPaths::writableLocation(QStandardPaths::GenericDataLocation) + "/" + kAppName);
#else
    return QDir::cleanPath(QStandardPaths::writableLocation(QStandardPaths::GenericConfigLocation) + "/" + kAppName);
#endif
}

QString nodePath()
{
    const QString override = qEnvironmentVariable("CLOSENI_NODE");
    if (!override.isEmpty())
        return existing(override);
#ifdef Q_OS_WIN
    const QString bundled = existing(resourcesDir() + "/node/node.exe");
#else
    const QString bundled = existing(resourcesDir() + "/node/bin/node");
#endif
    if (!bundled.isEmpty())
        return bundled;
    return QStandardPaths::findExecutable("node");
}

QString agentPath()
{
    const QString override = qEnvironmentVariable("CLOSENI_AGENT");
    if (!override.isEmpty())
        return existing(override);
    const QString bundled = bundledAgent();
    return bundled.isEmpty() ? checkoutAgent() : bundled;
}

bool agentIsBundled()
{
    const QString bundled = bundledAgent();
    return !bundled.isEmpty() && bundled == agentPath();
}

}
