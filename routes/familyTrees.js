const express = require("express");
const router = express.Router();
const crypto = require("crypto");
// Reemplazá esto por tu conexión real (la misma que usa routes/clients.js)
const db = require("../db");
// Reemplazá esto por tu middleware real de autenticación (el que ya
// protege /clients y /charts — probablemente lee el Bearer token y
// pone req.user)
const requireAuth = require("../middleware/requireAuth");

router.use(requireAuth);

function newId() { return crypto.randomUUID(); }

// ---- Árboles ----

router.get("/family-trees", (req, res) => {
  const rows = db.prepare("SELECT * FROM family_trees WHERE user_id = ? ORDER BY created_at DESC").all(req.user.id);
  res.json(rows);
});

router.post("/family-trees", (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Falta el nombre del árbol." });
  const id = newId();
  db.prepare("INSERT INTO family_trees (id, user_id, name) VALUES (?, ?, ?)").run(id, req.user.id, name);
  const row = db.prepare("SELECT * FROM family_trees WHERE id = ?").get(id);
  res.status(201).json(row);
});

router.put("/family-trees/:id", (req, res) => {
  const tree = db.prepare("SELECT * FROM family_trees WHERE id = ? AND user_id = ?").get(req.params.id, req.user.id);
  if (!tree) return res.status(404).json({ error: "Árbol no encontrado." });
  db.prepare("UPDATE family_trees SET name = ? WHERE id = ?").run(req.body.name, req.params.id);
  res.json(db.prepare("SELECT * FROM family_trees WHERE id = ?").get(req.params.id));
});

router.delete("/family-trees/:id", (req, res) => {
  const tree = db.prepare("SELECT * FROM family_trees WHERE id = ? AND user_id = ?").get(req.params.id, req.user.id);
  if (!tree) return res.status(404).json({ error: "Árbol no encontrado." });
  db.prepare("DELETE FROM family_trees WHERE id = ?").run(req.params.id); // los nodos y relaciones se borran solos por el ON DELETE CASCADE
  res.status(204).end();
});

// Devuelve el árbol completo: datos del árbol + todos sus nodos + todas sus relaciones
router.get("/family-trees/:id", (req, res) => {
  const tree = db.prepare("SELECT * FROM family_trees WHERE id = ? AND user_id = ?").get(req.params.id, req.user.id);
  if (!tree) return res.status(404).json({ error: "Árbol no encontrado." });
  const nodes = db.prepare("SELECT * FROM family_nodes WHERE tree_id = ?").all(req.params.id);
  const relations = db.prepare("SELECT * FROM family_relations WHERE tree_id = ?").all(req.params.id);
  res.json({ ...tree, nodes, relations });
});

// ---- Nodos (personas del árbol) ----

router.post("/family-trees/:id/nodes", (req, res) => {
  const tree = db.prepare("SELECT * FROM family_trees WHERE id = ? AND user_id = ?").get(req.params.id, req.user.id);
  if (!tree) return res.status(404).json({ error: "Árbol no encontrado." });
  const b = req.body;
  if (!b.name) return res.status(400).json({ error: "Falta el nombre de la persona." });
  const id = newId();
  db.prepare(`INSERT INTO family_nodes
    (id, tree_id, client_id, name, date, time, time_unknown, place, lat, lng, tz, tz_name, gender, deceased, death_date, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, req.params.id, b.clientId || null, b.name, b.date || null, b.time || null, b.timeUnknown ? 1 : 0,
        b.place || null, b.lat ?? null, b.lng ?? null, b.tz || null, b.tzName || null, b.gender || null,
        b.deceased ? 1 : 0, b.deathDate || null, b.notes || null);
  res.status(201).json(db.prepare("SELECT * FROM family_nodes WHERE id = ?").get(id));
});

router.put("/family-nodes/:id", (req, res) => {
  const node = db.prepare(
    `SELECT family_nodes.* FROM family_nodes
     JOIN family_trees ON family_trees.id = family_nodes.tree_id
     WHERE family_nodes.id = ? AND family_trees.user_id = ?`
  ).get(req.params.id, req.user.id);
  if (!node) return res.status(404).json({ error: "Persona no encontrada." });
  const b = req.body;
  db.prepare(`UPDATE family_nodes SET
    client_id = ?, name = ?, date = ?, time = ?, time_unknown = ?, place = ?, lat = ?, lng = ?,
    tz = ?, tz_name = ?, gender = ?, deceased = ?, death_date = ?, notes = ?
    WHERE id = ?`
  ).run(b.clientId || null, b.name, b.date || null, b.time || null, b.timeUnknown ? 1 : 0,
        b.place || null, b.lat ?? null, b.lng ?? null, b.tz || null, b.tzName || null, b.gender || null,
        b.deceased ? 1 : 0, b.deathDate || null, b.notes || null, req.params.id);
  res.json(db.prepare("SELECT * FROM family_nodes WHERE id = ?").get(req.params.id));
});

router.delete("/family-nodes/:id", (req, res) => {
  const node = db.prepare(
    `SELECT family_nodes.* FROM family_nodes
     JOIN family_trees ON family_trees.id = family_nodes.tree_id
     WHERE family_nodes.id = ? AND family_trees.user_id = ?`
  ).get(req.params.id, req.user.id);
  if (!node) return res.status(404).json({ error: "Persona no encontrada." });
  db.prepare("DELETE FROM family_nodes WHERE id = ?").run(req.params.id); // las relaciones que la mencionan se borran solas (ON DELETE CASCADE)
  res.status(204).end();
});

// ---- Relaciones (vínculos entre dos personas) ----

router.post("/family-trees/:id/relations", (req, res) => {
  const tree = db.prepare("SELECT * FROM family_trees WHERE id = ? AND user_id = ?").get(req.params.id, req.user.id);
  if (!tree) return res.status(404).json({ error: "Árbol no encontrado." });
  const { nodeId, relatedNodeId, type } = req.body;
  if (!nodeId || !relatedNodeId || !["padre", "madre", "pareja"].includes(type)) {
    return res.status(400).json({ error: "Faltan datos del vínculo." });
  }
  const id = newId();
  db.prepare("INSERT INTO family_relations (id, tree_id, node_id, related_node_id, type) VALUES (?, ?, ?, ?, ?)")
    .run(id, req.params.id, nodeId, relatedNodeId, type);
  res.status(201).json(db.prepare("SELECT * FROM family_relations WHERE id = ?").get(id));
});

router.delete("/family-relations/:id", (req, res) => {
  const rel = db.prepare(
    `SELECT family_relations.* FROM family_relations
     JOIN family_trees ON family_trees.id = family_relations.tree_id
     WHERE family_relations.id = ? AND family_trees.user_id = ?`
  ).get(req.params.id, req.user.id);
  if (!rel) return res.status(404).json({ error: "Vínculo no encontrado." });
  db.prepare("DELETE FROM family_relations WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

module.exports = router;
