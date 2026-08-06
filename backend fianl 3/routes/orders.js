// routes/orders.js
// El corazón de la plataforma de pagos. Todo esto es PÚBLICO (sin login) —
// lo usa un cliente potencial del astrólogo, no el astrólogo mismo.

import { db, newId } from "../db.js";
import { HttpError } from "../http-utils.js";
import { getSettingsWithSecrets } from "./paymentSettings.js";
import * as mp from "../providers/mercadopago.js";
import * as paypal from "../providers/paypal.js";

const COMMISSION_RATE = 0.045; // informativo — no hay split automático de fondos, Mercado Pago/PayPal no lo hacen solos sin cuenta marketplace

export function listPublicServices(astrologerId) {
  const user = db.prepare("SELECT id, name FROM users WHERE id = ?").get(astrologerId);
  if (!user) throw new HttpError(404, "Astrólogo no encontrado.");
  const services = db.prepare("SELECT id, name, description, modality, duration_minutes, price_cents, currency FROM services WHERE user_id = ? AND is_active = 1").all(astrologerId);
  return { astrologerName: user.name, services };
}

function recordOrder({ userId, serviceId, clientName, clientEmail, amountCents, currency, paymentMethod }) {
  const id = newId("ord");
  db.prepare(`INSERT INTO orders (id, user_id, service_id, client_name, client_email, amount_cents, currency, payment_method, status)
              VALUES (?,?,?,?,?,?,?,?, 'pending')`)
    .run(id, userId, serviceId, clientName, clientEmail || null, amountCents, currency, paymentMethod);
  return id;
}

function markOrderApproved(orderId, providerRef) {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!order || order.status === "approved") return order; // ya procesado — evita duplicar el ingreso si el webhook llega más de una vez
  db.prepare("UPDATE orders SET status='approved', provider_ref=?, updated_at=datetime('now') WHERE id=?").run(providerRef || order.provider_ref, orderId);
  const commission = Math.round(order.amount_cents * COMMISSION_RATE);
  db.prepare(`INSERT INTO payments (id, user_id, client_id, service_id, amount_cents, commission_cents, currency, status)
              VALUES (?,?,?,?,?,?,?, 'approved')`)
    .run(newId("pay"), order.user_id, null, order.service_id, order.amount_cents, commission, order.currency);
  return db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
}

export async function createOrder(astrologerId, body, baseUrl) {
  const { serviceId, clientName, clientEmail, paymentMethod } = body;
  if (!serviceId || !clientName || !paymentMethod) throw new HttpError(400, "Faltan serviceId, clientName o paymentMethod.");

  const service = db.prepare("SELECT * FROM services WHERE id = ? AND user_id = ? AND is_active = 1").get(serviceId, astrologerId);
  if (!service) throw new HttpError(404, "Servicio no disponible.");

  const settings = getSettingsWithSecrets(astrologerId);
  const orderId = recordOrder({
    userId: astrologerId, serviceId, clientName, clientEmail,
    amountCents: service.price_cents, currency: service.currency, paymentMethod,
  });

  if (paymentMethod === "transferencia") {
    if (!settings.bankAlias && !settings.bankCbu) throw new HttpError(400, "Este astrólogo todavía no cargó sus datos bancarios.");
    return {
      orderId, status: "pending",
      bankDetails: { bankName: settings.bankName, bankAlias: settings.bankAlias, bankCbu: settings.bankCbu },
    };
  }

  if (paymentMethod === "mercadopago" || paymentMethod === "debito_automatico") {
    if (!settings.mpAccessToken) throw new HttpError(400, "Este astrólogo todavía no conectó Mercado Pago.");
    const notificationUrl = `${baseUrl}/api/public/webhooks/mercadopago?orderId=${orderId}`;
    if (paymentMethod === "mercadopago") {
      const pref = await mp.createPreference(settings.mpAccessToken, {
        title: service.name, amountCents: service.price_cents, currency: service.currency,
        payerEmail: clientEmail, externalReference: orderId, notificationUrl,
        successUrl: `${baseUrl}/reservar-gracias.html?orderId=${orderId}`,
        failureUrl: `${baseUrl}/reservar.html?astrologo=${astrologerId}&error=1`,
      });
      db.prepare("UPDATE orders SET provider_ref=? WHERE id=?").run(pref.id, orderId);
      return { orderId, status: "pending", redirectUrl: pref.init_point };
    } else {
      const pre = await mp.createPreapproval(settings.mpAccessToken, {
        reason: service.name, amountCents: service.price_cents, currency: service.currency,
        frequency: 1, frequencyType: "months", payerEmail: clientEmail, externalReference: orderId,
        backUrl: `${baseUrl}/reservar-gracias.html?orderId=${orderId}`,
      });
      db.prepare("UPDATE orders SET provider_ref=? WHERE id=?").run(pre.id, orderId);
      return { orderId, status: "pending", redirectUrl: pre.init_point };
    }
  }

  if (paymentMethod === "paypal") {
    if (!settings.paypalClientId || !settings.paypalClientSecret) throw new HttpError(400, "Este astrólogo todavía no conectó PayPal.");
    const result = await paypal.createOrder(settings.paypalClientId, settings.paypalClientSecret, settings.paypalMode, {
      amountCents: service.price_cents, currency: service.currency, customId: orderId,
      returnUrl: `${baseUrl}/api/public/webhooks/paypal/capture?orderId=${orderId}`,
      cancelUrl: `${baseUrl}/reservar.html?astrologo=${astrologerId}&error=1`,
    });
    db.prepare("UPDATE orders SET provider_ref=? WHERE id=?").run(result.orderId, orderId);
    return { orderId, status: "pending", redirectUrl: result.approveUrl };
  }

  throw new HttpError(400, "Método de pago no reconocido.");
}

export async function handleMercadopagoWebhook(query, headers, body) {
  const orderId = query.get("orderId");
  const order = orderId && db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!order) return; // orden desconocida — no hay nada que hacer, pero igual respondemos 200 (ver server.js)

  const settings = getSettingsWithSecrets(order.user_id);
  const paymentId = query.get("data.id") || (body && body.data && body.data.id) || query.get("id");
  if (!paymentId) return;

  if (settings.mpWebhookSecret) {
    const valid = mp.verifyWebhookSignature({
      xSignature: headers["x-signature"], xRequestId: headers["x-request-id"],
      dataId: paymentId, webhookSecret: settings.mpWebhookSecret,
    });
    if (!valid) { console.warn("Webhook de Mercado Pago con firma inválida, se ignora. orderId=" + orderId); return; }
  } else {
    console.warn("Mercado Pago webhook sin firma secreta configurada — procesando sin verificar (configurala en Pagos → Métodos de cobro).");
  }

  const payment = await mp.getPayment(settings.mpAccessToken, paymentId);
  if (payment.status === "approved") markOrderApproved(order.id, String(paymentId));
}

export async function capturePaypalOrder(orderId, token) {
  const order = orderId && db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!order) throw new HttpError(404, "Orden no encontrada.");
  const settings = getSettingsWithSecrets(order.user_id);
  const result = await paypal.captureOrder(settings.paypalClientId, settings.paypalClientSecret, settings.paypalMode, token || order.provider_ref);
  if (result.status === "COMPLETED") markOrderApproved(order.id, order.provider_ref);
  return { status: result.status };
}

export function confirmBankTransfer(user, orderId) {
  const order = db.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").get(orderId, user.id);
  if (!order) throw new HttpError(404, "Orden no encontrada.");
  if (order.payment_method !== "transferencia") throw new HttpError(400, "Esta orden no es de transferencia bancaria.");
  return markOrderApproved(order.id, "manual");
}

export function listOrders(user) {
  return db.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC").all(user.id);
}
