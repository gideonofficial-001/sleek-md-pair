// 🎵 Background Music
function playMusic() {
    const bgm = document.getElementById("bgm");
    if (bgm) bgm.play();
}

// 🌗 Light/Dark Toggle
function toggleMode() {
    document.body.classList.toggle("light");
}

// Global sessionId
let currentSessionId = null;

// 🚀 Generate Pair Code (advanced backend)
async function generate() {
    const phone = document.getElementById("phone").value.trim();
    const token = document.getElementById("token").value.trim();

    const loader = document.getElementById("loader");
    const output = document.getElementById("output");
    const sound = document.getElementById("ding");

    if (!phone) return alert("Enter phone number (digits only).");
    if (!token) return alert("Enter your secret token.");

    loader.style.display = "flex";
    output.style.display = "none";

    try {
        const res = await fetch(`/api/pair-code?phone=${encodeURIComponent(phone)}&token=${encodeURIComponent(token)}`);
        const data = await res.json();

        loader.style.display = "none";

        if (data.error) {
            alert(data.error);
            return;
        }

        // Show data
        document.getElementById("pair").innerText = data.pairCode;
        document.getElementById("qr").src = data.qrCode;
        document.getElementById("sessionIdDisplay").innerText = data.sessionId;

        currentSessionId = data.sessionId;

        output.style.display = "block";

        sound.play();

    } catch (err) {
        loader.style.display = "none";
        alert("Network error — check your server.");
        console.error(err);
    }
}

// ⬇ Download session ZIP
async function downloadSession() {
    if (!currentSessionId) return alert("Generate a pair code first.");

    const token = document.getElementById("token").value.trim();
    if (!token) return alert("Enter token first.");

    const url = `/api/download-session?sessionId=${encodeURIComponent(currentSessionId)}&token=${encodeURIComponent(token)}`;

    // Force browser download
    const a = document.createElement("a");
    a.href = url;
    a.download = `${currentSessionId}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
}