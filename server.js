require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { RtcTokenBuilder, RtcRole } = require("agora-access-token");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ===== CONFIG (.env) =====
const APP_ID = process.env.APP_ID;
const APP_CERTIFICATE = process.env.APP_CERTIFICATE;
const JWT_SECRET = process.env.JWT_SECRET;

const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;

// ===== DATABASE =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ===== INIT TABLES =====
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE,
      password TEXT,
      expired_at BIGINT,
      devices TEXT DEFAULT '[]'
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      username TEXT,
      action TEXT,
      time BIGINT
    );
  `);
})();

// ===== LOG HELPER =====
async function logAction(username, action){
  await pool.query(
    "INSERT INTO logs(username, action, time) VALUES($1,$2,$3)",
    [username, action, Date.now()]
  );
}

// ===== AUTH MIDDLEWARE =====
function auth(req, res, next){
  const authHeader = req.headers["authorization"];
  if(!authHeader) return res.json({error:"No token"});
  const token = authHeader.split(" ")[1];
  try{
    jwt.verify(token, JWT_SECRET);
    next();
  }catch{
    res.json({error:"Token sai"});
  }
}

// ===== ADMIN LOGIN =====
app.post("/admin-login", (req,res)=>{
  const {username,password} = req.body;
  if(username===ADMIN_USER && password===ADMIN_PASS){
    const token = jwt.sign({user:"admin"}, JWT_SECRET, {expiresIn:"7d"});
    logAction(username,"Admin login");
    return res.json({token});
  }
  res.json({error:"Sai admin"});
});

// ===== CREATE USER =====
app.post("/create-user", auth, async(req,res)=>{
  const {username,password,days} = req.body;
  const expired = Date.now() + days*86400000;
  const hashed = await bcrypt.hash(password,10);
  try{
    await pool.query(
      "INSERT INTO users(username,password,expired_at) VALUES($1,$2,$3)",
      [username,hashed,expired]
    );
    await logAction("admin","Tạo user "+username);
    res.json({message:"Đã tạo"});
  }catch(err){
    res.json({error:err.detail});
  }
});

// ===== EXTEND USER =====
app.post("/extend", auth, async(req,res)=>{
  const {username,days} = req.body;
  const {rows} = await pool.query("SELECT * FROM users WHERE username=$1",[username]);
  if(rows.length===0) return res.json({error:"Không có user"});
  const newTime = parseInt(rows[0].expired_at) + days*86400000;
  await pool.query("UPDATE users SET expired_at=$1 WHERE username=$2",[newTime,username]);
  await logAction("admin","Gia hạn user "+username+" thêm "+days+" ngày");
  res.json({message:"Gia hạn OK"});
});

// ===== DELETE USER =====
app.post("/delete-user", auth, async(req,res)=>{
  const {username} = req.body;
  await pool.query("DELETE FROM users WHERE username=$1",[username]);
  await logAction("admin","Xoá user "+username);
  res.json({message:"Đã xoá"});
});

// ===== GET USERS =====
app.get("/users", auth, async(req,res)=>{
  const q = req.query.q||"";
  const {rows} = await pool.query(
    "SELECT * FROM users WHERE username ILIKE $1 ORDER BY id DESC",
    ["%"+q+"%"]
  );
  res.json(rows);
});

// ===== GET LOGS =====
app.get("/logs", auth, async(req,res)=>{
  const {rows} = await pool.query(
    "SELECT * FROM logs ORDER BY id DESC LIMIT 100"
  );
  res.json(rows);
});

// ===== LOGIN USER =====
app.post("/login", async(req,res)=>{
  const {username,password,deviceId} = req.body;
  const {rows} = await pool.query("SELECT * FROM users WHERE username=$1",[username]);
  if(rows.length===0) return res.json({error:"Sai tài khoản"});
  const user = rows[0];
  if(Date.now() > user.expired_at) return res.json({error:"Hết hạn"});

  // CHECK THIẾT BỊ
  let devices = JSON.parse(user.devices||"[]");
  if(!devices.includes(deviceId)){
    if(devices.length>=5) return res.json({error:"Đã đạt 5 thiết bị"});
    devices.push(deviceId);
    await pool.query("UPDATE users SET devices=$1 WHERE username=$2",[JSON.stringify(devices),username]);
  }

  // Tạo token Agora 12h
  const channel = "room_"+username;
  const uid = Math.floor(Math.random()*10000);
  const expireTime = 12*3600;
  const now = Math.floor(Date.now()/1000);
  const token = RtcTokenBuilder.buildTokenWithUid(
    APP_ID,
    APP_CERTIFICATE,
    channel,
    uid,
    RtcRole.PUBLISHER,
    now+expireTime
  );

  await logAction(username,"Login user");

  res.json({token,channel,uid});
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT,()=>console.log("Server chạy cổng "+PORT));