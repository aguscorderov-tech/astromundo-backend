// providers/paypal.js
// Habla directo con la API real de PayPal Orders v2. Sandbox y producción
// usan hosts distintos — paypalMode decide cuál (ver routes/paymentSettings.js).

function baseUrl(mode) {
  return mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

async function getAccessToken(clientId, clientSecret, mode) {
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(`${baseUrl(mode)}/v1/oauth2/token`, {
    method: "POST",
    headers: { "Authorization": "Basic " + auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  if (!res.ok) throw new Error("PayPal (token): " + (data.error_description || JSON.stringify(data)));
  return data.access_token;
}

// Crea la orden — intent CAPTURE: el dinero se mueve apenas el comprador confirma,
// no queda una autorización pendiente de capturar después.
export async function createOrder(clientId, clientSecret, mode, { amountCents, currency, customId, returnUrl, cancelUrl }) {
  const token = await getAccessToken(clientId, clientSecret, mode);
  const res = await fetch(`${baseUrl(mode)}/v2/checkout/orders`, {
    method: "POST",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        custom_id: customId,
        amount: { currency_code: currency, value: (amountCents / 100).toFixed(2) },
      }],
      application_context: { return_url: returnUrl, cancel_url: cancelUrl, user_action: "PAY_NOW" },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("PayPal (create order): " + JSON.stringify(data));
  const approveLink = (data.links || []).find(l => l.rel === "approve");
  return { orderId: data.id, approveUrl: approveLink ? approveLink.href : null };
}

// Se llama cuando el comprador vuelve a nuestro return_url después de aprobar
// en PayPal — recién ahí se mueve la plata de verdad.
export async function captureOrder(clientId, clientSecret, mode, orderId) {
  const token = await getAccessToken(clientId, clientSecret, mode);
  const res = await fetch(`${baseUrl(mode)}/v2/checkout/orders/${orderId}/capture`, {
    method: "POST",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
  });
  const data = await res.json();
  if (!res.ok) throw new Error("PayPal (capture): " + JSON.stringify(data));
  return data; // data.status === "COMPLETED" si salió bien
}
