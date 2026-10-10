/*
 * The secret store on Linux and the BSDs: libsecret, which speaks to whatever
 * implements org.freedesktop.secrets (GNOME Keyring, KWallet, KeePassXC).
 *
 * Opened with dlopen at run time rather than linked, so it is not a build
 * dependency and a system without it still runs - it just cannot remember the
 * token between launches.
 *
 * The libsecret and GLib declarations used are restated below; they are part
 * of libsecret-1's stable ABI.
 */
#include "SecretStore.h"

#include <QByteArray>
#include <QMutex>

#include <dlfcn.h>

namespace {

typedef struct {
    unsigned int domain;
    int code;
    char *message;
} GError;

typedef enum { SECRET_SCHEMA_NONE = 0 } SecretSchemaFlags;
typedef enum { SECRET_SCHEMA_ATTRIBUTE_STRING = 0 } SecretSchemaAttributeType;

typedef struct {
    const char *name;
    SecretSchemaAttributeType type;
} SecretSchemaAttribute;

typedef struct {
    const char *name;
    SecretSchemaFlags flags;
    SecretSchemaAttribute attributes[32];
    int reserved;
    void *reserved1;
    void *reserved2;
    void *reserved3;
    void *reserved4;
    void *reserved5;
    void *reserved6;
    void *reserved7;
} SecretSchema;

using StoreFn = int (*)(const SecretSchema *, const char *collection, const char *label, const char *password,
                        void *cancellable, GError **error, ...);
using LookupFn = char *(*)(const SecretSchema *, void *cancellable, GError **error, ...);
using ClearFn = int (*)(const SecretSchema *, void *cancellable, GError **error, ...);
using FreeFn = void (*)(char *);
using ErrorFreeFn = void (*)(GError *);

const SecretSchema kSchema = {
    "com.closeni.Secret",
    SECRET_SCHEMA_NONE,
    {{"account", SECRET_SCHEMA_ATTRIBUTE_STRING}, {nullptr, SECRET_SCHEMA_ATTRIBUTE_STRING}},
    0, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr,
};

struct Lib {
    bool loaded = false;
    StoreFn store = nullptr;
    LookupFn lookup = nullptr;
    ClearFn clear = nullptr;
    FreeFn free = nullptr;
    ErrorFreeFn errorFree = nullptr;
};

QMutex gMutex;

const Lib &lib()
{
    static Lib l = [] {
        Lib out;
        void *h = dlopen("libsecret-1.so.0", RTLD_NOW | RTLD_LOCAL);
        if (!h)
            h = dlopen("libsecret-1.so", RTLD_NOW | RTLD_LOCAL);
        if (!h)
            return out;
        // dlsym through the handle also searches its dependencies, which is
        // where GLib's g_error_free lives.
        out.store = reinterpret_cast<StoreFn>(dlsym(h, "secret_password_store_sync"));
        out.lookup = reinterpret_cast<LookupFn>(dlsym(h, "secret_password_lookup_sync"));
        out.clear = reinterpret_cast<ClearFn>(dlsym(h, "secret_password_clear_sync"));
        out.free = reinterpret_cast<FreeFn>(dlsym(h, "secret_password_free"));
        out.errorFree = reinterpret_cast<ErrorFreeFn>(dlsym(h, "g_error_free"));
        out.loaded = out.store && out.lookup && out.clear && out.free && out.errorFree;
        return out;
    }();
    return l;
}

QString takeError(GError *e)
{
    if (!e)
        return QString();
    const QString msg = QString::fromUtf8(e->message ? e->message : "unknown error");
    lib().errorFree(e);
    return msg;
}

const char kMissing[] = "libsecret is not installed, so there is no system keyring to keep the token in";

}

namespace SecretStore {

bool available()
{
    // Settled once per run. A probe against a bus with no secret service can
    // take seconds to time out, and the answer does not change mid-session
    // often enough to pay that on every status check.
    static int state = -1;
    QMutexLocker lock(&gMutex);
    if (state != -1)
        return state == 1;
    const Lib &l = lib();
    if (!l.loaded) {
        state = 0;
        return false;
    }
    GError *err = nullptr;
    char *found = l.lookup(&kSchema, nullptr, &err, "account", "closeni-probe", nullptr);
    if (found)
        l.free(found);
    state = err ? 0 : 1;
    takeError(err);
    return state == 1;
}

bool store(const QString &account, const QString &secret, QString *error)
{
    const Lib &l = lib();
    if (!l.loaded) {
        if (error)
            *error = QString::fromLatin1(kMissing);
        return false;
    }
    const QByteArray acc = account.toUtf8();
    const QByteArray value = secret.toUtf8();
    const QByteArray label = QByteArray("CloseNI ") + acc;
    GError *err = nullptr;
    const int ok = l.store(&kSchema, "default", label.constData(), value.constData(), nullptr, &err,
                           "account", acc.constData(), nullptr);
    const QString msg = takeError(err);
    if (!ok || !msg.isEmpty()) {
        if (error)
            *error = msg.isEmpty() ? QStringLiteral("the keyring refused the token") : msg;
        return false;
    }
    return true;
}

std::optional<QString> load(const QString &account, QString *error)
{
    const Lib &l = lib();
    if (!l.loaded) {
        if (error)
            *error = QString::fromLatin1(kMissing);
        return std::nullopt;
    }
    const QByteArray acc = account.toUtf8();
    GError *err = nullptr;
    char *found = l.lookup(&kSchema, nullptr, &err, "account", acc.constData(), nullptr);
    const QString msg = takeError(err);
    if (!msg.isEmpty()) {
        if (found)
            l.free(found);
        if (error)
            *error = msg;
        return std::nullopt;
    }
    if (!found)
        return std::nullopt;
    const QString out = QString::fromUtf8(found);
    l.free(found);
    return out;
}

bool remove(const QString &account, QString *error)
{
    const Lib &l = lib();
    if (!l.loaded)
        return true;
    const QByteArray acc = account.toUtf8();
    GError *err = nullptr;
    l.clear(&kSchema, nullptr, &err, "account", acc.constData(), nullptr);
    const QString msg = takeError(err);
    if (!msg.isEmpty()) {
        if (error)
            *error = msg;
        return false;
    }
    return true;
}

}
