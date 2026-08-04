import { Router } from "express";
import { query } from "../db/index.js";

const router = Router();

router.get("/", async (req, res) => {
  const result = await query("SELECT * FROM flows ORDER BY updated_at DESC");
  res.json(result.rows);
});

router.get("/:id", async (req, res) => {
  const result = await query("SELECT * FROM flows WHERE id = $1", [req.params.id]);
  if (!result.rows.length) return res.status(404).json({ error: "not found" });
  res.json(result.rows[0]);
});

router.post("/", async (req, res) => {
  const { name, graph } = req.body;
  const result = await query(
    "INSERT INTO flows (name, graph) VALUES ($1, $2) RETURNING *",
    [name || "Untitled flow", graph || { nodes: [], edges: [] }]
  );
  res.json(result.rows[0]);
});

router.put("/:id", async (req, res) => {
  const { name, graph } = req.body;
  const result = await query(
    `UPDATE flows SET name = COALESCE($1,name), graph = COALESCE($2,graph), updated_at = now()
     WHERE id = $3 RETURNING *`,
    [name, graph, req.params.id]
  );
  res.json(result.rows[0]);
});

// Only one flow can be active (live) at a time; activating one deactivates the rest.
router.post("/:id/activate", async (req, res) => {
  await query("UPDATE flows SET is_active = false");
  const result = await query(
    "UPDATE flows SET is_active = true WHERE id = $1 RETURNING *",
    [req.params.id]
  );
  res.json(result.rows[0]);
});

router.delete("/:id", async (req, res) => {
  await query("DELETE FROM flows WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

export default router;
