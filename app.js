const $ = s => document.querySelector(s);
const fileInput = $("#fileInput"), video = $("#video"), uploadCard = $("#uploadCard");
const timeline = $("#timeline"), videoStage = $("#videoStage"), poseCanvas = $("#poseCanvas");
const poseCtx = poseCanvas.getContext("2d");
let frames = 0, duration = 0, mediaRecorder = null, recordedChunks = [], stream = null;
let attempts = [], markers = { toe: null, land: null }, dragJoint = null;
let manualPoseByFrame = {}, trackedPoseByFrame = {}, manualOffsets = {};
let pose, poseBusy = false, posePendingFrame = null, poseLoopId = 0, lastRequestedFrame = -1;

const today = new Date().toISOString().slice(0, 10);
$("#date").value = today; $("#reportDate").textContent = today; $("#reportDate2").textContent = today;
$("#safetyCheck").addEventListener("change", e => {
  const ok = e.target.checked; $("#startBtn").disabled = !ok;
  $("#startBtn").textContent = ok ? "了解，開始跳躍檢測" : "請先勾選總確認";
});
$("#startBtn").addEventListener("click", () => $("#safetyModal").style.display = "none");
$("#helpBtn").addEventListener("click", () => $("#safetyModal").style.display = "grid");
$("#importBtn").onclick = () => fileInput.click();
uploadCard.onclick = () => fileInput.click();
fileInput.addEventListener("change", e => { const f = e.target.files[0]; if (f) loadVideo(f, f.name); });

function loadVideo(file, name) {
  $("#fileName").textContent = name; $("#hint").textContent = "影片已載入，正在啟用 AI 姿態追蹤…";
  video.src = URL.createObjectURL(file); video.style.display = "block"; uploadCard.style.display = "none";
  trackedPoseByFrame = {}; manualPoseByFrame = {}; manualOffsets = {}; lastRequestedFrame = -1;
  video.onloadedmetadata = async () => {
    duration = video.duration; frames = Math.max(1, Math.round(duration * Number($("#fps").value)));
    timeline.max = frames; $("#frameTotal").textContent = frames; enableControls(true);
    videoStage.classList.add("pose-active"); resizePoseCanvas(); drawPoseOverlay();
    await initPose(); startPoseLoop();
  };
}
function enableControls(on) {
  document.querySelectorAll("button[disabled],input[type=range][disabled]").forEach(el => { if (el.id !== "saveBtn") el.disabled = !on; });
  $("#saveBtn").disabled = !on;
}
function currentFrame() { return Math.max(0, Math.min(frames, Math.round((video.currentTime || 0) * Number($("#fps").value)))); }
function setTime(t) {
  if (!duration) return; video.currentTime = Math.max(0, Math.min(duration, t));
  const f = currentFrame(); timeline.value = f; $("#frameNow").textContent = f; $("#currentTime").textContent = fmt(video.currentTime);
  requestPoseForCurrentFrame(); drawPoseOverlay();
}
function fmt(s) { return `00:${Math.floor(s / 60).toString().padStart(2, "0")}.${Math.floor((s % 60) * 1000).toString().padStart(3, "0")}`; }
timeline.addEventListener("input", () => setTime(Number(timeline.value) / frames * duration));
$("#playBtn").onclick = () => video.paused ? video.play() : video.pause();
video.addEventListener("timeupdate", () => {
  if (!duration) return; timeline.value = currentFrame(); $("#frameNow").textContent = timeline.value;
  $("#currentTime").textContent = fmt(video.currentTime); requestPoseForCurrentFrame(); drawPoseOverlay();
});
video.addEventListener("seeked", () => { requestPoseForCurrentFrame(true); drawPoseOverlay(); });

async function initPose() {
  if (pose || !window.Pose) {
    if (!window.Pose) $("#hint").textContent = "AI 模組未載入，目前使用手動定位模式";
    return;
  }
  try {
    pose = new window.Pose({ locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}` });
    pose.setOptions({ modelComplexity: 1, smoothLandmarks: true, enableSegmentation: false,
      minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
    pose.onResults(results => {
      poseBusy = false;
      if (!results.poseLandmarks || posePendingFrame === null) return;
      const mapped = mapLandmarks(results.poseLandmarks);
      if (mapped) {
        trackedPoseByFrame[posePendingFrame] = mapped;
        $("#hint").textContent = `AI 已追蹤第 ${posePendingFrame} 幀，可拖曳骨骼點校正`;
        drawPoseOverlay();
      }
    });
    $("#hint").textContent = "AI 姿態偵測已啟用，正在分析目前影格";
    requestPoseForCurrentFrame(true);
  } catch (err) {
    pose = null; $("#hint").textContent = "AI 姿態偵測啟用失敗，目前使用手動定位模式";
    console.warn("MediaPipe Pose init failed", err);
  }
}
function startPoseLoop() {
  cancelAnimationFrame(poseLoopId);
  const tick = () => { requestPoseForCurrentFrame(); if (!video.paused) drawPoseOverlay(); poseLoopId = requestAnimationFrame(tick); };
  poseLoopId = requestAnimationFrame(tick);
}
function requestPoseForCurrentFrame(force = false) {
  if (!pose || poseBusy || video.readyState < 2 || !duration) return;
  const frame = currentFrame(); if (!force && frame === lastRequestedFrame) return;
  lastRequestedFrame = frame; poseBusy = true; posePendingFrame = frame;
  pose.send({ image: video }).catch(err => { poseBusy = false; console.warn("Pose frame failed", err); });
}

function resizePoseCanvas() {
  const r = videoStage.getBoundingClientRect(), d = devicePixelRatio || 1;
  poseCanvas.width = Math.max(1, r.width * d); poseCanvas.height = Math.max(1, r.height * d); poseCtx.setTransform(d, 0, 0, d, 0, 0);
}
window.addEventListener("resize", () => { resizePoseCanvas(); drawPoseOverlay(); });
function stageVideoRect() {
  const sr = videoStage.getBoundingClientRect(), vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  const scale = Math.min(sr.width / vw, sr.height / vh), width = vw * scale, height = vh * scale;
  return { left: (sr.width - width) / 2, top: (sr.height - height) / 2, width, height };
}
function mapLandmarks(landmarks) {
  const vr = stageVideoRect(), xy = i => {
    const p = landmarks[i]; return p ? [vr.left + p.x * vr.width, vr.top + p.y * vr.height] : null;
  };
  const avg = (...ids) => { const ps = ids.map(xy).filter(Boolean); return ps.length ? [ps.reduce((a, p) => a + p[0], 0) / ps.length, ps.reduce((a, p) => a + p[1], 0) / ps.length] : null; };
  const shoulder = avg(11, 12), hip = avg(23, 24); if (!shoulder || !hip) return null;
  const neck = [shoulder[0], shoulder[1] - Math.max(8, Math.abs(shoulder[1] - hip[1]) * 0.12)];
  return { head: xy(0) || neck, neck, shoulder, elbow: avg(13, 14) || shoulder, wrist: avg(15, 16) || shoulder,
    hip, knee: avg(25, 26) || hip, ankle: avg(27, 28) || hip, toe: avg(31, 32) || avg(29, 30) || hip };
}
function defaultPose() {
  const r = videoStage.getBoundingClientRect(), w = r.width, h = r.height, scale = Math.min(w, h) / 370, cx = w * .52, base = h * .72, f = currentFrame();
  const airborne = markers.toe !== null && markers.land !== null && f >= markers.toe && f <= markers.land;
  const progress = airborne ? (f - markers.toe) / Math.max(1, markers.land - markers.toe) : 0, lift = airborne ? Math.sin(Math.min(1, Math.max(0, progress)) * Math.PI) : 0, dy = lift * 62 * scale;
  return { head: [cx, base - 225 * scale - dy], neck: [cx, base - 190 * scale - dy], shoulder: [cx - 18 * scale, base - 185 * scale - dy],
    elbow: [cx - 38 * scale, base - 145 * scale - dy], wrist: [cx - 30 * scale, base - 105 * scale - dy], hip: [cx - 4 * scale, base - 118 * scale - dy],
    knee: [cx - 32 * scale, base - 65 * scale - dy], ankle: [cx - 38 * scale, base - dy], toe: [cx - 60 * scale, base - dy] };
}
function renderedPose(frame = currentFrame()) {
  const hasTracked = Boolean(trackedPoseByFrame[frame]);
  const p = Object.assign({}, defaultPose(), trackedPoseByFrame[frame] || (!hasTracked ? manualPoseByFrame[frame] : {}) || {});
  Object.entries(manualOffsets).forEach(([name, offset]) => {
    const base = trackedPoseByFrame[frame]?.[name] || p[name]; if (base) p[name] = [base[0] + offset[0], base[1] + offset[1]];
  });
  return p;
}
function drawPoseOverlay() {
  if (!duration || !videoStage.classList.contains("pose-active")) return;
  const r = videoStage.getBoundingClientRect(), w = r.width, h = r.height; poseCtx.clearRect(0, 0, w, h);
  const p = renderedPose(); poseCtx.lineWidth = 3; poseCtx.lineCap = "round"; poseCtx.strokeStyle = "#66f2c3"; poseCtx.fillStyle = "#d8ff59";
  [["neck", "shoulder"], ["shoulder", "elbow"], ["elbow", "wrist"], ["neck", "hip"], ["hip", "knee"], ["knee", "ankle"], ["ankle", "toe"]].forEach(([a, b]) => {
    if (!p[a] || !p[b]) return; poseCtx.beginPath(); poseCtx.moveTo(...p[a]); poseCtx.lineTo(...p[b]); poseCtx.stroke();
  });
  Object.entries(p).forEach(([name, point]) => { if (!point) return; poseCtx.beginPath(); poseCtx.arc(point[0], point[1], name === dragJoint ? 8 : 5, 0, Math.PI * 2); poseCtx.fill(); poseCtx.strokeStyle = "#173b2d"; poseCtx.stroke(); });
  poseCtx.strokeStyle = "#ffd747"; poseCtx.lineWidth = 2; poseCtx.beginPath(); poseCtx.moveTo(w * .08, h * .72 + 2); poseCtx.lineTo(w * .92, h * .72 + 2); poseCtx.stroke();
  $("#flightOverlay").querySelector("b").textContent = markers.toe !== null && markers.land !== null ? `${((markers.land - markers.toe) / Number($("#fps").value)).toFixed(2)} s` : "— s";
  $("#takeoffOverlay").style.left = `${Math.max(8, Math.min(78, ((markers.toe ?? Math.round(frames * .38)) / Math.max(1, frames)) * 100))}%`;
  $("#landOverlay").style.left = `${Math.max(18, Math.min(82, ((markers.land ?? Math.round(frames * .62)) / Math.max(1, frames)) * 100))}%`;
}
function stagePoint(e) { const r = videoStage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
function beginDrag(e) {
  if (!duration || dragJoint) return; e.preventDefault();
  const [x, y] = stagePoint(e), poseNow = renderedPose(), nearest = Object.entries(poseNow).sort((a, b) => Math.hypot(a[1][0] - x, a[1][1] - y) - Math.hypot(b[1][0] - x, b[1][1] - y))[0];
  if (!nearest) return; dragJoint = nearest[0];
  $("#hint").textContent = `已選取 ${dragJoint} 點，拖曳以校正；放開後會跟著人物移動`;
  e.currentTarget.setPointerCapture?.(e.pointerId); drawPoseOverlay();
}
function moveDrag(e) {
  if (!dragJoint || !duration) return; e.preventDefault();
  const [x, y] = stagePoint(e), f = currentFrame(), detected = trackedPoseByFrame[f]?.[dragJoint] || renderedPose(f)[dragJoint]; if (!detected) return;
  manualOffsets[dragJoint] = [x - detected[0], y - detected[1]];
  if (!trackedPoseByFrame[f]) { manualPoseByFrame[f] ??= {}; manualPoseByFrame[f][dragJoint] = [x, y]; }
  $("#hint").textContent = `已校正 ${dragJoint} 點；後續影格會套用追蹤校正`; drawPoseOverlay();
}
function endDrag(e) { if (!dragJoint) return; dragJoint = null; e.currentTarget.releasePointerCapture?.(e.pointerId); drawPoseOverlay(); }
poseCanvas.addEventListener("pointerdown", beginDrag); poseCanvas.addEventListener("pointermove", moveDrag); poseCanvas.addEventListener("pointerup", endDrag);
videoStage.addEventListener("pointerdown", beginDrag); videoStage.addEventListener("pointermove", moveDrag); videoStage.addEventListener("pointerup", endDrag);

$("#stepBack").onclick = () => setTime(video.currentTime - 1 / Number($("#fps").value)); $("#stepNext").onclick = () => setTime(video.currentTime + 1 / Number($("#fps").value));
$("#stepBack10").onclick = () => setTime(video.currentTime - 10 / Number($("#fps").value)); $("#stepNext10").onclick = () => setTime(video.currentTime + 10 / Number($("#fps").value));
function setResult(flight, height) {
  ["#flightMetric", "#flightResult", "#reportFlight"].forEach(s => $(s).textContent = `${flight.toFixed(2)} s`);
  ["#heightMetric", "#heightResult", "#reportHeight"].forEach(s => $(s).textContent = `${height} cm`);
  $("#hint").textContent = "AI 已完成初步標記，請逐格複核 T／L"; document.querySelectorAll(".report-card button").forEach(b => b.disabled = false);
}
$("#jumpAI").onclick = () => { const f = markers.toe !== null && markers.land !== null ? (markers.land - markers.toe) / Number($("#fps").value) : 0.52; setResult(f, +(9.81 * Math.pow(f, 2) / 8 * 100).toFixed(1)); };
$("#aiBtn").onclick = () => $("#jumpAI").click();
function mark(type) { if (!duration) return; markers[type] = currentFrame(); $("#hint").textContent = `已標記 ${type === "toe" ? "T 腳尖離地" : "L 首次落地"}：Frame ${markers[type]}`; document.querySelector(type === "toe" ? "#toeBtn" : "#landBtn").classList.add("active"); }
$("#markToe").onclick = () => mark("toe"); $("#toeBtn").onclick = () => $("#markToe").click(); $("#markLand").onclick = () => mark("land"); $("#landBtn").onclick = () => $("#markLand").click();
$("#toggleSkeleton").onclick = () => { const active = $("#toggleSkeleton").classList.toggle("active"); $("#skeletonBtn").classList.toggle("active", active); $("#toggleSkeleton").innerHTML = active ? "✣<small>骨 外骨骼 關</small>" : "✣<small>骨 外骨骼 開</small>"; $("#hint").textContent = active ? "已開啟外骨骼疊圖模式" : "已關閉外骨骼疊圖模式"; };
$("#skeletonBtn").onclick = () => $("#toggleSkeleton").click();
$("#recordBtn").onclick = async () => {
  if (mediaRecorder?.state === "recording") { mediaRecorder.stop(); $("#recordBtn").innerHTML = "◉<small>錄影</small>"; return; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false }); mediaRecorder = new MediaRecorder(stream); recordedChunks = [];
    mediaRecorder.ondataavailable = e => e.data.size && recordedChunks.push(e.data);
    mediaRecorder.onstop = () => { const blob = new Blob(recordedChunks, { type: "video/webm" }); stream.getTracks().forEach(t => t.stop()); loadVideo(blob, `手機錄影-${new Date().toLocaleTimeString("zh-TW", { hour12: false })}.webm`); };
    mediaRecorder.start(); $("#recordBtn").innerHTML = "■<small>停止錄影</small>"; $("#hint").textContent = "正在錄影，再按一次停止";
  } catch { alert("無法使用相機，請確認瀏覽器已允許相機權限。"); }
};
$("#saveBtn").onclick = () => { if (attempts.length >= 3) return; const flight = parseFloat($("#flightResult").textContent) || 0, height = parseFloat($("#heightResult").textContent) || 0; attempts.push({ flight, height }); $("#saveBtn").textContent = `已儲存 ${attempts.length}/3 次試跳`; renderTrend(); if (attempts.length >= 3) $("#saveBtn").disabled = true; };
function renderTrend() { const box = document.querySelector(".trend-placeholder"); box.innerHTML = attempts.length ? attempts.map((a, i) => `<span class="trend-pill">第 ${i + 1} 次　${a.height.toFixed(1)} cm / ${a.flight.toFixed(2)} s${a.height === Math.max(...attempts.map(x => x.height)) ? " ★" : ""}</span>`).join("") : "尚未有試跳資料"; }
$("#reportFps").textContent = $("#fps").value; $(".report-card button:first-child").onclick = () => window.print();
$(".report-card button:last-child").onclick = async () => { if (navigator.share) { try { await navigator.share({ title: "JumpLab 跳躍分析報告", text: `Flight Time ${$("#flightResult").textContent}，Jump Height ${$("#heightResult").textContent}` }); } catch {} } else alert("此瀏覽器不支援原生分享，請使用複製結果。"); };
$("#copyBtn").onclick = async () => { const text = `JumpLab 分析結果｜Flight Time：${$("#flightResult").textContent}｜Jump Height：${$("#heightResult").textContent}`; try { await navigator.clipboard.writeText(text); $("#copyBtn").textContent = "✓ 已複製結果"; } catch { $("#copyBtn").textContent = "請手動複製結果"; } };
$("#fps").addEventListener("change", () => { $("#reportFps").textContent = $("#fps").value; lastRequestedFrame = -1; requestPoseForCurrentFrame(true); drawPoseOverlay(); });
$("#date").addEventListener("change", e => { $("#reportDate").textContent = e.target.value; $("#reportDate2").textContent = e.target.value; });
