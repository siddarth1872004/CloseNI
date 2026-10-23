/*
 * The Updates service: reading a release, choosing its file, and refusing a
 * download that does not match the release's checksums. GitHub is MockGitHub,
 * so nothing here reaches the network.
 */
#include "data_harness.h"
#include "mock_github.h"

#include "UpdateService.h"

#include <QCryptographicHash>

namespace {

const QByteArray kInstaller = QByteArray("MZ the new installer ").repeated(4096);

QByteArray release(const QString &base, const QString &tag)
{
    QJsonArray assets;
    for (const QString &name : {QStringLiteral("CloseNI-Setup-9.9.exe"), QStringLiteral("CloseNI-9.9.AppImage"),
                                QStringLiteral("closeni_9.9_amd64.deb"), QStringLiteral("SHA256SUMS.txt")})
        assets.append(QJsonObject{{QStringLiteral("name"), name},
                                  {QStringLiteral("browser_download_url"), base + QStringLiteral("/dl/") + name}});
    return QJsonDocument(QJsonObject{{QStringLiteral("tag_name"), tag},
                                     {QStringLiteral("html_url"), QStringLiteral("https://github.com/x/releases/tag/") + tag},
                                     {QStringLiteral("assets"), assets}})
        .toJson();
}

void waitWhile(UpdateService &u, const QString &state)
{
    QDeadlineTimer deadline(15000);
    while (u.state() == state && !deadline.hasExpired())
        QTest::qWait(5);
}

}

class TestUpdates : public QObject
{
    Q_OBJECT

private slots:
    void initTestCase();
    void versions();
    void assets();
    void sums();
    void newerRelease();
    void sameRelease();
    void badChecksum();
    void failures();
    void cleanupTestCase() { REPORT_CHECKS(); }

private:
    ScratchStorage m_storage;
};

void TestUpdates::initTestCase()
{
    QCoreApplication::setApplicationVersion(QStringLiteral("0.1"));
    qputenv("CLOSENI_UPDATE_KIND", "installer");
}

void TestUpdates::versions()
{
    CHECK(UpdateService::compareVersions(QStringLiteral("v0.2"), QStringLiteral("0.1")) > 0);
    CHECK(UpdateService::compareVersions(QStringLiteral("0.1"), QStringLiteral("v0.1")) == 0);
    CHECK(UpdateService::compareVersions(QStringLiteral("0.1.0"), QStringLiteral("0.1")) == 0);
    CHECK(UpdateService::compareVersions(QStringLiteral("0.10"), QStringLiteral("0.9")) > 0);
    CHECK(UpdateService::compareVersions(QStringLiteral("0.1"), QStringLiteral("0.1.1")) < 0);
    CHECK(UpdateService::compareVersions(QStringLiteral("1.0"), QStringLiteral("0.99.9")) > 0);
    CHECK(UpdateService::compareVersions(QStringLiteral("0.2-beta"), QStringLiteral("0.2")) == 0);
}

void TestUpdates::assets()
{
    const QStringList names{QStringLiteral("CloseNI-0.2.AppImage"), QStringLiteral("CloseNI-Setup-0.2.exe"),
                            QStringLiteral("closeni_0.2_amd64.deb"), QStringLiteral("SHA256SUMS.txt")};
    CHECK(UpdateService::assetFor(QStringLiteral("installer"), names) == QLatin1String("CloseNI-Setup-0.2.exe"));
    CHECK(UpdateService::assetFor(QStringLiteral("appimage"), names) == QLatin1String("CloseNI-0.2.AppImage"));
    CHECK(UpdateService::assetFor(QStringLiteral("deb"), names) == QLatin1String("closeni_0.2_amd64.deb"));
    CHECK(UpdateService::assetFor(QStringLiteral("source"), names).isEmpty());
    CHECK(UpdateService::assetFor(QStringLiteral("installer"), {QStringLiteral("CloseNI-Setup-0.2.exe.sig")}).isEmpty());
}

void TestUpdates::sums()
{
    const QByteArray listing = QByteArray(64, 'a') + "  CloseNI-Setup-0.2.exe\n" + QByteArray(64, 'B') + " *closeni_0.2_amd64.deb\n";
    CHECK(UpdateService::sumFor(listing, QStringLiteral("CloseNI-Setup-0.2.exe")) == QString(64, QLatin1Char('a')));
    CHECK(UpdateService::sumFor(listing, QStringLiteral("closeni_0.2_amd64.deb")) == QString(64, QLatin1Char('b')));
    CHECK(UpdateService::sumFor(listing, QStringLiteral("CloseNI-0.2.AppImage")).isEmpty());
    CHECK(UpdateService::sumFor("not a listing", QStringLiteral("x")).isEmpty());
}

void TestUpdates::newerRelease()
{
    const QByteArray digest = QCryptographicHash::hash(kInstaller, QCryptographicHash::Sha256).toHex();
    MockGitHub *self = nullptr;
    MockGitHub mock([&self, digest](const MockGitHub::Request &r) -> MockGitHub::Response {
        if (r.path.endsWith(QLatin1String("/releases/latest")))
            return {200, release(self->url(), QStringLiteral("v9.9"))};
        if (r.path == QLatin1String("/dl/SHA256SUMS.txt"))
            return {200, digest + "  CloseNI-Setup-9.9.exe\n"};
        if (r.path == QLatin1String("/dl/CloseNI-Setup-9.9.exe"))
            return {200, kInstaller};
        return {404, "{}"};
    });
    self = &mock;

    UpdateService u;
    CHECK(u.kind() == QLatin1String("installer"));
    u.check();
    waitWhile(u, QStringLiteral("checking"));
    CHECK2(u.state() == QLatin1String("available"), u.state() + u.error());
    CHECK(u.latest() == QLatin1String("9.9"));
    CHECK(u.notesUrl().endsWith(QLatin1String("/v9.9")));
    // The release endpoint is asked without a token.
    CHECK(!mock.requests.first().headers.contains(QStringLiteral("authorization")));

    u.download();
    waitWhile(u, QStringLiteral("downloading"));
    CHECK2(u.state() == QLatin1String("ready"), u.state() + u.error());
    QFile f(u.file());
    CHECK(f.open(QIODevice::ReadOnly) && f.readAll() == kInstaller);
    CHECK(u.file().startsWith(m_storage.file(QStringLiteral("updates"))));
}

void TestUpdates::sameRelease()
{
    MockGitHub *self = nullptr;
    MockGitHub mock([&self](const MockGitHub::Request &) -> MockGitHub::Response {
        return {200, release(self->url(), QStringLiteral("v0.1"))};
    });
    self = &mock;
    UpdateService u;
    u.check();
    waitWhile(u, QStringLiteral("checking"));
    CHECK2(u.state() == QLatin1String("current"), u.state() + u.error());
    // Nothing to download from the release this build already is.
    u.download();
    CHECK(u.state() == QLatin1String("current"));
}

void TestUpdates::badChecksum()
{
    MockGitHub *self = nullptr;
    MockGitHub mock([&self](const MockGitHub::Request &r) -> MockGitHub::Response {
        if (r.path.endsWith(QLatin1String("/releases/latest")))
            return {200, release(self->url(), QStringLiteral("v9.9"))};
        if (r.path == QLatin1String("/dl/SHA256SUMS.txt"))
            return {200, QByteArray(64, 'c') + "  CloseNI-Setup-9.9.exe\n"};
        return {200, kInstaller};
    });
    self = &mock;
    UpdateService u;
    u.check();
    waitWhile(u, QStringLiteral("checking"));
    u.download();
    waitWhile(u, QStringLiteral("downloading"));
    CHECK2(u.state() == QLatin1String("failed"), u.state());
    CHECK(u.error().contains(QLatin1String("checksum")));
    CHECK(u.file().isEmpty());
    CHECK(!QFile::exists(m_storage.file(QStringLiteral("updates/CloseNI-Setup-9.9.exe"))));
    // Nothing unverified can be installed.
    CHECK(!u.install());
}

void TestUpdates::failures()
{
    {
        MockGitHub mock([](const MockGitHub::Request &) -> MockGitHub::Response { return {404, "{}"}; });
        UpdateService u;
        u.check();
        waitWhile(u, QStringLiteral("checking"));
        CHECK2(u.state() == QLatin1String("current"), u.state()); // no release published yet
    }
    {
        MockGitHub mock([](const MockGitHub::Request &) -> MockGitHub::Response { return {403, "{}"}; });
        UpdateService u;
        u.check();
        waitWhile(u, QStringLiteral("checking"));
        CHECK(u.state() == QLatin1String("failed") && u.error().contains(QLatin1String("rate limiting")));
    }
    {
        // A source build is told what is out, and never downloads.
        qputenv("CLOSENI_UPDATE_KIND", "source");
        MockGitHub *self = nullptr;
        MockGitHub mock([&self](const MockGitHub::Request &) -> MockGitHub::Response {
            return {200, release(self->url(), QStringLiteral("v9.9"))};
        });
        self = &mock;
        UpdateService u;
        u.check();
        waitWhile(u, QStringLiteral("checking"));
        CHECK(u.state() == QLatin1String("available"));
        u.download();
        CHECK(u.state() == QLatin1String("failed") && u.error().contains(QLatin1String("source build")));
        qputenv("CLOSENI_UPDATE_KIND", "installer");
    }
}

QTEST_GUILESS_MAIN(TestUpdates)
#include "tst_updates.moc"
