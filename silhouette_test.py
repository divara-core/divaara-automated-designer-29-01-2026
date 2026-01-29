# ================== IMPORTS ==================
import cv2, time, base64, threading, statistics
import mediapipe as mp
import numpy as np
from collections import deque
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# ================== APP ==================
app = FastAPI(title="DIVAARA Scanner")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ================== STATE ==================
final_output = silhouette_image = latest_frame = None
scanner_status, frozen = "scanning", False

# ================== MODELS ==================
pose = mp.solutions.pose.Pose(min_detection_confidence=0.6, min_tracking_confidence=0.6)
segmenter = mp.solutions.selfie_segmentation.SelfieSegmentation(model_selection=1)

# ================== HELPERS ==================
avg = lambda b: sum(b)/len(b) if b else 0
stable = lambda p,c,t=8: p is None or abs(p-c) < t

def confidence(bufs):
    d = sum(statistics.pstdev(b) for b in bufs if len(b) > 5)
    return max(0, min(100, 100-int(d))) if d else 0

def sil_width(mask, y):
    xs = np.where(mask[min(max(y,0),mask.shape[0]-1)] > 0.5)[0]
    return xs[-1]-xs[0] if len(xs) > 20 else None

def shape(sr, wr):
    if sr > 1.25 and wr > 0.9: return "Inverted Triangle"
    if sr < 0.9 and wr > 0.9: return "Pear"
    if abs(sr-1) < .12 and wr < .85: return "Hourglass"
    if abs(sr-1) < .1 and wr > .9: return "Rectangle"
    return "Balanced"

fit = lambda sr,wr: {
    "top_fit": "relaxed" if sr > 1.1 else "regular",
    "waist_fit": "defined" if wr < .85 else "straight",
    "bottom_fit": "flowy" if wr < .9 else "structured"
}

# ================== BUFFERS ==================
BUF, LOCK = 15, 25
S, H, W = (deque(maxlen=BUF) for _ in range(3))
prev_y = stable_frames = start = None

# ================== CAMERA ==================
def camera_loop():
    global final_output, silhouette_image, latest_frame
    global scanner_status, frozen, prev_y, stable_frames, start

    cap = cv2.VideoCapture(0)
    while cap.isOpened():
        ok, frame = cap.read()
        if not ok: break

        frame = cv2.flip(frame,1)
        h, w = frame.shape[:2]
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        latest_frame = base64.b64encode(cv2.imencode(".jpg",frame)[1]).decode()

        mask = segmenter.process(rgb).segmentation_mask
        sil = np.zeros_like(frame); sil[mask > .5] = 255
        res, dbg = pose.process(rgb), frame.copy()

        if res.pose_landmarks and not frozen:
            if start is None: start = time.time()
            lm = res.pose_landmarks.landmark

            sy = int((lm[11].y+lm[12].y)/2*h)
            hy = int((lm[23].y+lm[24].y)/2*h)
            wy = int(hy - .15*(hy-sy))
            cy = (sy+hy)//2

            if stable(prev_y, cy):
                stable_frames += 1
                vals = [sil_width(mask,y) for y in (sy,hy,wy)]
                if all(vals): S.append(vals[0]); H.append(vals[1]); W.append(vals[2])
            else: stable_frames = 0
            prev_y = cy

            for y,c in [(sy,(0,255,0)),(wy,(255,255,0)),(hy,(255,0,0))]:
                cv2.line(dbg,(0,y),(w,y),c,1)

            if len(S) > 5:
                sr, wr = avg(S)/avg(H), avg(W)/avg(H)
                cv2.putText(dbg,f"SR:{sr:.2f} WR:{wr:.2f}",(20,90),
                            cv2.FONT_HERSHEY_SIMPLEX,.8,(0,255,255),2)
                cv2.putText(dbg,shape(sr,wr),(20,130),
                            cv2.FONT_HERSHEY_SIMPLEX,.9,(0,255,0),2)

            if stable_frames >= LOCK and len(S) == BUF:
                frozen, scanner_status = True, "tryon_ready"
                sr, wr = avg(S)/avg(H), avg(W)/avg(H)
                silhouette_image = base64.b64encode(cv2.imencode(".png",sil)[1]).decode()
                final_output = {
                    "status":"locked",
                    "scan_time_sec":round(time.time()-start,2),
                    "confidence":confidence([S,H,W]),
                    "ratios":{"shoulder_hip":round(sr,3),"waist_hip":round(wr,3)},
                    "body_shape":shape(sr,wr),
                    "fit_profile":fit(sr,wr),
                    "tryon_ready":True
                }

        cv2.putText(dbg,f"STATUS:{scanner_status}",(20,40),
                    cv2.FONT_HERSHEY_SIMPLEX,1,(0,0,255) if frozen else (0,255,0),3)

        cv2.imshow("CAMERA",dbg); cv2.imshow("SILHOUETTE",sil)
        if cv2.waitKey(1)&0xFF==ord("q"): break

    cap.release(); cv2.destroyAllWindows()

# ================== API ==================
@app.get("/profile")
def profile(): return final_output or {"status":scanner_status}

@app.get("/frame")
def frame(): return {"image":latest_frame} if latest_frame else {"status":"no_frame"}

@app.get("/silhouette")
def sil(): return {"image":silhouette_image} if silhouette_image else {"status":"not_ready"}

# ================== START ==================
if __name__ == "__main__":
    threading.Thread(target=camera_loop, daemon=True).start()
    import uvicorn; uvicorn.run(app, host="127.0.0.1", port=8000)
