pragma Singleton
import QtQuick
import CloseNI
import "../js/renderer-logic.mjs" as R

/*
 * Toasts and the console, from desktop/renderer/core.js (toast, log, plog,
 * setConsole). The two logs are bounded: a long session must not grow them
 * without limit.
 *
 * The console drawer, closed, counts what arrived; an error opens it, because
 * an error nobody sees is the failure mode the old always-open panes existed
 * to prevent. Open or closed is remembered, as a convenience only.
 */
QtObject {
    id: notify

    readonly property int maxLines: 2000

    // { msg, kind, id } - ToastStack fades each after 3.5s and drops it at 3.9s.
    property ListModel toasts: ListModel {}
    // { line, cls } where cls is "", "ok", "step" or "err".
    property ListModel agentLog: ListModel {}
    property ListModel projectLog: ListModel {}

    property bool consoleOpen: Prefs.get("closeni.console", "closed") === "open"
    property int unread: 0
    readonly property string unreadText: R.unreadBadge(unread)
    property int _nextToast: 1

    function toast(msg, kind) {
        toasts.append({ msg: String(msg), kind: kind === "err" ? "err" : "", tid: _nextToast++ })
    }
    function dropToast(tid) {
        for (var i = 0; i < toasts.count; i++) {
            if (toasts.get(i).tid === tid) { toasts.remove(i); return }
        }
    }

    function _push(model, line, cls) {
        model.append({ line: String(line), cls: cls || "" })
        if (model.count > maxLines) model.remove(0, model.count - maxLines)
    }
    function log(line, cls) {
        _push(agentLog, line, cls)
        _arrived(cls === "err")
    }
    function plog(line) {
        _push(projectLog, line, "")
        _arrived(false)
    }
    function _arrived(isError) {
        if (consoleOpen) return
        if (isError) { setConsole(true, false); return }
        unread++
    }
    function setConsole(open, remember) {
        consoleOpen = !!open
        if (open) unread = 0
        if (remember) Prefs.set("closeni.console", open ? "open" : "closed")
    }
    function clearLogs() { agentLog.clear(); projectLog.clear() }

    property Connections _agent: Connections {
        target: Agent
        function onLog(line) { notify.log(line) }
        function onProjectLog(line) { notify.plog(line) }
    }
    // The git buttons, export and clone stream into the project log too.
    property Connections _git: Connections {
        target: Git
        function onProjectLog(line) { notify.plog(line) }
    }
    property Connections _github: Connections {
        target: GitHub
        function onProjectLog(line) { notify.plog(line) }
    }
}
