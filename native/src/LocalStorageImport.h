#pragma once

#include <QByteArray>
#include <QMap>
#include <QString>

/*
 * The Electron app's localStorage, read once so its settings carry over.
 *
 * Chromium keeps localStorage in a LevelDB database under
 * <storage>/Local Storage/leveldb: recent writes in *.log files, older ones
 * compacted into *.ldb tables. This reads both, by hand, rather than taking
 * LevelDB as a dependency for a one-time import of a dozen strings.
 *
 * Read-only and best-effort. Nothing is ever written to that directory - not
 * even its LOCK file, so a running Electron app is not disturbed - and
 * anything that cannot be read is skipped: losing an imported setting means
 * choosing a theme again, not a failed launch.
 *
 * The layout, as Chromium writes it:
 *   key   "_" + origin + "\x00" + encoded key     (origin "file://" here)
 *   value encoded value
 * where "encoded" is one byte - 0x01 Latin-1, 0x00 UTF-16LE - then the text.
 */
namespace LocalStorageImport {

/*
 * Every live value whose key starts with `keyPrefix`, for `origin`, newest
 * write winning and deletions honoured. Empty when there is nothing to read.
 */
QMap<QString, QString> read(const QString &leveldbDir,
                            const QString &origin = QStringLiteral("file://"),
                            const QString &keyPrefix = QStringLiteral("closeni."));

/* Snappy's raw format, which LevelDB compresses table blocks with. */
bool snappyUncompress(const QByteArray &in, QByteArray *out);

}
