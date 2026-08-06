// routes/payments.js
import { db, newId } from "../db.js";
import { HttpError } from "../http-utils.js";

export function listPayments(user) {
  return db.prepare("SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC").all(user.id);
}

export function createPayment(user, body) {
  const { clientId, serviceId, amountCents, commissionCents, status } = body;
  if (amountCents == null) throw new HttpError(400, "Falta amountCents.");
  const id = newId("pay");
  db.prepare(`INSERT INTO payments (id, user_id, client_id, service_id, amount_cents, commission_cents, status)
              VALUES (?,?,?,?,?,?,?)`).run(
    id, user.id, clientId || null, serviceId || null, amountCents, commissionCents || 0, status || "pending"
  );
  return db.prepare("SELECT * FROM payments WHERE id = ?").get(id);
}

export function paymentsSummary(user) {
  const rows = listPayments(user);
  const approved = rows.filter(r => r.status === "approved");
  const totalBruto = approved.reduce((s, r) => s + r.amount_cents, 0);
  const totalComision = approved.reduce((s, r) => s + r.commission_cents, 0);
  return { rows, totalBruto, totalComision, aprobados: approved.length };
}
