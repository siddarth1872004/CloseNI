/**
 * The in-page tap that watches the request a provider streams its reply over.
 *
 * Moved here verbatim from PlaywrightController.watchReplyStream so that the
 * controller and the browser-native layer (web/providers) install the same code
 * rather than two copies that could drift. Behaviour is unchanged: the page's
 * fetch and XHR are wrapped, only open/close events and the HTTP status are
 * reported through the exposed `__closeniStream` binding, and the reply bytes
 * are never read.
 *
 * Both transports, because a page may use either and DeepSeek uses only one of
 * them - XHR. The original wrapped fetch alone, so the tap never fired once
 * against the live site and completion silently fell back to text stability
 * for the whole life of the feature. Measured on 11 August: 0 fetch calls, 36
 * XHR calls, with /api/v0/chat/completion among them.
 *
 * Self-contained on purpose: Playwright serialises it with toString() and runs
 * it inside the page, so it may not close over anything in this module.
 */
export function replyStreamTap(pat: string): void {
  const w = globalThis as any;
  if (w.__closeniTapped) return;
  w.__closeniTapped = true;
  const re = new RegExp(pat);

  if (w.fetch) {
    const orig = w.fetch.bind(w);
    w.fetch = async (...args: any[]) => {
      const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
      const res = await orig(...args);
      try {
        if (!re.test(String(url)) || !res.body) return res;
        const [mine, theirs] = res.body.tee();
        w.__closeniStream("open", res.status);
        (async () => {
          const rd = mine.getReader();
          // The third argument says whether the stream ended in an error - a
          // connection cut mid-reply, which otherwise looks exactly like a
          // finished one. PlaywrightController ignores it; the web layer uses it.
          let errored = false;
          try { for (;;) { const r = await rd.read(); if (r.done) break; } }
          catch { errored = true; }
          finally { w.__closeniStream("close", res.status, errored); }
        })();
        return new (w.Response)(theirs, res);
      } catch { return res; }
    };
  }

  // XHR needs no tee: the page reads the response itself and readyState
  // tells us the same two things a tee'd body would - it started, it
  // finished. Nothing is intercepted, so the page behaves identically.
  const X = w.XMLHttpRequest;
  if (X && X.prototype && X.prototype.open) {
    const open = X.prototype.open;
    const send = X.prototype.send;
    X.prototype.open = function (method: string, url: string, ...rest: any[]) {
      try { (this as any).__closeniUrl = String(url || ""); } catch { /* frozen */ }
      return open.apply(this, [method, url, ...rest] as any);
    };
    X.prototype.send = function (...args: any[]) {
      try {
        const url = (this as any).__closeniUrl || "";
        if (re.test(url)) {
          let opened = false;
          this.addEventListener("readystatechange", () => {
            // HEADERS_RECEIVED: the server has begun answering.
            // HEADERS_RECEIVED is also the first moment `status` exists,
            // so the reply's HTTP result is known here for free - no body is
            // read and nothing is guessed at.
            if (!opened && this.readyState >= 2) {
              opened = true;
              w.__closeniStream("open", this.status);
            }
          });
          // loadend covers load, error and abort, so a stream that fails
          // still closes and cannot leave the counter permanently unbalanced.
          this.addEventListener("loadend", () => {
            // status 0 after headers arrived means the transfer failed.
            if (opened) w.__closeniStream("close", this.status, this.status === 0);
          });
        }
      } catch { /* never break the page's own request */ }
      return send.apply(this, args as any);
    };
  }
}

/**
 * A cheap "did anything change" counter for the new layer.
 *
 * A MutationObserver on the document increments a sequence number on every
 * childList/characterData change. Polling reads one integer; the reply text is
 * only re-read when the integer moved - instead of a full textContent read
 * every tick, which is what the controller does.
 */
export function mutationCounter(): void {
  const w = globalThis as any;
  if (w.__closeniMut) return;
  const state = { seq: 0, last: Date.now() };
  w.__closeniMut = state;
  const doc = w.document;
  const start = () => {
    if (!doc.body) return false;
    new w.MutationObserver(() => { state.seq++; state.last = Date.now(); })
      .observe(doc.body, { childList: true, subtree: true, characterData: true });
    return true;
  };
  if (!start()) doc.addEventListener("DOMContentLoaded", start, { once: true });
}
