import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { query } from "../db/index.js";

const router = Router();
const UPLOAD_DIR = path.join(process.env.RECORDINGS_DIR || "/app/recordings", "assets");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

router.get("/", async (req, res) => {
  const result = await query("SELECT * FROM audio_assets ORDER BY created_at DESC");
  res.json(result.rows);
});

router.post("/", upload.single("file"), async (req, res) => {
  const result = await query(
    "INSERT INTO audio_assets (name, file_path) VALUES ($1,$2) RETURNING *",
    [req.body.name || req.file.originalname, req.file.path]
  );
  res.json(result.rows[0]);
});

router.delete("/:id", async (req, res) => {
  await query("DELETE FROM audio_assets WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

export default router;
