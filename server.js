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
const JWT_SECRET = "secret120512"; // đổi lại cho bảo mật

// ===== ADMIN LOGIN =====
const ADMIN_USER = "adminDaiCaBach";
const ADMIN_PASS = "210521";

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
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font-family:Arial;background:#f5f6fa;padding:20px}
.card{background:white;padding:15px;margin:10px 0;border-radius:10px;box-shadow:0 2px 6px rgba(0,0,0,0.1)}
input{width:100%;padding:10px;margin:5px 0;border-radius:6px;border:1px solid #ccc}
button{padding:10px;width:100%;border:none;border-radius:6px;background:#3498db;color:white}
.user{border:1px solid #ddd;padding:10px;margin-top:5px;border-radius:6px}
.green{color:green}
.red{color:red}
</style>
</head>

<body>

<div class="card">
<h3>🔐 Admin Login</h3>
<input id="user" placeholder="admin">
<input id="pass" placeholder="password">
<button onclick="login()">Đăng nhập</button>
</div>

<div id="panel" style="display:none">

<div class="card">
<h3>🔍 Tìm / Lọc tài khoản</h3>
<input id="search" placeholder="Nhập username để lọc">
<button onclick="load()">Tìm</button>
</div>

<div class="card">
<h3>➕ Tạo tài khoản</h3>
<input id="u" placeholder="username">
<input id="p" placeholder="password">
<input id="d" type="number" placeholder="số ngày">
<button onclick="create()">Tạo</button>
</div>

<div class="card">
<h3>📋 Danh sách</h3>
<button onclick="load()">Load tất cả</button>
<div id="list"></div>
</div>

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
 }else{
   alert("Sai tài khoản admin");
 }
}

// ===== LOAD + SEARCH =====
async function load(){
 let keyword = search.value || "";

 let r = await fetch('/users?q='+keyword,{
  headers:{'Authorization':token}
 });

 let data = await r.json();

 let html="";

 if(data.length === 0){
   html = "<p>❌ Không có tài khoản</p>";
 }else{
   data.forEach(x=>{
     let remain = Math.floor((x.expired_at - Date.now()) / 86400000);

     let date = new Date(parseInt(x.expired_at)).toLocaleDateString();

     let status = remain > 0
       ? "<span class='green'>Còn " + remain + " ngày</span>"
       : "<span class='red'>Hết hạn</span>";

     html += \`
     <div class="user">
       👤 <b>\${x.username}</b><br>
       📅 Hết hạn: \${date}<br>
       ⏳ \${status}<br><br>
       <button onclick="del('\${x.username}')">❌ Xoá</button>
     </div>\`;
   });
 }

 list.innerHTML = html;
}

// ===== CREATE =====
async function create(){
 let r = await fetch('/create-user',{
  method:'POST',
  headers:{
    'Content-Type':'application/json',
    'Authorization':token
  },
  body:JSON.stringify({
    username:u.value,
    password:p.value,
    days:parseInt(d.value)
  })
 });

 let dres = await r.json();
 alert(dres.message || dres.error);
 load();
}

// ===== DELETE =====
async function del(u){
 if(!confirm("Xoá " + u + "?")) return;

 await fetch('/delete-user',{
  method:'POST',
  headers:{
    'Content-Type':'application/json',
    'Authorization':token
  },
  body:JSON.stringify({username:u})
 });

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


