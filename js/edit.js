/**
 * BERIBUG Video Editor Logic
 * Handles video processing, drawing, cutting, and log synchronization.
 */

document.addEventListener("DOMContentLoaded", () => {
  // Elements
  const sourceVideo = document.getElementById("sourceVideo");
  const canvas = document.getElementById("editorCanvas");
  const ctx = canvas.getContext("2d");
  const interactionLayer = document.getElementById("interactionLayer");
  const playhead = document.getElementById("playhead");
  const timelineTrack = document.getElementById("timelineTrack");
  const btnPlayPause = document.getElementById("btnPlayPause");
  const btnBack5 = document.getElementById("btnBack5");
  const btnFwd5 = document.getElementById("btnFwd5");
  const currentTimeDisplay = document.getElementById("currentTime");
  const durationDisplay = document.getElementById("duration");
  const playbackSpeed = document.getElementById("playbackSpeed");
  const activeEditDurationInput = document.getElementById("activeEditDuration");
  const editListContainer = document.getElementById("editList");
  const renderOverlay = document.getElementById("renderOverlay");
  const renderProgress = document.getElementById("renderProgress");
  const renderStatus = document.getElementById("renderStatus");

  // State
  let sessionLogs = {
    console: [],
    network: [],
    actions: [],
    backend: [],
    info: {},
  };
  let originalVideoBlob = null;
  let activeTool = "select";
  let isPlaying = false;
  let animationId = null;
  let cuts = []; // Array of {start: 0, end: 10} for DELETED segments
  let annotations = []; // Array of {type, start, end, x, y, w, h, color, size}
  let cropRect = null; // {x, y, w, h}
  let magnifier = null; // {time, x, y, size}
  let currentCutStart = null;

  // Settings / selection / drag
  let defaultActiveEditDurationSec = 5;
  let nextEditId = 1;
  let selectedEditId = null;
  let isSeeking = false;
  let wasPlayingBeforeSeek = false;
  let draggingEditZone = null; // { id, baseStart, baseEnd, startClientX }

  // Interaction State
  let isDragging = false;
  let startX, startY;
  let currentAnnotation = null;

  // Select/transform state
  let isTransforming = false;
  let transformState = null; // { id, mode: 'move'|'resize', handle, startX, startY, orig }

  // --- INITIALIZATION ---
  async function init() {
    loadEditorSettings();

    // 1. Load Logs from SessionStorage
    const savedLogs = sessionStorage.getItem("editLogs");
    if (savedLogs) {
      sessionLogs = JSON.parse(savedLogs);
    }

    // 2. Try to get Video from IndexedDB first (most reliable)
    try {
      const dbBlob = await getVideoFromDB();
      if (dbBlob) {
        console.log("Loading video from IndexedDB");
        originalVideoBlob = dbBlob;
        loadVideoToPlayer(dbBlob);
        return;
      }
    } catch (e) {
      console.warn(
        "IndexedDB check failed, falling back to background message",
        e,
      );
    }

    // 3. Fallback: Get Video from Background
    chrome.runtime.sendMessage({ action: "GET_PENDING_VIDEO" }, (res) => {
      if (res && res.videoBase64) {
        try {
          const byteCharacters = atob(res.videoBase64);
          const byteNumbers = new Uint8Array(byteCharacters.length);
          for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
          }
          originalVideoBlob = new Blob([byteNumbers], { type: "video/webm" });
          loadVideoToPlayer(originalVideoBlob);
        } catch (e) {
          console.error("Video load failed", e);
          alert("Failed to load video for editing.");
        }
      } else {
        alert("No video found to edit.");
      }
    });
  }

  function loadVideoToPlayer(blob) {
    sourceVideo.src = URL.createObjectURL(blob);
    sourceVideo.onloadedmetadata = () => {
      const setupVideo = () => {
        canvas.width = sourceVideo.videoWidth;
        canvas.height = sourceVideo.videoHeight;
        durationDisplay.textContent = formatTime(sourceVideo.duration);
        sourceVideo.playbackRate = parseFloat(playbackSpeed.value || "1");
        renderEditsUI();
        requestAnimationFrame(renderLoop);
      };

      if (sourceVideo.duration === Infinity || isNaN(sourceVideo.duration)) {
        sourceVideo.currentTime = 1e6; // Safe large number to force Chrome to calculate duration (1 million seconds)
        sourceVideo.onseeked = () => {
          sourceVideo.onseeked = null;
          sourceVideo.currentTime = 0;
          setupVideo();
        };
      } else {
        setupVideo();
      }
    };
  }

  init();

  // --- RENDERING LOOP ---
  function renderLoop() {
    if (!sourceVideo.paused || !isPlaying) {
      drawFrame();
    }
    updateTimeline();
    animationId = requestAnimationFrame(renderLoop);
  }

  function drawFrame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 1. Draw Base Video
    if (cropRect) {
      ctx.drawImage(
        sourceVideo,
        cropRect.x,
        cropRect.y,
        cropRect.w,
        cropRect.h,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    } else {
      ctx.drawImage(sourceVideo, 0, 0, canvas.width, canvas.height);
    }

    const now = sourceVideo.currentTime;

    // 2. Draw Annotations & Blurs
    const allToDraw = [...annotations];
    if (currentAnnotation) allToDraw.push(currentAnnotation);

    allToDraw.forEach((ann) => {
      const isVisible =
        currentAnnotation === ann || (now >= ann.start && now <= ann.end);
      if (isVisible) {
        ctx.save();
        if (ann.type === "blur") {
          ctx.filter = `blur(${ann.amount}px)`;
          ctx.drawImage(
            canvas,
            ann.x,
            ann.y,
            ann.w,
            ann.h,
            ann.x,
            ann.y,
            ann.w,
            ann.h,
          );
        } else {
          ctx.strokeStyle = ann.color;
          ctx.lineWidth = ann.size;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";

          if (ann.type === "pen" && ann.points) {
            ctx.beginPath();
            ctx.moveTo(ann.points[0].x, ann.points[0].y);
            ann.points.forEach((p) => ctx.lineTo(p.x, p.y));
            ctx.stroke();
          } else if (ann.type === "draw-rect") {
            ctx.strokeRect(ann.x, ann.y, ann.w, ann.h);
          } else if (ann.type === "draw-circle") {
            ctx.beginPath();
            ctx.ellipse(
              ann.x + ann.w / 2,
              ann.y + ann.h / 2,
              Math.abs(ann.w / 2),
              Math.abs(ann.h / 2),
              0,
              0,
              Math.PI * 2,
            );
            ctx.stroke();
          }
        }
        ctx.restore();
      }
    });

    // 3. Draw Magnifier
    if (magnifier && now >= magnifier.start && now <= magnifier.end) {
      const zoom = 2;
      const size = 150;
      ctx.save();
      ctx.beginPath();
      ctx.arc(magnifier.x, magnifier.y, size / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(
        canvas,
        magnifier.x - size / (2 * zoom),
        magnifier.y - size / (2 * zoom),
        size / zoom,
        size / zoom,
        magnifier.x - size / 2,
        magnifier.y - size / 2,
        size,
        size,
      );
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }

    // 4. Draw selection overlay (Select tool only)
    drawSelectionOverlay(now);
  }

  function drawSelectionOverlay(now) {
    if (activeTool !== "select") return;
    if (!selectedEditId) return;

    const data = getEditDataById(selectedEditId);
    if (!data) return;

    const isTimed = data.start != null && data.end != null;
    if (isTimed && !(now >= data.start && now <= data.end)) return;

    ctx.save();
    ctx.strokeStyle = "rgba(232, 234, 237, 0.95)";
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);

    const handleSize = 10;

    if (data.points && Array.isArray(data.points) && data.points.length > 0) {
      const box = getPointsBoundingBox(data.points);
      if (!box) {
        ctx.restore();
        return;
      }
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      drawHandles(box, handleSize);
      ctx.restore();
      return;
    }

    if (data.x != null && data.y != null && data.w != null && data.h != null) {
      const box = normalizeRect({ x: data.x, y: data.y, w: data.w, h: data.h });
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      drawHandles(box, handleSize);
      ctx.restore();
      return;
    }

    if (data.x != null && data.y != null && data.w == null && data.h == null) {
      // point-based (magnifier)
      ctx.beginPath();
      ctx.arc(data.x, data.y, 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      return;
    }

    ctx.restore();
  }

  function drawHandles(box, size) {
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(232, 234, 237, 0.95)";
    const half = size / 2;
    const pts = [
      { k: "nw", x: box.x, y: box.y },
      { k: "ne", x: box.x + box.w, y: box.y },
      { k: "sw", x: box.x, y: box.y + box.h },
      { k: "se", x: box.x + box.w, y: box.y + box.h },
    ];
    pts.forEach((p) => ctx.fillRect(p.x - half, p.y - half, size, size));
  }

  function normalizeRect(r) {
    const x = Math.min(r.x, r.x + r.w);
    const y = Math.min(r.y, r.y + r.h);
    const w = Math.abs(r.w);
    const h = Math.abs(r.h);
    return { x, y, w, h };
  }

  function clampRectToCanvas(box) {
    const minSize = 2;
    let x = box.x;
    let y = box.y;
    let w = Math.max(minSize, box.w);
    let h = Math.max(minSize, box.h);

    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x + w > canvas.width) x = Math.max(0, canvas.width - w);
    if (y + h > canvas.height) y = Math.max(0, canvas.height - h);

    w = Math.min(w, canvas.width - x);
    h = Math.min(h, canvas.height - y);
    return { x, y, w, h };
  }

  function getPointsBoundingBox(points) {
    if (!points || points.length === 0) return null;
    let minX = points[0].x;
    let minY = points[0].y;
    let maxX = points[0].x;
    let maxY = points[0].y;
    for (const p of points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    return {
      x: minX,
      y: minY,
      w: Math.max(1, maxX - minX),
      h: Math.max(1, maxY - minY),
    };
  }

  function getCanvasPointFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  function hitTestHandle(box, p) {
    const size = 10;
    const half = size / 2;
    const handles = [
      { k: "nw", x: box.x, y: box.y },
      { k: "ne", x: box.x + box.w, y: box.y },
      { k: "sw", x: box.x, y: box.y + box.h },
      { k: "se", x: box.x + box.w, y: box.y + box.h },
    ];
    for (const h of handles) {
      if (
        p.x >= h.x - half &&
        p.x <= h.x + half &&
        p.y >= h.y - half &&
        p.y <= h.y + half
      ) {
        return h.k;
      }
    }
    return null;
  }

  function pointInBox(box, p) {
    return (
      p.x >= box.x &&
      p.x <= box.x + box.w &&
      p.y >= box.y &&
      p.y <= box.y + box.h
    );
  }

  function updateTimeline() {
    const dur = sourceVideo.duration;
    if (!dur || !isFinite(dur)) {
      playhead.style.left = "0%";
      currentTimeDisplay.textContent = formatTime(0);
      return;
    }

    const pct = Math.max(
      0,
      Math.min(100, (sourceVideo.currentTime / dur) * 100),
    );
    playhead.style.left = `${pct}%`;
    currentTimeDisplay.textContent = formatTime(sourceVideo.currentTime);
  }

  // --- INTERACTION LOGIC ---
  interactionLayer.addEventListener("mousedown", (e) => {
    if (activeTool === "select") {
      if (!selectedEditId) return;
      const data = getEditDataById(selectedEditId);
      if (!data) return;
      const now = sourceVideo.currentTime;
      const isTimed = data.start != null && data.end != null;
      if (isTimed && !(now >= data.start && now <= data.end)) return;

      const p = getCanvasPointFromEvent(e);

      // Pen (points): move only
      if (data.points && Array.isArray(data.points) && data.points.length > 0) {
        const box = getPointsBoundingBox(data.points);
        if (!box || !pointInBox(box, p)) return;
        isTransforming = true;
        transformState = {
          id: selectedEditId,
          mode: "move",
          handle: null,
          startX: p.x,
          startY: p.y,
          orig: { points: data.points.map((pt) => ({ ...pt })) },
        };
        return;
      }

      // Rect-like: move or resize
      if (
        data.x != null &&
        data.y != null &&
        data.w != null &&
        data.h != null
      ) {
        const box = normalizeRect({
          x: data.x,
          y: data.y,
          w: data.w,
          h: data.h,
        });
        const handle = hitTestHandle(box, p);
        if (handle || pointInBox(box, p)) {
          isTransforming = true;
          transformState = {
            id: selectedEditId,
            mode: handle ? "resize" : "move",
            handle,
            startX: p.x,
            startY: p.y,
            orig: { box },
          };
        }
        return;
      }

      // Point-like (magnifier): move
      if (
        data.x != null &&
        data.y != null &&
        data.w == null &&
        data.h == null
      ) {
        const dx = p.x - data.x;
        const dy = p.y - data.y;
        if (Math.sqrt(dx * dx + dy * dy) > 14) return;
        isTransforming = true;
        transformState = {
          id: selectedEditId,
          mode: "move",
          handle: null,
          startX: p.x,
          startY: p.y,
          orig: { x: data.x, y: data.y },
        };
        return;
      }

      return;
    }

    isDragging = true;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    startX = (e.clientX - rect.left) * scaleX;
    startY = (e.clientY - rect.top) * scaleY;

    if (activeTool === "zoom") {
      magnifier = ensureEditId(
        {
          start: sourceVideo.currentTime,
          end: sourceVideo.currentTime + defaultActiveEditDurationSec,
          x: startX,
          y: startY,
        },
        "mag",
      );
      selectEdit(magnifier._id);
      renderEditsUI();
      return;
    }

    currentAnnotation = {
      type: activeTool,
      start: sourceVideo.currentTime,
      end: sourceVideo.currentTime + defaultActiveEditDurationSec,
      x: startX,
      y: startY,
      w: 0,
      h: 0,
      points: activeTool === "pen" ? [{ x: startX, y: startY }] : null,
      color:
        document.querySelector(".color-swatch.active")?.dataset.color ||
        "#ff0000",
      size: parseInt(document.getElementById("propStrokeWidth").value),
      amount: parseInt(document.getElementById("propBlurAmount").value),
    };
    ensureEditId(currentAnnotation, "ann");
    selectEdit(currentAnnotation._id);
  });

  interactionLayer.addEventListener("mousemove", (e) => {
    if (isTransforming && transformState) {
      const data = getEditDataById(transformState.id);
      if (!data) return;
      const p = getCanvasPointFromEvent(e);
      const dx = p.x - transformState.startX;
      const dy = p.y - transformState.startY;

      if (data.points && transformState.orig?.points) {
        data.points = transformState.orig.points.map((pt) => ({
          x: pt.x + dx,
          y: pt.y + dy,
        }));
      } else if (
        data.x != null &&
        data.y != null &&
        data.w != null &&
        data.h != null
      ) {
        const origBox = transformState.orig.box;
        if (transformState.mode === "move") {
          let newBox = {
            x: origBox.x + dx,
            y: origBox.y + dy,
            w: origBox.w,
            h: origBox.h,
          };
          newBox = clampRectToCanvas(newBox);
          data.x = newBox.x;
          data.y = newBox.y;
          data.w = newBox.w;
          data.h = newBox.h;
        } else if (transformState.mode === "resize") {
          let newBox = { ...origBox };
          if (transformState.handle === "se") {
            newBox.w = origBox.w + dx;
            newBox.h = origBox.h + dy;
          } else if (transformState.handle === "sw") {
            newBox.x = origBox.x + dx;
            newBox.w = origBox.w - dx;
            newBox.h = origBox.h + dy;
          } else if (transformState.handle === "ne") {
            newBox.y = origBox.y + dy;
            newBox.w = origBox.w + dx;
            newBox.h = origBox.h - dy;
          } else if (transformState.handle === "nw") {
            newBox.x = origBox.x + dx;
            newBox.y = origBox.y + dy;
            newBox.w = origBox.w - dx;
            newBox.h = origBox.h - dy;
          }
          newBox = clampRectToCanvas(normalizeRect(newBox));
          data.x = newBox.x;
          data.y = newBox.y;
          data.w = newBox.w;
          data.h = newBox.h;
        }
      } else if (
        data.x != null &&
        data.y != null &&
        data.w == null &&
        data.h == null
      ) {
        // point-like
        const newX = Math.max(
          0,
          Math.min(canvas.width, transformState.orig.x + dx),
        );
        const newY = Math.max(
          0,
          Math.min(canvas.height, transformState.orig.y + dy),
        );
        data.x = newX;
        data.y = newY;
      }

      if (!isPlaying) drawFrame();
      return;
    }

    if (!isDragging || !currentAnnotation) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const curX = (e.clientX - rect.left) * scaleX;
    const curY = (e.clientY - rect.top) * scaleY;

    if (currentAnnotation.type === "pen") {
      currentAnnotation.points.push({ x: curX, y: curY });
    } else {
      currentAnnotation.w = curX - startX;
      currentAnnotation.h = curY - startY;
    }

    if (!isPlaying) drawFrame();
  });

  interactionLayer.addEventListener("mouseup", () => {
    if (isTransforming) {
      isTransforming = false;
      transformState = null;
      if (!isPlaying) drawFrame();
      return;
    }
    if (!isDragging) return;
    isDragging = false;

    if (activeTool === "crop") {
      cropRect = ensureEditId(
        {
          x: Math.min(startX, startX + currentAnnotation.w),
          y: Math.min(startY, startY + currentAnnotation.h),
          w: Math.abs(currentAnnotation.w),
          h: Math.abs(currentAnnotation.h),
        },
        "crop",
      );
      selectEdit(cropRect._id);
      renderEditsUI();
    } else if (currentAnnotation) {
      annotations.push(currentAnnotation);
      renderEditsUI();
    }
    currentAnnotation = null;
  });

  // --- UI HANDLERS ---
  document.querySelectorAll(".tool-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".tool-btn")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeTool = btn.dataset.tool;

      const isDrawing = activeTool.includes("draw") || activeTool === "pen";
      document.getElementById("propDraw").style.display = isDrawing
        ? "block"
        : "none";
      document.getElementById("propBlur").style.display =
        activeTool === "blur" ? "block" : "none";
    });
  });

  btnPlayPause.addEventListener("click", () => {
    if (sourceVideo.paused) {
      sourceVideo.play();
      btnPlayPause.textContent = "⏸";
      isPlaying = true;
    } else {
      sourceVideo.pause();
      btnPlayPause.textContent = "▶";
      isPlaying = false;
    }
  });

  btnBack5.addEventListener("click", () => {
    if (!sourceVideo.duration || !isFinite(sourceVideo.duration)) return;
    sourceVideo.currentTime = Math.max(0, sourceVideo.currentTime - 5);
  });

  btnFwd5.addEventListener("click", () => {
    if (!sourceVideo.duration || !isFinite(sourceVideo.duration)) return;
    sourceVideo.currentTime = Math.min(
      sourceVideo.duration,
      sourceVideo.currentTime + 5,
    );
  });

  playbackSpeed.addEventListener("change", () => {
    const rate = parseFloat(playbackSpeed.value || "1");
    sourceVideo.playbackRate = isFinite(rate) ? rate : 1;
  });

  // Seek by clicking/dragging on timeline (playhead can be dragged indirectly)
  timelineTrack.addEventListener(
    "mousedown",
    (e) => {
      if (e.button !== 0) return;
      if (e.target.closest(".edit-zone")) return;
      if (!sourceVideo.duration || !isFinite(sourceVideo.duration)) return;

      isSeeking = true;
      wasPlayingBeforeSeek = !sourceVideo.paused;
      seekToClientX(e.clientX);

      const onMove = (ev) => {
        if (!isSeeking) return;
        seekToClientX(ev.clientX);
      };

      const onUp = () => {
        if (!isSeeking) return;
        isSeeking = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if (wasPlayingBeforeSeek) {
          sourceVideo.play();
          btnPlayPause.textContent = "⏸";
          isPlaying = true;
        }
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    true,
  );

  document.getElementById("btnMarkCut").addEventListener("click", () => {
    if (currentCutStart === null) {
      currentCutStart = sourceVideo.currentTime;
      document.getElementById("btnMarkCut").textContent = "📍 Mark Cut End";
      document.getElementById("btnMarkCut").classList.add("active");
    } else {
      const end = sourceVideo.currentTime;
      const start = Math.min(currentCutStart, end);
      const realEnd = Math.max(currentCutStart, end);
      const newCut = ensureEditId({ start, end: realEnd }, "cut");
      cuts.push(newCut);
      currentCutStart = null;
      document.getElementById("btnMarkCut").textContent = "✂️ Mark Cut Start";
      document.getElementById("btnMarkCut").classList.remove("active");
      selectEdit(newCut._id);
      renderEditsUI();
    }
  });

  document.getElementById("btnDeleteSegment").addEventListener("click", () => {
    if (!selectedEditId) return;
    removeEditById(selectedEditId);
    selectedEditId = null;
    renderEditsUI();
  });

  // --- RENDERING ENGINE ---
  document.getElementById("btnApply").addEventListener("click", async () => {
    renderOverlay.classList.remove("hidden");
    isPlaying = false;
    sourceVideo.pause();

    const finalCuts = mergeOverlappingCuts(cuts);
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
    const chunks = [];

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = async () => {
      console.log(`Recording finished. Chunks collected: ${chunks.length}`);
      if (chunks.length === 0) {
        alert("Failed to capture video.");
        renderOverlay.classList.add("hidden");
        return;
      }

      const newBlob = new Blob(chunks, { type: "video/webm" });
      const newLogs = syncLogs(sessionLogs, finalCuts);

      try {
        await saveVideoToDB(newBlob);
        chrome.runtime.sendMessage(
          { action: "SAVE_PENDING_VIDEO", useDB: true },
          () => {
            chrome.storage.local.set({ sessionLogs: newLogs }, () => {
              sessionStorage.setItem("editLogs", JSON.stringify(newLogs));
              window.location.href = "review.html";
            });
          },
        );
      } catch (err) {
        console.error("Save to DB failed:", err);
        alert("Error saving video.");
      }
    };

    recorder.start(1000);
    await new Promise((r) => setTimeout(r, 100));

    const segments = calculateKeepSegments(sourceVideo.duration, finalCuts);
    let totalKeepDuration = segments.reduce(
      (sum, s) => sum + (s.end - s.start),
      0,
    );
    let processed = 0;

    sourceVideo.playbackRate = parseFloat(playbackSpeed.value);

    for (const seg of segments) {
      sourceVideo.currentTime = seg.start;
      await new Promise((r) => (sourceVideo.onseeked = r));

      const segDuration = seg.end - seg.start;
      sourceVideo.play();

      while (sourceVideo.currentTime < seg.end) {
        drawFrame();
        const pct = Math.min(
          100,
          ((processed + (sourceVideo.currentTime - seg.start)) /
            totalKeepDuration) *
            100,
        );
        renderProgress.style.width = `${pct}%`;
        renderStatus.textContent = `Encoding... ${Math.round(pct)}%`;
        await new Promise((r) => setTimeout(r, 16));
        if (sourceVideo.ended) break;
      }
      sourceVideo.pause();
      processed += segDuration;
    }

    recorder.stop();
  });

  // --- UTILS & HELPERS ---
  async function saveVideoToDB(blob) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("BERIBUG_Storage", 2);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("videos"))
          db.createObjectStore("videos");
      };
      request.onsuccess = (e) => {
        const db = e.target.result;
        const transaction = db.transaction("videos", "readwrite");
        const store = transaction.objectStore("videos");
        const putRequest = store.put(blob, "pendingVideo");
        putRequest.onsuccess = () => resolve();
        putRequest.onerror = () => reject(putRequest.error);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async function getVideoFromDB() {
    return new Promise((resolve) => {
      const request = indexedDB.open("BERIBUG_Storage", 2);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("videos"))
          db.createObjectStore("videos");
      };
      request.onsuccess = (e) => {
        const db = e.target.result;
        const transaction = db.transaction("videos", "readonly");
        const store = transaction.objectStore("videos");
        const getRequest = store.get("pendingVideo");
        getRequest.onsuccess = () => resolve(getRequest.result);
        getRequest.onerror = () => resolve(null);
      };
      request.onerror = () => resolve(null);
    });
  }

  function mergeOverlappingCuts(cutList) {
    if (cutList.length <= 1) return cutList;
    const sorted = [...cutList].sort((a, b) => a.start - b.start);
    const merged = [];
    let current = { ...sorted[0] };
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start <= current.end) {
        current.end = Math.max(current.end, sorted[i].end);
      } else {
        merged.push(current);
        current = { ...sorted[i] };
      }
    }
    merged.push(current);
    return merged;
  }

  function calculateKeepSegments(duration, mergedCuts) {
    if (mergedCuts.length === 0) return [{ start: 0, end: duration }];
    const keeps = [];
    let lastEnd = 0;
    mergedCuts.forEach((cut) => {
      if (cut.start > lastEnd) keeps.push({ start: lastEnd, end: cut.start });
      lastEnd = Math.max(lastEnd, cut.end);
    });
    if (lastEnd < duration) keeps.push({ start: lastEnd, end: duration });
    return keeps;
  }

  function syncLogs(logs, mergedCuts) {
    if (mergedCuts.length === 0) return logs;
    const newLogs = JSON.parse(JSON.stringify(logs));
    const categories = ["console", "network", "actions", "backend"];
    function getNewTime(oldTimeSec) {
      let totalCutBefore = 0;
      for (const cut of mergedCuts) {
        if (oldTimeSec >= cut.end) totalCutBefore += cut.end - cut.start;
        else if (oldTimeSec > cut.start && oldTimeSec < cut.end) return null;
      }
      return Math.max(0, oldTimeSec - totalCutBefore);
    }
    categories.forEach((cat) => {
      if (!newLogs[cat]) return;
      newLogs[cat] = newLogs[cat]
        .map((item) => {
          const oldT = item.relativeMs / 1000 || parseSec(item.time);
          const newT = getNewTime(oldT);
          if (newT === null) return null;
          item.relativeMs = Math.round(newT * 1000);
          item.time = `[${formatTime(newT)}]`;
          return item;
        })
        .filter(Boolean);
    });
    // URL Timeline re-map
    if (newLogs.info && newLogs.info.urlTimeline) {
      let timeline = [];
      const originalTimeline = logs.info.urlTimeline || [];
      originalTimeline.forEach((item, idx) => {
        const oldT = item.timeMs / 1000 || item.time || 0;
        const newT = getNewTime(oldT);
        if (newT !== null)
          timeline.push({
            ...item,
            time: newT,
            timeMs: Math.round(newT * 1000),
          });
        else {
          const currentCut = mergedCuts.find(
            (c) => oldT >= c.start && oldT <= c.end,
          );
          const nextEntry = originalTimeline[idx + 1];
          const nextEntryTime = nextEntry
            ? nextEntry.timeMs / 1000 || nextEntry.time
            : Infinity;
          if (nextEntryTime > currentCut.end) {
            const newTPostCut = getNewTime(currentCut.end);
            timeline.push({
              ...item,
              time: newTPostCut,
              timeMs: Math.round(newTPostCut * 1000),
            });
          }
        }
      });
      timeline.sort((a, b) => a.time - b.time);
      const unique = [];
      timeline.forEach((entry) => {
        const last = unique[unique.length - 1];
        if (!last || last.url !== entry.url) unique.push(entry);
      });
      if (unique.length > 0) {
        unique[0].time = 0;
        unique[0].timeMs = 0;
      }
      newLogs.info.urlTimeline = unique;
      if (unique.length > 0) newLogs.info.url = unique[0].url;
    }
    return newLogs;
  }

  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60)
      .toString()
      .padStart(2, "0");
    return `${m}:${s}`;
  }

  function parseSec(timeStr) {
    if (!timeStr) return 0;
    const match = timeStr.match(/\[(\d+):(\d+)\]/);
    return match ? parseInt(match[1]) * 60 + parseInt(match[2]) : 0;
  }

  document.getElementById("btnCancel").addEventListener("click", () => {
    if (confirm("Discard changes?")) window.location.href = "review.html";
  });

  document.querySelectorAll(".color-swatch").forEach((sw) => {
    sw.addEventListener("click", () => {
      document
        .querySelectorAll(".color-swatch")
        .forEach((s) => s.classList.remove("active"));
      sw.classList.add("active");
    });
  });

  document.getElementById("propStrokeWidth").addEventListener("input", (e) => {
    document.getElementById("valStrokeWidth").textContent = e.target.value;
  });

  // --- SETTINGS ---
  function loadEditorSettings() {
    const saved = parseFloat(
      localStorage.getItem("beribug_defaultActiveEditDurationSec") || "5",
    );
    defaultActiveEditDurationSec = isFinite(saved) && saved > 0 ? saved : 5;
    if (activeEditDurationInput)
      activeEditDurationInput.value = String(defaultActiveEditDurationSec);
  }

  activeEditDurationInput?.addEventListener("change", () => {
    const val = parseFloat(activeEditDurationInput.value || "5");
    defaultActiveEditDurationSec = isFinite(val) && val > 0 ? val : 5;
    localStorage.setItem(
      "beribug_defaultActiveEditDurationSec",
      String(defaultActiveEditDurationSec),
    );
  });

  // --- ACTIVE EDITS UI (List + Timeline Zones) ---
  function ensureEditId(obj, prefix) {
    if (!obj) return obj;
    if (!obj._id) obj._id = `${prefix}_${nextEditId++}`;
    return obj;
  }

  function getAllEdits() {
    const edits = [];

    cuts.forEach((c) =>
      edits.push({ kind: "cut", label: "Cut Segment", data: c }),
    );
    annotations.forEach((a) =>
      edits.push({
        kind: "annotation",
        label: `Annotation: ${a.type}`,
        data: a,
      }),
    );
    if (magnifier)
      edits.push({ kind: "magnifier", label: "Magnifier", data: magnifier });
    if (cropRect)
      edits.push({ kind: "crop", label: "Crop Area", data: cropRect });

    // Sort by start time when possible
    edits.sort((a, b) => {
      const aStart =
        a.data.start != null ? a.data.start : Number.POSITIVE_INFINITY;
      const bStart =
        b.data.start != null ? b.data.start : Number.POSITIVE_INFINITY;
      return aStart - bStart;
    });

    return edits;
  }

  function getEditDataById(id) {
    if (!id) return null;
    for (const c of cuts) if (c._id === id) return c;
    for (const a of annotations) if (a._id === id) return a;
    if (magnifier && magnifier._id === id) return magnifier;
    if (cropRect && cropRect._id === id) return cropRect;
    return null;
  }

  function removeEditById(id) {
    const beforeCuts = cuts.length;
    cuts = cuts.filter((c) => c._id !== id);
    if (cuts.length !== beforeCuts) return;

    const beforeAnn = annotations.length;
    annotations = annotations.filter((a) => a._id !== id);
    if (annotations.length !== beforeAnn) return;

    if (magnifier && magnifier._id === id) {
      magnifier = null;
      return;
    }
    if (cropRect && cropRect._id === id) {
      cropRect = null;
      return;
    }
  }

  function selectEdit(id) {
    selectedEditId = id;
    renderEditList();
    renderTimelineEdits();
  }

  function renderEditsUI() {
    renderEditList();
    renderTimelineEdits();
  }

  function renderEditList() {
    editListContainer.innerHTML = "";
    const edits = getAllEdits();
    edits.forEach(({ kind, label, data }) => {
      ensureEditId(data, kind);
      const item = document.createElement("div");
      item.className = "edit-item";
      item.dataset.id = data._id;
      item.dataset.kind = kind;
      item.dataset.baseLabel = label;
      if (data._id === selectedEditId) item.classList.add("selected");

      const hasTiming = data.start != null && data.end != null;
      const timeInfo = hasTiming
        ? ` [${formatTime(data.start)}-${formatTime(data.end)}]`
        : "";
      const duration = hasTiming ? Math.max(0.1, data.end - data.start) : null;

      if (hasTiming) {
        item.innerHTML = `
          <span class="edit-label">${label}${timeInfo}</span>
          <input class="edit-duration" type="number" min="0.1" step="0.5" value="${duration.toFixed(1)}" title="Duration (seconds)">
          <button class="remove-btn" title="Remove">✕</button>
        `;
      } else {
        item.innerHTML = `<span class="edit-label">${label}</span> <button class="remove-btn" title="Remove">✕</button>`;
      }

      item.addEventListener("click", (e) => {
        if (e.target.closest(".edit-duration")) return;
        if (e.target.closest(".remove-btn")) return;
        selectEdit(data._id);
        if (data.start != null && isFinite(sourceVideo.duration)) {
          sourceVideo.currentTime = Math.max(
            0,
            Math.min(sourceVideo.duration, data.start),
          );
        }
      });

      const durInput = item.querySelector(".edit-duration");
      if (durInput) {
        durInput.addEventListener("click", (e) => e.stopPropagation());
        durInput.addEventListener("change", (e) => {
          e.stopPropagation();
          const newDur = parseFloat(e.target.value || "0");
          if (!isFinite(newDur) || newDur <= 0) return;
          const dur =
            sourceVideo.duration && isFinite(sourceVideo.duration)
              ? sourceVideo.duration
              : null;
          const newStart = data.start;
          let newEnd = newStart + newDur;
          if (dur != null)
            newEnd = Math.min(dur, Math.max(newStart + 0.1, newEnd));
          data.end = newEnd;
          if (selectedEditId === data._id) {
            renderTimelineEdits();
          } else {
            // Update only the DOM for that item + its zone if present
            updateEditDomById(data._id);
          }
          renderEditList();
          renderTimelineEdits();
        });
      }

      item.querySelector(".remove-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        removeEditById(data._id);
        if (selectedEditId === data._id) selectedEditId = null;
        renderEditsUI();
      });

      editListContainer.appendChild(item);
    });
  }

  function renderTimelineEdits() {
    const container = document.getElementById("cutZones");
    container.innerHTML = "";
    const dur = sourceVideo.duration;
    if (!dur || !isFinite(dur)) return;

    const edits = getAllEdits().filter(
      (e) => e.data.start != null && e.data.end != null,
    );
    edits.forEach(({ kind, data }) => {
      const startPct = (data.start / dur) * 100;
      const widthPct = ((data.end - data.start) / dur) * 100;
      const el = document.createElement("div");
      el.className = `edit-zone edit-zone--${kind}`;
      el.dataset.id = data._id;
      el.dataset.kind = kind;
      el.style.left = `${startPct}%`;
      el.style.width = `${Math.max(0.2, widthPct)}%`;
      if (data._id === selectedEditId) el.classList.add("selected");

      el.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        selectEdit(data._id);
        startEditZoneDrag(e, data._id);
      });

      el.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (data.start != null)
          sourceVideo.currentTime = Math.max(0, Math.min(dur, data.start));
      });

      container.appendChild(el);
    });
  }

  function updateEditTimesById(id, newStart, newEnd) {
    const data = getEditDataById(id);
    if (!data || data.start == null || data.end == null) return;
    data.start = newStart;
    data.end = newEnd;
  }

  function updateEditDomById(id) {
    const dur = sourceVideo.duration;
    const data = getEditDataById(id);
    if (
      !data ||
      !dur ||
      !isFinite(dur) ||
      data.start == null ||
      data.end == null
    )
      return;

    const zone = document.querySelector(
      `.edit-zone[data-id="${CSS.escape(id)}"]`,
    );
    if (zone) {
      const startPct = (data.start / dur) * 100;
      const widthPct = ((data.end - data.start) / dur) * 100;
      zone.style.left = `${startPct}%`;
      zone.style.width = `${Math.max(0.2, widthPct)}%`;
    }

    const itemEl = editListContainer.querySelector(
      `.edit-item[data-id="${CSS.escape(id)}"]`,
    );
    const labelEl = itemEl?.querySelector(".edit-label");
    if (itemEl && labelEl) {
      const baseLabel =
        itemEl.dataset.baseLabel ||
        labelEl.textContent.replace(/\s\[.*\]$/, "");
      labelEl.textContent = `${baseLabel} [${formatTime(data.start)}-${formatTime(data.end)}]`;
    }
  }

  function startEditZoneDrag(e, id) {
    const data = getEditDataById(id);
    if (!data || data.start == null || data.end == null) return;
    draggingEditZone = {
      id,
      baseStart: data.start,
      baseEnd: data.end,
      startClientX: e.clientX,
    };

    const onMove = (ev) => {
      if (!draggingEditZone) return;
      const rect = timelineTrack.getBoundingClientRect();
      const dx = ev.clientX - draggingEditZone.startClientX;
      const deltaSec = (dx / rect.width) * sourceVideo.duration;
      const segDur = draggingEditZone.baseEnd - draggingEditZone.baseStart;

      let newStart = draggingEditZone.baseStart + deltaSec;
      newStart = Math.max(0, Math.min(sourceVideo.duration - segDur, newStart));
      const newEnd = newStart + segDur;
      updateEditTimesById(draggingEditZone.id, newStart, newEnd);
      updateEditDomById(draggingEditZone.id);
    };

    const onUp = () => {
      if (!draggingEditZone) return;
      draggingEditZone = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      renderEditList();
      renderTimelineEdits();
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function seekToClientX(clientX) {
    const rect = timelineTrack.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const pct = rect.width ? x / rect.width : 0;
    const t = pct * sourceVideo.duration;
    sourceVideo.currentTime = Math.max(0, Math.min(sourceVideo.duration, t));
  }
});
