// routes/admin.js
import { db } from "../db.js";
import { HttpError } from "../http-utils.js";
import { registrarEvento } from "../auth.js";

function requireAdmin(user) {
  if (!user.is_admin) throw new HttpError(403, "No tenés permisos de administrador.");
}

export function listAllAstrologers(user) {
  requireAdmin(user);
  const rows = db.prepare(`
    SELECT u.id, u.email, u.name, u.professional_name, u.plan, u.created_at,
      (SELECT COUNT(*) FROM clients WHERE user_id = u.id) as client_count,
      (SELECT COUNT(*) FROM charts WHERE user_id = u.id) as chart_count,
      (SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE user_id = u.id AND status='approved') as revenue_cents
    FROM users u ORDER BY u.created_at DESC
  `).all();
  return rows;
}

export function platformStats(user) {
  requireAdmin(user);
  const byPlan = db.prepare("SELECT plan, COUNT(*) as count FROM users GROUP BY plan").all();
  const totalUsers = db.prepare("SELECT COUNT(*) as count FROM users").get().count;
  const activeSubs = db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(amount_cents),0) as total FROM platform_subscriptions WHERE status='active'").get();
  // COALESCE a "directo" -- alguien que se registró sin pasar por ningún
  // link con ?ref=, por ejemplo escribiendo la URL a mano o desde un
  // buscador. Así el desglose siempre suma el total de usuarios, sin un
  // grupo "null" confuso en la pantalla.
  const bySource = db.prepare("SELECT COALESCE(signup_source, 'directo') as source, COUNT(*) as count FROM users GROUP BY source ORDER BY count DESC").all();
  return { totalUsers, byPlan, bySource, activeSubscriptions: activeSubs.count, monthlyRecurringRevenueCents: activeSubs.total };
}

const PLANES_VALIDOS = ["gratis", "pro", "premium"];

/** Asignar un plan directo, sin pasar por ningún pago — para invitados,
    cuentas de prueba, etc. Queda registrado en security_events porque es
    una acción sensible (un admin dándole a alguien acceso pago gratis),
    no algo que deba pasar en silencio. */
export function setUserPlan(adminUser, targetUserId, newPlan) {
  requireAdmin(adminUser);
  if (!PLANES_VALIDOS.includes(newPlan)) throw new HttpError(400, "Plan no reconocido.");
  const target = db.prepare("SELECT * FROM users WHERE id = ?").get(targetUserId);
  if (!target) throw new HttpError(404, "Usuario no encontrado.");

  db.prepare("UPDATE users SET plan = ? WHERE id = ?").run(newPlan, targetUserId);
  registrarEvento("admin_set_plan", {
    userId: adminUser.id, email: adminUser.email,
    detail: `${adminUser.email} le asignó el plan "${newPlan}" a ${target.email} (antes: "${target.plan}")`,
  });
  return { updated: true };
}
