#include "GitHubAuth.h"

#include "GitHubSafe.h"
#include "NodeCompat.h"
#include "Paths.h"
#include "SecretStore.h"

#include <QDir>
#include <QFile>

namespace {

QString gToken;
QJsonValue gLogin = QJsonValue::Null;
// Whether the store has been asked this session. Asked once: a locked keyring
// would otherwise be asked to unlock on every git command.
bool gLoaded = false;

/*
 * The store's name for this storage root's token, scoped by a CLOSENI_STORAGE
 * override so a scratch storage (a test, a second profile) never sees or
 * replaces the real one.
 */
QString account()
{
    if (qEnvironmentVariableIsEmpty("CLOSENI_STORAGE"))
        return GitHubAuth::kAccount;
    return GitHubAuth::kAccount + QLatin1Char('@') + Paths::storageRoot();
}

void loadToken()
{
    if (!gToken.isEmpty() || gLoaded)
        return;
    gLoaded = true;
    if (!SecretStore::available())
        return;
    // Absent, or unreadable: signed out either way.
    if (const auto saved = SecretStore::load(account()))
        gToken = *saved;
}

}

namespace GitHubAuth {

QString token()
{
    loadToken();
    return gToken;
}

void setToken(const QString &token)
{
    gToken = token;
    gLoaded = true;
}

QJsonValue login()
{
    return gLogin;
}

void setLogin(const QJsonValue &login)
{
    gLogin = login;
}

bool encryptionAvailable()
{
    return SecretStore::available();
}

bool saveToken(const QString &token, bool *persisted, QString *error)
{
    setToken(token);
    *persisted = false;
    if (!GitHubSafe::shouldPersistToken(encryptionAvailable()))
        return true;
    if (!SecretStore::store(account(), token, error))
        return false;
    *persisted = true;
    return true;
}

void clearToken()
{
    gToken.clear();
    gLogin = QJsonValue::Null;
    gLoaded = true;
    SecretStore::remove(account());
}

QString askPassScript()
{
#ifdef Q_OS_WIN
    const QString file = QDir(Paths::storageRoot()).filePath(QStringLiteral("askpass.bat"));
    const QString body = QStringLiteral("@echo off\r\necho %CLOSENI_GH_TOKEN%\r\n");
#else
    const QString file = QDir(Paths::storageRoot()).filePath(QStringLiteral("askpass.sh"));
    const QString body = QStringLiteral("#!/bin/sh\necho \"$CLOSENI_GH_TOKEN\"\n");
#endif
    // A missing helper just means git asks and fails fast.
    if (NodeCompat::writeText(file, body)) {
#ifndef Q_OS_WIN
        QFile::setPermissions(file, QFile::ReadOwner | QFile::WriteOwner | QFile::ExeOwner);
#endif
    }
    return file;
}

QProcessEnvironment gitEnv()
{
    QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    env.insert(QStringLiteral("GIT_TERMINAL_PROMPT"), QStringLiteral("0"));
    const QString t = token();
    if (!t.isEmpty()) {
        env.insert(QStringLiteral("GIT_ASKPASS"), askPassScript());
        env.insert(QStringLiteral("CLOSENI_GH_TOKEN"), t);
        env.insert(QStringLiteral("GIT_USERNAME"), QStringLiteral("x-access-token"));
    }
    return env;
}

}
