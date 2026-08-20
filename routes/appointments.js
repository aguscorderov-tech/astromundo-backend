// routes/appointments.js
import { db, newId } from "../db.js";
import { HttpError } from "../http-utils.js";

// Turnos NUEVOS creados por mes calendario -- a propósito no es un total
// histórico: si lo fuera, en algún momento le impediría al astrólogo seguir
// atendiendo incluso a los clientes que ya tiene.
const GRATIS_APPOINTMENT_MONTHLY_LIMIT = 10;

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

// "day" (0=lunes..6=domingo) se sigue guardando solo por compatibilidad con
// datos viejos -- ya no es la fuente real de la fecha, eso ahora es "date"
// (YYYY-MM-DD). Se deriva automáticamente de la fecha real, no hace falta
// que lo mande quien llama.
function diaDesdeFecha(fechaStr) {
  const d = new Date(fechaStr + "T00:00:00Z");
  const jsDay = d.getUTCDay(); // 0=domingo..6=sábado
  return (jsDay + 6) % 7; // 0=lunes..6=domingo
}

export function listAppointments(user) {
  return db.prepare("SELECT * FROM appointments WHERE user_id = ? ORDER BY date ASC, time ASC").all(user.id);
}

export function createAppointment(user, body) {
  const { clientId, serviceId, chartId, date, time, status } = body;
  if (!clientId || !date || !time) throw new HttpError(400, "Faltan clientId, date o time.");
  if (!FECHA_RE.test(date)) throw new HttpError(400, "Formato de fecha inválido, se espera YYYY-MM-DD.");
  const client = db.prepare("SELECT id FROM clients WHERE id = ? AND user_id = ?").get(clientId, user.id);
  if (!client) throw new HttpError(404, "El cliente de este turno no existe (o no es tuyo).");

  if (user.plan === "gratis") {
    const count = db.prepare(
      "SELECT COUNT(*) as n FROM appointments WHERE user_id = ? AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')"
    ).get(user.id).n;
    if (count >= GRATIS_APPOINTMENT_MONTHLY_LIMIT) {
      throw new HttpError(403, `El plan Gratis permite hasta ${GRATIS_APPOINTMENT_MONTHLY_LIMIT} turnos nuevos por mes — pasá a Pro o Premium para agendar sin límite.`);
    }
  }

  const id = newId("ap");
  db.prepare(`INSERT INTO appointments (id, user_id, client_id, service_id, chart_id, day, date, time, status)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(
    id, user.id, clientId, serviceId || null, chartId || null, diaDesdeFecha(date), date, time, status || "confirmed"
  );
  return db.prepare("SELECT * FROM appointments WHERE id = ?").get(id);
}

export function updateAppointment(user, apptId, body) {
  const existing = db.prepare("SELECT * FROM appointments WHERE id = ? AND user_id = ?").get(apptId, user.id);
  if (!existing) throw new HttpError(404, "Turno no encontrado.");
  const merged = { ...existing, ...body };
  const fecha = merged.date ?? existing.date;
  if (fecha && !FECHA_RE.test(fecha)) throw new HttpError(400, "Formato de fecha inválido, se espera YYYY-MM-DD.");
  db.prepare("UPDATE appointments SET client_id=?, service_id=?, day=?, date=?, time=?, status=? WHERE id=?")
    .run(
      merged.clientId ?? merged.client_id, merged.serviceId ?? merged.service_id,
      fecha ? diaDesdeFecha(fecha) : existing.day, fecha, merged.time, merged.status, apptId
    );
  return db.prepare("SELECT * FROM appointments WHERE id = ?").get(apptId);
}
