/**
 * T.R.A.C.E Video Editor Logic
 * Handles video processing, drawing, cutting, and log synchronization.
 */

document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const sourceVideo = document.getElementById('sourceVideo');
  const canvas = document.getElementById('editorCanvas');
  const ctx = canvas.getContext('2d');
  const interactionLayer = document.getElementById('interactionLayer');
  const playhead = document.getElementById('playhead');
  const timelineTrack = document.getElementById('timelineTrack');
  const btnPlayPause = document.getElementById('btnPlayPause');
  const currentTimeDisplay = document.getElementById('currentTime');
  const durationDisplay = document.getElementById('duration');
  const playbackSpeed = document.getElementById('playbackSpeed');
  const editListContainer = document.getElementById('editList');
  const renderOverlay = document.getElementById('renderOverlay');
  const renderProgress = document.getElementById('renderProgress');
  const renderStatus = document.getElementById('renderStatus');

  // State
  let sessionLogs = { console: [], network: [], actions: [], backend: [], info: {} };
  let originalVideoBlob = null;
  let activeTool = 'select';
  let isPlaying = false;
  let animationId = null;
  let cuts = []; // Array of {start: 0, end: 10} for DELETED segments
  let annotations = []; // Array of {type, start, end, x, y, w, h, color, size}
  let cropRect = null; // {x, y, w, h}
  let magnifier = null; // {time, x, y, size}
  let currentCutStart = null;
  
  // Interaction State
  let isDragging = false;
  let startX, startY;
  let currentAnnotation = null;

  // --- INITIALIZATION ---
  async function init() {
    // 1. Load Logs from SessionStorage
    const savedLogs = sessionStorage.getItem('editLogs');
    if (savedLogs) {
      sessionLogs = JSON.parse(savedLogs);
    }

    // 2. Get Video from Background
    chrome.runtime.sendMessage({ action: 'GET_PENDING_VIDEO' }, (res) => {
      if (res && res.videoBase64) {
        try {
          const byteCharacters = atob(res.videoBase64);
          const byteNumbers = new Uint8Array(byteCharacters.length);
          for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
          }
          originalVideoBlob = new Blob([byteNumbers], { type: 'video/webm' });
          sourceVideo.src = URL.createObjectURL(originalVideoBlob);
          
          sourceVideo.onloadedmetadata = () => {
            canvas.width = sourceVideo.videoWidth;
            canvas.height = sourceVideo.videoHeight;
            durationDisplay.textContent = formatTime(sourceVideo.duration);
            requestAnimationFrame(renderLoop);
          };
        } catch (e) {
          console.error("Video load failed", e);
          alert("Failed to load video for editing.");
        }
      } else {
        alert("No video found to edit.");
      }
    });
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
      ctx.drawImage(sourceVideo, cropRect.x, cropRect.y, cropRect.w, cropRect.h, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.drawImage(sourceVideo, 0, 0, canvas.width, canvas.height);
    }

    const now = sourceVideo.currentTime;

    // 2. Draw Annotations & Blurs
    const allToDraw = [...annotations];
    if (currentAnnotation) allToDraw.push(currentAnnotation);

    allToDraw.forEach(ann => {
      const isVisible = currentAnnotation === ann || (now >= ann.start && now <= ann.end);
      if (isVisible) {
        ctx.save();
        if (ann.type === 'blur') {
          ctx.filter = `blur(${ann.amount}px)`;
          ctx.drawImage(canvas, ann.x, ann.y, ann.w, ann.h, ann.x, ann.y, ann.w, ann.h);
        } else {
          ctx.strokeStyle = ann.color;
          ctx.lineWidth = ann.size;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          
          if (ann.type === 'pen' && ann.points) {
            ctx.beginPath();
            ctx.moveTo(ann.points[0].x, ann.points[0].y);
            ann.points.forEach(p => ctx.lineTo(p.x, p.y));
            ctx.stroke();
          } else if (ann.type === 'draw-rect') {
            ctx.strokeRect(ann.x, ann.y, ann.w, ann.h);
          } else if (ann.type === 'draw-circle') {
            ctx.beginPath();
            ctx.ellipse(ann.x + ann.w/2, ann.y + ann.h/2, Math.abs(ann.w/2), Math.abs(ann.h/2), 0, 0, Math.PI * 2);
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
      ctx.arc(magnifier.x, magnifier.y, size/2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(canvas, 
        magnifier.x - size/(2*zoom), magnifier.y - size/(2*zoom), size/zoom, size/zoom,
        magnifier.x - size/2, magnifier.y - size/2, size, size
      );
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }
  }

  function updateTimeline() {
    const pct = (sourceVideo.currentTime / sourceVideo.duration) * 100;
    playhead.style.left = `${pct}%`;
    currentTimeDisplay.textContent = formatTime(sourceVideo.currentTime);
  }

  // --- INTERACTION LOGIC ---
  interactionLayer.addEventListener('mousedown', (e) => {
    if (activeTool === 'select') return;
    
    isDragging = true;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    
    startX = (e.clientX - rect.left) * scaleX;
    startY = (e.clientY - rect.top) * scaleY;

    if (activeTool === 'zoom') {
      magnifier = { start: sourceVideo.currentTime, end: sourceVideo.currentTime + 5, x: startX, y: startY };
      addEditItem('Magnifier', magnifier);
      return;
    }

    currentAnnotation = {
      type: activeTool,
      start: sourceVideo.currentTime,
      end: sourceVideo.currentTime + 5,
      x: startX, y: startY, w: 0, h: 0,
      points: activeTool === 'pen' ? [{x: startX, y: startY}] : null,
      color: document.querySelector('.color-swatch.active')?.dataset.color || '#ff0000',
      size: parseInt(document.getElementById('propStrokeWidth').value),
      amount: parseInt(document.getElementById('propBlurAmount').value)
    };
  });

  interactionLayer.addEventListener('mousemove', (e) => {
    if (!isDragging || !currentAnnotation) return;
    
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const curX = (e.clientX - rect.left) * scaleX;
    const curY = (e.clientY - rect.top) * scaleY;

    if (currentAnnotation.type === 'pen') {
      currentAnnotation.points.push({x: curX, y: curY});
    } else {
      currentAnnotation.w = curX - startX;
      currentAnnotation.h = curY - startY;
    }
    
    if (!isPlaying) drawFrame(); // Force redraw when scrubbing/drawing while paused
  });

  interactionLayer.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;

    if (activeTool === 'crop') {
      cropRect = { x: Math.min(startX, startX + currentAnnotation.w), y: Math.min(startY, startY + currentAnnotation.h), w: Math.abs(currentAnnotation.w), h: Math.abs(currentAnnotation.h) };
      addEditItem('Crop Area', cropRect);
    } else if (currentAnnotation) {
      annotations.push(currentAnnotation);
      addEditItem(currentAnnotation.type, currentAnnotation);
    }
    currentAnnotation = null;
  });

  // --- UI HANDLERS ---
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTool = btn.dataset.tool;
      
      const isDrawing = activeTool.includes('draw') || activeTool === 'pen';
      document.getElementById('propDraw').style.display = isDrawing ? 'block' : 'none';
      document.getElementById('propBlur').style.display = (activeTool === 'blur') ? 'block' : 'none';
    });
  });

  btnPlayPause.addEventListener('click', () => {
    if (sourceVideo.paused) {
      sourceVideo.play();
      btnPlayPause.textContent = '⏸';
      isPlaying = true;
    } else {
      sourceVideo.pause();
      btnPlayPause.textContent = '▶';
      isPlaying = false;
    }
  });

  document.getElementById('btnMarkCut').addEventListener('click', () => {
    if (currentCutStart === null) {
      currentCutStart = sourceVideo.currentTime;
      document.getElementById('btnMarkCut').textContent = '📍 Mark Cut End';
      document.getElementById('btnMarkCut').classList.add('active');
    } else {
      const end = sourceVideo.currentTime;
      const start = Math.min(currentCutStart, end);
      const realEnd = Math.max(currentCutStart, end);
      cuts.push({ start, end: realEnd });
      currentCutStart = null;
      document.getElementById('btnMarkCut').textContent = '✂️ Mark Cut Start';
      document.getElementById('btnMarkCut').classList.remove('active');
      renderCutZones();
      addEditItem('Cut Segment', { start, end: realEnd });
    }
  });

  function renderCutZones() {
    const container = document.getElementById('cutZones');
    container.innerHTML = '';
    cuts.forEach(cut => {
      const startPct = (cut.start / sourceVideo.duration) * 100;
      const widthPct = ((cut.end - cut.start) / sourceVideo.duration) * 100;
      const el = document.createElement('div');
      el.className = 'cut-zone';
      el.style.left = `${startPct}%`;
      el.style.width = `${widthPct}%`;
      container.appendChild(el);
    });
  }

  function addEditItem(label, data) {
    const item = document.createElement('div');
    item.className = 'edit-item';
    const timeInfo = data.start != null ? `[${formatTime(data.start)}-${formatTime(data.end)}]` : '';
    item.innerHTML = `<span>${label} ${timeInfo}</span> <button class="remove-btn">✕</button>`;
    
    item.querySelector('.remove-btn').addEventListener('click', () => {
      if (label === 'Cut Segment') cuts = cuts.filter(c => c !== data);
      if (label === 'Crop Area') cropRect = null;
      annotations = annotations.filter(a => a !== data);
      if (label === 'Magnifier') magnifier = null;
      item.remove();
      renderCutZones();
    });
    
    editListContainer.appendChild(item);
  }

  // --- RENDERING ENGINE (THE BRAIN) ---
  document.getElementById('btnApply').addEventListener('click', async () => {
    renderOverlay.classList.remove('hidden');
    isPlaying = false;
    sourceVideo.pause();
    
    const stream = canvas.captureStream(30); // 30 FPS
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', bitsPerSecond: 5000000 });
    const chunks = [];
    
    recorder.ondataavailable = e => chunks.push(e.data);
    recorder.onstop = async () => {
      const newBlob = new Blob(chunks, { type: 'video/webm' });
      const newLogs = syncLogs(sessionLogs, cuts);
      
      // Save back to storage and redirect
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result.split(',')[1];
        chrome.runtime.sendMessage({ action: 'SAVE_PENDING_VIDEO', videoBase64: base64 }, () => {
          sessionStorage.setItem('editLogs', JSON.stringify(newLogs));
          window.location.href = 'review.html';
        });
      };
      reader.readAsDataURL(newBlob);
    };

    // Render Process
    recorder.start();
    
    // We need to play through the video, but ONLY segments that are NOT cut.
    const segments = calculateKeepSegments(sourceVideo.duration, cuts);
    let totalKeepDuration = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
    let processed = 0;

    sourceVideo.playbackRate = parseFloat(playbackSpeed.value);

    for (const seg of segments) {
      sourceVideo.currentTime = seg.start;
      await new Promise(r => sourceVideo.onseeked = r);
      
      const segDuration = (seg.end - seg.start);
      sourceVideo.play();
      
      const startTime = Date.now();
      while (sourceVideo.currentTime < seg.end) {
        drawFrame();
        const pct = Math.min(100, ((processed + (sourceVideo.currentTime - seg.start)) / totalKeepDuration) * 100);
        renderProgress.style.width = `${pct}%`;
        renderStatus.textContent = `Encoding frames... ${Math.round(pct)}%`;
        await new Promise(r => setTimeout(r, 16)); // ~60fps logic
        if (sourceVideo.ended) break;
      }
      sourceVideo.pause();
      processed += segDuration;
    }

    recorder.stop();
  });

  function calculateKeepSegments(duration, cutList) {
    if (cutList.length === 0) return [{ start: 0, end: duration }];
    
    const sortedCuts = [...cutList].sort((a, b) => a.start - b.start);
    const keeps = [];
    let lastEnd = 0;
    
    sortedCuts.forEach(cut => {
      if (cut.start > lastEnd) {
        keeps.push({ start: lastEnd, end: cut.start });
      }
      lastEnd = Math.max(lastEnd, cut.end);
    });
    
    if (lastEnd < duration) {
      keeps.push({ start: lastEnd, end: duration });
    }
    return keeps;
  }

  // --- LOG SYNC ALGORITHM ---
  function syncLogs(logs, cutList) {
    if (cutList.length === 0) return logs;
    
    const newLogs = JSON.parse(JSON.stringify(logs)); // Deep clone
    const categories = ['console', 'network', 'actions', 'backend'];
    
    categories.forEach(cat => {
      if (!newLogs[cat]) return;
      
      newLogs[cat] = newLogs[cat].filter(item => {
        const time = (item.relativeMs / 1000) || parseSec(item.time);
        // Remove if inside a cut zone
        const isCut = cutList.some(c => time >= c.start && time <= c.end);
        return !isCut;
      }).map(item => {
        const time = (item.relativeMs / 1000) || parseSec(item.time);
        // Calculate shift
        const totalCutBefore = cutList
          .filter(c => c.end <= time)
          .reduce((sum, c) => sum + (c.end - c.start), 0);
        
        // Handle overlapping cuts (if any) - simple version assumes non-overlapping
        const newTimeSec = time - totalCutBefore;
        item.relativeMs = Math.round(newTimeSec * 1000);
        item.time = `[${formatTime(newTimeSec)}]`;
        return item;
      });
    });

    // Also sync URL Timeline
    if (newLogs.info && newLogs.info.urlTimeline) {
      newLogs.info.urlTimeline = newLogs.info.urlTimeline.filter(item => {
        const t = item.timeMs / 1000;
        return !cutList.some(c => t >= c.start && t <= c.end);
      }).map(item => {
        const t = item.timeMs / 1000;
        const totalCutBefore = cutList
          .filter(c => c.end <= t)
          .reduce((sum, c) => sum + (c.end - c.start), 0);
        item.timeMs = Math.round((t - totalCutBefore) * 1000);
        item.time = t - totalCutBefore;
        return item;
      });
    }

    return newLogs;
  }

  // --- HELPERS ---
  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function parseSec(timeStr) {
    if (!timeStr) return 0;
    const match = timeStr.match(/\[(\d+):(\d+)\]/);
    if (match) return parseInt(match[1]) * 60 + parseInt(match[2]);
    return 0;
  }

  document.getElementById('btnCancel').addEventListener('click', () => {
    if (confirm("Discard changes and return to review?")) {
      window.location.href = 'review.html';
    }
  });

  // Color selection
  document.querySelectorAll('.color-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
    });
  });

  // Stroke width display update
  const strokeSlider = document.getElementById('propStrokeWidth');
  const strokeVal = document.getElementById('valStrokeWidth');
  strokeSlider.addEventListener('input', () => {
    strokeVal.textContent = strokeSlider.value;
  });
});
