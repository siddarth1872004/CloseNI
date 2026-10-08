// Promises over the services' callback methods (see src/Js.h).
//
//   import "../js/api.mjs" as Api
//   Api.call(Workspace, "listFiles", dir).then(function (files) { ... })
//
// QML's engine has no async/await, so code that needs several results in
// order chains .then() instead.
export function call(service, method) {
    const args = Array.prototype.slice.call(arguments, 2);
    return new Promise(function (resolve) {
        args.push(resolve);
        service[method].apply(service, args);
    });
}
