// routes/clientAuth.js
// Registro y login de la cuenta de CLIENTE FINAL -- sección aparte de la
// app, pensada para la persona que recibe una lectura, no para el
// astrólogo. Ver auth-cliente.js para el porqué de la sesión separada.

import { db, newId } from "../db.js";
import {
  hashPassword, verifyPassword, createClientSession, publicClientAccount,
  verificarLimiteIntentos, registrarIntentoFallido, limpiarIntentos,
  buscarFichasCoincidentesPorEmail, confirmarVinculo,
} from "../auth-cliente.js";
import { HttpError } from "../http-utils.js";

export async function registerClient(body) {
  const { email, password, name, date, time, timeUnknown, place, lat, lng, tz, tzName } = body;
  if (!email || !password || !name) throw new HttpError(400, "Faltan email, password o name.");
  if (password.length < 8) throw new HttpError(400, "La contraseña necesita al menos 8 caracteres.");

  const emailNormalizado = email.toLowerCase();
  const existente = db.prepare("SELECT id FROM client_accounts WHERE email = ?").get(emailNormalizado);
  if (existente) throw new HttpError(409, "Ya existe una cuenta con ese email.");

  const { hash, salt } = hashPassword(password);
  const id = newId("ca");
  db.prepare(
    `INSERT INTO client_accounts (id, email, password_hash, password_salt, name, date, time, time_unknown, place, lat, lng, tz, tz_name)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, emailNormalizado, hash, salt, name,
    date || null, time || null, timeUnknown ? 1 : 0, place || null,
    lat ?? null, lng ?? null, tz || null, tzName || null
  );

  // No se vincula nada todavía -- solo se buscan posibles coincidencias
  // para que el cliente las confirme a mano, una por una, antes de que su
  // cuenta quede conectada a esos datos.
  const fichasSugeridas = buscarFichasCoincidentesPorEmail(emailNormalizado);

  const token = createClientSession(id);
  const account = db.prepare("SELECT * FROM client_accounts WHERE id = ?").get(id);
  return { token, account: publicClientAccount(account), fichasSugeridas };
}

export async function loginClient(body) {
  const { email, password } = body;
  if (!email || !password) throw new HttpError(400, "Faltan email o password.");
  const identifier = "cliente:" + String(email).toLowerCase(); // prefijo para no compartir el contador con logins de astrólogo del mismo email

  verificarLimiteIntentos(identifier);

  const account = db.prepare("SELECT * FROM client_accounts WHERE email = ?").get(String(email).toLowerCase());
  if (!account || !verifyPassword(password, account.password_hash, account.password_salt)) {
    registrarIntentoFallido(identifier);
    throw new HttpError(401, "Email o contraseña incorrectos.");
  }
  limpiarIntentos(identifier);

  const token = createClientSession(account.id);
  return { token, account: publicClientAccount(account) };
}

/** Paso explícito de confirmación -- el cliente, ya logueado, elige "sí,
    esta ficha es mía" para una sugerencia puntual. Nunca se vincula nada
    sin que la propia cuenta lo pida activamente. */
export async function confirmLink(account, body) {
  const { fichaId } = body;
  if (!fichaId) throw new HttpError(400, "Falta fichaId.");
  const vinculado = confirmarVinculo(account.id, fichaId, account.email);
  if (!vinculado) throw new HttpError(404, "No se encontró esa ficha para vincular (o ya estaba vinculada a otra cuenta).");
  return { linked: true };
}

// Todas las cartas de todas las fichas que el cliente ya confirmó como
// suyas -- si todavía no vinculó ninguna, devuelve una lista vacía (el
// frontend, en ese caso, calcula la carta al vuelo con sus propios datos
// de nacimiento en vez de buscar una carta ya guardada).
export async function getMyCharts(account) {
  return db.prepare(
    `SELECT charts.* FROM charts
     JOIN clients ON clients.id = charts.client_id
     WHERE clients.client_account_id = ?
     ORDER BY charts.created_at DESC`
  ).all(account.id);
}

// Guarda los datos de nacimiento propios del cliente -- solo para el
// caso en que ningún astrólogo lo tenga cargado todavía. No calcula la
// carta acá (eso lo hace el frontend, con el mismo motor real de
// siempre) -- esta ruta solo persiste los datos para la próxima vez.
export async function updateBirthData(account, body) {
  const { date, time, timeUnknown, place, lat, lng, tz, tzName } = body;
  if (!date || !place) throw new HttpError(400, "Faltan date o place.");
  db.prepare(
    `UPDATE client_accounts SET date = ?, time = ?, time_unknown = ?, place = ?, lat = ?, lng = ?, tz = ?, tz_name = ? WHERE id = ?`
  ).run(date, time || null, timeUnknown ? 1 : 0, place, lat ?? null, lng ?? null, tz || null, tzName || null, account.id);
  const actualizada = db.prepare("SELECT * FROM client_accounts WHERE id = ?").get(account.id);
  return publicClientAccount(actualizada);
}
