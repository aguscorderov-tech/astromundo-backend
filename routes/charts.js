// routes/charts.js
// Importante: el CÁLCULO astronómico sigue viviendo en el frontend
// (astrology-engine, ya validado contra referencias reales) — este backend
// no recalcula nada, solo persiste el resultado que el navegador ya generó.
// Mantener el cálculo en un solo lugar evita que el backend y el frontend
// puedan alguna vez dar resultados distintos para la misma carta.

import { db, newId } from "../db.js";
import { HttpError } from "../http-utils.js";

// Los tipos de carta avanzados (todo salvo la carta natal simple) son
// exclusivos de los planes pagos — es uno de los diferenciadores reales
// entre Gratis y Pro/Premium.
const PREMIUM_ONLY_TYPES = ["transit", "solar_return", "lunar_return"];

export function listCharts(user, clientId) {
  if (clientId) {
    return db.prepare("SELECT * FROM charts WHERE user_id = ? AND client_id = ? ORDER BY created_at DESC").all(user.id, clientId);
  }
  return db.prepare("SELECT * FROM charts WHERE user_id = ? ORDER BY created_at DESC").all(user.id);
}

export function getChart(user, chartId) {
  const chart = db.prepare("SELECT * FROM charts WHERE id = ? AND user_id = ?").get(chartId, user.id);
  if (!chart) throw new HttpError(404, "Carta no encontrada.");
  return chart;
}

export function saveChart(user, body) {
  const { clientId, positions, houseCusps, aspects, ascLon, mcLon, housesReliable, engine, type,
    solarReturnYear, solarReturnMoment, solarReturnPlace, transitDate, transitNatalChartId,
    lunarReturnMoment, lunarReturnPlace, houseSystem } = body;
  if (!clientId || !positions) throw new HttpError(400, "Faltan clientId o positions.");

  if (PREMIUM_ONLY_TYPES.includes(type) && user.plan === "gratis") {
    const label = { transit: "Tránsitos", solar_return: "Revolución solar", lunar_return: "Retorno lunar" }[type];
    throw new HttpError(403, `${label} es una función de los planes Pro y Premium.`);
  }
  if (houseSystem === "placidus" && user.plan === "gratis") {
    throw new HttpError(403, "El sistema de casas Placidus es una función del plan Premium.");
  }

  const client = db.prepare("SELECT id FROM clients WHERE id = ? AND user_id = ?").get(clientId, user.id);
  if (!client) throw new HttpError(404, "El cliente de esta carta no existe (o no es tuyo).");

  const id = newId("ch");
  db.prepare(`INSERT INTO charts (id, user_id, client_id, type, positions_json, house_cusps_json, aspects_json, asc_lon, mc_lon, houses_reliable, engine, solar_return_year, solar_return_moment, solar_return_place, transit_date, transit_natal_chart_id, lunar_return_moment, lunar_return_place, house_system)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, user.id, clientId, type || "natal", JSON.stringify(positions), JSON.stringify(houseCusps || []),
    JSON.stringify(aspects || []), ascLon ?? null, mcLon ?? null, housesReliable ? 1 : 0, engine || null,
    solarReturnYear ?? null, solarReturnMoment ?? null, solarReturnPlace ?? null,
    transitDate ?? null, transitNatalChartId ?? null, lunarReturnMoment ?? null, lunarReturnPlace ?? null,
    houseSystem || "equal"
  );
  return getChart(user, id);
}

export function saveInterpretation(user, chartId, text) {
  if (user.plan === "gratis") throw new HttpError(403, "La interpretación con IA es una función de los planes Pro y Premium.");
  const chart = getChart(user, chartId);
  db.prepare("UPDATE charts SET interp_generated = 1, interp_text = ? WHERE id = ?").run(text, chart.id);
  return getChart(user, chartId);
}

export function deleteChart(user, chartId) {
  const result = db.prepare("DELETE FROM charts WHERE id = ? AND user_id = ?").run(chartId, user.id);
  if (result.changes === 0) throw new HttpError(404, "Carta no encontrada.");
  return { deleted: true };
}
