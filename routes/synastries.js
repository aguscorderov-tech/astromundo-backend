// routes/synastries.js
import { db, newId } from "../db.js";
import { HttpError } from "../http-utils.js";
export function listSynastries(user) {
  return db.prepare("SELECT * FROM synastries WHERE user_id = ? ORDER BY created_at DESC").all(user.id);
}
export function getSynastry(user, id) {
  const row = db.prepare("SELECT * FROM synastries WHERE id = ? AND user_id = ?").get(id, user.id);
  if (!row) throw new HttpError(404, "Sinastría no encontrada.");
  return row;
}
export function createSynastry(user, body) {
  if (user.plan === "gratis") throw new HttpError(403, "Sinastría es una función de los planes Pro y Premium.");
  const { clientAId, clientBId, positionsA, positionsB, aspects, interpText } = body;
  if (!clientAId || !clientBId || !positionsA || !positionsB) throw new HttpError(400, "Faltan datos para crear la sinastría.");
  if (clientAId === clientBId) throw new HttpError(400, "Elegí dos clientes distintos.");
  const clientA = db.prepare("SELECT id FROM clients WHERE id = ? AND user_id = ?").get(clientAId, user.id);
  const clientB = db.prepare("SELECT id FROM clients WHERE id = ? AND user_id = ?").get(clientBId, user.id);
  if (!clientA || !clientB) throw new HttpError(404, "Alguno de los dos clientes no existe (o no es tuyo).");
  const id = newId("syn");
  db.prepare(`INSERT INTO synastries (id, user_id, client_a_id, client_b_id, positions_a_json, positions_b_json, aspects_json, interp_text)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, user.id, clientAId, clientBId, JSON.stringify(positionsA), JSON.stringify(positionsB), JSON.stringify(aspects || []), interpText || null);
  return getSynastry(user, id);
}

// Regenera SOLO el texto de interpretación de una sinastría ya guardada,
// con el banco de frases actual -- para sinastrías viejas, calculadas
// antes de alguna mejora al texto, sin tener que recrearla de cero. Las
// posiciones y aspectos (ya calculados, no cambian) se mandan tal cual
// desde el frontend -- este endpoint solo pisa interp_text.
export function updateSynastryInterpretation(user, id, body) {
  const { interpText } = body;
  if (!interpText) throw new HttpError(400, "Falta interpText.");
  const syn = getSynastry(user, id);
  db.prepare("UPDATE synastries SET interp_text = ? WHERE id = ?").run(interpText, syn.id);
  return getSynastry(user, id);
}

export function deleteSynastry(user, id) {
  const result = db.prepare("DELETE FROM synastries WHERE id = ? AND user_id = ?").run(id, user.id);
  if (result.changes === 0) throw new HttpError(404, "Sinastría no encontrada.");
  return { deleted: true };
}
