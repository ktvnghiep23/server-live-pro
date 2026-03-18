require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Pool } = require("pg");
const { RtcTokenBuilder, RtcRole } = require("agora-access-token");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ===== CONFIG AGORA =====
const APP_ID = process.env.APP_ID;
const APP_CERTIFICATE = process.env.APP_CERTIFICATE;
const ADMIN_KEY = process.env.ADMIN_KEY;

// ===== DATABASE =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Khởi tạo bảng users (nếu chưa có)
(async () => {
  const query = `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE,
      password TEXT,
      expired_at BIGINT,
      device_id TEXT
    );
  `;
  await pool.query(query);
})();

// ===== CREATE USER =====
app.post("/create-user", async (req, res) => {
  const { username, password, days, key } = req.body;
  if (key !== ADMIN_KEY) return res.json({ error: "Sai key admin" });

  const expired = Date.now() + days * 86400000;

  try {
    await pool.query(
      "INSERT INTO users (username, password, expired_at) VALUES ($1, $2, $3)",
      [username, password, expired]
    );
    res.json({ message: "Đã tạo user" });
  } catch (err) {
    res.json({ error: err.detail || err.message });
  }
});

// ===== EXTEND USER =====
app.post("/extend", async (req, res) => {
  const { username, days, key } = req.body;
  if (key !== ADMIN_KEY) return res.json({ error: "Sai key admin" });

  const add = days * 86400000;

  try {
    const { rows } = await pool.query(
      "SELECT * FROM users WHERE username=$1",
      [username]
    );
    if (rows.length === 0) return res.json({ error: "User không tồn tại" });

    const newTime = parseInt(rows[0].expired_at) + add;
    await pool.query(
      "UPDATE users SET expired_at=$1 WHERE username=$2",
      [newTime, username]
    );
    res.json({ message: "Gia hạn OK" });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ===== LOGIN =====
app.post("/login", async (req, res) => {
  const { username, password, device_id } = req.body;

  try {
    const { rows } = await pool.query(
      "SELECT * FROM users WHERE username=$1 AND password=$2",
      [username, password]
    );
    if (rows.length === 0) return res.json({ error: "Sai tài khoản" });

    const user = rows[0];
    if (Date.now() > parseInt(user.expired_at)) return res.json({ error: "Hết hạn" });

    // Chống share device
    if (user.device_id && user.device_id !== device_id) {
      return res.json({ error: "Tài khoản đã đăng nhập trên thiết bị khác" });
    }

    // Cập nhật device_id nếu chưa có
    if (!user.device_id) {
      await pool.query("UPDATE users SET device_id=$1 WHERE username=$2", [device_id, username]);
    }

    const channel = "room_" + username;
    const uid = Math.floor(Math.random() * 10000);

    // ===== TOKEN 12H =====
    const expireTime = 12 * 3600; // 12h in seconds
    const currentTime = Math.floor(Date.now() / 1000);
    const privilegeExpireTime = currentTime + expireTime;

    const token = RtcTokenBuilder.buildTokenWithUid(
      APP_ID,
      APP_CERTIFICATE,
      channel,
      uid,
      RtcRole.PUBLISHER,
      privilegeExpireTime
    );

    res.json({ token, channel, uid });
  } catch (err) {
    res.json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server chạy cổng ${PORT}`));