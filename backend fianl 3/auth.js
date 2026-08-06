// auth.js
// Hash de contraseñas con scrypt (nativo de node:crypto, mismo nivel de
// seguridad que bcrypt para este caso de uso) y sesiones por token — sin
// dependencias externas ni JWT: un token aleatorio guardado en la tabla
// `sessions`, con expiración de 30 días.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db, newId } from "./db.js";

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
  return { id: user.id, email: user.email, name: user.name, plan: user.plan };
}
