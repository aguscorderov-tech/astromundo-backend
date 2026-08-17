// routes/subscriptions.js
// Cobro real de las suscripciones Pro/Premium — acá el COMPRADOR es el
// astrólogo y el que RECIBE la plata sos vos, el dueño de la plataforma.
// Es lo opuesto de orders.js (ahí el astrólogo recibe de sus clientes).
// Usa tus propias credenciales de Mercado Pago, cargadas como variables de
// entorno en Railway — nunca las credenciales de cada astrólogo.

import { db, newId } from "../db.js";
import { HttpError } from "../http-utils.js";
import * as mp from "../providers/mercadopago.js";

// Mismos precios que ya se mostraban en el panel de Pagos — en centavos,
// mismo criterio que el resto de la plataforma (price_cents / 100 = pesos).
export const PLAN_PRICES = { pro: 3000000, premium: 6800000 };

function ownerCredentials() {
  const accessToken = process.env.OWNER_MP_ACCESS_TOKEN;
  const webhookSecret = process.env.OWNER_MP_WEBHOOK_SECRET;
  if (!accessToken) throw new HttpError(400, "El dueño de la plataforma todavía no conectó el cobro de suscripciones — avisale para que cargue sus credenciales de Mercado Pago.");
  return { accessToken, webhookSecret };
}

export async function createSubscriptionCheckout(user, plan, baseUrl) {
  if (!PLAN_PRICES[plan]) throw new HttpError(400, "Plan no reconocido para suscripción.");
  if (user.plan === plan) throw new HttpError(400, "Ya estás en ese plan.");
  const { accessToken } = ownerCredentials();

  const id = newId("psub");
  db.prepare(`INSERT INTO platform_subscriptions (id, user_id, plan, amount_cents, status) VALUES (?,?,?,?, 'pending')`)
    .run(id, user.id, plan, PLAN_PRICES[plan]);

  const pre = await mp.createPreapproval(accessToken, {
    reason: `Suscripción Astromundo — Plan ${plan[0].toUpperCase() + plan.slice(1)}`,
    amountCents: PLAN_PRICES[plan], currency: "ARS", frequency: 1, frequencyType: "months",
    payerEmail: user.email, externalReference: id,
    notificationUrl: `${baseUrl}/api/public/webhooks/platform-subscription?subscriptionId=${id}`,
    backUrl: `${baseUrl}/index.html?subscription=gracias`,
  });
  db.prepare("UPDATE platform_subscriptions SET provider_ref = ? WHERE id = ?").run(pre.id, id);
  return { redirectUrl: pre.init_point };
}

export async function handleSubscriptionWebhook(query, headers, body) {
  const subId = query.get("subscriptionId");
  const sub = subId && db.prepare("SELECT * FROM platform_subscriptions WHERE id = ?").get(subId);
  if (!sub) return;
  const { accessToken, webhookSecret } = ownerCredentials();

  const preapprovalId = query.get("data.id") || (body && body.data && body.data.id) || sub.provider_ref;
  if (webhookSecret) {
    const valid = mp.verifyWebhookSignature({
      xSignature: headers["x-signature"], xRequestId: headers["x-request-id"],
      dataId: preapprovalId, webhookSecret,
    });
    if (!valid) { console.warn("Webhook de suscripción con firma inválida, se ignora."); return; }
  }

  const preapproval = await mp.getPreapproval(accessToken, sub.provider_ref);

  if (preapproval.status === "authorized") {
    db.prepare("UPDATE platform_subscriptions SET status='active', updated_at=datetime('now') WHERE id=?").run(sub.id);
    db.prepare("UPDATE users SET plan = ? WHERE id = ?").run(sub.plan, sub.user_id);
    return;
  }

  // "paused" o "cancelled" -- el astrólogo dejó de pagar (canceló él mismo,
  // o Mercado Pago la canceló sola después de varios cobros rechazados).
  // Solo lo bajamos a Gratis si el plan de ESTA suscripción sigue siendo el
  // que tiene activo ahora mismo -- si mientras tanto pasó a otro plan por
  // otro camino (por ejemplo, se lo asignó un admin a mano), no lo tocamos,
  // para no pisar ese cambio posterior sin querer.
  if (preapproval.status === "paused" || preapproval.status === "cancelled") {
    db.prepare("UPDATE platform_subscriptions SET status=?, updated_at=datetime('now') WHERE id=?").run(preapproval.status, sub.id);
    const user = db.prepare("SELECT plan FROM users WHERE id = ?").get(sub.user_id);
    if (user && user.plan === sub.plan) {
      db.prepare("UPDATE users SET plan = 'gratis' WHERE id = ?").run(sub.user_id);
    }
  }
}

export function listMySubscriptions(user) {
  return db.prepare("SELECT * FROM platform_subscriptions WHERE user_id = ? ORDER BY created_at DESC").all(user.id);
}
