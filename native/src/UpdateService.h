#pragma once

#include <QByteArray>
#include <QCryptographicHash>
#include <QObject>
#include <QPointer>
#include <QQmlEngine>
#include <QString>
#include <QStringList>

class QFile;
class QNetworkAccessManager;
class QNetworkReply;

/*
 * Updating CloseNI from its GitHub releases.
 *
 * check() reads the latest published release - never a draft or a prerelease,
 * which the endpoint leaves out - and compares its tag with this build's
 * version. download() fetches the file that matches how this copy was
 * installed and verifies it against the release's SHA256SUMS.txt; a file
 * that does not match is deleted, never installed. install() then hands over:
 *
 *   installer  Windows: the new installer runs, and upgrades in place once
 *              CloseNI has quit (installer.nsi waits for it).
 *   appimage   Linux AppImage: the new file replaces $APPIMAGE and starts.
 *   deb        Linux .deb: QML opens the file in the system's package
 *              installer, which asks for the password apt needs.
 *   source     a checkout: only told that a release is out.
 *
 * The release endpoint is GitHubApi::baseUrl(), so tests aim it at a local
 * server with CLOSENI_GITHUB_API. No token is sent: releases are public.
 */
class UpdateService : public QObject
{
    Q_OBJECT
    QML_NAMED_ELEMENT(Updates)
    QML_SINGLETON

    /* idle, checking, current, available, downloading, ready or failed. */
    Q_PROPERTY(QString state READ state NOTIFY changed)
    Q_PROPERTY(QString latest READ latest NOTIFY changed)
    /* The release page, for its notes. */
    Q_PROPERTY(QString notesUrl READ notesUrl NOTIFY changed)
    Q_PROPERTY(double progress READ progress NOTIFY changed)
    Q_PROPERTY(QString error READ error NOTIFY changed)
    /* The downloaded, verified file, once state is "ready". */
    Q_PROPERTY(QString file READ file NOTIFY changed)
    Q_PROPERTY(QString kind READ kind CONSTANT)
    /* False under a test or a script: only a click checks then. */
    Q_PROPERTY(bool automatic READ automatic CONSTANT)

public:
    explicit UpdateService(QObject *parent = nullptr);
    ~UpdateService() override;

    QString state() const { return m_state; }
    QString latest() const { return m_latest; }
    QString notesUrl() const { return m_notesUrl; }
    double progress() const { return m_progress; }
    QString error() const { return m_error; }
    QString file() const { return m_file; }
    QString kind() const { return m_kind; }
    bool automatic() const;

    Q_INVOKABLE void check();
    Q_INVOKABLE void download();
    /* Hands over to the new version and quits; false, with error set, when it cannot. */
    Q_INVOKABLE bool install();

    /* main.cpp turns automatic checks off for --self-test and the other unattended runs. */
    static void setUnattended(bool on);

    /* <0, 0 or >0 as a is older, the same or newer than b. A leading v and trailing zero parts are ignored. */
    static int compareVersions(const QString &a, const QString &b);
    /* The release file for an install kind, from the release's file names; "" when none fits. */
    static QString assetFor(const QString &kind, const QStringList &names);
    /* The lower-case hex digest `name` has in a sha256sum listing; "" when it is not listed. */
    static QString sumFor(const QByteArray &sums, const QString &name);
    /* How this copy was installed. CLOSENI_UPDATE_KIND overrides it. */
    static QString detectKind();

signals:
    void changed();

private:
    void setState(const QString &state, const QString &error = QString());
    void fetchSums();
    void fetchAsset(const QString &digest);
    QString downloadPath() const;

    QNetworkAccessManager *m_nam;
    QPointer<QNetworkReply> m_reply;
    QFile *m_out = nullptr;
    QCryptographicHash m_hash{QCryptographicHash::Sha256};

    QString m_state = QStringLiteral("idle");
    QString m_latest;
    QString m_notesUrl;
    double m_progress = 0;
    QString m_error;
    QString m_file;
    QString m_kind;

    QString m_assetName;
    QString m_assetUrl;
    QString m_sumsUrl;
};
