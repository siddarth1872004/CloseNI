/*
 * The system secret store, round trip. Skipped where there is none (a CI
 * runner, a desktop with no secret service): that is the memory-only case,
 * and the store must say so rather than fall back to a file.
 */
#include "data_harness.h"

#include "SecretStore.h"

class TestSecretStore : public QObject
{
    Q_OBJECT

private slots:
    void roundTrip();
    void cleanupTestCase() { REPORT_CHECKS(); }
};

void TestSecretStore::roundTrip()
{
    ScratchStorage storage; // the Windows store keeps its blob under the storage root
    if (!SecretStore::available())
        QSKIP("no system secret store here");
    const QString account = QStringLiteral("closeni-test-%1").arg(QCoreApplication::applicationPid());
    QString error;

    CHECK2(!SecretStore::load(account, &error) && error.isEmpty(), error);
    CHECK2(SecretStore::store(account, QStringLiteral("ghp_first"), &error), error);
    CHECK(SecretStore::load(account, &error) == QStringLiteral("ghp_first"));
    CHECK2(SecretStore::store(account, QStringLiteral("ghp_second ✓"), &error), error);
    CHECK(SecretStore::load(account, &error) == QStringLiteral("ghp_second ✓"));
    CHECK2(SecretStore::remove(account, &error), error);
    CHECK(!SecretStore::load(account, &error));
    CHECK2(SecretStore::remove(account, &error), error); // already gone is fine
}

QTEST_GUILESS_MAIN(TestSecretStore)
#include "tst_secretstore.moc"
