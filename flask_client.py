from flask import Flask, Response, request
import threading, cv2, numpy as np, time, base64

app = Flask(__name__)
latest = None
lock = threading.Lock()

#동기로 받자
last_seq = -1
#느리게 온 프레임은 반영하지않음
@app.route('/upload', methods=['POST'])
def upload():
    global latest, last_seq
    seq_hdr = request.headers.get('X-Seq')
    try:
        seq = int(seq_hdr) if seq_hdr is not None else None
    except Exception:
        seq = None

    b64 = request.data.decode('utf-8')
    try:
        jpg_bytes = base64.b64decode(b64, validate=True)
    except Exception as e:
        return f"BAD BASE64: {e}", 400

    arr = np.frombuffer(jpg_bytes, dtype=np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if frame is None:
        return "BAD JPG", 400

    with lock:
        # 시퀀스가 있고, 이전보다 작거나 같으면 드롭
        if seq is not None and last_seq is not None and seq <= last_seq:
            # print(f"drop old seq={seq} (last={last_seq})")
            return "OLD", 200

        latest = frame
        if seq is not None:
            last_seq = seq

    # print(f"ok seq={seq} shape={frame.shape}")
    return "OK", 200

def mjpeg_generator():
    global latest
    boundary = b'--frame\r\n'
    while True:
        with lock:
            frame = None if latest is None else latest.copy()
        if frame is None:
            frame = np.zeros((360,640,3), np.uint8)
            cv2.putText(frame, "waiting for upload...", (20,200),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255,255,255), 2)
        ok, jpg = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
        if ok:
            yield boundary + b'Content-Type: image/jpeg\r\n\r\n' + jpg.tobytes() + b'\r\n'
        time.sleep(0.05)

@app.route('/mjpeg')
def mjpeg():
    return Response(mjpeg_generator(),
                    mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/')
def index():
    return '<a href="/mjpeg">Open MJPEG stream</a>'

@app.route('/health')
def health():
    return "OK", 200

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=9999, threaded=True)
