#pragma once

#include <QJsonValue>
#include <QString>
#include <QStringList>

#include <optional>

/*
 * The security-relevant decisions, kept pure so they can be tested without a
 * network or a credential. Ports the main-process half of desktop/github-safe.js
 * (the renderer keeps its own copy).
 *
 * linuxPasswordStore is not ported: it chose which key store Chromium's
 * safeStorage should use, and the native app talks to libsecret directly.
 */
namespace GitHubSafe {

/*
 * Remove a token from anything about to be logged or shown.
 *
 * The git IPC pipes stdout and stderr straight into the project log, and git
 * echoes URLs on failure. A credential that reaches a log file has been
 * published - to a screenshot, a pasted error report, a support request.
 */
QString redactToken(const QString &text, const QString &token);

/*
 * Check git arguments before they are spawned.
 *
 * Deliberately does NOT escape content. Git runs without a shell, so an
 * argument is data rather than syntax - a commit message containing a
 * semicolon is a commit message, and escaping it would corrupt it. Only the
 * wrong type is rejected, and it fails rather than filtering: silently
 * dropping an argument produces a git command that means something other
 * than what was asked for. On failure `error` holds the message.
 */
bool safeGitArgs(const QJsonValue &args, QStringList *out, QString *error);

struct Repo {
    QString owner;
    QString repo;
};

/*
 * Owner and repository from a GitHub URL, or nothing.
 *
 * Everything that clones or fetches goes through this, so a search result -
 * network-derived text - cannot point an operation at another host.
 */
std::optional<Repo> parseRepoUrl(const QString &url);

/*
 * Whether a token may be written to disk.
 *
 * Only when the OS can encrypt it. Anything else - including an unknown
 * state - means memory for this session and re-entry next launch.
 */
bool shouldPersistToken(std::optional<bool> encryptionAvailable);

}
