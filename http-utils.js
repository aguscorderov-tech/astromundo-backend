// http-utils.js
// Helpers mínimos para no depender de Express — el servidor entero corre con
// el módulo http nativo de Node, cero dependencias externas.

export function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  // Los headers de CORS y de seguridad ya se ponen una sola vez, al
  // principio de cada pedido, en aplicarHeadersDeSeguridad() (server.js) —
  // acá NO hay que repetirlos: si esta llamada a writeHead() incluyera de
  // nuevo "Access-Control-Allow-Origin", pisaría (con el valor viejo,
  // abierto a *) lo que ya se calculó bien más arriba.
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function readJSONBody(req, maxBytes = 5_000_000) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; if (raw.length > maxBytes) req.destroy(); });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error("JSON inválido en el body")); }
    });
    req.on("error", reject);
  });
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
