/*
 * The one-time import of the Electron app's localStorage into Prefs
 * (LocalStorageImport.h). LevelDB files are built here byte by byte - a log
 * with overwrites, deletions and a record split across blocks, and tables with
 * and without Snappy - and the import must leave its source exactly as it was.
 *
 * With CLOSENI_LS_COPY set to a copy of a real "Local Storage" directory, that
 * copy is copied again into scratch and read too. Never point it at the real
 * profile: the suite only reads, but the rule is that profile is not touched.
 */
#include "data_harness.h"

#include "LocalStorageImport.h"
#include "Prefs.h"

#include <QCryptographicHash>
#include <QDirIterator>
#include <QLibrary>

namespace {

QByteArray varint(quint64 v)
{
    QByteArray out;
    while (v >= 0x80) {
        out += char((v & 0x7f) | 0x80);
        v >>= 7;
    }
    out += char(v);
    return out;
}

QByteArray fixed(quint64 v, int bytes)
{
    QByteArray out;
    for (int i = 0; i < bytes; ++i)
        out += char((v >> (8 * i)) & 0xff);
    return out;
}

/* Chromium's localStorage key for `key` under file://, Latin-1 form. */
QByteArray lsKey(const QByteArray &key, const QByteArray &origin = "file://")
{
    return "_" + origin + QByteArray(1, '\0') + QByteArray(1, '\x01') + key;
}

QByteArray latin1(const QByteArray &v)
{
    return QByteArray(1, '\x01') + v;
}

QByteArray utf16(const QString &v)
{
    QByteArray out(1, '\0');
    for (QChar c : v) {
        out += char(c.unicode() & 0xff);
        out += char(c.unicode() >> 8);
    }
    return out;
}

struct Op {
    QByteArray key;
    QByteArray value;
    bool del = false;
};

QByteArray batch(quint64 seq, const QList<Op> &ops)
{
    QByteArray b = fixed(seq, 8) + fixed(quint64(ops.size()), 4);
    for (const Op &op : ops) {
        b += char(op.del ? 0 : 1);
        b += varint(quint64(op.key.size())) + op.key;
        if (!op.del)
            b += varint(quint64(op.value.size())) + op.value;
    }
    return b;
}

/* A log file: batches as records, split across 32 KiB blocks as LevelDB does. */
QByteArray logFile(const QList<QByteArray> &batches)
{
    constexpr int kBlock = 32768;
    QByteArray out;
    for (const QByteArray &b : batches) {
        qsizetype pos = 0;
        bool first = true;
        do {
            qsizetype left = kBlock - (out.size() % kBlock);
            if (left < 7) {
                out += QByteArray(left, '\0');
                left = kBlock;
            }
            const qsizetype take = qMin(b.size() - pos, left - 7);
            const bool last = pos + take == b.size();
            const char type = first && last ? 1 : first ? 2 : last ? 4 : 3;
            out += fixed(0, 4) + fixed(quint64(take), 2) + type + b.mid(pos, take);
            pos += take;
            first = false;
        } while (pos < b.size());
    }
    return out;
}

/* A block: prefix-compressed entries, then one restart at 0. */
QByteArray block(const QList<QPair<QByteArray, QByteArray>> &entries)
{
    QByteArray out, prev;
    for (const auto &[key, value] : entries) {
        qsizetype shared = 0;
        while (shared < prev.size() && shared < key.size() && prev[shared] == key[shared])
            ++shared;
        out += varint(quint64(shared)) + varint(quint64(key.size() - shared)) + varint(quint64(value.size()));
        out += key.mid(shared) + value;
        prev = key;
    }
    return out + fixed(0, 4) + fixed(1, 4);
}

QByteArray internalKey(const QByteArray &user, quint64 seq, bool del)
{
    return user + fixed((seq << 8) | (del ? 0 : 1), 8);
}

using Compress = std::function<bool(const QByteArray &, QByteArray *)>;

/* A table with one data block, compressed when `compress` is given. */
QByteArray tableFile(const QList<QPair<QByteArray, QByteArray>> &entries, const Compress &compress = {})
{
    QByteArray file;
    auto put = [&file](const QByteArray &contents, char type) {
        const quint64 offset = quint64(file.size());
        file += contents + type + fixed(0, 4);
        return varint(offset) + varint(quint64(contents.size()));
    };
    const QByteArray raw = block(entries);
    QByteArray packed;
    const bool compressed = compress && compress(raw, &packed);
    const QByteArray dataHandle = put(compressed ? packed : raw, compressed ? 1 : 0);
    const QByteArray metaHandle = put(block({}), 0);
    const QByteArray indexHandle = put(block({{entries.last().first, dataHandle}}), 0);
    QByteArray footer = metaHandle + indexHandle;
    footer += QByteArray(40 - footer.size(), '\0');
    return file + footer + fixed(0xdb4775248b80fb57ull, 8);
}

/* The system's libsnappy, when there is one, to make real compressed blocks. */
Compress systemSnappy()
{
    static QLibrary lib(QStringLiteral("snappy"), 1);
    using CompressFn = int (*)(const char *, size_t, char *, size_t *);
    using MaxFn = size_t (*)(size_t);
    const auto compressFn = reinterpret_cast<CompressFn>(lib.resolve("snappy_compress"));
    const auto maxFn = reinterpret_cast<MaxFn>(lib.resolve("snappy_max_compressed_length"));
    if (!compressFn || !maxFn)
        return {};
    return [compressFn, maxFn](const QByteArray &in, QByteArray *out) {
        size_t length = maxFn(size_t(in.size()));
        out->resize(qsizetype(length));
        if (compressFn(in.constData(), size_t(in.size()), out->data(), &length) != 0)
            return false;
        out->resize(qsizetype(length));
        return true;
    };
}

/* Every file under `dir` with its hash and modification time. */
QMap<QString, QString> fingerprint(const QString &dir)
{
    QMap<QString, QString> out;
    QDirIterator it(dir, QDir::Files | QDir::Hidden | QDir::System, QDirIterator::Subdirectories);
    while (it.hasNext()) {
        const QString path = it.next();
        QFile f(path);
        const QByteArray bytes = f.open(QIODevice::ReadOnly) ? f.readAll() : QByteArray("<unreadable>");
        out.insert(QDir(dir).relativeFilePath(path),
                   QString::fromLatin1(QCryptographicHash::hash(bytes, QCryptographicHash::Sha256).toHex()) + QLatin1Char(' ')
                       + QString::number(it.fileInfo().lastModified().toMSecsSinceEpoch()));
    }
    return out;
}

bool copyTree(const QString &from, const QString &to)
{
    QDirIterator it(from, QDir::Files | QDir::Hidden | QDir::System, QDirIterator::Subdirectories);
    bool ok = true;
    while (it.hasNext()) {
        const QString path = it.next();
        const QString target = QDir(to).filePath(QDir(from).relativeFilePath(path));
        QDir().mkpath(QFileInfo(target).absolutePath());
        ok = QFile::copy(path, target) && ok;
    }
    return ok;
}

/* A fixture leveldb: an older table, then a log that overrides parts of it. */
void writeFixture(const QString &dir, const Compress &compress = {})
{
    writeAll(QDir(dir).filePath("000005.ldb"),
             tableFile({{internalKey(lsKey("closeni.deleted-later"), 3, false), latin1("old")},
                        {internalKey(lsKey("closeni.table-only"), 2, false), latin1("from the table")},
                        {internalKey(lsKey("closeni.theme"), 1, false), latin1("light")}},
                       compress));
    const QByteArray big(40000, 'x'); // larger than a block: FIRST, MIDDLE?, LAST
    writeAll(QDir(dir).filePath("000007.log"),
             logFile({batch(10, {{lsKey("closeni.theme"), latin1("midnight")},
                                 {lsKey("closeni.unicode"), utf16(QStringLiteral("café ✓"))},
                                 {lsKey("other.key"), latin1("not ours")},
                                 {lsKey("closeni.theme", "https://evil.test"), latin1("not this origin")}}),
                      batch(20, {{lsKey("closeni.deleted-later"), {}, true}, {lsKey("closeni.big"), latin1(big)}}),
                      batch(30, {{lsKey("closeni.autonomy"), latin1("ask")}})}));
    writeAll(QDir(dir).filePath("CURRENT"), "MANIFEST-000001\n");
    writeAll(QDir(dir).filePath("LOCK"), "");
}

}

class TestPrefsImport : public QObject
{
    Q_OBJECT

private slots:
    void snappy();
    void logAndTable();
    void compressedTable();
    void tornAndCorrupt();
    void prefsImportsOnce();
    void realCopy();
    void cleanupTestCase() { REPORT_CHECKS(); }
};

void TestPrefsImport::snappy()
{
    QByteArray out;
    CHECK(LocalStorageImport::snappyUncompress(QByteArray("\x0c\x08" "abc\x15\x03", 7), &out) && out == "abcabcabcabc");
    CHECK(LocalStorageImport::snappyUncompress(QByteArray("\x06\x04xy\x0e\x02\x00", 7), &out) && out == "xyxyxy");
    CHECK(LocalStorageImport::snappyUncompress(QByteArray("\x00", 1), &out) && out.isEmpty());
    CHECK(!LocalStorageImport::snappyUncompress(QByteArray("\x0c\x08" "abc\x15\x00", 7), &out)); // offset 0
    CHECK(!LocalStorageImport::snappyUncompress(QByteArray("\x0d\x08" "abc\x15\x03", 7), &out)); // short of its length
    CHECK(!LocalStorageImport::snappyUncompress(QByteArray("\x02\x08" "abc", 5), &out));        // longer than its length
    CHECK(!LocalStorageImport::snappyUncompress(QByteArray("\x0c\x08" "ab", 4), &out));         // literal runs off the end
    CHECK(!LocalStorageImport::snappyUncompress(QByteArray("\xff\xff\xff\xff\xff\xff", 6), &out));

    if (const Compress real = systemSnappy()) {
        const QByteArray text = QByteArray("closeni localStorage ").repeated(500) + QByteArray("tail \x01\x02\x03", 8);
        QByteArray packed, unpacked;
        CHECK(real(text, &packed) && packed.size() < text.size());
        CHECK(LocalStorageImport::snappyUncompress(packed, &unpacked) && unpacked == text);
    }
}

void TestPrefsImport::logAndTable()
{
    QTemporaryDir dir;
    writeFixture(dir.path());
    const auto before = fingerprint(dir.path());
    const QMap<QString, QString> got = LocalStorageImport::read(dir.path());

    CHECK2(got.value("closeni.theme") == QStringLiteral("midnight"), got.value("closeni.theme"));
    CHECK2(got.value("closeni.table-only") == QStringLiteral("from the table"), QStringList(got.keys()).join(","));
    CHECK(!got.contains("closeni.deleted-later"));
    CHECK2(got.value("closeni.unicode") == QStringLiteral("café ✓"), got.value("closeni.unicode"));
    CHECK2(got.value("closeni.big").size() == 40000, QString::number(got.value("closeni.big").size()));
    CHECK(got.value("closeni.autonomy") == QStringLiteral("ask"));
    CHECK(!got.contains("other.key"));
    CHECK2(got.size() == 5, QStringList(got.keys()).join(","));
    CHECK(fingerprint(dir.path()) == before);

    CHECK(LocalStorageImport::read(QDir(dir.path()).filePath("missing")).isEmpty());
}

void TestPrefsImport::compressedTable()
{
    Compress compress = systemSnappy();
    if (!compress) {
        // No libsnappy here: a hand-built stream of the block as one literal.
        compress = [](const QByteArray &in, QByteArray *out) {
            *out = varint(quint64(in.size()));
            for (qsizetype i = 0; i < in.size(); i += 60) {
                const QByteArray part = in.mid(i, 60);
                *out += char((part.size() - 1) << 2) + part;
            }
            return true;
        };
    }
    QTemporaryDir dir;
    writeAll(QDir(dir.path()).filePath("000003.ldb"),
             tableFile({{internalKey(lsKey("closeni.console"), 4, false), latin1("open")},
                        {internalKey(lsKey("closeni.console"), 2, false), latin1("closed")},
                        {internalKey(lsKey("closeni.consoleHeight"), 3, false), latin1("240")}},
                       compress));
    const QMap<QString, QString> got = LocalStorageImport::read(dir.path());
    CHECK2(got.value("closeni.console") == QStringLiteral("open"), QStringList(got.keys()).join(","));
    CHECK(got.value("closeni.consoleHeight") == QStringLiteral("240"));
}

void TestPrefsImport::tornAndCorrupt()
{
    QTemporaryDir dir;
    const QByteArray log = logFile({batch(1, {{lsKey("closeni.a"), latin1("1")}}), batch(2, {{lsKey("closeni.b"), latin1("2")}})});
    // The app was writing as the import read: the tail is cut mid-record.
    writeAll(QDir(dir.path()).filePath("000001.log"), log.left(log.size() - 3));
    writeAll(QDir(dir.path()).filePath("000002.ldb"), QByteArray(100, '\x7f'));
    writeAll(QDir(dir.path()).filePath("000004.ldb"), QByteArray(10, '\0'));
    const QMap<QString, QString> got = LocalStorageImport::read(dir.path());
    CHECK2(got.value("closeni.a") == QStringLiteral("1") && !got.contains("closeni.b"), QStringList(got.keys()).join(","));
}

void TestPrefsImport::prefsImportsOnce()
{
    QTemporaryDir storage;
    qputenv("CLOSENI_STORAGE", storage.path().toUtf8());
    const QString leveldb = QDir(storage.path()).filePath("Local Storage/leveldb");
    writeFixture(leveldb);
    const auto before = fingerprint(leveldb);
    const QString saved = QDir(storage.path()).filePath("native-prefs.json");

    {
        Prefs prefs;
        CHECK2(prefs.get("closeni.theme") == QStringLiteral("midnight"), prefs.get("closeni.theme"));
        CHECK(prefs.get("closeni.table-only") == QStringLiteral("from the table"));
        CHECK(prefs.get("closeni.deleted-later", "none") == QStringLiteral("none"));
        CHECK(QFile::exists(saved));
        prefs.set("closeni.theme", "light");
    }
    CHECK(fingerprint(leveldb) == before);
    {
        // Once native-prefs.json exists, the old store is never read again.
        Prefs prefs;
        CHECK2(prefs.get("closeni.theme") == QStringLiteral("light"), prefs.get("closeni.theme"));
    }
    CHECK(fingerprint(leveldb) == before);

    // Nothing to import: nothing is written.
    QTemporaryDir empty;
    qputenv("CLOSENI_STORAGE", empty.path().toUtf8());
    {
        Prefs prefs;
        CHECK(prefs.get("closeni.theme").isEmpty());
    }
    CHECK(!QFile::exists(QDir(empty.path()).filePath("native-prefs.json")));
    qunsetenv("CLOSENI_STORAGE");
}

void TestPrefsImport::realCopy()
{
    const QString source = qEnvironmentVariable("CLOSENI_LS_COPY");
    if (source.isEmpty())
        QSKIP("CLOSENI_LS_COPY is not set (a copy of a real \"Local Storage\" directory)");
    QVERIFY2(!QDir::cleanPath(source).startsWith(QDir::homePath() + "/.config/CloseNI"), "point it at a copy, not the profile");
    QTemporaryDir storage;
    QVERIFY(copyTree(source, QDir(storage.path()).filePath("Local Storage")));
    const QString leveldb = QDir(storage.path()).filePath("Local Storage/leveldb");
    const auto before = fingerprint(leveldb);
    const QMap<QString, QString> got = LocalStorageImport::read(leveldb);
    qInfo("imported %lld keys: %s", qlonglong(got.size()), qPrintable(QStringList(got.keys()).join(", ")));
    CHECK2(!got.value("closeni.theme").isEmpty(), QStringList(got.keys()).join(","));
    for (auto it = got.cbegin(); it != got.cend(); ++it)
        CHECK2(it.key().startsWith("closeni."), it.key());

    qputenv("CLOSENI_STORAGE", storage.path().toUtf8());
    {
        Prefs prefs;
        CHECK(prefs.get("closeni.theme") == got.value("closeni.theme"));
    }
    qunsetenv("CLOSENI_STORAGE");
    CHECK(fingerprint(leveldb) == before);
}

QTEST_GUILESS_MAIN(TestPrefsImport)
#include "tst_prefs_import.moc"
