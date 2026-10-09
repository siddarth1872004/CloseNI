/*
 * The secret store on Windows: DPAPI.
 *
 * CryptProtectData encrypts with a key tied to the signed-in Windows user, so
 * the file it produces is useless to another account or another machine. That
 * is what Electron's safeStorage did on Windows too; the blob goes in
 * storageRoot as github.native.token (one per account name), beside the
 * Electron app's github.token, which this app cannot read.
 */
#include "SecretStore.h"

#include "../Paths.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QSaveFile>

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <wincrypt.h>

namespace {

QString fileFor(const QString &account)
{
    // The file already lives under the storage root, so an account scoped by
    // it ("github@<root>", GitHubAuth) needs only its name.
    return QDir(Paths::storageRoot()).filePath(account.section(QLatin1Char('@'), 0, 0) + QStringLiteral(".native.token"));
}

QString lastError()
{
    return QStringLiteral("Windows error %1").arg(GetLastError());
}

}

namespace SecretStore {

bool available()
{
    return true;
}

bool store(const QString &account, const QString &secret, QString *error)
{
    QByteArray plain = secret.toUtf8();
    DATA_BLOB in;
    in.pbData = reinterpret_cast<BYTE *>(plain.data());
    in.cbData = DWORD(plain.size());
    DATA_BLOB out = {};
    if (!CryptProtectData(&in, L"CloseNI", nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &out)) {
        if (error)
            *error = QStringLiteral("could not encrypt the token: ") + lastError();
        return false;
    }
    const QByteArray blob(reinterpret_cast<const char *>(out.pbData), int(out.cbData));
    LocalFree(out.pbData);
    SecureZeroMemory(plain.data(), size_t(plain.size()));

    const QString file = fileFor(account);
    QDir().mkpath(QFileInfo(file).absolutePath());
    QSaveFile f(file);
    if (!f.open(QIODevice::WriteOnly) || f.write(blob) != blob.size() || !f.commit()) {
        if (error)
            *error = QStringLiteral("could not save the token: ") + f.errorString();
        return false;
    }
    return true;
}

std::optional<QString> load(const QString &account, QString *error)
{
    QFile f(fileFor(account));
    if (!f.exists())
        return std::nullopt;
    if (!f.open(QIODevice::ReadOnly)) {
        if (error)
            *error = f.errorString();
        return std::nullopt;
    }
    QByteArray blob = f.readAll();
    DATA_BLOB in;
    in.pbData = reinterpret_cast<BYTE *>(blob.data());
    in.cbData = DWORD(blob.size());
    DATA_BLOB out = {};
    // Written under a different Windows user, or damaged: as good as absent.
    if (!CryptUnprotectData(&in, nullptr, nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &out)) {
        if (error)
            *error = QStringLiteral("could not decrypt the saved token: ") + lastError();
        return std::nullopt;
    }
    const QString secret = QString::fromUtf8(reinterpret_cast<const char *>(out.pbData), int(out.cbData));
    SecureZeroMemory(out.pbData, out.cbData);
    LocalFree(out.pbData);
    return secret;
}

bool remove(const QString &account, QString *error)
{
    QFile f(fileFor(account));
    if (!f.exists() || f.remove())
        return true;
    if (error)
        *error = f.errorString();
    return false;
}

}
