// routes/ephemeris.js
import { getAllMinorBodyPositions } from "../providers/jplHorizons.js";
import { HttpError } from "../http-utils.js";

// Cachea por fecha (día) en memoria — si dos cartas distintas nacieron el
// mismo día, no hace falta pedirle a JPL dos veces lo mismo.
const cache = new Map();

export async function getMinorBodyPositions(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || "")) throw new HttpError(400, "Formato de fecha inválido, se espera YYYY-MM-DD.");
  if (cache.has(dateStr)) return cache.get(dateStr);
  try {
    const positions = await getAllMinorBodyPositions(dateStr);
    cache.set(dateStr, positions);
    return positions;
  } catch (e) {
    throw new HttpError(502, "No se pudo consultar JPL Horizons: " + e.message);
  }
}
