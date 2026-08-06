// providers/mercadopago.js
// Habla directo con la API real de Mercado Pago — https://api.mercadopago.com
// Nada de esto funciona sin un access token real cargado por el astrólogo en
// Pagos → Métodos de cobro (ver routes/paymentSettings.js).

import { createHmac } from "node:crypto";

const BASE = "https://api.mercadopago.com";

async function mpFetch(accessToken, path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + accessToken, ...(options.headers || {}) },
  });
  const data = await res.json();
  if (!res.ok) throw new Error("Mercado Pago: " + (data.message || JSON.stringify(data)));
  return data;
}

// Pago único (Checkout Pro) — el cliente paga una vez y listo. Devuelve
// init_point: la URL a la que hay que mandar al cliente para que pague.
export async function createPreference(accessToken, { title, amountCents, currency, payerEmail, externalReference, notificationUrl, successUrl, failureUrl }) {
  const body = {
    items: [{ title, quantity: 1, unit_price: amountCents / 100, currency_id: currency }],
    payer: payerEmail ? { email: payerEmail } : undefined,
    external_reference: externalReference,
    notification_url: notificationUrl,
    back_urls: { success: successUrl, failure: failureUrl, pending: successUrl },
    auto_return: "approved",
  };
  return mpFetch(accessToken, "/checkout/preferences", { method: "POST", body: JSON.stringify(body) });
}

// Débito automático / suscripción — el cliente autoriza un cobro recurrente.
// Sin card_token_id ni status:"authorized", MP crea la suscripción en estado
// pendiente y da un init_point donde el propio cliente termina de autorizarla
// con su tarjeta — no necesitamos (ni queremos) tocar sus datos de tarjeta.
export async function createPreapproval(accessToken, { reason, amountCents, currency, frequency, frequencyType, payerEmail, externalReference, backUrl }) {
  const body = {
    reason,
    external_reference: externalReference,
    payer_email: payerEmail,
    back_url: backUrl,
    auto_recurring: {
      frequency: frequency || 1,
      frequency_type: frequencyType || "months",
      transaction_amount: amountCents / 100,
      currency_id: currency,
    },
  };
  return mpFetch(accessToken, "/preapproval", { method: "POST", body: JSON.stringify(body) });
}

export async function getPayment(accessToken, paymentId) {
  return mpFetch(accessToken, `/v1/payments/${paymentId}`);
}

export async function getPreapproval(accessToken, preapprovalId) {
  return mpFetch(accessToken, `/preapproval/${preapprovalId}`);
}

// Verificación de firma del webhook — algoritmo documentado por Mercado Pago:
// HMAC-SHA256 de un "manifest" con el id del recurso, el x-request-id y el
// timestamp, firmado con la clave secreta del webhook (NO el access token —
// es una clave distinta que se configura en el panel de la aplicación en
// MP Developers → Webhooks → "Firma secreta").
export function verifyWebhookSignature({ xSignature, xRequestId, dataId, webhookSecret }) {
  if (!xSignature || !webhookSecret) return false;
  let ts, hash;
  xSignature.split(",").forEach(part => {
    const [k, v] = part.split("=");
    if (!k || v === undefined) return;
    const key = k.trim(), value = v.trim();
    if (key === "ts") ts = value;
    if (key === "v1") hash = value;
  });
  if (!ts || !hash) return false;
  const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
  const computed = createHmac("sha256", webhookSecret).update(manifest).digest("hex");
  return computed === hash;
}
