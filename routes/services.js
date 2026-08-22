// routes/services.js
import { db, newId } from "../db.js";
import { HttpError } from "../http-utils.js";
const GRATIS_SERVICE_LIMIT = 3;

// Monedas que la app deja elegir por servicio -- coincide con lo que
// orders.js ya manda de verdad a Mercado Pago y PayPal al armar el cobro.
// Mercado Pago solo procesa la moneda del país de la cuenta conectada (un
// Mercado Pago argentino solo cobra en ARS, nunca en dólares de verdad,
// sin importar lo que diga acá) -- PayPal sí soporta la mayoría de estas
// de forma nativa, según la cuenta del astrólogo.
const MONEDAS_VALIDAS = ["ARS", "USD", "EUR", "MXN", "COP", "CLP", "UYU", "BRL"];

export function listServices(user) {
  return db.prepare("SELECT * FROM services WHERE user_id = ? ORDER BY created_at ASC").all(user.id);
}
export function createService(user, body) {
  if (!body.name) throw new HttpError(400, "El servicio necesita un nombre.");
  if (body.currency && !MONEDAS_VALIDAS.includes(body.currency)) {
    throw new HttpError(400, `Moneda no reconocida. Válidas: ${MONEDAS_VALIDAS.join(", ")}.`);
  }
  if (user.plan === "gratis") {
    const count = db.prepare("SELECT COUNT(*) as n FROM services WHERE user_id = ?").get(user.id).n;
    if (count >= GRATIS_SERVICE_LIMIT) {
      throw new HttpError(403, `El plan Gratis permite hasta ${GRATIS_SERVICE_LIMIT} servicios — pasá a Pro o Premium para cargar servicios ilimitados.`);
    }
  }
  const id = newId("s");
  db.prepare(`INSERT INTO services (id, user_id, name, description, modality, duration_minutes, price_cents, is_active, category, currency)
              VALUES (?,?,?,?,?,?,?,1,?,?)`).run(
    id, user.id, body.name, body.desc || body.description || "", body.modality || "video",
    body.duration ?? body.duration_minutes ?? null, body.price ?? body.price_cents ?? 0, body.category || null,
    body.currency || "ARS"
  );
  return db.prepare("SELECT * FROM services WHERE id = ?").get(id);
}
export function updateService(user, serviceId, body) {
  const existing = db.prepare("SELECT * FROM services WHERE id = ? AND user_id = ?").get(serviceId, user.id);
  if (!existing) throw new HttpError(404, "Servicio no encontrado.");
  if (body.currency && !MONEDAS_VALIDAS.includes(body.currency)) {
    throw new HttpError(400, `Moneda no reconocida. Válidas: ${MONEDAS_VALIDAS.join(", ")}.`);
  }
  const merged = {
    name: body.name ?? existing.name,
    description: body.desc ?? body.description ?? existing.description,
    modality: body.modality ?? existing.modality,
    duration_minutes: body.duration ?? body.duration_minutes ?? existing.duration_minutes,
    price_cents: body.price ?? body.price_cents ?? existing.price_cents,
    is_active: body.active != null ? (body.active ? 1 : 0) : existing.is_active,
    category: body.category !== undefined ? (body.category || null) : existing.category,
    currency: body.currency || existing.currency,
  };
  db.prepare("UPDATE services SET name=?, description=?, modality=?, duration_minutes=?, price_cents=?, is_active=?, category=?, currency=? WHERE id=?")
    .run(merged.name, merged.description, merged.modality, merged.duration_minutes, merged.price_cents, merged.is_active, merged.category, merged.currency, serviceId);
  return db.prepare("SELECT * FROM services WHERE id = ?").get(serviceId);
}
export function toggleService(user, serviceId) {
  const existing = db.prepare("SELECT * FROM services WHERE id = ? AND user_id = ?").get(serviceId, user.id);
  if (!existing) throw new HttpError(404, "Servicio no encontrado.");
  db.prepare("UPDATE services SET is_active = ? WHERE id = ?").run(existing.is_active ? 0 : 1, serviceId);
  return db.prepare("SELECT * FROM services WHERE id = ?").get(serviceId);
}
export function deleteService(user, serviceId) {
  const result = db.prepare("DELETE FROM services WHERE id = ? AND user_id = ?").run(serviceId, user.id);
  if (result.changes === 0) throw new HttpError(404, "Servicio no encontrado.");
  return { deleted: true };
}
