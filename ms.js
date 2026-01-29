// ms.js — Manual Scan Reader for DIVAARA
async function loadScanData() {
    try {
        // Fetching the locked session data from the backend
        const res = await fetch("http://127.0.0.1:8000/silhouette");
        const data = await res.json();

        if (data.status !== "ok") {
            console.log("No scan data available or scan not locked.");
            return;
        }

        // 1. EXTRACT RATIOS
        // Your backend stores ratios in a list [SR, WR]
        const sr = data.ratios[0];
        const wr = data.ratios[1];

        // 2. POPULATE INPUTS (Normalized to 100)
        // We set Hips to 100 and scale Shoulder/Waist accordingly
        if (document.getElementById("shoulder")) {
            document.getElementById("shoulder").value = (sr * 100).toFixed(1);
        }
        if (document.getElementById("waist")) {
            document.getElementById("waist").value = (wr * 100).toFixed(1);
        }
        if (document.getElementById("hips")) {
            document.getElementById("hips").value = 100;
        }

        // 3. TRIGGER ANALYSIS
        // This function updates the UI with the Luxury Gold styling
        calculateShape();

    } catch (err) {
        console.error("DIVAARA Sync Error:", err);
    }
}

// Automatically load data when the user arrives from the scan page
window.onload = loadScanData;