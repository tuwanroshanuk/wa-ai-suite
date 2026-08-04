import { Router } from "express";
import { query } from "../db/index.js";

const router = Router();

router.get("/", async (req, res) => {
  const result = await query("SELECT * FROM contacts ORDER BY created_at DESC LIMIT 500");
  res.json(result.rows);
});

router.patch("/:id", async (req, res) => {
  const { name, attributes, bot_enabled } = req.body;
  const result = await query(
    `UPDATE contacts SET
       name = COALESCE($1, name),
       attributes = COALESCE($2, attributes),
       bot_enabled = COALESCE($3, bot_enabled)
     WHERE id = $4 RETURNING *`,
    [name, attributes, bot_enabled, req.params.id]
  );
  res.json(result.rows[0]);
});

export default router;
