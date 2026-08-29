// server.js
// Punto de entrada del backend. Un solo proceso Node, cero dependencias de
// npm (usa node:http y node:sqlite, ambos nativos desde Node 22.5+).
// Arrancar con: node server.js  (variable de entorno PORT opcional).

import { createServer } from "node:http";
import { authenticate } from "./auth.js";
import { authenticateClient, publicClientAccount } from "./auth-cliente.js";
import { sendJSON, readJSONBody, HttpError } from "./http-utils.js";

import * as authRoutes from "./routes/auth.js";
import * as clientAuthRoutes from "./routes/clientAuth.js";
import * as communityRoutes from "./routes/community.js";
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

// ORIGIN_ALLOWLIST: dominios reales desde donde se puede llamar a esta API,
// separados por coma en la variable de entorno ALLOWED_ORIGINS de Railway
// (ej: "https://astromundo.aguscorderov.workers.dev"). Sin esa variable
// cargada, cae a *: sigue funcionando, pero sin la restricción real.
//
// Nota del 20-ago-2026: esto se había desactivado por completo durante una
// caída real de producción -- en su momento pareció ser la causa de un
// "Failed to fetch" persistente, pero investigándolo con calma después, la
// causa real fue otra (rutas de importación rotas en dos archivos, que
// tumbaban el servidor entero). La lógica de acá abajo se probó de nuevo,
// contra un servidor real, con pedidos OPTIONS (preflight) reales -- ver el
// registro de pruebas de esa fecha.
const ORIGIN_ALLOWLIST = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(o => o.trim()).filter(Boolean);

function aplicarHeadersDeSeguridad(req, res) {
  const origin = req.headers.origin;
  if (ORIGIN_ALLOWLIST.length === 0) {
    // Sin la variable configurada: abierto a cualquier origen, para no
    // romper nada mientras no se cargue ALLOWED_ORIGINS en Railway.
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && ORIGIN_ALLOWLIST.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  // Si hay lista cargada y el origen del pedido NO está en ella, no se pone
  // el header — el navegador bloquea la respuesta del lado del que pidió.
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Client-Auth");
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

// Mismo patrón que requireAuth(), pero para la cuenta de cliente final --
// mira el header X-Client-Auth en vez de Authorization (ver el porqué
// en auth-cliente.js).
function requireClientAuth(req) {
  const account = authenticateClient(req);
  if (!account) throw new HttpError(401, "No autenticado — mandá el header X-Client-Auth: Bearer <token>.");
  return account;
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

    // ---- /api/client-auth/* -- cuenta de cliente final, aparte de
    // /api/auth (que es para el astrólogo). Ver auth-cliente.js. ----
    if (parts[1] === "client-auth") {
      if (parts[2] === "register" && req.method === "POST") {
        const body = await readJSONBody(req);
        sendJSON(res, 201, await clientAuthRoutes.registerClient(body)); return;
      }
      if (parts[2] === "login" && req.method === "POST") {
        const body = await readJSONBody(req);
        sendJSON(res, 200, await clientAuthRoutes.loginClient(body)); return;
      }
      if (parts[2] === "me" && req.method === "GET") {
        const account = requireClientAuth(req);
        sendJSON(res, 200, publicClientAccount(account)); return;
      }
      if (parts[2] === "confirm-link" && req.method === "POST") {
        const account = requireClientAuth(req);
        const body = await readJSONBody(req);
        sendJSON(res, 200, await clientAuthRoutes.confirmLink(account, body)); return;
      }
      if (parts[2] === "my-charts" && req.method === "GET") {
        const account = requireClientAuth(req);
        sendJSON(res, 200, await clientAuthRoutes.getMyCharts(account)); return;
      }
      if (parts[2] === "birth-data" && req.method === "PUT") {
        const account = requireClientAuth(req);
        const body = await readJSONBody(req);
        sendJSON(res, 200, await clientAuthRoutes.updateBirthData(account, body)); return;
      }
    }

    // ---- /api/community/* -- acá publican tanto astrólogos como
    // clientes finales, por eso usa requireAnyAuth() en vez de
    // requireAuth()/requireClientAuth() por separado. ----
    if (parts[1] === "community" && parts[2] === "posts") {
      if (parts.length === 3 && req.method === "GET") {
        sendJSON(res, 200, await communityRoutes.listPosts(req, url.searchParams)); return;
      }
      if (parts.length === 3 && req.method === "POST") {
        const author = communityRoutes.requireAnyAuth(req);
        // Límite más alto que el default (5MB) -- puede venir una foto o
        // un video real en base64 (+33% de peso extra por la propia
        // codificación base64), no solo texto. El límite del lado del
        // cliente es 120MB, así que acá tiene que entrar cómodo eso
        // más el 33% extra (≈160MB) más el resto del cuerpo del pedido.
        const body = await readJSONBody(req, 170_000_000);
        sendJSON(res, 201, await communityRoutes.createPost(author, body)); return;
      }
      if (parts.length === 4 && req.method === "GET") {
        sendJSON(res, 200, await communityRoutes.getPost(req, parts[3])); return;
      }
      if (parts.length === 5 && parts[4] === "comments" && req.method === "POST") {
        const author = communityRoutes.requireAnyAuth(req);
        const body = await readJSONBody(req);
        sendJSON(res, 201, await communityRoutes.createComment(author, parts[3], body)); return;
      }
      if (parts.length === 5 && parts[4] === "react" && req.method === "POST") {
        const author = communityRoutes.requireAnyAuth(req);
        const body = await readJSONBody(req);
        sendJSON(res, 200, await communityRoutes.toggleReaction(author, parts[3], body.tipo)); return;
      }
      if (parts.length === 5 && parts[4] === "destacar" && req.method === "POST") {
        const author = communityRoutes.requireAnyAuth(req);
        sendJSON(res, 200, await communityRoutes.toggleDestacado(author, parts[3])); return;
      }
    }
    if (parts[1] === "community" && parts[2] === "follow" && req.method === "POST") {
      const author = communityRoutes.requireAnyAuth(req);
      const body = await readJSONBody(req);
      sendJSON(res, 200, await communityRoutes.toggleFollow(author, body.type, body.id)); return;
    }
    if (parts[1] === "community" && parts[2] === "profile") {
      if (parts.length === 5 && req.method === "GET") {
        sendJSON(res, 200, await communityRoutes.getProfile(req, parts[3], parts[4])); return;
      }
      if (parts.length === 3 && req.method === "PUT") {
        const author = communityRoutes.requireAnyAuth(req);
        const body = await readJSONBody(req, 12_000_000); // puede traer una foto de perfil en base64
        sendJSON(res, 200, await communityRoutes.updateBioYFoto(author, body)); return;
      }
    }

    // ---- /api/media/:id -- sirve el archivo real (foto o video) que se
    // subió a la Comunidad. Respuesta binaria de verdad, no JSON. ----
    if (parts[1] === "media" && parts.length === 3 && req.method === "GET") {
      const { mimeType, buffer } = await communityRoutes.getMedia(parts[2]);
      res.writeHead(200, { "Content-Type": mimeType, "Content-Length": buffer.length, "Cache-Control": "public, max-age=31536000, immutable" });
      res.end(buffer);
      return;
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
      if (parts.length === 4 && parts[3] === "positions" && req.method === "PUT") {
        sendJSON(res, 200, chartRoutes.updateChartPositions(user, parts[2], await readJSONBody(req))); return;
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
      if (parts.length === 4 && parts[3] === "interpretation" && req.method === "PUT") {
        sendJSON(res, 200, synastryRoutes.updateSynastryInterpretation(user, parts[2], await readJSONBody(req))); return;
      }
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

