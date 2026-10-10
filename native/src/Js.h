#pragma once

#include <QJSEngine>
#include <QJSValue>
#include <QVariant>

/*
 * Replying to QML.
 *
 * Every asynchronous method a service exposes takes a QJSValue callback as its
 * last argument and calls it exactly once with the result, as plain JSON.
 * qml/js/api.mjs turns that into a
 * Promise for code that chains.
 */
namespace Js {

/*
 * A list becomes a real JS Array, at any depth. toScriptValue alone turns a
 * QVariantList into a sequence wrapper, which Array.isArray rejects, so a
 * caller checking for an array silently dropped every item.
 */
inline QJSValue toJs(QJSEngine *engine, const QVariant &value)
{
    const int type = value.typeId();
    if (type == QMetaType::QVariantList || type == QMetaType::QStringList) {
        const QVariantList list = value.toList();
        QJSValue array = engine->newArray(uint(list.size()));
        for (qsizetype i = 0; i < list.size(); ++i)
            array.setProperty(quint32(i), toJs(engine, list.at(i)));
        return array;
    }
    if (type == QMetaType::QVariantMap) {
        const QVariantMap map = value.toMap();
        QJSValue object = engine->newObject();
        for (auto it = map.cbegin(); it != map.cend(); ++it)
            object.setProperty(it.key(), toJs(engine, it.value()));
        return object;
    }
    return engine->toScriptValue(value);
}

/* `owner` is the service: a QML singleton, so it knows its engine. */
inline void reply(QObject *owner, QJSValue callback, const QVariant &result = QVariant())
{
    if (!callback.isCallable())
        return;
    QJSEngine *engine = qjsEngine(owner);
    if (!engine)
        return;
    callback.call({toJs(engine, result)});
}

}
