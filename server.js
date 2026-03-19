require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Pool } = require("pg");
const { RtcTokenBuilder, RtcRole } = require("agora-access-token");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ===== CONFIG =====
const APP_ID = process.env.APP_ID;
const APP_CERTIFICATE = process.env.APP_CERTIFICATE;
const ADMIN_KEY = process.env.ADMIN_KEY;

// ===== DATABASE =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20
});

// ===== CACHE TOKEN =====
const tokenCache = new Map();

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

// ===== CREATE USER =====
app.post("/create-user", async (req, res) => {
  const { username, password, days, key } = req.body;
  if (key !== ADMIN_KEY) return res.json({ error: "Sai key admin" });

  const expired = Date.now() + days * 86400000;

  try {
    await pool.query(
      "INSERT INTO users (username, password, expired_at) VALUES ($1,$2,$3)",
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

    if (rows.length === 0) return res.json({ error: "Không tồn tại" });

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

// ===== GET USERS =====
app.get("/users", async (req, res) => {
  const key = req.query.key;
  if (key !== ADMIN_KEY) return res.json({ error: "Sai key" });

  const { rows } = await pool.query("SELECT * FROM users ORDER BY id DESC");
  res.json(rows);
});

// ===== DELETE USER =====
app.post("/delete-user", async (req, res) => {
  const { username, key } = req.body;

  if (key !== ADMIN_KEY) return res.json({ error: "Sai key" });

  await pool.query("DELETE FROM users WHERE username=$1", [username]);

  res.json({ message: "Đã xoá user" });
});

// ===== LOGIN =====
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    // CACHE (giảm lag)
    const cached = tokenCache.get(username);
    if (cached && Date.now() < cached.expireAt) {
      return res.json(cached.data);
    }

    const { rows } = await pool.query(
      "SELECT * FROM users WHERE username=$1 AND password=$2",
      [username, password]
    );

    if (rows.length === 0) return res.json({ error: "Sai tài khoản" });

    const user = rows[0];

    if (Date.now() > parseInt(user.expired_at))
      return res.json({ error: "Hết hạn" });

    // TOKEN 12H
    const channel = "room_" + username;
    const uid = Math.floor(Math.random() * 10000);

    const expireTime = 12 * 3600;
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

    const data = { token, channel, uid };

    // cache 60s
    tokenCache.set(username, {
      data,
      expireAt: Date.now() + 60000
    });

    res.json(data);

  } catch (err) {
    res.json({ error: err.message });
  }
});

// ===== WEB ADMIN PRO =====
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin Panel</title>

<style>
body{
  font-family: Arial;
  background:#f5f6fa;
  padding:20px;
}
.container{
  max-width:500px;
  margin:auto;
}
.card{
  background:white;
  padding:15px;
  margin-bottom:15px;
  border-radius:10px;
  box-shadow:0 2px 8px rgba(0,0,0,0.1);
}
h2,h3{margin-top:0}
input{
  width:100%;
  padding:10px;
  margin:5px 0;
  border-radius:6px;
  border:1px solid #ccc;
}
button{
  width:100%;
  padding:10px;
  border:none;
  border-radius:6px;
  background:#3498db;
  color:white;
  font-weight:bold;
  cursor:pointer;
}
button:hover{background:#2980b9}
.user{
  border:1px solid #ddd;
  padding:10px;
  margin:5px 0;
  border-radius:6px;
}
.green{color:green}
.red{color:red}
</style>

</head>

<body>

<div class="container">

<div class="card">
<h2>🔐 Admin Login</h2>
<input id="key" placeholder="Nhập admin key">
<button onclick="login()">Đăng nhập</button>
</div>

<div id="panel" style="display:none;">

<div class="card">
<h3>➕ Tạo tài khoản</h3>
<input id="u" placeholder="Username">
<input id="p" placeholder="Password">
<input id="d" type="number" placeholder="Số ngày">
<button onclick="create()">Tạo</button>
</div>

<div class="card">
<h3>🔄 Gia hạn</h3>
<input id="u2" placeholder="Username">
<input id="d2" type="number" placeholder="Số ngày thêm">
<button onclick="extend()">Gia hạn</button>
</div>

<div class="card">
<h3>📋 Danh sách user</h3>
<button onclick="load()">Load danh sách</button>
<div id="list"></div>
</div>

</div>

</div>

<script>
let k="";

function login(){
  k = document.getElementById('key').value;
  if(!k){ alert("Nhập key"); return; }
  panel.style.display='block';
}

async function create(){
  let r = await fetch('/create-user',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      username:u.value,
      password:p.value,
      days:parseInt(d.value),
      key:k
    })
  });
  alert(await r.text());
}

async function extend(){
  let r = await fetch('/extend',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      username:u2.value,
      days:parseInt(d2.value),
      key:k
    })
  });
  alert(await r.text());
}

async function load(){
  let r = await fetch('/users?key='+k);
  let d = await r.json();

  let html="";
  d.forEach(x=>{
    let remain = Math.floor((x.expired_at - Date.now())/86400000);
    let status = remain > 0 
      ? "<span class='green'>Còn " + remain + " ngày</span>"
      : "<span class='red'>Hết hạn</span>";

    html += \`
    <div class="user">
      <b>\${x.username}</b><br>
      \${status}<br>
      <button onclick="del('\${x.username}')">Xoá</button>
    </div>\`;
  });

  list.innerHTML = html;
}

async function del(u){
  if(!confirm("Xoá " + u + "?")) return;

  let r = await fetch('/delete-user',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:u,key:k})
  });

  alert(await r.text());
  load();
}
</script>

</body>
</html>
  `);
});
// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server chạy cổng " + PORT));


