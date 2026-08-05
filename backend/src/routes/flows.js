import { Router } from "express";
import { query } from "../db/index.js";
import { simulateIvr, validateIvrGraph } from "../services/ivrEngine.js";

const router = Router();

function graphFrom(body) {
  return body?.graph && typeof body.graph === "object"
    ? body.graph
    : { nodes: [], edges: [] };
}

router.get("/", async (req, res) => {
  const result = await query(
    `SELECT f.*,
            (SELECT count(*)::int FROM ivr_events e WHERE e.flow_id=f.id) AS execution_count,
            (SELECT max(created_at) FROM ivr_events e WHERE e.flow_id=f.id) AS last_executed_at
       FROM flows f ORDER BY f.is_active DESC, f.updated_at DESC`
  );
  res.json(result.rows);
});

router.get("/active/current", async (req, res) => {
  const result = await query("SELECT * FROM flows WHERE is_active=true ORDER BY updated_at DESC LIMIT 1");
  res.json(result.rows[0] || null);
});

router.get("/:id", async (req, res) => {
  const result = await query("SELECT * FROM flows WHERE id=$1", [req.params.id]);
  if (!result.rows.length) return res.status(404).json({ error: "IVR flow not found." });
  res.json(result.rows[0]);
});

router.post("/validate", async (req, res) => {
  res.json(validateIvrGraph(graphFrom(req.body)));
});

router.post("/simulate", async (req, res) => {
  res.json(await simulateIvr(graphFrom(req.body), Array.isArray(req.body?.inputs) ? req.body.inputs : []));
});

router.post("/", async (req, res) => {
  const name = String(req.body?.name || "Untitled IVR").trim().slice(0, 160);
  const description = String(req.body?.description || "").trim().slice(0, 1000);
  const graph = graphFrom(req.body);
  const validation = validateIvrGraph(graph);
  const result = await query(
    `INSERT INTO flows (name,description,graph,version,validation)
     VALUES ($1,$2,$3,1,$4) RETURNING *`,
    [name, description, graph, validation]
  );
  res.status(201).json(result.rows[0]);
});

router.put("/:id", async (req, res) => {
  const graph = graphFrom(req.body);
  const validation = validateIvrGraph(graph);
  const result = await query(
    `UPDATE flows
        SET name=COALESCE($1,name), description=COALESCE($2,description), graph=$3,
            version=version+1, validation=$4, updated_at=now()
      WHERE id=$5 RETURNING *`,
    [
      req.body?.name ? String(req.body.name).trim().slice(0, 160) : null,
      req.body?.description !== undefined ? String(req.body.description).trim().slice(0, 1000) : null,
      graph,
      validation,
      req.params.id,
    ]
  );
  if (!result.rows.length) return res.status(404).json({ error: "IVR flow not found." });
  res.json(result.rows[0]);
});

router.post("/:id/duplicate", async (req, res) => {
  const result = await query(
    `INSERT INTO flows (name,description,graph,version,validation)
     SELECT name || ' copy',description,graph,1,validation FROM flows WHERE id=$1 RETURNING *`,
    [req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: "IVR flow not found." });
  res.status(201).json(result.rows[0]);
});

router.post("/:id/activate", async (req, res) => {
  const found = await query("SELECT * FROM flows WHERE id=$1", [req.params.id]);
  if (!found.rows.length) return res.status(404).json({ error: "IVR flow not found." });
  const validation = validateIvrGraph(found.rows[0].graph);
  if (!validation.valid) return res.status(422).json({ error: "Fix validation errors before publishing.", validation });

  await query("BEGIN");
  try {
    await query("UPDATE flows SET is_active=false WHERE is_active=true");
    const result = await query(
      "UPDATE flows SET is_active=true,published_at=now(),validation=$2,updated_at=now() WHERE id=$1 RETURNING *",
      [req.params.id, validation]
    );
    await query("COMMIT");
    res.json(result.rows[0]);
  } catch (error) {
    await query("ROLLBACK");
    throw error;
  }
});

router.post("/:id/deactivate", async (req, res) => {
  const result = await query("UPDATE flows SET is_active=false,updated_at=now() WHERE id=$1 RETURNING *", [req.params.id]);
  if (!result.rows.length) return res.status(404).json({ error: "IVR flow not found." });
  res.json(result.rows[0]);
});

router.get("/:id/events", async (req, res) => {
  const result = await query(
    `SELECT e.*,c.wa_call_id FROM ivr_events e
       LEFT JOIN calls c ON c.id=e.call_id
      WHERE e.flow_id=$1 ORDER BY e.created_at DESC LIMIT 500`,
    [req.params.id]
  );
  res.json(result.rows);
});

router.delete("/:id", async (req, res) => {
  const active = await query("SELECT is_active FROM flows WHERE id=$1", [req.params.id]);
  if (!active.rows.length) return res.status(404).json({ error: "IVR flow not found." });
  if (active.rows[0].is_active) return res.status(409).json({ error: "Deactivate the live IVR before deleting it." });
  await query("DELETE FROM flows WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

export default router;
