// routes/auth.js
import { db, newId } from "../db.js";
import { hashPassword, verifyPassword, createSession, authenticate, publicUser, grantAdminIfOwner } from "../auth.js";
import { HttpError } from "../http-utils.js";

export async function register(body) {
  const { email, password, name } = body;
  if (!email || !password || !name) throw new HttpError(400, "Faltan email, password o name.");
  if (password.length < 8) throw new HttpError(400, "La contraseña necesita al menos 8 caracteres.");

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email.toLowerCase());
  if (existing) throw new HttpError(409, "Ya existe una cuenta con ese email.");

  const { hash, salt } = hashPassword(password);
  const id = newId("u");
  db.prepare("INSERT INTO users (id, email, password_hash, password_salt, name) VALUES (?, ?, ?, ?, ?)")
    .run(id, email.toLowerCase(), hash, salt, name);

  // Servicios de ejemplo para que la cuenta nueva no arranque completamente vacía.
  const defaults = [
    ["Informe de carta natal", "Lectura completa en PDF: personalidad, propósito y potenciales.", "async", null, 28000],
    ["Sesión en vivo · 45 min", "Videollamada para profundizar carta natal o tránsitos actuales.", "video", 45, 35000],
  ];
  for (const [n, d, m, dur, p] of defaults) {
    db.prepare("INSERT INTO services (id, user_id, name, description, modality, duration_minutes, price_cents) VALUES (?,?,?,?,?,?,?)")
      .run(newId("s"), id, n, d, m, dur, p);
  }

  const token = createSession(id);
  let user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  user = grantAdminIfOwner(user);
  return { token, user: publicUser(user) };
}

export async function login(body) {
  const { email, password } = body;
  if (!email || !password) throw new HttpError(400, "Faltan email o password.");
  let user = db.prepare("SELECT * FROM users WHERE email = ?").get(String(email).toLowerCase());
  if (!user || !verifyPassword(password, user.password_hash, user.password_salt)) {
    throw new HttpError(401, "Email o contraseña incorrectos.");
  }
  user = grantAdminIfOwner(user);
  const token = createSession(user.id);
  return { token, user: publicUser(user) };
}

export async function me(req) {
  let user = authenticate(req);
  if (!user) throw new HttpError(401, "No autenticado.");
  user = grantAdminIfOwner(user);
  return publicUser(user);
}

const VALID_PLANS = ["gratis", "pro", "premium"];
export async function updatePlan(user, planId) {
  if (!VALID_PLANS.includes(planId)) throw new HttpError(400, "Plan no reconocido.");
  // Pasar a un plan pago ahora es un pago real (ver routes/subscriptions.js)
  // — este endpoint solo sigue sirviendo para volver al plan Gratis, que no
  // necesita cobrar nada.
  if (planId !== "gratis") throw new HttpError(400, "Para pasar a un plan pago, usá el checkout de suscripción — este cambio directo ya no está disponible.");
  db.prepare("UPDATE users SET plan = ? WHERE id = ?").run(planId, user.id);
  const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  return publicUser(updated);
}

export async function updateProfile(user, body) {
  const { professionalName } = body;
  db.prepare("UPDATE users SET professional_name = ? WHERE id = ?").run(professionalName || null, user.id);
  const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  return publicUser(updated);
}

export async function changePassword(user, body) {
  const { currentPassword, newPassword } = body;
  if (!currentPassword || !newPassword) throw new HttpError(400, "Faltan la contraseña actual o la nueva.");
  if (newPassword.length < 8) throw new HttpError(400, "La contraseña nueva necesita al menos 8 caracteres.");
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  if (!verifyPassword(currentPassword, row.password_hash, row.password_salt)) {
    throw new HttpError(401, "La contraseña actual no es correcta.");
  }
  const { hash, salt } = hashPassword(newPassword);
  db.prepare("UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?").run(hash, salt, user.id);
  return { updated: true };
}
