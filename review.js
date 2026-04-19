document.addEventListener('DOMContentLoaded', () => {
  const videoPreview = document.getElementById('videoPreview');
  const btnSave = document.getElementById('btnSave');
  const inputTitle = document.getElementById('inputTitle');
  const inputDesc = document.getElementById('inputDesc');
  const stepForm = document.getElementById('stepForm');
  const stepSuccess = document.getElementById('stepSuccess');
  const shareLink = document.getElementById('shareLink');
  const btnCopy = document.getElementById('btnCopy');
  const loading = document.getElementById('loading');
  const errorMsg = document.getElementById('errorMsg');

  // Logs Tabs Setup
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.panel');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));

      tab.classList.add('active');
      const targetId = tab.getAttribute('data-target');
      document.getElementById(targetId).classList.add('active');
    });
  });

  // Fetch and display logs
  chrome.storage.local.get(['sessionLogs'], (res) => {
    const sessionLogs = res.sessionLogs || { console: [], network: [], actions: [], backend: [] };

    // Update Console
    const consoleLogHtml = sessionLogs.console.map(l => `<div class="log-entry ${l.type}">[${l.time}] ${l.type.toUpperCase()}: ${l.message}</div>`).join('');
    document.getElementById('consoleLogs').innerHTML = consoleLogHtml || '<div class="log-entry">No console logs</div>';

    // Update Network
    const networkLogHtml = sessionLogs.network.map(n => `<div class="log-entry">[${n.time}] ${n.method} ${n.url} - ${n.status || 'PENDING'}</div>`).join('');
    document.getElementById('networkLogs').innerHTML = networkLogHtml || '<div class="log-entry">No network logs</div>';

    // Update Actions
    const actionLogHtml = sessionLogs.actions.map(a => `<div class="log-entry">[${a.time}] ${a.event}: ${a.element}</div>`).join('');
    document.getElementById('actionLogs').innerHTML = actionLogHtml || '<div class="log-entry">No actions captured</div>';

    // Update Backend Logs
    if (sessionLogs.backend && sessionLogs.backend.length > 0) {
      const backendLogHtml = sessionLogs.backend.map(s => `<div class="log-entry error">[${s.time}] ${s.type}: ${s.message}</div>`).join('');
      document.getElementById('backendLogs').innerHTML = backendLogHtml;
    } else {
      document.getElementById('backendLogs').innerHTML = '<div class="log-entry">No backend logs</div>';
    }
  });

  // Populate Environment Info
  document.getElementById('infoBrowser').textContent = getBrowserInfo();
  document.getElementById('infoOS').textContent = getOSInfo();
  
  chrome.storage.local.get(['sessionLogs'], (res) => {
    let url = '-';
    if (res && res.sessionLogs && res.sessionLogs.info && res.sessionLogs.info.url) {
      url = res.sessionLogs.info.url;
    }
    document.getElementById('infoUrl').textContent = url;
    document.getElementById('infoRes').textContent = window.screen.width + 'x' + window.screen.height;
  });

  // Fetch pending video from background
  chrome.runtime.sendMessage({ action: 'GET_PENDING_VIDEO' }, (res) => {
    if (res && res.videoBase64) {
      const byteCharacters = atob(res.videoBase64);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: 'video/webm' });
      
      const videoUrl = URL.createObjectURL(blob);
      videoPreview.src = videoUrl;
    } else {
      errorMsg.textContent = "Error: No video found to review.";
      errorMsg.classList.remove('hidden');
    }
  });

  btnSave.addEventListener('click', () => {
    const title = inputTitle.value.trim();
    const desc = inputDesc.value.trim();

    if (!title) {
      inputTitle.style.borderColor = 'red';
      return;
    }

    inputTitle.style.borderColor = '#ccc';
    btnSave.disabled = true;
    loading.classList.remove('hidden');
    errorMsg.classList.add('hidden');

    chrome.runtime.sendMessage({
      action: 'COMMIT_UPLOAD',
      title: title,
      description: desc,
      info: {
        browser: document.getElementById('infoBrowser').textContent,
        os: document.getElementById('infoOS').textContent,
        resolution: document.getElementById('infoRes').textContent,
        url: document.getElementById('infoUrl')?.textContent || window.location.href
      }
    }, (res) => {
      btnSave.disabled = false;
      loading.classList.add('hidden');

      if (res && res.success) {
        stepForm.classList.add('hidden');
        stepSuccess.classList.remove('hidden');
        shareLink.value = res.url;
      } else {
        errorMsg.textContent = "Upload failed: " + (res.error || 'Unknown error');
        errorMsg.classList.remove('hidden');
      }
    });
  });

  btnCopy.addEventListener('click', () => {
    shareLink.select();
    document.execCommand('copy');
    const ogText = btnCopy.textContent;
    btnCopy.textContent = 'Copied!';
    setTimeout(() => { btnCopy.textContent = ogText; }, 2000);
  });
});

function getBrowserInfo() {
  const ua = navigator.userAgent;
  let tem, M = ua.match(/(opera|chrome|safari|firefox|msie|trident(?=\/))\/?\s*(\d+)/i) || [];
  if (/trident/i.test(M[1])) {
    tem = /\brv[ :]+(\d+)/g.exec(ua) || [];
    return 'IE ' + (tem[1] || '');
  }
  if (M[1] === 'Chrome') {
    tem = ua.match(/\b(OPR|Edge)\/(\d+)/);
    if (tem != null) return tem.slice(1).join(' ').replace('OPR', 'Opera');
  }
  M = M[2] ? [M[1], M[2]] : [navigator.appName, navigator.appVersion, '-?'];
  if ((tem = ua.match(/version\/(\d+)/i)) != null) M.splice(1, 1, tem[1]);
  return M.join(' ');
}

function getOSInfo() {
  if (navigator.userAgent.indexOf("Win") != -1) return "Windows";
  if (navigator.userAgent.indexOf("Mac") != -1) return "MacOS";
  if (navigator.userAgent.indexOf("Linux") != -1) return "Linux";
  if (navigator.userAgent.indexOf("X11") != -1) return "UNIX";
  return "Unknown OS";
}
