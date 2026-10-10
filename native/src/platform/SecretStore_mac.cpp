/*
 * The secret store on macOS: a generic password in the login keychain,
 * through the Security framework's C API (no Objective-C).
 * One item per secret, under the "CloseNI" service.
 */
#include "SecretStore.h"

#include <QByteArray>

#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>

namespace {

const char kService[] = "CloseNI";

CFStringRef cfString(const QByteArray &utf8)
{
    return CFStringCreateWithBytes(kCFAllocatorDefault, reinterpret_cast<const UInt8 *>(utf8.constData()),
                                   CFIndex(utf8.size()), kCFStringEncodingUTF8, false);
}

QString describe(OSStatus status)
{
    QString text = QStringLiteral("keychain error %1").arg(status);
    if (CFStringRef msg = SecCopyErrorMessageString(status, nullptr)) {
        char buf[512];
        if (CFStringGetCString(msg, buf, sizeof buf, kCFStringEncodingUTF8))
            text = QString::fromUtf8(buf);
        CFRelease(msg);
    }
    return text;
}

/* The query that names one item: class, service and account. */
CFMutableDictionaryRef baseQuery(const QString &account)
{
    CFMutableDictionaryRef q = CFDictionaryCreateMutable(kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks,
                                                         &kCFTypeDictionaryValueCallBacks);
    CFStringRef service = cfString(QByteArray(kService));
    CFStringRef acc = cfString(account.toUtf8());
    CFDictionarySetValue(q, kSecClass, kSecClassGenericPassword);
    CFDictionarySetValue(q, kSecAttrService, service);
    CFDictionarySetValue(q, kSecAttrAccount, acc);
    CFRelease(service);
    CFRelease(acc);
    return q;
}

}

namespace SecretStore {

bool available()
{
    // The login keychain is always there for a signed-in user.
    return true;
}

bool store(const QString &account, const QString &secret, QString *error)
{
    const QByteArray value = secret.toUtf8();
    CFDataRef data = CFDataCreate(kCFAllocatorDefault, reinterpret_cast<const UInt8 *>(value.constData()), CFIndex(value.size()));

    // Update in place when it exists; add otherwise.
    CFMutableDictionaryRef query = baseQuery(account);
    CFMutableDictionaryRef change = CFDictionaryCreateMutable(kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks,
                                                              &kCFTypeDictionaryValueCallBacks);
    CFDictionarySetValue(change, kSecValueData, data);
    OSStatus status = SecItemUpdate(query, change);
    CFRelease(change);
    if (status == errSecItemNotFound) {
        CFDictionarySetValue(query, kSecValueData, data);
        CFDictionarySetValue(query, kSecAttrAccessible, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly);
        status = SecItemAdd(query, nullptr);
    }
    CFRelease(query);
    CFRelease(data);
    if (status != errSecSuccess) {
        if (error)
            *error = describe(status);
        return false;
    }
    return true;
}

std::optional<QString> load(const QString &account, QString *error)
{
    CFMutableDictionaryRef query = baseQuery(account);
    CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
    CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
    CFTypeRef result = nullptr;
    const OSStatus status = SecItemCopyMatching(query, &result);
    CFRelease(query);
    if (status == errSecItemNotFound)
        return std::nullopt;
    if (status != errSecSuccess || !result) {
        if (error)
            *error = describe(status);
        return std::nullopt;
    }
    CFDataRef data = static_cast<CFDataRef>(result);
    const QString secret = QString::fromUtf8(reinterpret_cast<const char *>(CFDataGetBytePtr(data)), qsizetype(CFDataGetLength(data)));
    CFRelease(result);
    return secret;
}

bool remove(const QString &account, QString *error)
{
    CFMutableDictionaryRef query = baseQuery(account);
    const OSStatus status = SecItemDelete(query);
    CFRelease(query);
    if (status == errSecSuccess || status == errSecItemNotFound)
        return true;
    if (error)
        *error = describe(status);
    return false;
}

}
