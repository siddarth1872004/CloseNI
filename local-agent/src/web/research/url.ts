/**
 * One URL, one identity.
 *
 * The same page arrives as ?utm_source=newsletter, with a #fragment, with and
 * without a trailing slash, via http and https, with its query in another order.
 * Deduplication, the visited set, the cache and the source graph all key on the
 * canonical form, so none of them sees one page as five.
 */
import { SourceType } from "./types.js";

const TRACKING = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|yclid|igshid|ref|ref_src|ref_url|referrer|source|spm|_hsenc|_hsmi|mkt_tok|vero_id|oly_\w+|__s|si|feature|share)$/i;

export function canonicalizeUrl(raw: string, base?: string): string {
  let u: URL;
  try { u = base ? new URL(raw, base) : new URL(raw); } catch { return String(raw || "").trim(); }
  if (u.protocol !== "http:" && u.protocol !== "https:") return u.toString();
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) u.port = "";
  const keep: Array<[string, string]> = [];
  u.searchParams.forEach((v, k) => { if (!TRACKING.test(k)) keep.push([k, v]); });
  keep.sort((a, b) => (a[0] + "=" + a[1]).localeCompare(b[0] + "=" + b[1]));
  u.search = keep.length ? "?" + keep.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&") : "";
  let path = u.pathname.replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/$/, "");
  path = path.replace(/\/index\.html?$/i, "") || "/";
  u.pathname = path;
  // Scheme is not part of identity: an http and an https copy are one page.
  return u.toString().replace(/^https?:\/\//, "//");
}

export function domainOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

/** The registrable-ish part: docs.python.org → python.org. Heuristic, for diversity counting. */
export function siteOf(url: string): string {
  const d = domainOf(url);
  const parts = d.split(".");
  if (parts.length <= 2 || /^\d+$/.test(parts[parts.length - 1])) return d;
  const sld = parts[parts.length - 2];
  if (["co", "com", "org", "net", "ac", "gov", "edu"].includes(sld) && parts.length >= 3) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

/**
 * What kind of source a URL is, from the URL alone.
 *
 * Deliberately cheap and conservative: it is a retrieval signal, not a verdict
 * on trustworthiness, and "unknown" is a fine answer.
 */
export function sourceTypeOf(url: string, title: string = ""): SourceType {
  const d = domainOf(url);
  let path = "";
  try { path = new URL(url).pathname.toLowerCase(); } catch { /* keep empty */ }
  if (/(^|\.)github\.com$|(^|\.)gitlab\.com$|(^|\.)bitbucket\.org$/.test(d)) return "code-repository";
  if (/wikipedia\.org$/.test(d)) return "encyclopedia";
  if (/arxiv\.org$|doi\.org$|acm\.org$|ieee\.org$|springer\.com$|sciencedirect\.com$|semanticscholar\.org$|nature\.com$/.test(d)) return "academic";
  if (/stackoverflow\.com$|stackexchange\.com$|reddit\.com$|news\.ycombinator\.com$|discourse|forum/.test(d)) return "forum";
  if (/^docs?\.|^developer\.|^devdocs\.|readthedocs\.io$|^learn\./.test(d) || /\/(docs?|documentation|reference|api|manual|guide)(\/|$)/.test(path)) return "documentation";
  if (/news|reuters\.com$|apnews\.com$|bbc\.|nytimes\.com$|theverge\.com$|techcrunch\.com$/.test(d) || /\/news\//.test(path)) return "news";
  if (/^blog\.|medium\.com$|dev\.to$|substack\.com$/.test(d) || /\/blog\//.test(path) || /\bblog\b/i.test(title)) return "blog";
  return "unknown";
}

/** Same page, ignoring scheme/tracking/fragment. */
export function sameDocument(a: string, b: string): boolean {
  return canonicalizeUrl(a) === canonicalizeUrl(b);
}

export function isHttpUrl(u: string): boolean {
  return /^https?:\/\//i.test(String(u || ""));
}

/** The URL as it should be cited: scheme kept, tracking parameters and fragment removed. */
export function cleanUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { return raw; }
  u.hash = "";
  for (const k of Array.from(u.searchParams.keys())) if (TRACKING.test(k)) u.searchParams.delete(k);
  return u.toString();
}
