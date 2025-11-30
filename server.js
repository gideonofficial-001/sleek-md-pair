/**
 * server.js
 * Advanced SLEEK MD Pairer backend (CommonJS)
 *
 * Features:
 *  - Protected pairing endpoint (/api/pair-code)
 *  - Per-phone session folders (isolated)
 *  - Zip & download session endpoint (/api/download-session)
 *  - Auto cleanup of stale sessions
 *  - Rate limiting & optional IP whitelist
 *  - Basic logging to file + /api/logs endpoint
 *
 * Environment variables (recommended to set on host / Render):
 *  - PAIR_SECRET           : required secret token for pairing
 *  - SESSION_ROOT          : root path where session folders are created (default ./sessions)
 *  - PORT                  : listening port (default 3000)
 *  - CLEANUP_MINUTES       : how many minutes before an unused session is auto-removed (default 10)
 *  - ALLOWED_IPS           : comma-separated allowed IPs (optional) — if provided, blocks others
 *  - NODE_ENV              : 'production' recommended
 *
 * Dependencies (install with npm):
 * npm i express cors helmet express-rate-limit morgan archiver fs-extra qrcode @whiskeysockets/baileys
 *
 * Note: Use Node 18 or 20. Keep PAIR_SECRET safe.
 */

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const morgan = require("morgan");
const fs = require("fs-extra");
const path = require("path");
const archiver = require("archiver");
const qrcode = require("qrcode");
const os = require("os");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const app = express();

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const PAIR_SECRET = process.env.PAIR_SECRET || "SLEEK_FDROID";
const SESSION_ROOT = process.env.SESSION_ROOT || path.join(__dirname, "sessions");
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, "pairer.log");
const CLEANUP_MINUTES = parseInt(process.env.CLEANUP_MINUTES || "10", 10);
const ALLOWED_IPS = (process.env.ALLOWED_IPS || "").split(",").map(s => s.trim()).filter(Boolean);
// ensure folders
fs.ensureDirSync(SESSION_ROOT);

// in-memory session registry
// sessionId => { phone, createdAt, folder, socketAlive (bool) }
const sessions = new Map();

// ---------- Middlewares ----------
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// logging
const accessLogStream = fs.createWriteStream(path.join(__dirname, "access.log"), { flags: "a" });
app.use(morgan("combined", { stream: accessLogStream }));

// Rate limit: protect endpoints (basic)
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 15, // limit per minute per IP
  message: { error: "Too many requests, slow down." }
});
app.use("/api/", limiter);

// helper: append logs
function appendLog(line) {
  const ts = new Date().toISOString();
  const text = `[${ts}] ${line}${os.EOL}`;
  fs.appendFile(LOG_FILE, text).catch(console.error);
}

// helper: check IP whitelist
function checkIpAllowed(req, res, next) {
  if (ALLOWED_IPS.length === 0) return next();
  const ip = (req.ip || req.connection.remoteAddress || "").replace("::ffff:", "");
  if (!ALLOWED_IPS.includes(ip)) {
    appendLog(`Blocked IP ${ip}`);
    return res.status(403).json({ error: "Forbidden (IP not allowed)" });
  }
  next();
}

// helper: validate token
function validateToken(req, res, next) {
  const token = req.query.token || req.headers["x-pair-token"] || req.body.token;
  if (!token) return res.status(401).json({ error: "Missing token" });
  if (token !== PAIR_SECRET) return res.status(403).json({ error: "Invalid token" });
  next();
}

// utility: create unique session id
function newSessionId(phone) {
  const ts = Date.now();
  const safePhone = phone.replace(/[^0-9]/g, "") || "anon";
  return `${safePhone}_${ts}`;
}

// cleanup logic: remove folder and map entry
async function removeSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  try {
    await fs.remove(s.folder);
    appendLog(`Removed session ${sessionId} (phone: ${s.phone})`);
  } catch (e) {
    appendLog(`Error removing session ${sessionId}: ${e.message}`);
  }
  sessions.delete(sessionId);
}

// schedule periodic cleanup to remove old sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    const ageMs = now - s.createdAt;
    if (ageMs > CLEANUP_MINUTES * 60 * 1000) {
      appendLog(`Auto-clean: session ${id} aged ${Math.round(ageMs/1000)}s`);
      removeSession(id).catch(console.error);
    }
  }
}, 60 * 1000); // every minute

// ---------- API: Generate Pair Code (real Baileys pairing) ----------
// GET /api/pair-code?phone=2547xxxxx&token=PAIR_SECRET
app.get("/api/pair-code", checkIpAllowed, validateToken, async (req, res) => {
  try {
    const phoneRaw = (req.query.phone || "").toString();
    const phone = phoneRaw.replace(/[^0-9]/g, "");
    if (!phone) return res.status(400).json({ error: "Missing or invalid phone parameter" });

    // create unique session folder per attempt (isolated)
    const sessionId = newSessionId(phone);
    const folder = path.join(SESSION_ROOT, sessionId);
    await fs.ensureDir(folder);

    // Use multi-file state in this folder
    const { state, saveCreds } = await useMultiFileAuthState(folder);
    const { version } = await fetchLatestBaileysVersion();

    // Create a temporary socket for pairing
    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ["SLEEK-MD-Pairer", "Chrome", "1.0"]
    });

    // Persist credentials to this folder
    sock.ev.on("creds.update", saveCreds);

    // Ensure socket kept alive in memory; store in registry
    sessions.set(sessionId, {
      phone,
      folder,
      createdAt: Date.now(),
      socketAlive: true,
      socketInfo: { /* for future use */ }
    });

    appendLog(`Created session ${sessionId} for phone ${phone}`);

    // ensure pairing method exists
    if (typeof sock.requestPairingCode !== "function") {
      appendLog(`Pairing method missing for session ${sessionId}`);
      // cleanup socket & folder
      try { await sock.logout?.(); } catch(e){}
      await removeSession(sessionId);
      return res.status(500).json({ error: "This Baileys build does not support requestPairingCode()" });
    }

    // request pair code (phone without plus)
    const codeObj = await sock.requestPairingCode(phone);
    // codeObj may be string or { code, qr }
    const pairCode = (typeof codeObj === "object" && codeObj?.code) ? codeObj.code : String(codeObj);

    // generate QR image (data URL) for UI
    const qrDataUrl = await qrcode.toDataURL(pairCode);

    appendLog(`Pair code generated for session ${sessionId}`);

    // Return sessionId so client can request download later, and pairing code + QR
    return res.json({
      status: "success",
      sessionId,
      pairCode,
      qrCode: qrDataUrl,
      message: "Use this code or QR in WhatsApp → Linked Devices → Link a device"
    });
  } catch (err) {
    appendLog(`pair-code error: ${err?.message || err}`);
    console.error(err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
});

// ---------- API: Download Session (zip & provide file) ----------
// GET /api/download-session?sessionId=...&token=PAIR_SECRET
// This zips the session folder and streams it. Optionally deletes after download.
app.get("/api/download-session", checkIpAllowed, validateToken, async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });
    const meta = sessions.get(sessionId);
    if (!meta) return res.status(404).json({ error: "Session not found or expired" });

    const folder = meta.folder;
    const zipName = `${sessionId}.zip`;

    // stream zip
    res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);
    res.setHeader("Content-Type", "application/zip");

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", (err) => {
      appendLog(`Archive error for ${sessionId}: ${err.message}`);
      res.status(500).end();
    });
    archive.pipe(res);

    archive.directory(folder, false);
    archive.finalize();

    // after stream finishes, remove the session folder
    res.on("finish", async () => {
      appendLog(`Session ${sessionId} downloaded — cleaning up`);
      try {
        await removeSession(sessionId);
      } catch (e) {
        appendLog(`Error cleanup after download ${sessionId}: ${e.message}`);
      }
    });
  } catch (err) {
    appendLog(`download-session error: ${err?.message || err}`);
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ---------- API: List active sessions (for admin) ----------
// GET /api/sessions?token=PAIR_SECRET
app.get("/api/sessions", checkIpAllowed, validateToken, (req, res) => {
  const list = [];
  for (const [id, s] of sessions.entries()) {
    list.push({ sessionId: id, phone: s.phone, createdAt: s.createdAt, socketAlive: s.socketAlive });
  }
  res.json({ count: list.length, sessions: list });
});

// ---------- API: Read logs (tail) ----------
// GET /api/logs?lines=200&token=PAIR_SECRET
app.get("/api/logs", checkIpAllowed, validateToken, async (req, res) => {
  try {
    const lines = Math.min(1000, parseInt(req.query.lines || "200", 10));
    if (!await fs.pathExists(LOG_FILE)) {
      return res.json({ logs: [] });
    }
    const txt = await fs.readFile(LOG_FILE, "utf8");
    const arr = txt.trim().split(/\r?\n/).slice(-lines);
    res.json({ logs: arr });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error reading logs" });
  }
});

// ---------- Serve UI (static public folder) ----------
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------- Start server ----------
app.listen(PORT, () => {
  appendLog(`SLEEK MD Pairer started on port ${PORT}. Sessions root: ${SESSION_ROOT}`);
  console.log(`SLEEK MD Pairer running on port ${PORT}`);
});