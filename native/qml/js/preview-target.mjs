/*
 * What should the preview show?
 *
 * An ES module imported by the QML app and by the test harness.
 *
 * Only local addresses count. A documentation link in a traceback is not a
 * server, and pointing the preview at the open internet is not what anyone
 * asked for.
 */
var LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s"'<>)\]]*/g;

function previewTarget(output, files) {
  var urls = String(output || "").match(LOCAL_URL);
  if (urls && urls.length) {
    // The last one wins: a server that reprints its address as it restarts
    // should not pin the preview to the first line it ever wrote.
    return { url: urls[urls.length - 1], kind: "server" };
  }

  var list = files || [];
  var atRoot = null;
  var nested = null;
  for (var i = 0; i < list.length; i++) {
    var p = String(list[i]).replace(/\\/g, "/");
    if (p === "index.html") atRoot = p;
    else if (/(^|\/)index\.html$/.test(p) && !nested) nested = p;
  }
  var pick = atRoot || nested;
  return pick ? { url: pick, kind: "file" } : null;
}

export {
  previewTarget,
};
