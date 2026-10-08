#pragma once

#include <QJSEngine>
#include <QJSValue>
#include <QVariant>

/*
 * Replying to QML.
 *
 * Every asynchronous method a service exposes takes a QJSValue callback as its
 * last argument and calls it exactly once with the result, the same JSON shape
 * the Electron IPC handler resolved with. qml/js/api.mjs turns that into a
 * Promise for code that chains.
 */
namespace Js {

/* `owner` is the service: a QML singleton, so it knows its engine. */
inline void reply(QObject *owner, QJSValue callback, const QVariant &result = QVariant())
{
    if (!callback.isCallable())
        return;
    QJSEngine *engine = qjsEngine(owner);
    if (!engine)
        return;
    callback.call({engine->toScriptValue(result)});
}

}
