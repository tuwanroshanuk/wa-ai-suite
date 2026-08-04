import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { query } from "../db/index.js";

const router = Router();

// Creates the admin user from env vars if it doesn't exist yet.
// Called once at server boot (see index.js).
export async function bootstrapAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;

  const existing = await query("SELECT id FROM users WHERE email = $1", [email]);
  if (existing.rows.length) return;

  const hash = await bcrypt.hash(password, 10);
  await query(
    "INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,'admin')",
    [email, hash, "Admin"]
  );
  console.log(`[auth] bootstrapped admin user ${email}`);
}

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "email and password required" });

  const result = await query("SELECT * FROM users WHERE email = $1", [email]);
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({ token, user: { id: user.id, email: user.email, role: user.role, name: user.name } });
});

router.post("/register-agent", async (req, res) => {
  // Intended to be called by an admin from the dashboard (Settings > Team).
  // Left open here at the route level; wire requireAdmin in index.js when mounting if desired.
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: "email and password required" });
  const hash = await bcrypt.hash(password, 10);
  const result = await query(
    "INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,'agent') RETURNING id, email, name, role",
    [email, hash, name || null]
  );
  res.json(result.rows[0]);
});

export default router;
