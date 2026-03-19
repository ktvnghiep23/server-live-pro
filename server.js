require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const { RtcTokenBuilder, RtcRole } = require("agora-access-token");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ===== CONFIG =====
const APP_ID = process.env.APP_ID;
const APP_CERTIFICATE = process.env.APP_CERTIFICATE;
const JWT_SECRET = "secret123"; // đổi lại cho bảo mật

// ===== ADMIN LOGIN =====
const ADMIN_USER = "admin";
const ADMIN_PASS = "123456";

// ===== DATABASE =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ===== INIT TABLE =====
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE,
      password TEXT,
      expired_at BIGINT
    );
  `);
})();

// ===== MIDDLEWARE CHECK TOKEN =====
function auth(req, res, next) {
  const token = req.headers["authorization"];
  if (!token) return res.json({ error: "No token" });

  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.json({ error: "Token sai" });
  }
}

// ===== ADMIN LOGIN =====
app.post("/admin-login", (req, res) => {
  const { username, password } = req.body;

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = jwt.sign({ user: "admin" }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token });
  } else {
    res.json({ error: "Sai admin" });
  }
});

// ===== CREATE USER =====
app.post("/create-user", auth, async (req, res) => {
  const { username, password, days } = req.body;
  const expired = Date.now() + days * 86400000;

  try {
    await pool.query(
      "INSERT INTO users (username,password,expired_at) VALUES ($1,$2,$3)",
      [username, password, expired]
    );
    res.json({ message: "Đã tạo" });
  } catch (err) {
    res.json({ error: err.detail });
  }
});

// ===== EXTEND =====
app.post("/extend", auth, async (req, res) => {
  const { username, days } = req.body;

  const { rows } = await pool.query(
    "SELECT * FROM users WHERE username=$1",
    [username]
  );

  if (rows.length === 0) return res.json({ error: "Không có user" });

  const newTime = parseInt(rows[0].expired_at) + days * 86400000;

  await pool.query(
    "UPDATE users SET expired_at=$1 WHERE username=$2",
    [newTime, username]
  );

  res.json({ message: "Gia hạn OK" });
});

// ===== DELETE =====
app.post("/delete-user", auth, async (req, res) => {
  const { username } = req.body;

  await pool.query("DELETE FROM users WHERE username=$1", [username]);
  res.json({ message: "Đã xoá" });
});

// ===== GET USERS + SEARCH =====
app.get("/users", auth, async (req, res) => {
  const q = req.query.q || "";

  const { rows } = await pool.query(
    "SELECT * FROM users WHERE username ILIKE $1 ORDER BY id DESC",
    ["%" + q + "%"]
  );

  res.json(rows);
});

// ===== LOGIN USER =====
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  const { rows } = await pool.query(
    "SELECT * FROM users WHERE username=$1 AND password=$2",
    [username, password]
  );

  if (rows.length === 0) return res.json({ error: "Sai tài khoản" });

  const user = rows[0];
  if (Date.now() > user.expired_at)
    return res.json({ error: "Hết hạn" });

  const channel = "room_" + username;
  const uid = Math.floor(Math.random() * 10000);

  const expireTime = 12 * 3600;
  const now = Math.floor(Date.now() / 1000);

  const token = RtcTokenBuilder.buildTokenWithUid(
    APP_ID,
    APP_CERTIFICATE,
    channel,
    uid,
    RtcRole.PUBLISHER,
    now + expireTime
  );

  res.json({ token, channel, uid });
});

// ===== WEB ADMIN PRO =====
app.get("/", (req, res) => {
res.send(`
<h2>ADMIN LOGIN</h2>

<input id="user" placeholder="admin">
<input id="pass" placeholder="password">
<button onclick="login()">Login</button>

<div id="panel" style="display:none">

<h3>Tìm user</h3>
<input id="search" placeholder="Nhập username">
<button onclick="load()">Tìm</button>

<h3>Tạo user</h3>
<input id="u"><input id="p"><input id="d">
<button onclick="create()">Tạo</button>

<div id="list"></div>

</div>

<script>
let token="";

async function login(){
 let r = await fetch('/admin-login',{
  method:'POST',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({username:user.value,password:pass.value})
 });
 let d = await r.json();
 if(d.token){
   token=d.token;
   panel.style.display='block';
 }else alert("Sai");
}

async function load(){
 let r = await fetch('/users?q='+search.value,{
  headers:{'Authorization':token}
 });
 let d = await r.json();

 let html="";
 d.forEach(x=>{
  html += \`
  <div>
   \${x.username}
   <button onclick="del('\${x.username}')">X</button>
  </div>\`;
 });

 list.innerHTML=html;
}

async function create(){
 await fetch('/create-user',{
  method:'POST',
  headers:{'Content-Type':'application/json','Authorization':token},
  body:JSON.stringify({username:u.value,password:p.value,days:parseInt(d.value)})
 });
 alert("OK");
}

async function del(u){
 await fetch('/delete-user',{
  method:'POST',
  headers:{'Content-Type':'application/json','Authorization':token},
  body:JSON.stringify({username:u})
 });
 load();
}
</script>
`);
});
// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server chạy cổng " + PORT));


