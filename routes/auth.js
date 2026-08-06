// routes/auth.js
import { db, newId } from "../db.js";
import { hashPassword, verifyPassword, createSession, authenticate, publicUser } from "../auth.js";
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

  const defaults = [
    ["Informe de carta natal", "Lectura completa en PDF: personalidad, propósito y potenciales.", "async", null, 28000],
    ["Sesión en vivo · 45 min", "Videollamada para profundizar carta natal o tránsitos actuales.", "video", 45, 35000],
  ];
  for (const [n, d, m, dur, p] of defaults) {
    db.prepare("INSERT INTO services (id, user_id, name, description, modality, duration_minutes, price_cents) VALUES (?,?,?,?,?,?,?)")
      .run(newId("s"), id, n, d, m, dur, p);
  }

  const token = createSession(id);
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  return { token, user: publicUser(user) };
}

export async function login(body) {
  const { email, password } = body;
  if (!email || !password) throw new HttpError(400, "Faltan email o password.");
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(String(email).toLowerCase());
  if (!user || !verifyPassword(password, user.password_hash, user.password_salt)) {
    throw new HttpError(401, "Email o contraseña incorrectos.");
  }
  const token = createSession(user.id);
  return { token, user: publicUser(user) };
}

export async function me(req) {
  const user = authenticate(req);
  if (!user) throw new HttpError(401, "No autenticado.");
  return publicUser(user);
}

const VALID_PLANS = ["gratis", "pro", "premium"];
export async function updatePlan(user, planId) {
  if (!VALID_PLANS.includes(planId)) throw new HttpError(400, "Plan no reconocido.");
  db.prepare("UPDATE users SET plan = ? WHERE id = ?").run(planId, user.id);
  const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  return publicUser(updated);
}
