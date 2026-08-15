// auth.js
// Hash de contraseñas con scrypt (nativo de node:crypto, mismo nivel de
// seguridad que bcrypt para este caso de uso) y sesiones por token — sin
// dependencias externas ni JWT: un token aleatorio guardado en la tabla
// `sessions`, con expiración de 30 días.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db, newId } from "./db.js";
import { HttpError } from "./http-utils.js";
import { generarSecretoTotp, verificarTotp, otpauthUri } from "./totp.js";

const SESSION_DAYS = 30;

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  const attempt = scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, "hex");
  if (attempt.length !== stored.length) return false;
  return timingSafeEqual(attempt, stored);
}

export function createSession(userId) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(token, userId, expiresAt);
  return token;
}

export function getUserFromToken(token) {
  if (!token) return null;
  const row = db.prepare(
    "SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token = ? AND sessions.expires_at > datetime('now')"
  ).get(token);
  return row || null;
}

// Middleware-like helper: lee el header Authorization: Bearer <token>,
// devuelve el usuario autenticado o null.
export function authenticate(req) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  return getUserFromToken(token);
}

export function publicUser(user) {
  return {
    id: user.id, email: user.email, name: user.name, plan: user.plan,
    professionalName: user.professional_name, isAdmin: !!user.is_admin, createdAt: user.created_at,
    photoUrl: user.photo_url, bio: user.bio, totpEnabled: !!user.totp_enabled,
  };
}

// El "dueño" de la plataforma se designa por variable de entorno
// (ADMIN_EMAIL en Railway) — nunca autoasignable desde la app, para que no
// haya forma de que un astrólogo cualquiera se dé permisos de admin.
export function grantAdminIfOwner(user) {
  const ownerEmail = (process.env.ADMIN_EMAIL || "").toLowerCase().trim();
  if (ownerEmail && user.email.toLowerCase() === ownerEmail && !user.is_admin) {
    db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(user.id);
    user.is_admin = 1;
    registrarEvento("admin_granted", { userId: user.id, email: user.email });
  }
  return user;
}

// ---------------------------------------------------------------------------
// Límite de intentos de login (Fase 0 del plan de seguridad). Todo el
// cálculo de tiempo se hace en SQL con datetime('now', ...) en vez de traer
// fechas a JavaScript y restarlas a mano — mismo criterio que ya usa
// getUserFromToken() de más arriba para la expiración de sesión, así no se
// suma un segundo método de manejar fechas en el mismo archivo.

const INTENTOS_MAXIMOS = 10;
const VENTANA_MINUTOS = 15;
const BLOQUEO_MINUTOS = 15;

/** Tira HttpError si ese identifier está bloqueado ahora mismo. Se llama
    ANTES de verificar la contraseña, para no gastar el cálculo de scrypt
    (que es lento a propósito) en un pedido que ya se sabe que hay que
    rechazar. */
export function verificarLimiteIntentos(identifier) {
  const bloqueado = db.prepare(
    "SELECT 1 FROM login_attempts WHERE identifier = ? AND blocked_until IS NOT NULL AND blocked_until > datetime('now')"
  ).get(identifier);
  if (bloqueado) {
    registrarEvento("login_blocked", { email: identifier });
    throw new HttpError(429, "Demasiados intentos fallidos con este email — probá de nuevo en unos minutos.");
  }
}

export function registrarIntentoFallido(identifier) {
  const row = db.prepare("SELECT * FROM login_attempts WHERE identifier = ?").get(identifier);

  if (!row) {
    db.prepare("INSERT INTO login_attempts (identifier, count, window_started_at) VALUES (?, 1, datetime('now'))").run(identifier);
    return;
  }

  const ventanaVencida = db.prepare(
    "SELECT (window_started_at <= datetime('now', '-' || ? || ' minutes')) AS vencida FROM login_attempts WHERE identifier = ?"
  ).get(VENTANA_MINUTOS, identifier);

  if (ventanaVencida.vencida) {
    // Pasó la ventana sin llegar al máximo — arranca de cero, no se arrastra.
    db.prepare("UPDATE login_attempts SET count = 1, window_started_at = datetime('now'), blocked_until = NULL WHERE identifier = ?").run(identifier);
    return;
  }

  const nuevoCount = row.count + 1;
  if (nuevoCount >= INTENTOS_MAXIMOS) {
    db.prepare(
      "UPDATE login_attempts SET count = ?, blocked_until = datetime('now', '+' || ? || ' minutes') WHERE identifier = ?"
    ).run(nuevoCount, BLOQUEO_MINUTOS, identifier);
  } else {
    db.prepare("UPDATE login_attempts SET count = ? WHERE identifier = ?").run(nuevoCount, identifier);
  }
}

/** Login correcto: se borra el historial de intentos de ese identifier. */
export function limpiarIntentos(identifier) {
  db.prepare("DELETE FROM login_attempts WHERE identifier = ?").run(identifier);
}

// ---------------------------------------------------------------------------
// Registro de eventos de seguridad (Fase 1 del plan). No guarda TODO lo que
// pasa en la app — solo lo que serviría para reconstruir qué ocurrió si algo
// raro pasa: logins (exitosos y fallidos), bloqueos por intentos, cambios de
// contraseña, borrado de cuenta, y otorgamiento de admin.
export function registrarEvento(eventType, { userId = null, email = null, detail = null } = {}) {
  db.prepare(
    "INSERT INTO security_events (id, user_id, email, event_type, detail) VALUES (?, ?, ?, ?, ?)"
  ).run(newId("evt"), userId, email, eventType, detail);
}

// ---------------------------------------------------------------------------
// Verificación en dos pasos (Fase 2, ítem 13) — TOTP compatible con Google
// Authenticator, Authy, etc. Pensada especialmente para cuentas de
// administrador, pero disponible para cualquier cuenta.

const PENDING_2FA_MINUTES = 5;

/** Genera un secreto nuevo y lo guarda — todavía SIN activar (totp_enabled
    sigue en 0) hasta que se confirme con confirmarTotp(). Un alta a medio
    hacer nunca bloquea el login normal. */
export function iniciarSetupTotp(user) {
  const secret = generarSecretoTotp();
  db.prepare("UPDATE users SET totp_secret = ? WHERE id = ?").run(secret, user.id);
  return { secret, otpauthUri: otpauthUri(secret, user.email) };
}

export function confirmarSetupTotp(user, code) {
  const row = db.prepare("SELECT totp_secret FROM users WHERE id = ?").get(user.id);
  if (!row.totp_secret) throw new HttpError(400, "Primero pedí el alta de la verificación en dos pasos.");
  if (!verificarTotp(row.totp_secret, code)) throw new HttpError(400, "El código no es correcto.");
  db.prepare("UPDATE users SET totp_enabled = 1 WHERE id = ?").run(user.id);
  registrarEvento("totp_enabled", { userId: user.id, email: user.email });
  return { enabled: true };
}

export function desactivarTotp(user, password) {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  if (!verifyPassword(password, row.password_hash, row.password_salt)) {
    throw new HttpError(403, "La contraseña no es correcta.");
  }
  db.prepare("UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?").run(user.id);
  registrarEvento("totp_disabled", { userId: user.id, email: user.email });
  return { enabled: false };
}

/** El paso intermedio del login: contraseña ya verificada, pero como la
    cuenta tiene 2FA activado, todavía no se crea una sesión real — se crea
    esta ficha corta (5 minutos) que solo sirve para completar el segundo
    paso con completarLoginConTotp(). */
export function crearLogin2faPendiente(userId) {
  const token = randomBytes(32).toString("hex");
  db.prepare(
    "INSERT INTO login_2fa_pending (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+' || ? || ' minutes'))"
  ).run(token, userId, PENDING_2FA_MINUTES);
  return token;
}

export function completarLoginConTotp(pendingToken, code) {
  const pending = db.prepare(
    "SELECT * FROM login_2fa_pending WHERE token = ? AND expires_at > datetime('now')"
  ).get(pendingToken);
  if (!pending) throw new HttpError(401, "El código venció o el pedido no es válido — iniciá sesión de nuevo.");

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(pending.user_id);
  if (!user || !user.totp_enabled) throw new HttpError(401, "Pedido inválido.");

  if (!verificarTotp(user.totp_secret, code)) {
    registrarEvento("totp_login_failed", { userId: user.id, email: user.email });
    throw new HttpError(401, "El código no es correcto.");
  }
  // Se usa una sola vez — aunque todavía no haya vencido, no debe quedar
  // reutilizable.
  db.prepare("DELETE FROM login_2fa_pending WHERE token = ?").run(pendingToken);
  registrarEvento("login_success", { userId: user.id, email: user.email, detail: "con 2FA" });
  return user;
}
