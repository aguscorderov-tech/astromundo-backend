// routes/auth.js
import { db, newId } from "../db.js";
import { hashPassword, verifyPassword, createSession, authenticate, publicUser, grantAdminIfOwner,
  verificarLimiteIntentos, registrarIntentoFallido, limpiarIntentos, registrarEvento,
  iniciarSetupTotp, confirmarSetupTotp, desactivarTotp, crearLogin2faPendiente, completarLoginConTotp } from "../auth.js";
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
  const identifier = String(email).toLowerCase();

  verificarLimiteIntentos(identifier);

  let user = db.prepare("SELECT * FROM users WHERE email = ?").get(identifier);
  if (!user || !verifyPassword(password, user.password_hash, user.password_salt)) {
    registrarIntentoFallido(identifier);
    registrarEvento("login_failed", { email: identifier });
    throw new HttpError(401, "Email o contraseña incorrectos.");
  }
  limpiarIntentos(identifier);
  user = grantAdminIfOwner(user);

  if (user.totp_enabled) {
    // No se crea sesión real todavía — el segundo paso (completeLogin2fa)
    // es el que de verdad la crea, una vez confirmado el código.
    const pendingToken = crearLogin2faPendiente(user.id);
    return { requiresTotp: true, pendingToken };
  }

  registrarEvento("login_success", { userId: user.id, email: user.email });
  const token = createSession(user.id);
  return { token, user: publicUser(user) };
}

/** Segundo paso del login cuando la cuenta tiene 2FA activado — recibe el
    token corto de login() y el código de la app autenticadora. */
export async function completeLogin2fa(body) {
  const { pendingToken, code } = body;
  if (!pendingToken || !code) throw new HttpError(400, "Faltan el token o el código.");
  const user = completarLoginConTotp(pendingToken, code);
  const token = createSession(user.id);
  return { token, user: publicUser(user) };
}

export async function setupTotp(user) {
  return iniciarSetupTotp(user);
}

export async function confirmTotp(user, body) {
  return confirmarSetupTotp(user, body.code);
}

export async function disableTotpRoute(user, body) {
  if (!body.password) throw new HttpError(400, "Confirmá tu contraseña.");
  return desactivarTotp(user, body.password);
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

const MAX_BYTES_FOTO = 2 * 1024 * 1024; // 2MB reales — de sobra para una foto de perfil ya achicada

/** No alcanza con mirar el "data:image/jpeg;base64," del principio — eso es
    solo una etiqueta que cualquiera puede escribir. Se decodifica el
    base64 de verdad y se revisan los primeros bytes contra la firma real
    de cada formato (los "magic bytes"), para confirmar que el contenido
    sea realmente una imagen de ese tipo, no cualquier otra cosa disfrazada. */
export function validarFotoPerfil(dataUri) {
  if (typeof dataUri !== "string") throw new HttpError(400, "La foto de perfil no tiene un formato válido.");
  const match = dataUri.match(/^data:image\/(jpeg|jpg|png|webp|gif);base64,(.+)$/);
  if (!match) throw new HttpError(400, "La foto de perfil tiene que ser una imagen (jpeg, png, webp o gif) en formato data URI.");
  const [, tipo, base64Payload] = match;

  const bytesAprox = base64Payload.length * 0.75;
  if (bytesAprox > MAX_BYTES_FOTO) throw new HttpError(400, "La foto de perfil no puede superar los 2MB.");

  let buffer;
  try {
    buffer = Buffer.from(base64Payload, "base64");
  } catch {
    throw new HttpError(400, "La foto de perfil no es un base64 válido.");
  }
  if (buffer.length < 12) throw new HttpError(400, "El archivo es demasiado chico para ser una imagen real.");

  const firmaValida =
    (/jpe?g/.test(tipo) && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) ||
    (tipo === "png" && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) ||
    (tipo === "gif" && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) ||
    (tipo === "webp" && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP");

  if (!firmaValida) throw new HttpError(400, "El contenido no coincide con el tipo de imagen declarado — no parece ser una imagen real.");

  return dataUri;
}

export async function updateProfile(user, body) {
  // Actualización PARCIAL de verdad: antes, mandar solo {bio} sin
  // professionalName lo pisaba con NULL (professionalName||null, sin
  // chequear si el campo vino siquiera) — acá cada columna se toca SOLO si
  // esa clave está presente en el body. photoUrl:null sigue funcionando
  // para "sacar la foto" (el frontend ya lo usa así), porque la clave SÍ
  // está presente, solo que su valor es null.
  const campos = [];
  const valores = [];
  if ("professionalName" in body) { campos.push("professional_name = ?"); valores.push(body.professionalName || null); }
  if ("photoUrl" in body) {
    const foto = body.photoUrl ? validarFotoPerfil(body.photoUrl) : null;
    campos.push("photo_url = ?"); valores.push(foto);
  }
  if ("bio" in body) { campos.push("bio = ?"); valores.push(body.bio || null); }
  if (campos.length > 0) {
    valores.push(user.id);
    db.prepare(`UPDATE users SET ${campos.join(", ")} WHERE id = ?`).run(...valores);
  }
  const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  return publicUser(updated);

}

export async function changePassword(user, body) {
  const { currentPassword, newPassword } = body;
  if (!currentPassword || !newPassword) throw new HttpError(400, "Faltan la contraseña actual o la nueva.");
  if (newPassword.length < 8) throw new HttpError(400, "La contraseña nueva necesita al menos 8 caracteres.");
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  if (!verifyPassword(currentPassword, row.password_hash, row.password_salt)) {
    // 403, no 401 — 401 es "tu sesión no es válida" y el frontend borra el
    // token automáticamente apenas lo ve. Acá la sesión SÍ es válida, solo
    // la contraseña de confirmación está mal — un 401 acá desloguearía a
    // alguien que solo se equivocó tipeando, sin que su cuenta haya corrido
    // ningún riesgo real.
    throw new HttpError(403, "La contraseña actual no es correcta.");
  }
  const { hash, salt } = hashPassword(newPassword);
  db.prepare("UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?").run(hash, salt, user.id);
  registrarEvento("password_changed", { userId: user.id, email: user.email });
  return { updated: true };
}

// Derecho de supresión (Ley 25.326) — pide la contraseña de nuevo a
// propósito: si alguien roba solo el token de sesión (por ejemplo, de un
// dispositivo desatendido), no alcanza con eso para borrar la cuenta
// entera. El borrado de la fila de users se propaga solo a clientes,
// cartas, servicios, sesiones, etc. vía ON DELETE CASCADE (confirmado con
// una prueba real) — login_attempts es la única tabla que NO cuelga de
// user_id (usa el email como clave), así que se limpia acá aparte.
export async function deleteAccount(user, body) {
  const { password } = body;
  if (!password) throw new HttpError(400, "Confirmá tu contraseña para borrar la cuenta.");
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  if (!verifyPassword(password, row.password_hash, row.password_salt)) {
    // Mismo motivo que en changePassword: 403, no 401, para no desloguear
    // por error a alguien que solo tipeó mal la contraseña de confirmación.
    throw new HttpError(403, "La contraseña no es correcta.");
  }
  db.prepare("DELETE FROM login_attempts WHERE identifier = ?").run(row.email);
  // Antes del DELETE de la fila de users a propósito — así el evento queda
  // insertado con el user_id todavía válido, y el ON DELETE SET NULL de la
  // tabla lo deja en null automáticamente apenas se borra la cuenta.
  registrarEvento("account_deleted", { userId: user.id, email: row.email });
  db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
  return { deleted: true };
}
