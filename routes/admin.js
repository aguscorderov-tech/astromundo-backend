// routes/admin.js
import { db } from "../db.js";
import { HttpError } from "../http-utils.js";

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
  return { totalUsers, byPlan, activeSubscriptions: activeSubs.count, monthlyRecurringRevenueCents: activeSubs.total };
}
