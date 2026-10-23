#include "UpdateService.h"

#include "GitHubApi.h"
#include "Paths.h"

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QProcess>
#include <QRegularExpression>
#include <QUrl>

#include <cstdio>

namespace {

const char *const kRepo = "/repos/siddarth1872004/CloseNI/releases/latest";
const char *const kSums = "SHA256SUMS.txt";

bool g_unattended = false;

QNetworkRequest request(const QString &url)
{
    QNetworkRequest req{QUrl(url)};
    // A release file answers with a redirect to GitHub's file host.
    req.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::NoLessSafeRedirectPolicy);
    req.setRawHeader("User-Agent", "CloseNI");
    return req;
}

/* A failed reply, as one line for the About section. */
QString describe(QNetworkReply *r)
{
    const int status = r->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    if (status == 403 || status == 429)
        return QStringLiteral("GitHub is rate limiting update checks. Try again later.");
    if (status)
        return QStringLiteral("GitHub answered %1.").arg(status);
    return QStringLiteral("Could not reach GitHub: %1").arg(r->errorString());
}

}

UpdateService::UpdateService(QObject *parent)
    : QObject(parent)
    , m_nam(new QNetworkAccessManager(this))
    , m_kind(detectKind())
{
}

UpdateService::~UpdateService()
{
    if (m_reply) {
        m_reply->disconnect(this);
        m_reply->abort();
    }
    // A download cut off by quitting is not kept.
    if (m_out)
        m_out->remove();
}

bool UpdateService::automatic() const
{
    return !g_unattended && qEnvironmentVariable("CLOSENI_NO_UPDATE_CHECK").isEmpty();
}

void UpdateService::setUnattended(bool on)
{
    g_unattended = on;
}

int UpdateService::compareVersions(const QString &a, const QString &b)
{
    // Each part's leading digits: "0.2-beta" reads as 0.2.
    static const QRegularExpression digits(QStringLiteral("^\\d+"));
    auto parts = [](QString v) {
        v = v.trimmed();
        if (v.startsWith(QLatin1Char('v')) || v.startsWith(QLatin1Char('V')))
            v.remove(0, 1);
        QList<qlonglong> out;
        for (const QString &p : v.split(QLatin1Char('.')))
            out << digits.match(p).captured().toLongLong();
        return out;
    };
    const QList<qlonglong> x = parts(a), y = parts(b);
    for (qsizetype i = 0; i < qMax(x.size(), y.size()); ++i) {
        const qlonglong l = x.value(i), r = y.value(i);
        if (l != r)
            return l < r ? -1 : 1;
    }
    return 0;
}

QString UpdateService::assetFor(const QString &kind, const QStringList &names)
{
    // The names release.yml gives the files.
    QString pattern;
    if (kind == QLatin1String("installer"))
        pattern = QStringLiteral("^CloseNI-Setup-[^/\\\\]+\\.exe$");
    else if (kind == QLatin1String("appimage"))
        pattern = QStringLiteral("^CloseNI-[^/\\\\]+\\.AppImage$");
    else if (kind == QLatin1String("deb"))
        pattern = QStringLiteral("^closeni_[^/\\\\]+_amd64\\.deb$");
    else
        return QString();
    const QRegularExpression re(pattern);
    for (const QString &n : names)
        if (re.match(n).hasMatch())
            return n;
    return QString();
}

QString UpdateService::sumFor(const QByteArray &sums, const QString &name)
{
    // sha256sum writes "<digest>  <name>", or "<digest> *<name>" in binary mode.
    static const QRegularExpression line(QStringLiteral("^([0-9a-fA-F]{64}) [ *](.+)$"));
    for (const QByteArray &raw : sums.split('\n')) {
        const QRegularExpressionMatch m = line.match(QString::fromUtf8(raw).trimmed());
        if (m.hasMatch() && m.captured(2) == name)
            return m.captured(1).toLower();
    }
    return QString();
}

QString UpdateService::detectKind()
{
    const QString forced = qEnvironmentVariable("CLOSENI_UPDATE_KIND");
    if (!forced.isEmpty())
        return forced;
    // A checkout runs its own build; only a packaged copy carries the agent.
    if (!Paths::agentIsBundled())
        return QStringLiteral("source");
#if defined(Q_OS_WIN)
    return QStringLiteral("installer");
#elif defined(Q_OS_LINUX)
    // The AppImage runtime names the file it was started from.
    if (!qEnvironmentVariable("APPIMAGE").isEmpty())
        return QStringLiteral("appimage");
    return QStringLiteral("deb");
#else
    return QStringLiteral("source");
#endif
}

void UpdateService::setState(const QString &state, const QString &error)
{
    m_state = state;
    m_error = error;
    emit changed();
}

void UpdateService::check()
{
    if (m_state == QLatin1String("checking") || m_state == QLatin1String("downloading"))
        return;
    setState(QStringLiteral("checking"));
    QNetworkRequest req = request(GitHubApi::baseUrl() + QLatin1String(kRepo));
    req.setRawHeader("Accept", "application/vnd.github+json");
    QNetworkReply *r = m_nam->get(req);
    m_reply = r;
    connect(r, &QNetworkReply::finished, this, [this, r] {
        r->deleteLater();
        const int status = r->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        // No published release yet.
        if (status == 404) {
            setState(QStringLiteral("current"));
            return;
        }
        if (r->error() != QNetworkReply::NoError) {
            setState(QStringLiteral("failed"), describe(r));
            return;
        }
        const QJsonObject release = QJsonDocument::fromJson(r->readAll()).object();
        const QString tag = release.value(QStringLiteral("tag_name")).toString();
        if (tag.isEmpty()) {
            setState(QStringLiteral("failed"), QStringLiteral("GitHub's answer had no release in it."));
            return;
        }
        m_latest = tag.startsWith(QLatin1Char('v')) ? tag.mid(1) : tag;
        m_notesUrl = release.value(QStringLiteral("html_url")).toString();
        QStringList names;
        QHash<QString, QString> urls;
        for (const QJsonValue &a : release.value(QStringLiteral("assets")).toArray()) {
            const QString name = a.toObject().value(QStringLiteral("name")).toString();
            names << name;
            urls.insert(name, a.toObject().value(QStringLiteral("browser_download_url")).toString());
        }
        m_assetName = assetFor(m_kind, names);
        m_assetUrl = urls.value(m_assetName);
        m_sumsUrl = urls.value(QLatin1String(kSums));
        setState(compareVersions(m_latest, QCoreApplication::applicationVersion()) > 0 ? QStringLiteral("available")
                                                                                       : QStringLiteral("current"));
    });
}

QString UpdateService::downloadPath() const
{
    // Beside the AppImage, so the swap is a rename on one file system;
    // anything else in the storage directory.
    if (m_kind == QLatin1String("appimage"))
        return QFileInfo(qEnvironmentVariable("APPIMAGE")).absolutePath() + QLatin1String("/.") + m_assetName + QLatin1String(".part");
    return Paths::storageRoot() + QLatin1String("/updates/") + m_assetName;
}

void UpdateService::download()
{
    if (m_state != QLatin1String("available"))
        return;
    if (m_assetUrl.isEmpty() || m_sumsUrl.isEmpty()) {
        setState(QStringLiteral("failed"), m_kind == QLatin1String("source")
                     ? QStringLiteral("This is a source build: pull and rebuild to update.")
                     : QStringLiteral("The release has no file for this system, or no checksums. Download it from the release page."));
        return;
    }
    // A release file named by GitHub's answer is only ever fetched over HTTPS,
    // unless the endpoint itself is a test's local server.
    const bool local = !qEnvironmentVariable("CLOSENI_GITHUB_API").isEmpty();
    if (!local && (QUrl(m_assetUrl).scheme() != QLatin1String("https") || QUrl(m_sumsUrl).scheme() != QLatin1String("https"))) {
        setState(QStringLiteral("failed"), QStringLiteral("The release's download link is not HTTPS."));
        return;
    }
    m_progress = 0;
    setState(QStringLiteral("downloading"));
    fetchSums();
}

void UpdateService::fetchSums()
{
    QNetworkReply *r = m_nam->get(request(m_sumsUrl));
    m_reply = r;
    connect(r, &QNetworkReply::finished, this, [this, r] {
        r->deleteLater();
        if (r->error() != QNetworkReply::NoError) {
            setState(QStringLiteral("failed"), describe(r));
            return;
        }
        const QString digest = sumFor(r->readAll(), m_assetName);
        if (digest.isEmpty()) {
            setState(QStringLiteral("failed"), QStringLiteral("%1 is not in the release's checksums.").arg(m_assetName));
            return;
        }
        fetchAsset(digest);
    });
}

void UpdateService::fetchAsset(const QString &digest)
{
    const QString path = downloadPath();
    QDir().mkpath(QFileInfo(path).absolutePath());
    if (m_kind != QLatin1String("appimage")) {
        // One download at a time is kept: an earlier version's is spent.
        QDir dir(QFileInfo(path).absolutePath());
        for (const QString &old : dir.entryList(QDir::Files))
            if (old != m_assetName)
                dir.remove(old);
    }
    m_out = new QFile(path, this);
    if (!m_out->open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        const QString why = m_kind == QLatin1String("appimage")
            ? QStringLiteral("Cannot write beside %1. Download the new AppImage from the release page.").arg(qEnvironmentVariable("APPIMAGE"))
            : QStringLiteral("Cannot write %1: %2").arg(path, m_out->errorString());
        delete m_out;
        m_out = nullptr;
        setState(QStringLiteral("failed"), why);
        return;
    }
    m_hash.reset();
    QNetworkReply *r = m_nam->get(request(m_assetUrl));
    m_reply = r;
    // Written as it arrives: an installer is far too big to hold in memory.
    connect(r, &QNetworkReply::readyRead, this, [this, r] {
        const QByteArray chunk = r->readAll();
        m_hash.addData(chunk);
        m_out->write(chunk);
    });
    connect(r, &QNetworkReply::downloadProgress, this, [this](qint64 got, qint64 total) {
        if (total > 0) {
            m_progress = double(got) / double(total);
            emit changed();
        }
    });
    connect(r, &QNetworkReply::finished, this, [this, r, digest, path] {
        r->deleteLater();
        const QByteArray rest = r->readAll();
        m_hash.addData(rest);
        m_out->write(rest);
        const bool written = m_out->flush();
        m_out->close();
        delete m_out;
        m_out = nullptr;
        if (r->error() != QNetworkReply::NoError || !written) {
            QFile::remove(path);
            setState(QStringLiteral("failed"), written ? describe(r) : QStringLiteral("Could not write the download."));
            return;
        }
        if (QString::fromLatin1(m_hash.result().toHex()) != digest) {
            QFile::remove(path);
            setState(QStringLiteral("failed"), QStringLiteral("The download did not match its checksum, so it was deleted."));
            return;
        }
        m_file = path;
        m_progress = 1;
        setState(QStringLiteral("ready"));
    });
}

bool UpdateService::install()
{
    if (m_state != QLatin1String("ready") || m_file.isEmpty())
        return false;
    if (m_kind == QLatin1String("installer")) {
        if (!QProcess::startDetached(m_file, {})) {
            setState(QStringLiteral("failed"), QStringLiteral("The installer would not start: %1").arg(m_file));
            return false;
        }
    } else if (m_kind == QLatin1String("appimage")) {
        const QString target = qEnvironmentVariable("APPIMAGE");
        QFile::setPermissions(m_file, QFile::permissions(target) | QFileDevice::ExeOwner | QFileDevice::ReadOwner);
        // rename(2) replaces the file in one step. The running copy keeps the
        // old one open until it exits.
        if (std::rename(QFile::encodeName(m_file).constData(), QFile::encodeName(target).constData()) != 0) {
            setState(QStringLiteral("failed"), QStringLiteral("Could not replace %1.").arg(target));
            return false;
        }
        m_file.clear();
        // The new copy's runtime sets these afresh; the old copy's would point
        // at a mount that goes away when it exits.
        QProcess next;
        QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
        for (const char *name : {"APPDIR", "APPIMAGE", "ARGV0", "OWD"})
            env.remove(QString::fromLatin1(name));
        next.setProcessEnvironment(env);
        next.setProgram(target);
        next.startDetached();
    } else {
        return false;
    }
    QMetaObject::invokeMethod(QCoreApplication::instance(), [] { QCoreApplication::quit(); }, Qt::QueuedConnection);
    return true;
}
