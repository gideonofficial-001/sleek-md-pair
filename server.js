const express = require("express");
const path = require("path");
const qrcode = require("qrcode");

const app = express();
app.use(express.static(path.join(__dirname, "public")));

function generatePair() {
    const seed = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let code = "PAIR-";
    for (let i = 0; i < 8; i++) {
        code += seed[Math.floor(Math.random() * seed.length)];
    }
    return code;
}

app.get("/generate", async (req, res) => {
    const pairCode = generatePair();
    const qrCode = await qrcode.toDataURL(pairCode);
    res.json({ status: "success", pairCode, qrCode });
});

app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(3000, () => console.log("Running on port 3000"));
