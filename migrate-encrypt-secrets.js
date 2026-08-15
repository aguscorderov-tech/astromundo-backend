// migrate-encrypt-secrets.js
// Corrida ÚNICA, a mano: cifra las credenciales de pago que ya estaban
// guardadas en texto plano ANTES de este cambio. La migración normal es
// "perezosa" (un secreto viejo se cifra solo cuando ese astrólogo vuelve a
// guardar ESE campo puntual) — este script cierra el resto de una sola vez,
// en vez de esperar a que cada astrólogo lo toque solo.
//
// Uso, desde Railway (Shell del servicio, o corriendo local apuntando a la
// misma base con DB_PATH):
//   node migrate-encrypt-secrets.js
//
// Es seguro correrlo más de una vez — los valores que ya están cifrados
// (empiezan con "enc:v1:") se saltean, no se cifran dos veces.

import { db } from "./db.js";
import { cifrar } from "./crypto-secrets.js";

const CAMPOS = ["mp_access_token", "mp_webhook_secret", "paypal_client_secret"];

function yaEstaCifrado(valor) {
  return typeof valor === "string" && valor.startsWith("enc:v1:");
}

function migrar() {
  const filas = db.prepare("SELECT user_id, mp_access_token, mp_webhook_secret, paypal_client_secret FROM payment_settings").all();
  let filasTocadas = 0;
  let camposCifrados = 0;

  for (const fila of filas) {
    const cambios = {};
    for (const campo of CAMPOS) {
      const valor = fila[campo];
      if (valor && !yaEstaCifrado(valor)) {
        cambios[campo] = cifrar(valor);
        camposCifrados++;
      }
    }
    if (Object.keys(cambios).length > 0) {
      const sets = Object.keys(cambios).map(c => `${c} = ?`).join(", ");
      db.prepare(`UPDATE payment_settings SET ${sets} WHERE user_id = ?`).run(...Object.values(cambios), fila.user_id);
      filasTocadas++;
    }
  }

  console.log(`Revisadas ${filas.length} filas de payment_settings.`);
  console.log(`${filasTocadas} astrólogos tenían al menos un campo sin cifrar — ${camposCifrados} campos cifrados en total.`);
  console.log(filasTocadas === 0 ? "No había nada para migrar (o ya se había corrido antes)." : "Listo.");
}

migrar();
