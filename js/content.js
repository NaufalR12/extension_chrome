// Inject script into main world
const script = document.createElement('script');
script.src = chrome.runtime.getURL('js/injected.js');
script.onload = function() {
    this.remove();
};
(document.head || document.documentElement).appendChild(script);

// Listen to injected script messages
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.source !== 'BUG_REPORTER_INJECTED') {
    return;
  }
  
  try {
    chrome.runtime.sendMessage({
      action: 'LOG_CAPTURED',
      type: event.data.type,
      payload: event.data.payload
    });
  } catch (e) {
    if (e.message.includes('context invalidated')) {
      console.warn('[Bug Reporter] Extension updated. Please refresh the page to continue log capture.');
    }
  }
});

// Key sequence tracking for inputs
let keySequenceMap = new Map();
document.addEventListener('keydown', (e) => {
  const target = e.target;
  if (!target || !['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
  
  let seq = keySequenceMap.get(target) || '';
  if (e.key === 'Backspace') seq += '⌫';
  else if (e.key === 'Enter') seq += 'Enter';
  else if (e.key.length === 1) seq += e.key;
  
  keySequenceMap.set(target, seq);
}, true);

function getElementAttributes(el) {
  let attrs = `<${el.tagName.toLowerCase()}`;
  for (let i = 0; i < el.attributes.length; i++) {
    const attr = el.attributes[i];
    attrs += ` ${attr.name}="${attr.value}"`;
  }
  return attrs + '>';
}

// Generate CSS selector unik untuk elemen
function getCssSelector(el) {
  if (!el || el.nodeType !== 1) return '';
  if (el.id) return `${el.tagName.toLowerCase()}#${el.id}`;
  let selector = el.tagName.toLowerCase();
  if (el.className && typeof el.className === 'string') {
    const classes = el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3);
    if (classes.length > 0) selector += '.' + classes.join('.');
  }
  return selector;
}

// Generate XPath for an element
function getXPath(el) {
  if (!el || el.nodeType !== 1) return '';
  if (el.id) return `//*[@id="${el.id}"]`;
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1) {
    let idx = 1;
    let sib = node.previousSibling;
    while (sib) {
      if (sib.nodeType === 1 && sib.nodeName === node.nodeName) idx++;
      sib = sib.previousSibling;
    }
    parts.unshift(`${node.nodeName.toLowerCase()}[${idx}]`);
    node = node.parentNode;
  }
  return '/' + parts.join('/');
}

// Capture environment snapshot (called when recording starts)
function captureEnvironment() {
  try {
    // LocalStorage keys (capture all, no masking)
    const localStorageData = {};
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      localStorageData[k] = window.localStorage.getItem(k);
    }

    // SessionStorage keys (capture all, no masking)
    const sessionStorageData = {};
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const k = window.sessionStorage.key(i);
      sessionStorageData[k] = window.sessionStorage.getItem(k);
    }

    // Cookies - hanya nama dan count, bukan nilai
    const cookieNames = document.cookie.split(';').map(c => c.split('=')[0].trim()).filter(Boolean);

    return {
      localStorage: localStorageData,
      sessionStorage: sessionStorageData,
      cookieCount: cookieNames.length,
      cookieNames: cookieNames,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      language: navigator.language,
      onlineStatus: navigator.onLine
    };
  } catch (e) {
    return { error: 'Could not capture environment: ' + e.message };
  }
}

// Scroll Tracker (debounced, max 1 entry per 2 seconds)
let lastScrollTime = 0;
let scrollDirection = null;
let scrollStartY = window.scrollY;

window.addEventListener('scroll', () => {
  const now = Date.now();
  if (now - lastScrollTime < 2000) return;
  lastScrollTime = now;

  const currentY = window.scrollY;
  const delta = currentY - scrollStartY;
  if (Math.abs(delta) < 100) return; // Ignore small scrolls

  const dir = delta > 0 ? 'down' : 'up';
  const target = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  const targetDesc = target ? `<${target.tagName.toLowerCase()}>` : 'page';

  try {
    chrome.runtime.sendMessage({
      action: 'LOG_CAPTURED',
      type: 'ACTIONS',
      payload: {
        time: new Date().toISOString(),
        event: 'Scroll',
        element: targetDesc,
        value: `${dir} ${Math.abs(Math.round(delta))}px (position: ${Math.round(currentY)}px)`
      }
    });
  } catch(err) {}

  scrollStartY = currentY;
}, { passive: true });

// Capture Actions (clicks and inputs)
document.addEventListener('click', (e) => {
  const target = e.target;
  if (!target) return;
  
  const elementDesc = getElementAttributes(target);
  const xpath = getXPath(target);
  const cssSelector = getCssSelector(target);
  const textContent = (target.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 80);
  
  try {
    chrome.runtime.sendMessage({
      action: 'LOG_CAPTURED',
      type: 'ACTIONS',
      payload: {
        time: new Date().toISOString(),
        event: 'Click',
        element: elementDesc,
        fullHtml: target.outerHTML.substring(0, 1000),
        xpath: xpath,
        cssSelector: cssSelector,
        textContent: textContent,
        clientX: Math.round(e.clientX),
        clientY: Math.round(e.clientY),
        pageX: Math.round(e.pageX),
        pageY: Math.round(e.pageY)
      }
    });
  } catch(err) {}
}, true);

document.addEventListener('input', (e) => {
  const target = e.target;
  if (!target || !target.tagName) return;
  
  const elementDesc = getElementAttributes(target);
  let value = keySequenceMap.get(target) || target.value || '';
  
  if (target.type === 'password') value = '***';
  else if (value.length > 100) value = value.substring(0, 100) + '...';

  try {
    chrome.runtime.sendMessage({
      action: 'LOG_CAPTURED',
      type: 'ACTIONS',
      payload: {
        time: new Date().toISOString(),
        event: 'Typed',
        element: elementDesc,
        value: value
      }
    });
  } catch(err) {}
  
  // Reset sequence after a while or on focus out? Jam usually debounces.
  // For now let's keep it until blur.
}, true);

document.addEventListener('blur', (e) => {
  if (keySequenceMap.has(e.target)) {
    keySequenceMap.delete(e.target);
  }
}, true);

// Respond to requests
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'BERIBUG_PING') {
    sendResponse({ ok: true });
    return;
  }
  if (request.action === 'GET_RESOLUTION') {
    sendResponse({ resolution: `${window.innerWidth}x${window.innerHeight}` });
  } else if (request.action === 'SHOW_WIDGET') {
    createWidget(request.startTime || 0, request.isPaused || false);
    // Capture and send environment snapshot when recording starts
    const env = captureEnvironment();
    try {
      chrome.runtime.sendMessage({ action: 'SAVE_ENVIRONMENT', payload: env });
    } catch(e) {}
    sendResponse({ ok: true });
  } else if (request.action === 'HIDE_WIDGET') {
    removeWidget();
    sendResponse({ ok: true });
  } else if (request.action === 'BUGLENS_GET_STORAGE') {
    sendResponse(getStorageSnapshot());
  } else if (request.action === 'SCREENSHOT_GET_METRICS') {
    sendResponse(getScreenshotMetrics());
  } else if (request.action === 'SCREENSHOT_SCROLL_TO') {
    scrollToY(request.y).then(() => sendResponse({ ok: true, y: window.scrollY })).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  } else if (request.action === 'SCREENSHOT_START_AREA_SELECT') {
    startAreaSelectionOverlay();
    sendResponse({ ok: true });
  } else if (request.action === 'SCREENSHOT_SCROLL_UI_START') {
    startScrollStopOverlay();
    sendResponse({ ok: true });
  } else if (request.action === 'SCREENSHOT_SCROLL_UI_END') {
    removeScrollStopOverlay();
    sendResponse({ ok: true });
  }
});

function getStorageSnapshot() {
  const ls = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    ls[key] = localStorage.getItem(key);
  }
  const ss = {};
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    ss[key] = sessionStorage.getItem(key);
  }
  return { localStorage: ls, sessionStorage: ss };
}

// ==================== SCREENSHOT HELPERS (CONTENT SCRIPT) ====================

function getScreenshotMetrics() {
  const docEl = document.documentElement;
  return {
    scrollHeight: Math.max(docEl.scrollHeight, document.body ? document.body.scrollHeight : 0),
    scrollWidth: Math.max(docEl.scrollWidth, document.body ? document.body.scrollWidth : 0),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    scrollX: window.scrollX,
    scrollY: window.scrollY
  };
}

function scrollToY(y) {
  return new Promise((resolve) => {
    try {
      // 'instant' is not a valid ScrollBehavior in Chrome; use 'auto'.
      window.scrollTo({ top: y, left: 0, behavior: 'auto' });
    } catch (_) {
      window.scrollTo(0, y);
    }
    requestAnimationFrame(() => setTimeout(() => resolve(), 140));
  });
}

let __beribugShotOverlay = null;
let __beribugScrollOverlay = null;

function startAreaSelectionOverlay() {
  if (__beribugShotOverlay) return;

  const overlay = document.createElement('div');
  __beribugShotOverlay = overlay;
  overlay.style.position = 'fixed';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.right = '0';
  overlay.style.bottom = '0';
  overlay.style.zIndex = '2147483647';
  overlay.style.cursor = 'crosshair';
  overlay.style.background = 'rgba(0,0,0,0.25)';
  overlay.style.userSelect = 'none';

  const hint = document.createElement('div');
  hint.textContent = 'Silahkan pilih area untuk screenshot (drag). Tekan ESC untuk batal.';
  hint.style.position = 'fixed';
  hint.style.top = '16px';
  hint.style.left = '50%';
  hint.style.transform = 'translateX(-50%)';
  hint.style.padding = '10px 14px';
  hint.style.borderRadius = '10px';
  hint.style.background = 'rgba(26,115,232,0.95)';
  hint.style.color = '#fff';
  hint.style.font = '600 13px/1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  hint.style.boxShadow = '0 6px 18px rgba(0,0,0,0.25)';
  overlay.appendChild(hint);

  const box = document.createElement('div');
  box.style.position = 'fixed';
  box.style.border = '2px solid #1a73e8';
  box.style.background = 'rgba(26,115,232,0.10)';
  box.style.display = 'none';
  box.style.borderRadius = '4px';
  overlay.appendChild(box);

  let start = null;

  function cleanup() {
    document.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
    __beribugShotOverlay = null;
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cleanup();
      chrome.runtime.sendMessage({
        action: 'SCREENSHOT_AREA_RESULT',
        canceled: true
      }).catch(() => {});
    }
  }

  document.addEventListener('keydown', onKeyDown, true);

  overlay.addEventListener('mousedown', (e) => {
    start = { x: e.clientX, y: e.clientY };
    box.style.display = 'block';
    box.style.left = `${start.x}px`;
    box.style.top = `${start.y}px`;
    box.style.width = '0px';
    box.style.height = '0px';
  });

  overlay.addEventListener('mousemove', (e) => {
    if (!start) return;
    const x1 = Math.min(start.x, e.clientX);
    const y1 = Math.min(start.y, e.clientY);
    const x2 = Math.max(start.x, e.clientX);
    const y2 = Math.max(start.y, e.clientY);
    box.style.left = `${x1}px`;
    box.style.top = `${y1}px`;
    box.style.width = `${x2 - x1}px`;
    box.style.height = `${y2 - y1}px`;
  });

  overlay.addEventListener('mouseup', (e) => {
    if (!start) return;
    const x1 = Math.min(start.x, e.clientX);
    const y1 = Math.min(start.y, e.clientY);
    const x2 = Math.max(start.x, e.clientX);
    const y2 = Math.max(start.y, e.clientY);
    const w = x2 - x1;
    const h = y2 - y1;

    start = null;

    if (w < 30 || h < 30) {
      // keep overlay, let user retry
      box.style.display = 'none';
      return;
    }

    const metrics = getScreenshotMetrics();
    cleanup();

    chrome.runtime.sendMessage({
      action: 'SCREENSHOT_AREA_RESULT',
      canceled: false,
      rect: { x: x1, y: y1, width: w, height: h },
      metrics
    }).catch(() => {});
  });

  document.documentElement.appendChild(overlay);
}

function removeScrollStopOverlay() {
  if (__beribugScrollOverlay) {
    __beribugScrollOverlay.remove();
    __beribugScrollOverlay = null;
  }
}

function startScrollStopOverlay() {
  if (__beribugScrollOverlay) return;

  const box = document.createElement('div');
  __beribugScrollOverlay = box;
  box.style.position = 'fixed';
  box.style.right = '18px';
  box.style.bottom = '18px';
  box.style.zIndex = '2147483647';
  box.style.display = 'flex';
  box.style.gap = '10px';
  box.style.alignItems = 'center';
  box.style.padding = '12px 12px';
  box.style.borderRadius = '12px';
  box.style.background = 'rgba(0,0,0,0.72)';
  box.style.color = '#fff';
  box.style.font = '600 13px/1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  box.style.boxShadow = '0 10px 24px rgba(0,0,0,0.25)';
  box.style.userSelect = 'none';

  const text = document.createElement('div');
  text.textContent = 'Scroll untuk lanjut, klik ✅ bila cukup';
  text.style.marginRight = '6px';

  const btnStop = document.createElement('button');
  btnStop.type = 'button';
  btnStop.textContent = '✅';
  btnStop.title = 'Selesai';
  btnStop.style.width = '44px';
  btnStop.style.height = '36px';
  btnStop.style.borderRadius = '10px';
  btnStop.style.border = '1px solid rgba(255,255,255,0.2)';
  btnStop.style.background = 'rgba(26,115,232,0.95)';
  btnStop.style.color = '#fff';
  btnStop.style.cursor = 'pointer';

  const btnCancel = document.createElement('button');
  btnCancel.type = 'button';
  btnCancel.textContent = '✕';
  btnCancel.title = 'Batal';
  btnCancel.style.width = '44px';
  btnCancel.style.height = '36px';
  btnCancel.style.borderRadius = '10px';
  btnCancel.style.border = '1px solid rgba(255,255,255,0.2)';
  btnCancel.style.background = 'rgba(217,48,37,0.95)';
  btnCancel.style.color = '#fff';
  btnCancel.style.cursor = 'pointer';

  btnStop.addEventListener('click', () => {
    const y = window.scrollY;
    removeScrollStopOverlay();
    chrome.runtime.sendMessage({ action: 'SCREENSHOT_SCROLL_STOP', scrollY: y }).catch(() => {});
  });
  btnCancel.addEventListener('click', () => {
    removeScrollStopOverlay();
    chrome.runtime.sendMessage({ action: 'SCREENSHOT_SCROLL_CANCEL' }).catch(() => {});
  });

  box.appendChild(text);
  box.appendChild(btnStop);
  box.appendChild(btnCancel);
  document.documentElement.appendChild(box);
}



let widgetContainer = null;
let timerInterval = null;
let secondsRecord = 0;

function createWidget(initialSeconds = 0, initiallyPaused = false) {
  if (widgetContainer) return;
  
  widgetContainer = document.createElement('div');
  widgetContainer.id = 'bug-reporter-widget-container';
  widgetContainer.style.position = 'fixed';
  widgetContainer.style.bottom = '20px';
  widgetContainer.style.left = '20px';
  widgetContainer.style.zIndex = '2147483647'; // Max z-index

  const shadow = widgetContainer.attachShadow({mode: 'closed'});
  
  const style = document.createElement('style');
  style.textContent = `
    .widget {
      display: flex !important;
      visibility: visible !important;
      opacity: 1 !important;
      align-items: center;
      background: #1e1e2e;
      color: white;
      padding: 8px 16px;
      border-radius: 50px;
      font-family: sans-serif;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      gap: 12px;
      cursor: grab;
      user-select: none;
    }
    .widget:active {
      cursor: grabbing;
    }
    .btn {
      background: none;
      border: none;
      color: white;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      transition: background 0.2s;
    }
    .btn:hover { background: #3c3c50; }
    .btn.stop:hover { background: #ff4d4d; }
    .btn.draw-active { background: #ffd700; color: #000; }
    .timer { font-variant-numeric: tabular-nums; font-weight: bold; width: 50px; text-align: center; }
    .divider { width: 1px; height: 24px; background: #4e4e60; margin: 0 4px; }
    
    .color-picker { display: none; gap: 6px; margin: 0 4px; align-items: center; }
    .color-picker.show { display: flex; }
    .color-dot { width: 16px; height: 16px; border-radius: 50%; cursor: pointer; border: 2px solid transparent; transition: transform 0.1s;}
    .color-dot:hover { transform: scale(1.1); }
    .color-dot.active { border-color: white; box-shadow: 0 0 0 1px #000; }
    .c-red { background: #ff0000; }
    .c-blue { background: #0088ff; }
    .c-green { background: #00d26a; }
    .c-yellow { background: #ffea00; }
    .clear { background: none; border: 1px solid rgba(255,255,255,0.3); color: white; border-radius: 4px; font-size: 11px; padding: 2px 6px; cursor: pointer;}
    .clear:hover { background: rgba(255,255,255,0.1); }
  `;

  const widget = document.createElement('div');
  widget.className = 'widget';
  
  const timer = document.createElement('div');
  timer.className = 'timer';
  const initM = String(Math.floor(initialSeconds / 60)).padStart(2, '0');
  const initS = String(initialSeconds % 60).padStart(2, '0');
  timer.innerText = `${initM}:${initS}`;
  
  const btnPause = document.createElement('button');
  btnPause.className = 'btn';
  btnPause.title = 'Pause Record';
  btnPause.innerHTML = initiallyPaused ? '▶️' : '⏸️'; // Simple emoji icon
  
  const btnStop = document.createElement('button');
  btnStop.className = 'btn stop';
  btnStop.title = 'Stop Record';
  btnStop.innerHTML = '⏹️';

  const divider = document.createElement('div');
  divider.className = 'divider';

  const btnDraw = document.createElement('button');
  btnDraw.className = 'btn';
  btnDraw.title = 'Toggle Draw Mode';
  btnDraw.innerHTML = '✏️';

  const colorPickerWrapper = document.createElement('div');
  colorPickerWrapper.className = 'color-picker';
  
  const colors = [
    { class: 'c-red', value: '#ff0000' },
    { class: 'c-blue', value: '#0088ff' },
    { class: 'c-green', value: '#00d26a' },
    { class: 'c-yellow', value: '#ffea00' }
  ];

  colors.forEach((c, i) => {
    const dot = document.createElement('div');
    dot.className = `color-dot ${c.class} ${i === 0 ? 'active' : ''}`;
    dot.onclick = () => {
      currentColor = c.value;
      colorPickerWrapper.querySelectorAll('.color-dot').forEach(el => el.classList.remove('active'));
      dot.classList.add('active');
    };
    colorPickerWrapper.appendChild(dot);
  });

  const btnClear = document.createElement('button');
  btnClear.className = 'clear';
  btnClear.innerText = 'Clear';
  btnClear.onclick = () => {
    if (drawCtx && drawCanvas) {
      drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    }
  };
  colorPickerWrapper.appendChild(btnClear);

  let isPaused = initiallyPaused;
  
  btnPause.addEventListener('click', () => {
    isPaused = !isPaused;
    btnPause.innerHTML = isPaused ? '▶️' : '⏸️';
    chrome.runtime.sendMessage({ action: isPaused ? 'PAUSE_RECORDING' : 'RESUME_RECORDING' });
  });

  btnStop.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'STOP_RECORDING' });
  });

  btnDraw.addEventListener('click', () => {
    isDrawingMode = !isDrawingMode;
    if (isDrawingMode) {
      btnDraw.classList.add('draw-active');
      colorPickerWrapper.classList.add('show');
      if (drawCanvas) drawCanvas.style.pointerEvents = 'auto'; // Enable draw focus
    } else {
      btnDraw.classList.remove('draw-active');
      colorPickerWrapper.classList.remove('show');
      if (drawCanvas) drawCanvas.style.pointerEvents = 'none'; // Revert to click-through
    }
  });

  widget.appendChild(timer);
  widget.appendChild(btnPause);
  widget.appendChild(btnStop);
  widget.appendChild(divider);
  widget.appendChild(btnDraw);
  widget.appendChild(colorPickerWrapper);
  
  shadow.appendChild(style);
  shadow.appendChild(widget);
  
  document.documentElement.appendChild(widgetContainer);

  // Dragging logic
  let isDragging = false;
  let offsetX = 0;
  let offsetY = 0;

  widget.addEventListener('mousedown', (e) => {
    // Hindari drag jika yang diklik adalah tombol/warna
    if (e.target.tagName.toLowerCase() === 'button' || e.target.closest('.btn') || e.target.classList.contains('color-dot')) return;
    
    isDragging = true;
    const rect = widgetContainer.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    
    // Matikan bottom/right lock bawaan css karena kita sekarang memanipulasi .top dan .left
    widgetContainer.style.bottom = 'auto';
    widgetContainer.style.right = 'auto';
    
    const x = e.clientX - offsetX;
    const y = e.clientY - offsetY;
    widgetContainer.style.left = x + 'px';
    widgetContainer.style.top = y + 'px';
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
  });

  secondsRecord = initialSeconds;
  timerInterval = setInterval(() => {
    if (!isPaused) {
      secondsRecord++;
      const m = String(Math.floor(secondsRecord / 60)).padStart(2, '0');
      const s = String(secondsRecord % 60).padStart(2, '0');
      timer.innerText = `${m}:${s}`;
    }
  }, 1000);

  // Initialize Canvas
  setupCanvas();
}

let isDrawingMode = false;
let drawCanvas = null;
let drawCtx = null;
let currentColor = '#ff0000';
let isDrawing = false;
let resizeListener = null;

function setupCanvas() {
  if (drawCanvas) return;
  drawCanvas = document.createElement('canvas');
  drawCanvas.id = 'bug-reporter-drawing-canvas';
  drawCanvas.style.position = 'fixed';
  drawCanvas.style.top = '0';
  drawCanvas.style.left = '0';
  drawCanvas.style.zIndex = '2147483646'; // Just under the widget shadow root
  drawCanvas.style.pointerEvents = 'none';
  
  const resizeContent = () => {
    // Save image
    const tempCanvas = document.createElement('canvas');
    if (drawCanvas.width > 0 && drawCanvas.height > 0) {
       tempCanvas.width = drawCanvas.width;
       tempCanvas.height = drawCanvas.height;
       tempCanvas.getContext('2d').drawImage(drawCanvas, 0, 0);
    }
    
    drawCanvas.width = window.innerWidth;
    drawCanvas.height = window.innerHeight;
    
    // Restore image
    drawCtx = drawCanvas.getContext('2d');
    if (tempCanvas.width > 0) {
      drawCtx.drawImage(tempCanvas, 0, 0);
    }
  };
  
  resizeContent();
  resizeListener = resizeContent;
  window.addEventListener('resize', resizeContent);

  drawCanvas.addEventListener('mousedown', (e) => {
    isDrawing = true;
    drawCtx.beginPath();
    drawCtx.moveTo(e.clientX, e.clientY);
  });
  
  drawCanvas.addEventListener('mousemove', (e) => {
    if (!isDrawing) return;
    drawCtx.lineTo(e.clientX, e.clientY);
    drawCtx.strokeStyle = currentColor;
    drawCtx.lineWidth = 4;
    drawCtx.lineCap = 'round';
    drawCtx.lineJoin = 'round';
    drawCtx.stroke();
  });

  drawCanvas.addEventListener('mouseup', () => isDrawing = false);
  drawCanvas.addEventListener('mouseout', () => isDrawing = false);

  (document.body || document.documentElement).appendChild(drawCanvas);
}

function removeWidget() {
  if (widgetContainer) {
    widgetContainer.remove();
    widgetContainer = null;
  }
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  if (drawCanvas) {
    drawCanvas.remove();
    drawCanvas = null;
    isDrawingMode = false;
  }
  if (resizeListener) {
    window.removeEventListener('resize', resizeListener);
    resizeListener = null;
  }
}
