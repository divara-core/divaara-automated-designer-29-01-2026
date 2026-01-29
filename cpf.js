const video = document.getElementById("video");
const canvas = document.getElementById("overlay");
const ctx = canvas.getContext("2d");

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "user",
      width: { ideal: 720 },
      height: { ideal: 960 }
    },
    audio: false
  });

  video.srcObject = stream;

  video.onloadedmetadata = () => {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    drawTestGuide(); // remove later
  };
}

function drawTestGuide() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "rgba(255,215,0,0.6)";
  ctx.lineWidth = 2;

  // Center line
  ctx.beginPath();
  ctx.moveTo(canvas.width / 2, 0);
  ctx.lineTo(canvas.width / 2, canvas.height);
  ctx.stroke();

  // Waist guide
  ctx.beginPath();
  ctx.moveTo(0, canvas.height * 0.55);
  ctx.lineTo(canvas.width, canvas.height * 0.55);
  ctx.stroke();
}

startCamera();

/*
DAY 1 LOCK:
Tailwind camera + canvas stable.
DO NOT redesign.
*/
