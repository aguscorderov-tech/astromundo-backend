// auth-cliente.js
// Autenticación de la CUENTA DE CLIENTE FINAL — separada a propósito de la
// de los astrólogos (auth.js). Reusa lo que es genérico (hash de
// contraseña, límite de intentos de login, que no dependen de qué tabla
// sea), pero tiene su propia tabla de sesión (client_sessions) para que un
// token de cliente nunca sirva donde se espera un astrólogo, ni al revés.

import { randomBytes } from "node:crypto";
import { db, newId } from "./db.js";
import { hashPassword, verifyPassword, verificarLimiteIntentos, registrarIntentoFallido, limpiarIntentos } from "./auth.js";

export { hashPassword, verifyPassword, verificarLimiteIntentos, registrarIntentoFallido, limpiarIntentos };

const SESSION_DAYS = 30;

export function createClientSession(clientAccountId) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare("INSERT INTO client_sessions (token, client_account_id, expires_at) VALUES (?, ?, ?)").run(token, clientAccountId, expiresAt);
  return token;
}

export function getClientAccountFromToken(token) {
  if (!token) return null;
  const row = db.prepare(
    "SELECT client_accounts.* FROM client_sessions JOIN client_accounts ON client_accounts.id = client_sessions.client_account_id WHERE client_sessions.token = ? AND client_sessions.expires_at > datetime('now')"
  ).get(token);
  return row || null;
}

// Mismo patrón que authenticate() en auth.js, pero mira el header aparte
// (X-Client-Auth en vez de Authorization) -- así en un mismo navegador se
// puede, en teoría, tener sesión de astrólogo Y de cliente al mismo tiempo
// sin que una pise a la otra.
export function authenticateClient(req) {
  const header = req.headers["x-client-auth"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  return getClientAccountFromToken(token);
}

export function publicClientAccount(account) {
  return {
    id: account.id, email: account.email, name: account.name,
    date: account.date, time: account.time, timeUnknown: !!account.time_unknown,
    place: account.place, lat: account.lat, lng: account.lng, tz: account.tz, tzName: account.tz_name,
    notificationPref: account.notification_pref, createdAt: account.created_at,
  };
}

/** Al registrarse, busca si algún astrólogo ya tenía una ficha cargada con
    este mismo email -- pero NO la vincula sola. Devuelve la lista para que
    el cliente confirme explícitamente "sí, soy yo" antes de que su cuenta
    quede conectada a esos datos. Sin esta confirmación, vincular a ciegas
    por coincidencia de email es un riesgo real: si ese email ya no le
    pertenece a esa persona (typo del astrólogo, o el email cambió de dueño
    con el tiempo), alguien distinto terminaría viendo datos que no son
    suyos sin darse cuenta. */
export function buscarFichasCoincidentesPorEmail(email) {
  return db.prepare(
    `SELECT clients.id, clients.name, clients.date, clients.place, users.professional_name AS astrologo
     FROM clients JOIN users ON users.id = clients.user_id
     WHERE LOWER(clients.email) = ? AND clients.client_account_id IS NULL`
  ).all(email.toLowerCase());
}

/** Confirma el vínculo de UNA ficha puntual, ya elegida explícitamente por
    el cliente ("sí, esta es mi carta"). Se valida de nuevo que el email de
    esa ficha coincida con el de la cuenta -- así ni siquiera con el id a
    mano se puede vincular una ficha ajena. */
export function confirmarVinculo(clientAccountId, fichaId, emailCuenta) {
  const resultado = db.prepare(
    "UPDATE clients SET client_account_id = ? WHERE id = ? AND LOWER(email) = ? AND client_account_id IS NULL"
  ).run(clientAccountId, fichaId, emailCuenta.toLowerCase());
  return resultado.changes > 0;
}
