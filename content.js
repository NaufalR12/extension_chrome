// Inject script into main world
const script = document.createElement('script');
script.src = chrome.runtime.getURL('injected.js');
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
    // LocalStorage keys (max 20, sensor sensitif)
    const sensitiveKeys = ['password', 'token', 'secret', 'key', 'auth', 'credential'];
    const localStorageData = {};
    for (let i = 0; i < Math.min(window.localStorage.length, 20); i++) {
      const k = window.localStorage.key(i);
      const isSensitive = sensitiveKeys.some(s => k.toLowerCase().includes(s));
      localStorageData[k] = isSensitive ? '***** Auto-filtered' : window.localStorage.getItem(k).substring(0, 200);
    }

    // SessionStorage keys (max 20)
    const sessionStorageData = {};
    for (let i = 0; i < Math.min(window.sessionStorage.length, 20); i++) {
      const k = window.sessionStorage.key(i);
      const isSensitive = sensitiveKeys.some(s => k.toLowerCase().includes(s));
      sessionStorageData[k] = isSensitive ? '***** Auto-filtered' : window.sessionStorage.getItem(k).substring(0, 200);
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
  if (request.action === 'GET_RESOLUTION') {
    sendResponse({ resolution: `${window.innerWidth}x${window.innerHeight}` });
  } else if (request.action === 'SHOW_WIDGET') {
    createWidget();
    // Capture and send environment snapshot when recording starts
    const env = captureEnvironment();
    try {
      chrome.runtime.sendMessage({ action: 'SAVE_ENVIRONMENT', payload: env });
    } catch(e) {}
    sendResponse({ ok: true });
  } else if (request.action === 'HIDE_WIDGET') {
    removeWidget();
    sendResponse({ ok: true });
  }
});

let widgetContainer = null;
let timerInterval = null;
let secondsRecord = 0;

function createWidget() {
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
  timer.innerText = '00:00';
  
  const btnPause = document.createElement('button');
  btnPause.className = 'btn';
  btnPause.title = 'Pause Record';
  btnPause.innerHTML = '⏸️'; // Simple emoji icon
  
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

  let isPaused = false;
  
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

  secondsRecord = 0;
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
