#pragma once

#include <QString>

#include <optional>

/*
 * The system's secret store, for the GitHub token.
 *
 * One implementation per platform, chosen by CMake by file name:
 *   src/platform/SecretStore_win.cpp    DPAPI (CryptProtectData), a file in storageRoot
 *   src/platform/SecretStore_mac.cpp    the login keychain (Security framework C API)
 *   src/platform/SecretStore_linux.cpp  libsecret, opened at run time with dlopen
 *
 * There is no plain-text fallback, by design (github-safe.js
 * shouldPersistToken): when available() is false the token lives in memory for
 * the session and is asked for again next launch. A Linux desktop with no
 * secret service, or one where libsecret is missing, is such a case.
 *
 * Calls are synchronous. They are made from user actions (signing in and out)
 * and once when the token is first needed, never in a loop.
 */
namespace SecretStore {

/* Whether a secret written now would be encrypted by the OS and kept. */
bool available();

/* Save `secret` under `account`, replacing any earlier one. */
bool store(const QString &account, const QString &secret, QString *error = nullptr);

/*
 * The secret saved under `account`. Nothing, with `error` left empty, when
 * none is saved; nothing with `error` set when the store could not be read.
 */
std::optional<QString> load(const QString &account, QString *error = nullptr);

/* Forget `account`. Removing what is not there succeeds. */
bool remove(const QString &account, QString *error = nullptr);

}
