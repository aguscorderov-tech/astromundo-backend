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

const PORT = process.env.PORT || 3001;

function requireAuth(req) {
  const user = authenticate(req);
  if (!user) throw new HttpError(401, "No autenticado — mandá el header Authorization: Bearer <token>.");
  return user;
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") { sendJSON(res, 204, {}); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean); // ["api","clients","c_123"]

  try {
    if (parts[0] !== "api") { sendJSON(res, 404, { error: "Ruta no encontrada." }); return; }

    // ---- /api/health ----
    if (parts[1] === "health") { sendJSON(res, 200, { ok: true, service: "astromundo-backend" }); return; }

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
