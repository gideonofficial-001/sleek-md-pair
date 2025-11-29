function playMusic() {
    document.getElementById("bgm").play();
}

function toggleMode() {
    document.body.classList.toggle("light");
}

async function generate() {
    const phone = document.getElementById("phone").value.trim();

    if (!phone.startsWith("+")) {
        alert("Enter a correct phone number with country code.");
        return;
    }

    document.getElementById("loader").style.display = "block";
    document.getElementById("output").style.display = "none";

    const res = await fetch(`/generate?phone=${encodeURIComponent(phone)}`);
    const data = await res.json();

    document.getElementById("loader").style.display = "none";
    document.getElementById("output").style.display = "block";

    document.getElementById("pair").innerText = data.pairCode;
    document.getElementById("qr").src = data.qrCode;
}

function downloadQR() {
    const img = document.getElementById("qr").src;

    const link = document.createElement("a");
    link.href = img;
    link.download = "pair_qr.png";
    link.click();
}
