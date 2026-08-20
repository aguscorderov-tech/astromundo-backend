// server.js
// Punto de entrada del backend. Un solo proceso Node, cero dependencias de
// npm (usa node:http y node:sqlite, ambos nativos desde Node 22.5+).
// Arrancar con: node server.js  (variable de entorno PORT opcional).

import { createServer } from "node:http";
import { authenticate } from "./auth.js";
import { sendJSON, readJSONBody, HttpError } from "./http-utils.js";

import * as authRoutes from "./routes/auth.js";
import * as clientRoutes from "./routes/clients.js";
import * as chartRoutes from "./routes/charts.js";
import * as serviceRoutes from "./routes/services.js";
import * as apptRoutes from "./routes/appointments.js";
import * as paymentRoutes from "./routes/payments.js";
import * as paymentSettingsRoutes from "./routes/paymentSettings.js";
import * as orderRoutes from "./routes/orders.js";
import * as ephemerisRoutes from "./routes/ephemeris.js";
import * as synastryRoutes from "./routes/synastries.js";
import * as backupRoutes from "./routes/backup.js";
import * as subscriptionRoutes from "./routes/subscriptions.js";
import * as adminRoutes from "./routes/admin.js";

const PORT = process.env.PORT || 3001;

// ORIGIN_ALLOWLIST: restricción de dominios pausada temporalmente (ver
// 20-ago-2026) -- daba "Failed to fetch" en producción de forma persistente
// incluso con la variable bien cargada en Railway, y no había tiempo de
// depurarlo con calma en medio de una caída real del login. Vuelve a
// activarse más adelante, probado con cuidado antes de subir. Por ahora,
// abierto a cualquier origen siempre -- mismo comportamiento simple y
// confiable que tenía la app antes de que existiera esta restricción.
function aplicarHeadersDeSeguridad(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");

  // Headers de seguridad — esta API solo devuelve JSON (nunca HTML), así
  // que no hace falta una Content-Security-Policy pensada para páginas;
  // estos aplican igual y son la protección de base para cualquier API.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
}

function requireAuth(req) {
  const user = authenticate(req);
  if (!user) throw new HttpError(401, "No autenticado — mandá el header Authorization: Bearer <token>.");
  return user;
}

const server = createServer(async (req, res) => {
  aplicarHeadersDeSeguridad(req, res);
  if (req.method === "OPTIONS") { sendJSON(res, 204, {}); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean); // ["api","clients","c_123"]

  try {
    if (parts[0] !== "api") { sendJSON(res, 404, { error: "Ruta no encontrada." }); return; }

    // ---- /api/health ----
    if (parts[1] === "health") { sendJSON(res, 200, { ok: true, service: "astromundo-backend", version: "admin-v4" }); return; }

    // ---- /api/auth/* ----
    if (parts[1] === "auth") {
      if (parts[2] === "register" && req.method === "POST") {
        const body = await readJSONBody(req);
        sendJSON(res, 201, await authRoutes.register(body)); return;
      }
      if (parts[2] === "login" && req.method === "POST") {
        const body = await readJSONBody(req);
        sendJSON(res, 200, await authRoutes.login(body)); return;
      }
      if (parts[2] === "me" && req.method === "GET") {
        sendJSON(res, 200, await authRoutes.me(req)); return;
      }
      if (parts[2] === "plan" && req.method === "PUT") {
        const user = requireAuth(req);
        const body = await readJSONBody(req);
        sendJSON(res, 200, await authRoutes.updatePlan(user, body.plan)); return;
      }
      if (parts[2] === "profile" && req.method === "PUT") {
        const user = requireAuth(req);
        const body = await readJSONBody(req);
        sendJSON(res, 200, await authRoutes.updateProfile(user, body)); return;
      }
      if (parts[2] === "password" && req.method === "PUT") {
        const user = requireAuth(req);
        const body = await readJSONBody(req);
        sendJSON(res, 200, await authRoutes.changePassword(user, body)); return;
      }
      if (parts[2] === "account" && req.method === "DELETE") {
        const user = requireAuth(req);
        const body = await readJSONBody(req);
        sendJSON(res, 200, await authRoutes.deleteAccount(user, body)); return;
      }
      // Verificación en dos pasos (TOTP). El segundo paso del login
      // (completeLogin2fa) es público a propósito — a esa altura todavía
      // no hay una sesión real, es lo que la termina de crear.
      if (parts[2] === "2fa" && parts[3] === "login" && req.method === "POST") {
        const body = await readJSONBody(req);
        sendJSON(res, 200, await authRoutes.completeLogin2fa(body)); return;
      }
      if (parts[2] === "2fa" && parts[3] === "setup" && req.method === "POST") {
        const user = requireAuth(req);
        sendJSON(res, 200, await authRoutes.setupTotp(user)); return;
      }
      if (parts[2] === "2fa" && parts[3] === "confirm" && req.method === "POST") {
        const user = requireAuth(req);
        const body = await readJSONBody(req);
        sendJSON(res, 200, await authRoutes.confirmTotp(user, body)); return;
      }
      if (parts[2] === "2fa" && req.method === "DELETE") {
        const user = requireAuth(req);
        const body = await readJSONBody(req);
        sendJSON(res, 200, await authRoutes.disableTotpRoute(user, body)); return;
      }
    }

    // ---- /api/clients ----
    if (parts[1] === "clients") {
      const user = requireAuth(req);
      if (parts.length === 2 && req.method === "GET") { sendJSON(res, 200, clientRoutes.listClients(user)); return; }
      if (parts.length === 2 && req.method === "POST") { sendJSON(res, 201, clientRoutes.createClient(user, await readJSONBody(req))); return; }
      if (parts.length === 3 && req.method === "PUT") { sendJSON(res, 200, clientRoutes.updateClient(user, parts[2], await readJSONBody(req))); return; }
    }

    // ---- /api/charts ----
    if (parts[1] === "charts") {
      const user = requireAuth(req);
      if (parts.length === 2 && req.method === "GET") { sendJSON(res, 200, chartRoutes.listCharts(user, url.searchParams.get("clientId"))); return; }
      if (parts.length === 2 && req.method === "POST") { sendJSON(res, 201, chartRoutes.saveChart(user, await readJSONBody(req))); return; }
      if (parts.length === 3 && req.method === "GET") { sendJSON(res, 200, chartRoutes.getChart(user, parts[2])); return; }
      if (parts.length === 3 && req.method === "DELETE") { sendJSON(res, 200, chartRoutes.deleteChart(user, parts[2])); return; }
      if (parts.length === 4 && parts[3] === "interpretation" && req.method === "PUT") {
        const body = await readJSONBody(req);
        sendJSON(res, 200, chartRoutes.saveInterpretation(user, parts[2], body.text)); return;
      }
    }

    // ---- /api/services ----
    if (parts[1] === "services") {
      const user = requireAuth(req);
      if (parts.length === 2 && req.method === "GET") { sendJSON(res, 200, serviceRoutes.listServices(user)); return; }
      if (parts.length === 2 && req.method === "POST") { sendJSON(res, 201, serviceRoutes.createService(user, await readJSONBody(req))); return; }
      if (parts.length === 3 && req.method === "PUT") { sendJSON(res, 200, serviceRoutes.updateService(user, parts[2], await readJSONBody(req))); return; }
      if (parts.length === 4 && parts[3] === "toggle" && req.method === "POST") { sendJSON(res, 200, serviceRoutes.toggleService(user, parts[2])); return; }
      if (parts.length === 3 && req.method === "DELETE") { sendJSON(res, 200, serviceRoutes.deleteService(user, parts[2])); return; }
    }

    // ---- /api/appointments ----
    if (parts[1] === "appointments") {
      const user = requireAuth(req);
      if (parts.length === 2 && req.method === "GET") { sendJSON(res, 200, apptRoutes.listAppointments(user)); return; }
      if (parts.length === 2 && req.method === "POST") { sendJSON(res, 201, apptRoutes.createAppointment(user, await readJSONBody(req))); return; }
      if (parts.length === 3 && req.method === "PUT") { sendJSON(res, 200, apptRoutes.updateAppointment(user, parts[2], await readJSONBody(req))); return; }
    }

    // ---- /api/payments ----
    if (parts[1] === "payments") {
      const user = requireAuth(req);
      if (parts.length === 2 && req.method === "GET") { sendJSON(res, 200, paymentRoutes.listPayments(user)); return; }
      if (parts.length === 2 && req.method === "POST") { sendJSON(res, 201, paymentRoutes.createPayment(user, await readJSONBody(req))); return; }
      if (parts.length === 3 && parts[2] === "summary" && req.method === "GET") { sendJSON(res, 200, paymentRoutes.paymentsSummary(user)); return; }
    }

    // ---- /api/payment-settings (el astrólogo configura SUS credenciales de cobro) ----
    if (parts[1] === "payment-settings") {
      const user = requireAuth(req);
      if (parts.length === 2 && req.method === "GET") { sendJSON(res, 200, paymentSettingsRoutes.getSettings(user)); return; }
      if (parts.length === 2 && req.method === "PUT") { sendJSON(res, 200, paymentSettingsRoutes.updateSettings(user, await readJSONBody(req))); return; }
    }

    // ---- /api/orders (el astrólogo ve sus órdenes / confirma transferencias) ----
    if (parts[1] === "orders") {
      const user = requireAuth(req);
      if (parts.length === 2 && req.method === "GET") { sendJSON(res, 200, orderRoutes.listOrders(user)); return; }
      if (parts.length === 4 && parts[3] === "confirm-transfer" && req.method === "POST") {
        sendJSON(res, 200, orderRoutes.confirmBankTransfer(user, parts[2])); return;
      }
    }

    // ---- /api/ephemeris/minor-bodies?date=YYYY-MM-DD (Quirón, Folo, Neso,
    // Chariklo, Palas, Juno, Vesta vía JPL Horizons real) ----
    if (parts[1] === "ephemeris" && parts[2] === "minor-bodies" && req.method === "GET") {
      requireAuth(req);
      sendJSON(res, 200, await ephemerisRoutes.getMinorBodyPositions(url.searchParams.get("date"))); return;
    }

    // ---- /api/synastries ----
    if (parts[1] === "synastries") {
      const user = requireAuth(req);
      if (parts.length === 2 && req.method === "GET") { sendJSON(res, 200, synastryRoutes.listSynastries(user)); return; }
      if (parts.length === 2 && req.method === "POST") { sendJSON(res, 201, synastryRoutes.createSynastry(user, await readJSONBody(req))); return; }
      if (parts.length === 3 && req.method === "GET") { sendJSON(res, 200, synastryRoutes.getSynastry(user, parts[2])); return; }
      if (parts.length === 3 && req.method === "DELETE") { sendJSON(res, 200, synastryRoutes.deleteSynastry(user, parts[2])); return; }
    }

    // ---- /api/backup (cada astrólogo descarga SUS propios datos) ----
    if (parts[1] === "backup" && req.method === "GET") {
      const user = requireAuth(req);
      sendJSON(res, 200, backupRoutes.exportUserData(user)); return;
    }

    // ---- /api/subscriptions (el astrólogo paga de verdad para pasar a Pro/Premium) ----
    if (parts[1] === "subscriptions") {
      const user = requireAuth(req);
      const baseUrl = `${url.protocol}//${req.headers.host}`;
      if (parts.length === 2 && req.method === "GET") { sendJSON(res, 200, subscriptionRoutes.listMySubscriptions(user)); return; }
      if (parts.length === 3 && parts[2] === "checkout" && req.method === "POST") {
        const body = await readJSONBody(req);
        sendJSON(res, 200, await subscriptionRoutes.createSubscriptionCheckout(user, body.plan, baseUrl)); return;
      }
    }

    // ---- /api/admin/* (solo el dueño de la plataforma) ----
    if (parts[1] === "admin") {
      const user = requireAuth(req);
      if (parts[2] === "astrologers" && req.method === "GET") { sendJSON(res, 200, adminRoutes.listAllAstrologers(user)); return; }
      if (parts[2] === "stats" && req.method === "GET") { sendJSON(res, 200, adminRoutes.platformStats(user)); return; }
      if (parts[2] === "astrologers" && parts[3] && parts[4] === "plan" && req.method === "PUT") {
        const body = await readJSONBody(req);
        sendJSON(res, 200, adminRoutes.setUserPlan(user, parts[3], body.plan)); return;
      }
    }

    // ---- /api/public/* (SIN autenticación — lo usa un cliente potencial, no el astrólogo) ----
    if (parts[1] === "public") {
      const baseUrl = `${url.protocol}//${req.headers.host}`;
      if (parts[2] === "services" && parts.length === 4 && req.method === "GET") {
        sendJSON(res, 200, orderRoutes.listPublicServices(parts[3])); return;
      }
      if (parts[2] === "orders" && parts.length === 4 && req.method === "POST") {
        sendJSON(res, 201, await orderRoutes.createOrder(parts[3], await readJSONBody(req), baseUrl)); return;
      }
      if (parts[2] === "webhooks" && parts[3] === "mercadopago" && req.method === "POST") {
        const body = await readJSONBody(req).catch(() => ({}));
        await orderRoutes.handleMercadopagoWebhook(url.searchParams, req.headers, body);
        sendJSON(res, 200, { received: true }); return; // siempre 200, MP reintenta si no
      }
      if (parts[2] === "webhooks" && parts[3] === "platform-subscription" && req.method === "POST") {
        const body = await readJSONBody(req).catch(() => ({}));
        await subscriptionRoutes.handleSubscriptionWebhook(url.searchParams, req.headers, body);
        sendJSON(res, 200, { received: true }); return;
      }
      if (parts[2] === "webhooks" && parts[3] === "paypal" && parts[4] === "capture" && req.method === "GET") {
        const result = await orderRoutes.capturePaypalOrder(url.searchParams.get("orderId"));
        res.writeHead(302, { Location: `/reservar-gracias.html?status=${result.status}` });
        res.end();
        return;
      }
    }

    sendJSON(res, 404, { error: "Ruta no encontrada." });
  } catch (err) {
    if (err instanceof HttpError) { sendJSON(res, err.status, { error: err.message }); return; }
    console.error(err);
    sendJSON(res, 500, { error: "Error interno del servidor." });
  }
});

server.listen(PORT, () => {
  console.log(`Astromundo backend escuchando en http://localhost:${PORT}`);
});
