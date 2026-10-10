#pragma once

#include <QJsonValue>
#include <QProcessEnvironment>
#include <QString>

/*
 * The GitHub token lives here and nowhere else.
 *
 * Not in QML, and not in the agent process - the agent drives browsers and has
 * no reason to hold a GitHub credential. Not passing it is cheaper than
 * deciding later whether it leaked.
 *
 * Process-wide, because three services use it: GitHub (sign-in and the API),
 * Git (git's environment, and redaction) and Library (importing a skill from
 * a repository).
 */
namespace GitHubAuth {

/* The secret store's name for the token. */
inline const QString kAccount = QStringLiteral("github");

/*
 * The token for this session: the one signed in with, or the one the secret
 * store holds (read once, on first use). Empty when signed out.
 */
QString token();

/* Set or clear the in-memory token without touching the store. */
void setToken(const QString &token);

/* The login GitHub reported at sign-in, or null when not known this session. */
QJsonValue login();
void setLogin(const QJsonValue &login);

/* Whether the OS can encrypt the token, so it may be kept between launches. */
bool encryptionAvailable();

/*
 * Keep the token: in memory always, in the secret store when that is safe
 * (github-safe shouldPersistToken). Returns whether it was persisted; false
 * with `error` set when persisting was allowed but the write failed.
 */
bool saveToken(const QString &token, bool *persisted, QString *error);

/* Forget the token: memory and the secret store. */
void clearToken();

/*
 * Git's environment.
 *
 * GIT_ASKPASS rather than a token in the remote URL - which lands in
 * .git/config and stays there - or in a push argument, which is visible in ps
 * to every process on the machine. Here it exists only in this child's env.
 */
QProcessEnvironment gitEnv();

/*
 * A helper that echoes the token from its own environment.
 *
 * The script never contains the token - a credential written into a file on
 * disk is the same mistake in a different place.
 */
QString askPassScript();

}
