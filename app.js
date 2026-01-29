/**
 * DIVAARA UNIFIED INTELLIGENCE CONTROLLER
 * VERSION: v2.7 (Hybrid: Browser AI + Server Fallback)
 */

// =============================================================================
// 0. SYSTEM CONFIG
// =============================================================================
const DEBUG = false; // Set true for dev logs

// =============================================================================
// 1. GLOBAL STATE & CONFIG (FSM)
// =============================================================================
const STATE = {
    mode: null,          // 'body' | 'skin' | null
    phase: 'IDLE',       // 'IDLE' | 'CAMERA_READY' | 'ALIGNING' | 'CAPTURING' | 'PROCESSING' | 'RESULT' | 'ERROR'
    
    // ✅ FIX 1: Set to 'server' to prevent mobile browser crashes
    aiMode: 'server',   // 'browser' (MediaPipe) | 'server' (Python/OpenCV)
    
    // Hardware & ML
    cameraStream: null,
    mpCameraLoop: null,
    faceDetector: null,
    mpLoaded: false,     // Detection for silent WASM failures
    mpWarmed: false,     // Prevent double warm-ups
    modelRetries: 0,     // Retry counter
    
    // Logic Buffers
    stabilityBuffer: []  // For Tier 2 Face Stability
};

// Race Condition Lock
let MODE_LOCK = false;
// ✅ FIX 2: Replace with your actual Laptop/PC Local IP
const SERVER_URL = 'http://192.168.1.5:8000'; 
const CONFIG = {
    body: {
        apiEndpoint: `${SERVER_URL}/analyze-body`,
        maxAttempts: 50,
        pollInterval: 350,
        requestTimeout: 5000
    },
    skin: {
        apiEndpoint: `${SERVER_URL}/analyze-skin`,
        detectEndpoint: `${SERVER_URL}/detect-face`,
        batchSize: 3,           // <--- CHANGE THIS from 10 to 3 (Faster upload)
        captureInterval: 150, 
        inferenceInterval: 100,
        serverInterval: 500,    
        minFaceRatio: 0.08,
        maxFaceRatio: 0.18,
        stabilityThreshold: 0.02, 
        uploadTimeout: 30000    // <--- CHANGE THIS from 10000 to 30000 (Give it 30 seconds)
    
    }
};

// =============================================================================
// 2. DOM ELEMENTS
// =============================================================================
const DOM = {
    viewHome: document.getElementById('view-home'),
    viewScanner: document.getElementById('view-scanner'),
    video: document.getElementById('webcam'),
    canvas: document.getElementById('capture-canvas'),
    overlayBody: document.getElementById('overlay-body'),
    overlaySkin: document.getElementById('overlay-skin'),
    bodyScanLine: document.getElementById('body-scanline'),
    bodyCountdown: document.getElementById('body-countdown'),
    btnStartBody: document.getElementById('btn-start-body'),
    silWrapper: document.querySelector('.sil-wrapper'),
    skinGuide: document.getElementById('skin-guide'),
    skinProgress: document.getElementById('skin-progress'),
    statusText: document.getElementById('status-text'),
    resultCard: document.getElementById('result-card'),
    resTitle: document.getElementById('res-title'),
    resMetrics: document.getElementById('res-metrics')
};

const ctx = DOM.canvas.getContext('2d');

// Visibility & Unload Guards
document.addEventListener("visibilitychange", () => {
    if (document.hidden && STATE.mode === 'skin') {
        setSkinLoop(false);
    } else if (!document.hidden && STATE.mode === 'skin' && STATE.phase === 'ALIGNING') {
        setSkinLoop(true);
    }
});

window.addEventListener("beforeunload", () => {
    try {
        STATE.mpCameraLoop?.stop();
        STATE.faceDetector?.close?.();
    } catch {}
});

// =============================================================================
// 3. NAVIGATION & LIFECYCLE (FSM Implementation)
// =============================================================================

async function switchMode(mode) {
    if (MODE_LOCK) return;
    MODE_LOCK = true;

    setSkinLoop(false); 
    
    STATE.mode = mode;
    STATE.phase = 'IDLE';
    // STATE.aiMode is now set globally to 'server', do not reset to 'browser'
    
    DOM.viewHome.classList.add('hidden');
    DOM.viewScanner.classList.remove('hidden');
    resetUI();

    if (mode === 'body') {
        setupBodyMode();
    } else {
        await setupSkinMode();
    }
    
    await startCamera(mode);

    setTimeout(() => {
        MODE_LOCK = false;
    }, 800);
}

function exitScanner() {
    stopCamera();
    
    if (STATE.mpCameraLoop) {
        try { STATE.mpCameraLoop.stop(); } catch (e) {}
        STATE.mpCameraLoop = null;
    }

    if (STATE.faceDetector) {
        try { STATE.faceDetector.close?.(); } catch (e) {}
        STATE.faceDetector = null;
        STATE.mpWarmed = false;
        STATE.mpLoaded = false;
    }

    STATE.mode = null;
    STATE.phase = 'IDLE';
    DOM.viewScanner.classList.add('hidden');
    DOM.viewHome.classList.remove('hidden');
    
    // Reset specific states
    DOM.skinProgress.style.width = '0%';
    DOM.skinGuide.classList.remove('locked');
    DOM.skinGuide.style.opacity = "1";
    DOM.skinGuide.style.borderColor = "rgba(255,255,255,0.3)";
    DOM.skinGuide.style.boxShadow = "none";
}

function resetUI() {
    DOM.overlayBody.classList.add('hidden');
    DOM.overlaySkin.classList.add('hidden');
    DOM.btnStartBody.classList.add('hidden');
    DOM.resultCard.style.transform = "translateY(120%)";
    DOM.video.classList.remove('video-dim');
    DOM.statusText.className = "px-5 py-2 bg-black/60 backdrop-blur-md border border-white/10 rounded-full text-xs font-medium uppercase tracking-wider transition-all";
}

function resetScanner() {
    DOM.resultCard.style.transform = "translateY(120%)";
    DOM.video.classList.remove('video-dim');
    
    if (STATE.mode === 'body') {
        STATE.phase = 'IDLE';
        DOM.silWrapper.style.display = 'block';
        DOM.silWrapper.style.setProperty('--s-scale', 1);
        DOM.silWrapper.style.setProperty('--w-scale', 1);
        DOM.bodyScanLine.style.display = 'none';
        
        DOM.btnStartBody.disabled = false;
        DOM.btnStartBody.classList.remove('hidden');
        DOM.btnStartBody.innerText = "START SCAN";
        
        updateStatus("Align full body in frame");
    } else {
        STATE.phase = 'ALIGNING';
        STATE.stabilityBuffer.length = 0; 
        setSkinLoop(true); 
        DOM.skinGuide.classList.remove('locked');
        DOM.skinGuide.style.borderColor = "rgba(255,255,255,0.3)";
        DOM.skinGuide.style.boxShadow = "none";
        DOM.skinGuide.style.opacity = "1";
        DOM.skinProgress.style.width = '0%';
        updateStatus("Align face in guide");
    }
}

// Debug Logger
function debugState() {
    if (!DEBUG) return;
    console.table({
        mode: STATE.mode,
        phase: STATE.phase,
        aiMode: STATE.aiMode,
        mpLoaded: STATE.mpLoaded
    });
}

// =============================================================================
// 4. CAMERA & MEDIAPIPE MANAGER
// =============================================================================

async function startCamera(mode) {
    stopCamera(); 
    
    const constraints = {
        video: { facingMode: "user" },
        audio: false
    };

    try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        DOM.video.srcObject = stream;
        STATE.cameraStream = stream;
        await new Promise(resolve => DOM.video.onloadedmetadata = resolve);
        
        if (STATE.phase === 'IDLE') STATE.phase = 'CAMERA_READY';
        
        if (STATE.mode === 'skin') {
            await initSkinPipeline();
        }

    } catch (err) {
        STATE.phase = 'ERROR';
        updateStatus("Camera Access Denied");
        console.error("Camera Error:", err);
    }
}

function stopCamera() {
    setSkinLoop(false);
    if (STATE.cameraStream) {
        STATE.cameraStream.getTracks().forEach(track => track.stop());
        STATE.cameraStream = null;
        DOM.video.srcObject = null;
    }
}

function setSkinLoop(active) {
    // If in server mode, we don't control the MP loop, we control the polling loop
    if (STATE.aiMode === 'server') {
        // Logic handled in startServerFaceScan
        return;
    }

    if (!STATE.mpCameraLoop) return;
    if (active) {
        STATE.mpCameraLoop.start();
    } else {
        STATE.mpCameraLoop.stop();
    }
}

async function waitForVideoReady(video) {
    if (video.videoWidth > 0 && video.videoHeight > 0) return;
    while (video.videoWidth === 0) {
        if (STATE.mode !== 'skin') return;
        await new Promise(r => setTimeout(r, 50));
    }
}

// =============================================================================
// 5. BODY SCANNER LOGIC
// =============================================================================

function setupBodyMode() {
    DOM.overlayBody.classList.remove('hidden');
    DOM.btnStartBody.classList.remove('hidden');
    DOM.btnStartBody.innerText = "START SCAN"; 
    STATE.phase = 'IDLE';
    updateStatus("Align full body in frame");
}

function startBodySequence() {
    DOM.btnStartBody.disabled = true;
    DOM.btnStartBody.classList.add('hidden');
    
    let count = 3;
    DOM.bodyCountdown.classList.remove('hidden');
    DOM.bodyCountdown.innerText = count;
    
    const timer = setInterval(() => {
        count--;
        if (count > 0) {
            DOM.bodyCountdown.innerText = count;
        } else {
            clearInterval(timer);
            DOM.bodyCountdown.classList.add('hidden');
            performBodyScan();
        }
    }, 1000);
}

async function performBodyScan() {
    STATE.phase = 'CAPTURING';
    let attempts = 0;
    DOM.bodyScanLine.style.display = 'block';
    updateStatus("Scanning...");

    const scanLoop = async () => {
        if (STATE.phase !== 'CAPTURING' || STATE.mode !== 'body') return;

        attempts++;
        if (attempts > CONFIG.body.maxAttempts) {
            handleBodyError("Timed out. Ensure full body is visible.");
            return;
        }

        DOM.canvas.width = 480; 
        DOM.canvas.height = 640;
        ctx.drawImage(DOM.video, 0, 0, DOM.canvas.width, DOM.canvas.height);
        const imageBase64 = DOM.canvas.toDataURL("image/jpeg", 0.6);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.body.requestTimeout);

        try {
            const res = await fetch(CONFIG.body.apiEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: imageBase64 }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!res.ok) throw new Error("API Error");
            const data = await res.json();

            if (data.status === 'locked') {
                finalizeBodyScan(data);
            } else if (data.status === 'error') {
                handleBodyError("Scan Failed. Please retry.");
            } else {
                updateBodyStatus(data.status);
                setTimeout(scanLoop, CONFIG.body.pollInterval);
            }

        } catch (err) {
            if (err.name === 'AbortError') updateStatus("Network slow...");
            setTimeout(scanLoop, CONFIG.body.pollInterval);
        }
    };
    scanLoop();
}

function updateBodyStatus(status) {
    const messages = {
        'pose_not_upright': "Stand straight • Face camera",
        'stabilizing': "Hold still...",
        'scanning': "Scanning...",
        'scan_not_reliable': "Adjust position"
    };
    updateStatus(messages[status] || "Analyzing...");
}

function handleBodyError(msg) {
    STATE.phase = 'ERROR';
    DOM.bodyScanLine.style.display = 'none';
    updateStatus(msg);
    DOM.btnStartBody.disabled = false;
    DOM.btnStartBody.classList.remove('hidden');
    DOM.btnStartBody.innerText = "RETRY";
}

function finalizeBodyScan(data) {
    STATE.phase = 'RESULT';
    DOM.bodyScanLine.style.display = 'none';
    DOM.video.classList.add('video-dim');
    const deform = data.silhouette_deform;
    DOM.silWrapper.style.setProperty('--s-scale', deform.shoulder);
    DOM.silWrapper.style.setProperty('--w-scale', deform.waist);

    DOM.resTitle.innerText = data.body_shape.primary;
    DOM.resMetrics.innerHTML = `
        <div class="bg-white/5 p-3 rounded-xl"><span class="text-neutral-400 text-[10px] uppercase block">Shoulder/Hip</span><span class="font-mono font-bold">${data.ratios.shoulder_hip}</span></div>
        <div class="bg-white/5 p-3 rounded-xl"><span class="text-neutral-400 text-[10px] uppercase block">Waist/Hip</span><span class="font-mono font-bold">${data.ratios.waist_hip}</span></div>
        <div class="col-span-2 bg-white/5 p-3 rounded-xl"><span class="text-neutral-400 text-[10px] uppercase block">Confidence</span><span class="font-mono font-bold text-green-400">${Math.round(data.confidence * 100)}%</span></div>
    `;
    DOM.resultCard.style.transform = "translateY(0)";
    DOM.statusText.classList.add('bg-green-600');
    updateStatus("Analysis Complete");
}

// =============================================================================
// 6. SKIN SCANNER LOGIC (Hybrid Architecture)
// =============================================================================

async function setupSkinMode() {
    DOM.overlaySkin.classList.remove('hidden');
    STATE.phase = 'ALIGNING';
    STATE.stabilityBuffer.length = 0; 
    STATE.modelRetries = 0; 
    updateStatus("Align face in guide");
    STATE.mpLoaded = false; 

    // Force CDN
    const MEDIAPIPE_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/";

    if (!STATE.faceDetector) {
        STATE.faceDetector = new FaceDetection({
            locateFile: (file) => `${MEDIAPIPE_BASE}${file}`
        });
        
        STATE.faceDetector.setOptions({ model: 'short', minDetectionConfidence: 0.5 });
        
        STATE.faceDetector.onResults((results) => {
            STATE.mpLoaded = true;
            if(DEBUG) console.log("MediaPipe Results Active");
            handleFaceResults(results);
        });
    }
}

async function initSkinPipeline() {
    if (STATE.mode !== 'skin') return;

    await waitForVideoReady(DOM.video);

    // Browser Mode Loop (High FPS)
    if (!STATE.mpCameraLoop) {
        let lastRun = 0; 
        STATE.mpCameraLoop = new Camera(DOM.video, {
            onFrame: async () => {
                if (document.hidden || STATE.aiMode === 'server') return;
                
                // Resolution Guard
                if (!DOM.video.videoWidth || !DOM.video.videoHeight) return;

                const now = performance.now();
                if (now - lastRun < CONFIG.skin.inferenceInterval) return;
                
                if (STATE.mode === 'skin' && STATE.phase === 'ALIGNING') {
                    lastRun = now;
                    if(STATE.faceDetector) {
                        try {
                            await STATE.faceDetector.send({ image: DOM.video });
                        } catch (e) {
                            if (DEBUG) console.warn("MediaPipe send error", e);
                            STATE.mpLoaded = false; 
                        }
                    }
                }
            },
            width: 1280, height: 720
        });
    }

    if (!STATE.mpWarmed && STATE.faceDetector) {
        try {
            await STATE.faceDetector.send({ image: DOM.video });
            STATE.mpWarmed = true;
        } catch (e) {
            console.warn("Warmup send failed", e);
        }
    }

    setSkinLoop(true); 

    // ✅ FALLBACK SYSTEM (Trigger Server Mode Immediately if configured)
    if (STATE.aiMode === 'server') {
        updateStatus("Optimizing scan for your device…");
        startServerFaceScan();
        return;
    }

    setTimeout(() => {
        if (STATE.mode === 'skin' && STATE.phase === 'ALIGNING' && !STATE.mpLoaded) {
            if (STATE.modelRetries < 2) {
                STATE.modelRetries++;
                updateStatus("Initializing model… retrying");
                STATE.mpLoaded = false;
                setSkinLoop(false);
                setTimeout(() => { if (STATE.mode === 'skin') initSkinPipeline(); }, 1200);
            } else {
                // SWITCH TO SERVER MODE
                STATE.aiMode = 'server';
                updateStatus("Optimizing scan for your device…");
                startServerFaceScan();
            }
        }
    }, 8000); 
}

// ✅ NEW: Server-Side Loop
function startServerFaceScan() {
    if (STATE.mpCameraLoop) STATE.mpCameraLoop.stop(); // Kill browser loop
    
    const serverLoop = async () => {
        if (STATE.mode !== 'skin' || STATE.aiMode !== 'server') return;
        if (STATE.phase !== 'ALIGNING') return;

        // Capture current frame
        DOM.canvas.width = DOM.video.videoWidth;
        DOM.canvas.height = DOM.video.videoHeight;
        ctx.drawImage(DOM.video, 0, 0);
        
        // Use lower quality for speed
        const imageBase64 = DOM.canvas.toDataURL("image/jpeg", 0.5);

        try {
            const res = await fetch(CONFIG.skin.detectEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: imageBase64 })
            });
            
            if (res.ok) {
                const data = await res.json();
                if (data.found) {
                    // Convert Server Box to MediaPipe Format
                    const mpResult = {
                        detections: [{
                            boundingBox: data.box, // {width, height, xCenter, yCenter}
                            relativeBoundingBox: data.box // Assuming normalized
                        }]
                    };
                    handleFaceResults(mpResult);
                } else {
                    handleFaceResults({ detections: [] });
                }
            } else {
                // If backend 404/500, fallback to Blind Capture
                performBlindCapture();
                return; 
            }
        } catch (e) {
            performBlindCapture();
            return;
        }

        setTimeout(serverLoop, CONFIG.skin.serverInterval);
    };
    
    serverLoop();
}

// ✅ NEW: Blind Capture Fallback (If server detect fails)
function performBlindCapture() {
    updateStatus("Hold still for scan...");
    setTimeout(() => {
        if (STATE.phase === 'ALIGNING') performSkinBatchCapture();
    }, 2000);
}

// Face Stability Logic
function isStable(box) {
    STATE.stabilityBuffer.push(box);
    if (STATE.stabilityBuffer.length < 5) return false;
    STATE.stabilityBuffer.shift();

    return STATE.stabilityBuffer.every(b =>
        Math.abs(b.xCenter - box.xCenter) < CONFIG.skin.stabilityThreshold &&
        Math.abs(b.yCenter - box.yCenter) < CONFIG.skin.stabilityThreshold
    );
}

function handleFaceResults(results) {
    if (STATE.mode !== 'skin') return;
    if (STATE.phase !== 'ALIGNING') return; 

    if (!results.detections || !results.detections.length) {
        updateStatus("No face detected");
        DOM.skinGuide.style.borderColor = "rgba(255,255,255,0.3)";
        return;
    }

    DOM.skinGuide.style.borderColor = "rgba(16,185,129,0.8)";
    
    // Support both MediaPipe (rect) and Custom Server (box) structures
    const det = results.detections[0];
    const box = det.boundingBox || det.relativeBoundingBox; // Handle var formats
    
    const vW = DOM.video.videoWidth;
    const vH = DOM.video.videoHeight;
    
    if (!vW || !vH) return; 

    // Normalized dimensions if coming from server/MP
    const w = box.width; 
    const h = box.height; 
    
    // Calculate area coverage (approximate)
    const faceArea = (w * vW) * (h * vH);
    const frameArea = vW * vH;
    const ratio = faceArea / frameArea;

    if (ratio < CONFIG.skin.minFaceRatio) updateStatus("Move Closer");
    else if (ratio > CONFIG.skin.maxFaceRatio) updateStatus("Too Close");
    else if (det.relativeBoundingBox && !isStable(det.relativeBoundingBox)) { 
        // Only run stability check if we have relative box data
        updateStatus("Hold Steady...");
    } 
    else {
        if (typeof performSkinBatchCapture === "function") {
            performSkinBatchCapture();
        }
    }
}

async function performSkinBatchCapture() {
    if (STATE.phase !== 'ALIGNING') return; 
    
    setSkinLoop(false); 
    STATE.phase = 'CAPTURING';
    
    DOM.skinGuide.classList.add('locked');
    updateStatus("Hold Still...");
    DOM.statusText.classList.add('text-green-400');

    let frameBuffer = [];

    for (let i = 0; i < CONFIG.skin.batchSize; i++) {
        DOM.canvas.width = DOM.video.videoWidth;
        DOM.canvas.height = DOM.video.videoHeight;
        ctx.drawImage(DOM.video, 0, 0);
        
        const blob = await new Promise(r => DOM.canvas.toBlob(r, 'image/jpeg', 0.85));
        frameBuffer.push(blob);
        
        const progress = ((i + 1) / CONFIG.skin.batchSize) * 100;
        DOM.skinProgress.style.width = `${progress}%`;
        
        await new Promise(r => setTimeout(r, CONFIG.skin.captureInterval));
    }

    sendSkinData(frameBuffer);
}

async function sendSkinData(blobs) {
    STATE.phase = 'PROCESSING';
    updateStatus("Processing Profile...");
    const formData = new FormData();
    blobs.forEach((blob, i) => formData.append('files', blob, `frame_${i}.jpg`));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.skin.uploadTimeout);

    try {
        const res = await fetch(CONFIG.skin.apiEndpoint, {
            method: 'POST',
            body: formData,
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        const data = await res.json();

        if (data.status === 'success') {
            finalizeSkinScan(data);
        } else {
            handleSkinError(data.message);
        }
    } catch (err) {
        clearTimeout(timeoutId);
        console.error(err);
        handleSkinError("Network Error");
    }
}

function handleSkinError(msg) {
    STATE.phase = 'ERROR'; 
    updateStatus(msg);
    DOM.statusText.classList.remove('text-green-400');
    
    DOM.skinGuide.classList.remove('locked');
    DOM.skinProgress.style.width = '0%';
    DOM.skinGuide.style.borderColor = "rgba(255,255,255,0.3)";

    setTimeout(() => { 
        if (STATE.mode === 'skin') {
            STATE.phase = 'ALIGNING';
            STATE.stabilityBuffer.length = 0; 
            setSkinLoop(true); 
        }
    }, 2000);
}

function finalizeSkinScan(data) {
    STATE.phase = 'RESULT';
    DOM.statusText.classList.remove('text-green-400');
    DOM.video.classList.add('video-dim');
    DOM.resTitle.innerText = data.tone;
    DOM.skinGuide.style.opacity = "0.4";

    const isSafe = data.lock_safe;
    const safeBadge = isSafe 
        ? '<span class="text-green-400 text-xs font-bold uppercase border border-green-500/50 px-2 py-0.5 rounded">Verified</span>'
        : '<span class="text-yellow-500 text-xs font-bold uppercase border border-yellow-500/50 px-2 py-0.5 rounded">Low Conf</span>';

    DOM.resMetrics.innerHTML = `
        <div class="bg-white/5 p-3 rounded-xl"><span class="text-neutral-400 text-[10px] uppercase block">Undertone</span><span class="font-bold capitalize">${data.undertone}</span></div>
        <div class="bg-white/5 p-3 rounded-xl"><span class="text-neutral-400 text-[10px] uppercase block">Face Shape</span><span class="font-bold capitalize">${data.face_shape}</span></div>
        <div class="col-span-2 bg-white/5 p-3 rounded-xl flex justify-between items-center">
            <span class="text-neutral-400 text-[10px] uppercase">Lock Safe</span>
            ${safeBadge}
        </div>
    `;
    
    DOM.resultCard.style.transform = "translateY(0)";
    updateStatus("Profile Locked");
}

function updateStatus(text) {
    DOM.statusText.innerText = text;
}