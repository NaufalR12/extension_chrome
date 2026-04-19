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
  
  chrome.runtime.sendMessage({
    action: 'LOG_CAPTURED',
    type: event.data.type,
    payload: event.data.payload
  });
});

// Capture Actions (clicks and inputs)
document.addEventListener('click', (e) => {
  const target = e.target;
  let elementDesc = target.tagName.toLowerCase();
  if (target.id) elementDesc += `#${target.id}`;
  if (target.className && typeof target.className === 'string') {
    elementDesc += `.${target.className.split(' ').join('.')}`;
  }
  if (target.innerText) {
    let text = target.innerText.substring(0, 20).replace(/\n/g, ' ');
    elementDesc += ` ("${text}")`;
  }
  
  chrome.runtime.sendMessage({
    action: 'LOG_CAPTURED',
    type: 'ACTIONS',
    payload: {
      time: new Date().toISOString(),
      event: 'Click',
      element: elementDesc
    }
  });
}, true);

document.addEventListener('input', (e) => {
  const target = e.target;
  if (!target || !target.tagName) return;
  let elementDesc = target.tagName.toLowerCase();
  if (target.id) elementDesc += `#${target.id}`;
  if (target.name) elementDesc += `[name=${target.name}]`;

  chrome.runtime.sendMessage({
    action: 'LOG_CAPTURED',
    type: 'ACTIONS',
    payload: {
      time: new Date().toISOString(),
      event: 'Input Text',
      element: elementDesc
    }
  });
}, true);

// Respond to requests
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'GET_RESOLUTION') {
    sendResponse({ resolution: `${window.innerWidth}x${window.innerHeight}` });
  } else if (request.action === 'SHOW_WIDGET') {
    createWidget();
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
      display: flex;
      align-items: center;
      background: #1e1e2e;
      color: white;
      padding: 8px 16px;
      border-radius: 50px;
      font-family: sans-serif;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      gap: 12px;
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
    .timer { font-variant-numeric: tabular-nums; font-weight: bold; width: 50px; text-align: center; }
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

  let isPaused = false;
  
  btnPause.addEventListener('click', () => {
    isPaused = !isPaused;
    btnPause.innerHTML = isPaused ? '▶️' : '⏸️';
    chrome.runtime.sendMessage({ action: isPaused ? 'PAUSE_RECORDING' : 'RESUME_RECORDING' });
  });

  btnStop.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'STOP_RECORDING' });
  });

  widget.appendChild(timer);
  widget.appendChild(btnPause);
  widget.appendChild(btnStop);
  
  shadow.appendChild(style);
  shadow.appendChild(widget);
  
  document.documentElement.appendChild(widgetContainer);

  secondsRecord = 0;
  timerInterval = setInterval(() => {
    if (!isPaused) {
      secondsRecord++;
      const m = String(Math.floor(secondsRecord / 60)).padStart(2, '0');
      const s = String(secondsRecord % 60).padStart(2, '0');
      timer.innerText = `${m}:${s}`;
    }
  }, 1000);
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
}
