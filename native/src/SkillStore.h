#pragma once

#include <QString>
#include <QStringList>

/*
 * Personas and skills, as plain Markdown files.
 *
 * Ports local-agent/src/skill-store.ts, which the agent still uses for a
 * headless run: the two must agree on where the files live and which names
 * are safe, so change both together.
 *
 * A persona is a stance; a skill is a practice. Both are a paragraph of prose,
 * and inventing frontmatter, a registry or versioning around a paragraph would
 * be the larger commitment. The filename is the display name.
 *
 * Under the same user data directory the agent uses, so a headless run and the
 * app see the same skills - the mistake fixed on 11 August, where the app and
 * the CLI read two different browser profiles and only one of them was signed
 * in.
 */
namespace SkillStore {

QString skillsDir(const QString &root);
QString personasDir(const QString &root);

/*
 * Is this a name we will turn into a path?
 *
 * Refused rather than sanitised. A sanitised name silently reads or writes a
 * different file than the one asked for, and the name arrives from QML. A
 * leading dot is refused too: a skill called ".gitignore" is not a traversal,
 * but it is a hidden file the user cannot see in their own directory listing.
 */
bool isSafeName(const QString &name);

/* Display names of the .md files in a directory, sorted, without extensions. */
QStringList listMarkdown(const QString &dir);

/* The contents of the named files, in the order given, skipping any that fail. */
QStringList readSelected(const QString &dir, const QStringList &names);

}
