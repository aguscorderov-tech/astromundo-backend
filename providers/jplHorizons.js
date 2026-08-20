// providers/jplHorizons.js
// Consulta directa a la API pública de JPL Horizons (NASA/Caltech) —
// https://ssd-api.jpl.nasa.gov/doc/horizons.html — la misma fuente de datos
// numéricamente integrados (con perturbaciones reales de todos los planetas)
// en la que se apoya el software astrológico profesional. Reemplaza la
// aproximación kepleriana de dos cuerpos que usábamos antes para Quirón,
// Folo y Neso — esos tres cruzan cerca de Saturno, donde la aproximación
// simple pierde precisión real. Ceres, Palas, Vesta y Juno son asteroides del
// cinturón principal (no cruzan cerca de Saturno como los centauros), pero
// se calculan con el mismo método real acá para no mezclar dos técnicas
// distintas de precisión desigual en la misma carta.
//
// Gratis, sin API key, mantenida por el Jet Propulsion Laboratory.

const BASE = "https://ssd.jpl.nasa.gov/api/horizons.api";

// Números de cuerpo menor de JPL (el ";" al final le dice a Horizons que
// busque en la base de cuerpos pequeños, no en la numeración de planetas).
// Los tres primeros asteroides numerados históricamente (Pallas=2, Juno=3,
// Vesta=4 -- Ceres=1 no está en la lista, no se pidió incluirla) más los
// cuatro centauros.
export const MINOR_BODY_COMMANDS = {
  chiron: "2060",
  pholus: "5145",
  nessus: "7066",
  chariklo: "10199",
  sedna: "90377",
  ceres: "1",
  pallas: "2",
  juno: "3",
  vesta: "4",
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

// Devuelve { lon, retrograde, speed } para un cuerpo menor en una fecha UTC
// (YYYY-MM-DD). El día completo alcanza de sobra: incluso el más rápido de
// estos siete (Juno) se mueve bastante menos de 1°/día, así que ignorar la
// hora exacta de nacimiento introduce un error de segundos de arco — muy
// por debajo de lo que aportaba el método kepleriano anterior.
export async function getMinorBodyPosition(bodyKey, dateStr) {
  const command = MINOR_BODY_COMMANDS[bodyKey];
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

export async function getAllMinorBodyPositions(dateStr) {
  const keys = Object.keys(MINOR_BODY_COMMANDS);
  const out = {};
  // De a uno, no en paralelo — pedir los siete al mismo tiempo puede hacer
  // que JPL responda 503 (servidor ocupado) para alguno. Con un reintento
  // simple por cuerpo alcanza para los 503 transitorios, que son la
  // mayoría. Si alguno falla igual después de reintentar, se sigue con
  // los demás en vez de perder todos — mejor una carta con 6 de 7 que con
  // ninguno.
  for (const key of keys) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        out[key] = await getMinorBodyPosition(key, dateStr);
        break;
      } catch (e) {
        if (attempt === 0) { await new Promise(r => setTimeout(r, 800)); continue; }
        console.warn(`JPL Horizons: no se pudo obtener ${key} para ${dateStr} — se omite. ${e.message}`);
      }
    }
  }
  return out;
}
