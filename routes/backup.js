// routes/backup.js
// Cada astrólogo puede descargar un respaldo completo de SUS PROPIOS datos
// en cualquier momento — capa extra además de los backups automáticos de
// Railway (que no se pueden descargar directo, solo restaurar). Nunca
// incluye tokens de Mercado Pago/PayPal ni la contraseña — son secretos,
// no datos de negocio, y no deben viajar en un archivo descargable.

import { db } from "../db.js";

export function exportUserData(user) {
  const clients = db.prepare("SELECT * FROM clients WHERE user_id = ?").all(user.id);
  const charts = db.prepare("SELECT * FROM charts WHERE user_id = ?").all(user.id);
  const services = db.prepare("SELECT * FROM services WHERE user_id = ?").all(user.id);
  const appointments = db.prepare("SELECT * FROM appointments WHERE user_id = ?").all(user.id);
  const payments = db.prepare("SELECT * FROM payments WHERE user_id = ?").all(user.id);
  const orders = db.prepare("SELECT * FROM orders WHERE user_id = ?").all(user.id);
  const synastries = db.prepare("SELECT * FROM synastries WHERE user_id = ?").all(user.id);
  const settingsRow = db.prepare("SELECT bank_name, bank_alias, bank_cbu, paypal_mode FROM payment_settings WHERE user_id = ?").get(user.id);

  return {
    exportedAt: new Date().toISOString(),
    account: { email: user.email, name: user.name, plan: user.plan, professionalName: user.professional_name || null },
    clients, charts, services, appointments, payments, orders, synastries,
    paymentSettings: settingsRow || null, // sin tokens/secretos — solo datos bancarios propios
  };
}
