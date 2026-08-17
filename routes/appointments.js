// routes/appointments.js
import { db, newId } from "../db.js";
import { HttpError } from "../http-utils.js";

// Turnos NUEVOS creados por mes calendario -- a propósito no es un total
// histórico: si lo fuera, en algún momento le impediría al astrólogo seguir
// atendiendo incluso a los clientes que ya tiene.
const GRATIS_APPOINTMENT_MONTHLY_LIMIT = 10;

export function listAppointments(user) {
  return db.prepare("SELECT * FROM appointments WHERE user_id = ? ORDER BY day ASC, time ASC").all(user.id);
}

export function createAppointment(user, body) {
  const { clientId, serviceId, chartId, day, time, status } = body;
  if (!clientId || day == null || !time) throw new HttpError(400, "Faltan clientId, day o time.");
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
  db.prepare(`INSERT INTO appointments (id, user_id, client_id, service_id, chart_id, day, time, status)
              VALUES (?,?,?,?,?,?,?,?)`).run(
    id, user.id, clientId, serviceId || null, chartId || null, day, time, status || "confirmed"
  );
  return db.prepare("SELECT * FROM appointments WHERE id = ?").get(id);
}

export function updateAppointment(user, apptId, body) {
  const existing = db.prepare("SELECT * FROM appointments WHERE id = ? AND user_id = ?").get(apptId, user.id);
  if (!existing) throw new HttpError(404, "Turno no encontrado.");
  const merged = { ...existing, ...body };
  db.prepare("UPDATE appointments SET client_id=?, service_id=?, day=?, time=?, status=? WHERE id=?")
    .run(merged.clientId ?? merged.client_id, merged.serviceId ?? merged.service_id, merged.day, merged.time, merged.status, apptId);
  return db.prepare("SELECT * FROM appointments WHERE id = ?").get(apptId);
}
