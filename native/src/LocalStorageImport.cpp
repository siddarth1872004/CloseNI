#include "LocalStorageImport.h"

#include <QDir>
#include <QFile>
#include <QHash>

#include <cstdint>

namespace LocalStorageImport {

namespace {

/* A write as LevelDB recorded it: the newest sequence number wins. */
struct Entry {
    quint64 seq = 0;
    bool deleted = false;
    QByteArray value;
};
using Entries = QHash<QByteArray, Entry>;

void record(Entries *entries, const QByteArray &key, quint64 seq, bool deleted, const QByteArray &value)
{
    auto it = entries->find(key);
    if (it != entries->end() && it->seq > seq)
        return;
    (*entries)[key] = Entry{seq, deleted, deleted ? QByteArray() : value};
}

/* Bounds-checked reads over a byte range; any overrun leaves ok false. */
struct Cursor {
    const char *p;
    const char *end;
    bool ok = true;

    Cursor(const char *begin, const char *stop) : p(begin), end(stop) {}
    bool atEnd() const { return p >= end; }

    quint64 varint()
    {
        quint64 result = 0;
        for (int shift = 0; shift <= 63 && p < end; shift += 7) {
            const quint8 byte = quint8(*p++);
            result |= quint64(byte & 0x7f) << shift;
            if (!(byte & 0x80))
                return result;
        }
        ok = false;
        return 0;
    }

    quint64 fixed(int bytes)
    {
        if (end - p < bytes) {
            ok = false;
            return 0;
        }
        quint64 v = 0;
        for (int i = 0; i < bytes; ++i)
            v |= quint64(quint8(p[i])) << (8 * i);
        p += bytes;
        return v;
    }

    QByteArray bytes(quint64 n)
    {
        if (quint64(end - p) < n) {
            ok = false;
            return {};
        }
        QByteArray out(p, qsizetype(n));
        p += n;
        return out;
    }
};

/* A WriteBatch: sequence (8), count (4), then tagged puts and deletes. */
void readBatch(const QByteArray &batch, Entries *entries)
{
    Cursor c(batch.constData(), batch.constData() + batch.size());
    const quint64 seq = c.fixed(8);
    const quint64 count = c.fixed(4);
    for (quint64 i = 0; i < count && c.ok && !c.atEnd(); ++i) {
        const quint8 tag = quint8(c.fixed(1));
        const QByteArray key = c.bytes(c.varint());
        if (tag == 1) {
            const QByteArray value = c.bytes(c.varint());
            if (c.ok)
                record(entries, key, seq + i, false, value);
        } else if (tag == 0) {
            if (c.ok)
                record(entries, key, seq + i, true, {});
        } else {
            return; // a tag LevelDB never writes: the rest cannot be trusted
        }
    }
}

/*
 * A log file: 32 KiB blocks of records, each a 7-byte header (checksum 4,
 * length 2, type 1) and a fragment of a WriteBatch. A batch larger than a
 * block is split FIRST, MIDDLE..., LAST. A torn tail - the app was writing as
 * we read - ends the file rather than failing it.
 */
void readLog(const QByteArray &file, Entries *entries)
{
    constexpr qsizetype kBlock = 32768;
    enum { Zero = 0, Full = 1, First = 2, Middle = 3, Last = 4 };
    QByteArray pending;
    bool inFragment = false;
    qsizetype pos = 0;
    while (pos < file.size()) {
        const qsizetype blockLeft = kBlock - (pos % kBlock);
        if (blockLeft < 7) { // trailer padding
            pos += blockLeft;
            continue;
        }
        if (file.size() - pos < 7)
            return;
        const auto *h = reinterpret_cast<const quint8 *>(file.constData() + pos);
        const qsizetype length = h[4] | (h[5] << 8);
        const int type = h[6];
        if (length > blockLeft - 7 || pos + 7 + length > file.size())
            return;
        const QByteArray data = file.mid(pos + 7, length);
        pos += 7 + length;
        switch (type) {
        case Full:
            readBatch(data, entries);
            inFragment = false;
            break;
        case First:
            pending = data;
            inFragment = true;
            break;
        case Middle:
            if (inFragment)
                pending += data;
            break;
        case Last:
            if (inFragment)
                readBatch(pending + data, entries);
            inFragment = false;
            pending.clear();
            break;
        case Zero:
        default:
            break; // preallocated space, or a type this reader does not know
        }
    }
}

/* A block handle: offset and size, as varints. */
struct Handle {
    quint64 offset = 0;
    quint64 size = 0;
};

/* A table block's contents, decompressed. False when it cannot be read. */
bool tableBlock(const QByteArray &file, const Handle &h, QByteArray *out)
{
    // The block, then a 5-byte trailer: compression type and checksum.
    if (h.offset > quint64(file.size()) || h.size + 5 > quint64(file.size()) - h.offset)
        return false;
    const QByteArray raw = file.mid(qsizetype(h.offset), qsizetype(h.size));
    const quint8 compression = quint8(file.at(qsizetype(h.offset + h.size)));
    if (compression == 0) {
        *out = raw;
        return true;
    }
    if (compression == 1)
        return snappyUncompress(raw, out);
    return false; // zstd and anything newer: not used by Chromium's localStorage
}

/*
 * A block's entries: each key shares a prefix with the one before it
 * (shared, unshared, value length, key delta, value), followed by a restart
 * array this reader does not need, since it walks every entry in order.
 */
template<typename Visit>
void blockEntries(const QByteArray &block, Visit visit)
{
    if (block.size() < 4)
        return;
    Cursor tail(block.constData() + block.size() - 4, block.constData() + block.size());
    const quint64 restarts = tail.fixed(4);
    if (restarts * 4 + 4 > quint64(block.size()))
        return;
    Cursor c(block.constData(), block.constData() + block.size() - 4 - qsizetype(restarts) * 4);
    QByteArray key;
    while (!c.atEnd()) {
        const quint64 shared = c.varint();
        const quint64 unshared = c.varint();
        const quint64 valueLength = c.varint();
        if (!c.ok || shared > quint64(key.size()))
            return;
        key = key.left(qsizetype(shared)) + c.bytes(unshared);
        const QByteArray value = c.bytes(valueLength);
        if (!c.ok)
            return;
        visit(key, value);
    }
}

/*
 * A table (*.ldb): data blocks found through the index block, which the
 * 48-byte footer points at. Keys are internal keys - the user key, then 8
 * bytes holding (sequence << 8) | type, where type 1 is a value and 0 a
 * deletion.
 */
void readTable(const QByteArray &file, Entries *entries)
{
    constexpr qsizetype kFooter = 48;
    constexpr quint64 kMagic = 0xdb4775248b80fb57ull;
    if (file.size() < kFooter)
        return;
    const char *footer = file.constData() + file.size() - kFooter;
    Cursor magic(footer + 40, footer + kFooter);
    if (magic.fixed(8) != kMagic)
        return;
    Cursor f(footer, footer + 40);
    f.varint(); // metaindex offset
    f.varint(); // metaindex size
    Handle index;
    index.offset = f.varint();
    index.size = f.varint();
    QByteArray indexBlock;
    if (!f.ok || !tableBlock(file, index, &indexBlock))
        return;
    blockEntries(indexBlock, [&](const QByteArray &, const QByteArray &handleBytes) {
        Cursor hc(handleBytes.constData(), handleBytes.constData() + handleBytes.size());
        Handle h;
        h.offset = hc.varint();
        h.size = hc.varint();
        QByteArray data;
        if (!hc.ok || !tableBlock(file, h, &data))
            return;
        blockEntries(data, [&](const QByteArray &internalKey, const QByteArray &value) {
            if (internalKey.size() < 8)
                return;
            Cursor t(internalKey.constData() + internalKey.size() - 8, internalKey.constData() + internalKey.size());
            const quint64 trailer = t.fixed(8);
            const int type = int(trailer & 0xff);
            if (type != 0 && type != 1)
                return;
            record(entries, internalKey.left(internalKey.size() - 8), trailer >> 8, type == 0, value);
        });
    });
}

/* Chromium's string encoding: a format byte, then Latin-1 or UTF-16LE. */
bool decodeString(const QByteArray &bytes, QString *out)
{
    if (bytes.isEmpty())
        return false;
    const QByteArray body = bytes.mid(1);
    if (bytes.at(0) == 1) {
        *out = QString::fromLatin1(body);
        return true;
    }
    if (bytes.at(0) == 0 && body.size() % 2 == 0) {
        QString s(body.size() / 2, Qt::Uninitialized);
        for (qsizetype i = 0; i < s.size(); ++i)
            s[i] = QChar(char16_t(quint8(body.at(2 * i)) | (quint8(body.at(2 * i + 1)) << 8)));
        *out = s;
        return true;
    }
    return false;
}

bool readWhole(const QString &path, QByteArray *out)
{
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly))
        return false;
    *out = f.readAll();
    return true;
}

}

bool snappyUncompress(const QByteArray &in, QByteArray *out)
{
    Cursor c(in.constData(), in.constData() + in.size());
    const quint64 length = c.varint();
    // A block is at most a few megabytes; a larger claim is a corrupt preamble.
    if (!c.ok || length > (quint64(1) << 28))
        return false;
    QByteArray result;
    result.reserve(qsizetype(length));
    while (!c.atEnd()) {
        const quint8 tag = quint8(c.fixed(1));
        quint64 len = 0;
        quint64 offset = 0;
        switch (tag & 3) {
        case 0: { // literal
            len = tag >> 2;
            if (len >= 60)
                len = c.fixed(int(len - 59));
            len += 1;
            const QByteArray literal = c.bytes(len);
            if (!c.ok)
                return false;
            result += literal;
            continue;
        }
        case 1:
            len = ((tag >> 2) & 7) + 4;
            offset = (quint64(tag >> 5) << 8) | c.fixed(1);
            break;
        case 2:
            len = (tag >> 2) + 1;
            offset = c.fixed(2);
            break;
        default:
            len = (tag >> 2) + 1;
            offset = c.fixed(4);
            break;
        }
        if (!c.ok || offset == 0 || offset > quint64(result.size()) || quint64(result.size()) + len > length)
            return false;
        // Byte by byte: a copy may overlap the bytes it produces.
        qsizetype from = result.size() - qsizetype(offset);
        for (quint64 i = 0; i < len; ++i)
            result.append(result.at(from++));
    }
    if (quint64(result.size()) != length)
        return false;
    *out = result;
    return true;
}

QMap<QString, QString> read(const QString &leveldbDir, const QString &origin, const QString &keyPrefix)
{
    QMap<QString, QString> out;
    const QDir dir(leveldbDir);
    if (!dir.exists())
        return out;

    Entries entries;
    const QStringList files = dir.entryList({QStringLiteral("*.log"), QStringLiteral("*.ldb"), QStringLiteral("*.sst")},
                                            QDir::Files, QDir::Name);
    for (const QString &name : files) {
        QByteArray bytes;
        if (!readWhole(dir.filePath(name), &bytes))
            continue;
        if (name.endsWith(QStringLiteral(".log")))
            readLog(bytes, &entries);
        else
            readTable(bytes, &entries);
    }

    const QByteArray originKey = QByteArray("_") + origin.toLatin1() + QByteArray(1, '\0');
    for (auto it = entries.cbegin(); it != entries.cend(); ++it) {
        if (it->deleted || !it.key().startsWith(originKey))
            continue;
        QString key, value;
        if (!decodeString(it.key().mid(originKey.size()), &key) || !key.startsWith(keyPrefix))
            continue;
        if (!decodeString(it->value, &value))
            continue;
        out.insert(key, value);
    }
    return out;
}

}
