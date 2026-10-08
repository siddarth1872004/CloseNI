#include "SkillStore.h"

#include "NodeCompat.h"

#include <QDir>
#include <QFileInfo>
#include <QRegularExpression>

#include <algorithm>

namespace SkillStore {

QString skillsDir(const QString &root)
{
    return QDir::cleanPath(QDir(root).filePath(QStringLiteral("skills")));
}

QString personasDir(const QString &root)
{
    return QDir::cleanPath(QDir(root).filePath(QStringLiteral("personas")));
}

bool isSafeName(const QString &name)
{
    const QString n = name.trimmed();
    if (n.isEmpty())
        return false;
    if (n.contains(QLatin1Char('/')) || n.contains(QLatin1Char('\\')))
        return false;
    if (n.startsWith(QLatin1Char('.')))
        return false;
    static const QRegularExpression safe(QStringLiteral("^[A-Za-z0-9._-]+$"));
    return safe.match(n).hasMatch();
}

QStringList listMarkdown(const QString &dir)
{
    const QDir d(dir);
    // A directory that does not exist yet is a user who has written no skills,
    // not an error worth surfacing.
    if (!d.exists())
        return {};
    QStringList out;
    const QFileInfoList entries = d.entryInfoList(QDir::Files | QDir::Hidden | QDir::System | QDir::NoDotAndDotDot);
    for (const QFileInfo &e : entries) {
        // Dirent.isFile(): a symlink is not a file, whatever it points at.
        if (e.isSymLink() || !e.isFile())
            continue;
        const QString file = e.fileName();
        if (!file.toLower().endsWith(QStringLiteral(".md")))
            continue;
        const QString name = file.left(file.size() - 3);
        if (isSafeName(name))
            out << name;
    }
    // Array.prototype.sort: UTF-16 code unit order, which QString's < is.
    std::sort(out.begin(), out.end());
    return out;
}

QStringList readSelected(const QString &dir, const QStringList &names)
{
    QStringList out;
    for (const QString &name : names) {
        if (!isSafeName(name))
            continue;
        QString text;
        // A selected skill whose file has been deleted is a stale checkbox, not
        // a reason to fail a build.
        if (!NodeCompat::readText(QDir(dir).filePath(name + QStringLiteral(".md")), &text))
            continue;
        text = text.trimmed();
        if (!text.isEmpty())
            out << text;
    }
    return out;
}

}
