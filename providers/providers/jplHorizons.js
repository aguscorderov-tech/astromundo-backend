// providers/jplHorizons.js
// Consulta directa a la API pública de JPL Horizons (NASA/Caltech) —
// https://ssd-api.jpl.nasa.gov/doc/horizons.html — la misma fuente de datos
// numéricamente integrados (con perturbaciones reales de todos los planetas)
// en la que se apoya el software astrológico profesional. Reemplaza la
// aproximación kepleriana de dos cuerpos que usábamos antes para Quirón,
// Folo y Neso — esos tres cruzan cerca de Saturno, donde la aproximación
// simple pierde precisión real.
//
// Gratis, sin API key, mantenida por el Jet Propulsion Laboratory.

const BASE = "https://ssd.jpl.nasa.gov/api/horizons.api";

// Números de cuerpo menor de JPL (el ";" al final le dice a Horizons que
// busque en la base de cuerpos pequeños, no en la numeración de planetas).
export const CENTAUR_COMMANDS = {
  chiron: "2060",
  pholus: "5145",
  nessus: "7066",
};

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function buildUrl(command, dateStr) {
  const params = new URLSearchParams({
    format: "text",
    COMMAND: `'${command};'`,
    OBJ_DATA: "'NO'",
    MAKE_EPHEM: "'YES'",
    EPHEM_TYPE: "'OBSERVER'",
    CENTER: "'500@399'",       // geocéntrico
    START_TIME: `'${dateStr}'`,
    STOP_TIME: `'${addDays(dateStr, 1)}'`,
    STEP_SIZE: "'1 d'",
    QUANTITIES: "'31'",        // longitud y latitud eclíptica geocéntrica aparente
  });
  return `${BASE}?${params.toString()}`;
}

// Extrae los pares (longitud, latitud) de las filas de datos entre los
// marcadores $$SOE / $$EOE del formato de texto de Horizons.
function parseEclipticRows(text) {
  const soe = text.indexOf("$$SOE");
  const eoe = text.indexOf("$$EOE");
  if (soe === -1 || eoe === -1) throw new Error("Respuesta de JPL Horizons con formato inesperado.");
  const block = text.slice(soe + 5, eoe).trim();
  if (!block) throw new Error("JPL Horizons no devolvió filas de datos (¿fecha fuera de rango?).");
  return block.split("\n").map(line => {
    const nums = line.match(/-?\d+\.\d+/g); // la fecha usa mes en texto (Oct, Nov...), nunca matchea acá
    if (!nums || nums.length < 2) throw new Error("No se pudo leer longitud/latitud de la respuesta de Horizons.");
    return { lon: parseFloat(nums[0]), lat: parseFloat(nums[1]) };
  });
}

// Devuelve { lon, retrograde, speed } para un centauro en una fecha UTC
// (YYYY-MM-DD). El día completo alcanza de sobra: estos cuerpos se mueven
// apenas ~0.01–0.02°/día, así que ignorar la hora exacta de nacimiento
// introduce un error de segundos de arco — muy por debajo de lo que
// aportaba el método anterior.
export async function getCentaurPosition(bodyKey, dateStr) {
  const command = CENTAUR_COMMANDS[bodyKey];
  if (!command) throw new Error("Cuerpo no reconocido: " + bodyKey);

  const res = await fetch(buildUrl(command, dateStr));
  if (!res.ok) throw new Error(`JPL Horizons respondió ${res.status} para ${bodyKey}.`);
  const text = await res.text();
  const rows = parseEclipticRows(text);
  if (rows.length < 2) throw new Error("JPL Horizons no devolvió suficientes filas para calcular velocidad.");

  let speed = rows[1].lon - rows[0].lon;
  if (speed > 180) speed -= 360;
  if (speed < -180) speed += 360;

  return { lon: rows[0].lon, retrograde: speed < 0, speed };
}

export async function getAllCentaurPositions(dateStr) {
  const keys = Object.keys(CENTAUR_COMMANDS);
  const results = await Promise.all(keys.map(k => getCentaurPosition(k, dateStr)));
  return Object.fromEntries(keys.map((k, i) => [k, results[i]]));
}
