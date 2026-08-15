// routes/paymentSettings.js
// Acá el astrólogo carga SUS propias credenciales de cobro — nunca las mías
// ni las de la plataforma. Cada astrólogo cobra a su propia cuenta.

import { db } from "../db.js";
import { cifrar, descifrar } from "../crypto-secrets.js";

function hydrate(row, includeSecrets) {
  if (!row) {
    return {
      mpConnected: false, mpPublicKey: null,
      paypalConnected: false, paypalClientId: null, paypalMode: "sandbox",
      bankName: null, bankAlias: null, bankCbu: null,
    };
  }
  const out = {
    mpConnected: !!row.mp_access_token,
    mpPublicKey: row.mp_public_key,
    mpWebhookConfigured: !!row.mp_webhook_secret,
    paypalConnected: !!(row.paypal_client_id && row.paypal_client_secret),
    paypalClientId: row.paypal_client_id,
    paypalMode: row.paypal_mode,
    bankName: row.bank_name,
    bankAlias: row.bank_alias,
    bankCbu: row.bank_cbu,
  };
  // Los secretos (access token, client secret) solo se devuelven cuando el
  // propio backend los necesita para llamar a los proveedores — nunca al frontend.
  if (includeSecrets) {
    out.mpAccessToken = descifrar(row.mp_access_token);
    out.mpWebhookSecret = descifrar(row.mp_webhook_secret);
    out.paypalClientSecret = descifrar(row.paypal_client_secret);
  }
  return out;
}

export function getSettings(user) {
  const row = db.prepare("SELECT * FROM payment_settings WHERE user_id = ?").get(user.id);
  return hydrate(row, false);
}

// Uso interno (checkout.js) — sí incluye los secretos, porque hace falta
// llamar a la API real del proveedor con ellos.
export function getSettingsWithSecrets(userId) {
  const row = db.prepare("SELECT * FROM payment_settings WHERE user_id = ?").get(userId);
  return hydrate(row, true);
}

export function updateSettings(user, body) {
  const existing = db.prepare("SELECT * FROM payment_settings WHERE user_id = ?").get(user.id);
  const merged = {
    // Los tres secretos reales se cifran ACÁ, al guardar — solo cuando el
    // valor viene nuevo en el body. Si no vino (undefined), se usa el
    // valor que ya estaba guardado tal cual está (ya cifrado de un guardado
    // anterior, o todavía en texto plano si es un dato viejo de antes de
    // este cambio) — nunca se re-cifra algo que ya está guardado, eso
    // rompería el descifrado la próxima vez.
    mp_access_token: body.mpAccessToken !== undefined ? cifrar(body.mpAccessToken || null) : (existing ? existing.mp_access_token : null),
    mp_public_key: body.mpPublicKey !== undefined ? (body.mpPublicKey || null) : (existing ? existing.mp_public_key : null),
    mp_webhook_secret: body.mpWebhookSecret !== undefined ? cifrar(body.mpWebhookSecret || null) : (existing ? existing.mp_webhook_secret : null),
    paypal_client_id: body.paypalClientId !== undefined ? (body.paypalClientId || null) : (existing ? existing.paypal_client_id : null),
    paypal_client_secret: body.paypalClientSecret !== undefined ? cifrar(body.paypalClientSecret || null) : (existing ? existing.paypal_client_secret : null),
    paypal_mode: body.paypalMode || (existing ? existing.paypal_mode : "sandbox"),
    bank_name: body.bankName !== undefined ? (body.bankName || null) : (existing ? existing.bank_name : null),
    bank_alias: body.bankAlias !== undefined ? (body.bankAlias || null) : (existing ? existing.bank_alias : null),
    bank_cbu: body.bankCbu !== undefined ? (body.bankCbu || null) : (existing ? existing.bank_cbu : null),
  };
  if (existing) {
    db.prepare(`UPDATE payment_settings SET mp_access_token=?, mp_public_key=?, mp_webhook_secret=?, paypal_client_id=?, paypal_client_secret=?,
                paypal_mode=?, bank_name=?, bank_alias=?, bank_cbu=?, updated_at=datetime('now') WHERE user_id=?`)
      .run(merged.mp_access_token, merged.mp_public_key, merged.mp_webhook_secret, merged.paypal_client_id, merged.paypal_client_secret,
           merged.paypal_mode, merged.bank_name, merged.bank_alias, merged.bank_cbu, user.id);
  } else {
    db.prepare(`INSERT INTO payment_settings (user_id, mp_access_token, mp_public_key, mp_webhook_secret, paypal_client_id, paypal_client_secret,
                paypal_mode, bank_name, bank_alias, bank_cbu) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(user.id, merged.mp_access_token, merged.mp_public_key, merged.mp_webhook_secret, merged.paypal_client_id, merged.paypal_client_secret,
           merged.paypal_mode, merged.bank_name, merged.bank_alias, merged.bank_cbu);
  }
  return getSettings(user);
}
