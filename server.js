// server.js — CommonJS (works on Node 18/20)
const express = require("express");
const cors = require("cors");
const path = require("path");
const qrcode = require("qrcode");
const fs = require("fs");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const SECRET = process.env.PAIR_SECRET || "SLEEK_FDROID"; // default if not set
const SESSION_DIR = process.env.SESSION_DIR || "./session_pair";
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

/**
 * Real pairing endpoint
 * GET /api/pair-code?phone=2547XXXXXXX&token=YOUR_TOKEN
 *
 * Response:
 * { status: "success", pairCode: "...", qrCode: "data:image/png;base64,..." }
 */
app.get("/api/pair-code", async (req, res) => {
  try {
    // Security
    const token = req.query.token;
    if (!token || token !== SECRET) {
      return res.status(403).json({ error: "Forbidden — invalid token" });
    }

    // Phone validation
    const phone = (req.query.phone || "").replace(/[^0-9]/g, "");
    if (!phone) return res.status(400).json({ error: "Missing phone number" });

    // Create temporary auth state in SESSION_DIR (Baileys multi-file)
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ["SLEEK MD Pairer", "Chrome", "1.0"]
    });

    // persist creds
    sock.ev.on("creds.update", saveCreds);

    // check method exists
    if (typeof sock.requestPairingCode !== "function") {
      // cleanup socket
      try { sock.logout?.(); } catch(e) {}
      return res.status(500).json({
        error: "This Baileys build doesn't expose requestPairingCode(). Use a Baileys version that supports pairing or run pairing locally."
      });
    }

    // Request pair code (phone without plus)
    const code = await sock.requestPairingCode(phone);

    // If code is object or string: get string
    const pairCode = (typeof code === "object" && code?.code) ? code.code : code;

    // Make a QR image for display (data URI)
    const qrImage = await qrcode.toDataURL(pairCode);

    // Keep the socket running so the pairing flow can complete on phone.
    // NOTE: do not destroy sock here; the server process must keep running while the code is used.
    sock.ev.on("connection.update", (update) => {
      console.log("connection.update:", JSON.stringify(update || {}).slice(0, 500));
      // Optionally detect when pairing completed and close the socket or leave it for the real bot.
    });

    res.json({ status: "success", pairCode, qrCode: qrImage });
  } catch (err) {
    console.error("pair error:", err);
    res.status(500).json({ error: (err && err.message) || String(err) });
  }
});

// Serve UI (fallback)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SLEEK MD Pair Server running on port ${PORT}`));
