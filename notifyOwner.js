// notifyOwner.js
// Manda un email al dueño de la app cada vez que alguien se registra.
// Requiere el paquete "nodemailer" -- instalar con: npm install nodemailer
//
// Variables de entorno necesarias (configurarlas en Railway, no acá):
//   GMAIL_USER          -- el Gmail desde el que se manda el aviso
//   GMAIL_APP_PASSWORD  -- una "contraseña de aplicación" de Google, NO tu
//                           contraseña normal de Gmail. Se genera en
//                           https://myaccount.google.com/apppasswords
//                           (necesita verificación en dos pasos activada).
//   OWNER_NOTIFY_EMAIL  -- a qué email mandarle el aviso (puede ser el
//                           mismo GMAIL_USER, o cualquier otro).
//
// Si alguna de las tres variables falta, la función no hace nada --
// nunca frena ni rompe el registro real de la persona, solo se salta
// el aviso en silencio (y deja un aviso corto en los logs del servidor).

import nodemailer from "nodemailer";

let transporter = null;
function obtenerTransporter() {
  if (transporter) return transporter;
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  return transporter;
}

/** Llamar DESPUÉS de crear el usuario nuevo en la base, justo antes de
    devolver la respuesta -- así un fallo acá nunca puede frenar el
    registro real de la persona (no lleva await desde afuera a propósito,
    ver nota más abajo). */
export function notificarNuevoRegistro(user) {
  const destino = process.env.OWNER_NOTIFY_EMAIL;
  const t = obtenerTransporter();
  if (!t || !destino) {
    console.log("[notifyOwner] Aviso de registro salteado -- faltan variables de entorno (GMAIL_USER / GMAIL_APP_PASSWORD / OWNER_NOTIFY_EMAIL).");
    return;
  }
  t.sendMail({
    from: `Apolo <${process.env.GMAIL_USER}>`,
    to: destino,
    subject: "Nuevo registro en Apolo",
    text: `Se registró una cuenta nueva.\n\nNombre: ${user.name}\nEmail: ${user.email}\nFecha: ${new Date().toLocaleString("es-AR")}`,
  }).catch(err => {
    // A propósito NO se relanza el error -- si el email falla (credenciales
    // vencidas, Gmail caído, lo que sea), el registro de la persona ya se
    // guardó bien en la base y ya le devolvimos la respuesta. Fallar acá
    // no debe romper nada para quien se está registrando.
    console.error("[notifyOwner] No se pudo mandar el aviso de registro:", err.message);
  });
}
