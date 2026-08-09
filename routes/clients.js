// routes/clients.js
import { db, newId } from "../db.js";
import { HttpError } from "../http-utils.js";

const GRATIS_CLIENT_LIMIT = 5;

export function listClients(user) {
  return db.prepare("SELECT * FROM clients WHERE user_id = ? ORDER BY created_at DESC").all(user.id);
}

export function createClient(user, body) {
  if (!body.name) throw new HttpError(400, "El cliente necesita un nombre.");

  if (user.plan === "gratis") {
    const count = db.prepare("SELECT COUNT(*) as n FROM clients WHERE user_id = ?").get(user.id).n;
    if (count >= GRATIS_CLIENT_LIMIT) {
      throw new HttpError(403, `El plan Gratis permite hasta ${GRATIS_CLIENT_LIMIT} clientes — pasá a Pro o Premium para cargar clientes ilimitados.`);
    }
  }

  const id = newId("c");
  db.prepare(`INSERT INTO clients (id, user_id, name, email, date, time, time_unknown, place, lat, lng, tz, tz_name)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, user.id, body.name, body.email || null, body.date || null, body.time || null,
    body.timeUnknown ? 1 : 0, body.place || null, body.lat ?? null, body.lng ?? null, body.tz || null, body.tzName || null
  );
  return db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
}

export function updateClient(user, clientId, body) {
  const existing = db.prepare("SELECT * FROM clients WHERE id = ? AND user_id = ?").get(clientId, user.id);
  if (!existing) throw new HttpError(404, "Cliente no encontrado.");
  const merged = { ...existing, ...body };
  db.prepare(`UPDATE clients SET name=?, email=?, date=?, time=?, time_unknown=?, place=?, lat=?, lng=?, tz=?, tz_name=?, notes=? WHERE id=?`)
    .run(merged.name, merged.email, merged.date, merged.time, merged.timeUnknown ?? merged.time_unknown ? 1 : 0,
         merged.place, merged.lat ?? null, merged.lng ?? null, merged.tz, merged.tzName ?? merged.tz_name,
         body.notes !== undefined ? body.notes : (existing.notes || null), clientId);
  return db.prepare("SELECT * FROM clients WHERE id = ?").get(clientId);
}
