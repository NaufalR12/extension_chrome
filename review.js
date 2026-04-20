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
    const sessionLogs = res.sessionLogs || { console: [], network: [], actions: [], backend: [], info: {} };

    function parseSec(timeStr) {
      if (!timeStr) return 0;
      const match = timeStr.match(/\[(\d+):(\d+)\]/);
      if (match) {
        return parseInt(match[1]) * 60 + parseInt(match[2]);
      }
      return 0;
    }

    // --- CONSOLE & UNIFIED LOGIC ---
    let unified = [];
    function rebuildUnified() {
        unified = [];
        (sessionLogs.console || []).forEach(l => unified.push({...l, _cat: 'console'}));
        (sessionLogs.network || []).forEach(n => unified.push({...n, _cat: 'network'}));
        (sessionLogs.actions || []).forEach(a => unified.push({...a, _cat: 'action'}));
        unified.sort((a,b) => parseSec(a.time) - parseSec(b.time));
    }

    let uSearch = '';
    let showPageNav = true;
    let showNetErr = true;
    let showUsrAct = true;
    
    function renderUnified() {
      const filtered = unified.filter(item => {
        if (!showPageNav && item._cat === 'action' && item.event && item.event.includes('Navigated')) return false;
        if (!showNetErr && item._cat === 'network') {
            const isErr = (item.status === 'CACHE_MISS' || (item.status && item.status >= 400));
            if (!isErr) return false;
        }
        if (!showUsrAct && item._cat === 'action' && !item.event.includes('Navigated')) return false;
        
        if (uSearch) {
          const lowerS = uSearch.toLowerCase();
          const str = JSON.stringify(item).toLowerCase();
          if (!str.includes(lowerS)) return false;
        }
        return true;
      });
      
      const cHtml = filtered.map(item => {
        const match = (item.time || '').match(/\[(\d+:\d+)\]/);
        const t = match ? match[1] : '0:00';
        const sec = parseSec(item.time);
        
        let icon = '', content = '', css = '';
        if (item._cat === 'console') {
          icon = '💬'; css = item.type === 'error' ? 'error' : '';
          content = `${item.type ? item.type.toUpperCase() : 'LOG'}: ${item.message}`;
        } else if (item._cat === 'network') {
          const isErr = (item.status === 'CACHE_MISS' || (item.status && item.status >= 400));
          icon = '⇄'; css = isErr ? 'error' : 'net';
          content = `<b>${item.method}</b> ${item.url}`;
        } else if (item._cat === 'action') {
          const isNav = item.event && item.event.includes('Navigated');
          const isClick = item.event && item.event.includes('Click');
          const isType = item.event && (item.event.includes('Typed') || item.event.includes('Input'));
          
          if (isNav) {
            css = 'nav';
            icon = '🌐';
            const methodTag = item.method ? ` <span style="color:#888;font-size:11px">via ${item.method}</span>` : '';
            content = `Navigated to <a href="${item.element}" target="_blank" style="color: #1a73e8; text-decoration: none;">${item.element}</a>${methodTag}`;
          } else if (isClick) {
            icon = '🖱️';
            css = 'clicked';
            const rawEl = item.element || '';
            const tagMatch = rawEl.match(/^<([a-z0-9]+)/i);
            const tagName = tagMatch ? tagMatch[1] : 'element';
            const attrs = rawEl.replace(/^<[a-z0-9]+/i, '').replace(/>$/, '').trim();
            const cleanFull = (item.fullHtml || item.element || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            
            content = `Clicked <b>&lt;${tagName}</b> 
                      ${attrs ? `<span class="attr-text" style="color:#666; font-family:monospace;">${attrs.substring(0, 50)}${attrs.length > 50 ? '...' : ''}</span>` : ''}
                      <b>&gt;</b>
                      <span class="collapse-toggle" style="float:right;color:#1a73e8;cursor:pointer;font-size:11px;" onclick="event.stopPropagation(); const pre = this.parentElement.querySelector('pre'); pre.style.display = pre.style.display === 'block' ? 'none' : 'block'; this.innerText = pre.style.display === 'block' ? 'collapse' : 'expand';">expand</span>
                      <pre class="code-block" style="display:none;margin-top:8px;padding:10px;background:#f8f9fa;color:#d93025;border-radius:4px;font-size:11px;overflow-x:auto;border:1px solid #eee;white-space:pre-wrap;">${cleanFull}</pre>`;
          } else if (isType) {
            icon = '⌨️';
            css = 'typed';
            content = `Typed <b style="background:#f0f0f0;padding:2px 4px;border-radius:4px;font-family:monospace;font-weight:normal;border:1px solid #ddd;">${item.value || '***'}</b>`;
          } else {
            icon = '🪄';
            content = `${item.event} ${item.element}`;
          }
        }
        return `<div class="u-entry ${css}" data-time="${sec}"><div class="u-time">${t}</div><div class="u-icon">${icon}</div><div class="u-cont">${content}</div></div>`;
      }).join('');
      
      const startEntry = `<div class="u-entry nav"><div class="u-time">0:00</div><div class="u-icon">▶</div><div class="u-cont">Video started</div></div>`;
      document.getElementById('consoleLogs').innerHTML = startEntry + cHtml;
    }

    rebuildUnified();
    renderUnified();

    // Attach Listeners
    const cInput = document.getElementById('consoleFilterInput');
    if (cInput) cInput.addEventListener('input', e => { uSearch = e.target.value; renderUnified(); });
    const tNav = document.getElementById('toggleNav');
    if (tNav) tNav.addEventListener('click', () => { showPageNav = !showPageNav; tNav.classList.toggle('active', showPageNav); renderUnified(); });
    const tNet = document.getElementById('toggleNetErr');
    if (tNet) tNet.addEventListener('click', () => { showNetErr = !showNetErr; tNet.classList.toggle('active', showNetErr); renderUnified(); });
    const tUsr = document.getElementById('toggleUsrAct');
    if (tUsr) tUsr.addEventListener('click', () => { showUsrAct = !showUsrAct; tUsr.classList.toggle('active', showUsrAct); renderUnified(); });

    // --- NETWORK LOGIC ---
    let nSearch = '';
    let nTypeFilter = 'all';
    let nErrorsOnly = false;
    let selectedReq = null;

    function formatSize(bytes) {
        if (!bytes || bytes === 0) return '';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function renderNetwork() {
      const netArr = sessionLogs.network || [];
      const filtered = netArr.filter(n => {
        if (nErrorsOnly) {
          const isErr = (n.status === 'CACHE_MISS' || (n.status && n.status >= 400));
          if (!isErr) return false;
        }
        if (nTypeFilter !== 'all') {
          const t = (n.type || 'xhr').toLowerCase();
          if (nTypeFilter === 'xhr' && !['xhr', 'fetch'].includes(t)) return false;
          if (nTypeFilter !== 'xhr' && !t.includes(nTypeFilter)) return false;
        }
        if (nSearch) {
          if (!n.url.toLowerCase().includes(nSearch.toLowerCase())) return false;
        }
        return true;
      });

      const nHtml = filtered.map((n, i) => {
        const match = (n.time || '').match(/\[(\d+:\d+)\]/);
        const isErr = (n.status === 'CACHE_MISS' || (n.status && n.status >= 400));
        const name = n.url.split('/').pop() || n.url;
        let domain = '';
        try { domain = new URL(n.url).hostname; } catch(e){}
        
        return `<tr class="${isErr?'error-row':''} ${selectedReq === n ? 'selected' : ''}" data-idx="${netArr.indexOf(n)}">
          <td>${i+1}</td>
          <td><div title="${n.url}">${name}</div></td>
          <td>${n.method}</td>
          <td>${isErr ? (n.status === 'CACHE_MISS' ? 'CACHE_MISS' : n.status) : (n.status || '200')}</td>
          <td>${domain}</td>
          <td>${n.type||'xhr'}</td>
          <td>-</td>
          <td>0</td>
          <td>${n.size ? formatSize(n.size) : (n.isStatic ? '(Cached)' : '')}</td>
          <td>${n.duration ? n.duration + ' ms' : ''}</td>
          <td><div class="waterfall-bar" style="width: ${Math.min(n.duration/10, 50)}px"></div></td>
        </tr>`;
      }).join('');
      document.getElementById('networkLogs').innerHTML = nHtml || '<tr><td colspan="11" style="text-align:center">No network logs</td></tr>';

      // Attach row clicks
      document.querySelectorAll('#networkLogs tr').forEach(row => {
        row.addEventListener('click', () => {
          const idx = parseInt(row.getAttribute('data-idx'));
          selectedReq = netArr[idx];
          renderNetwork();
          showDetails(selectedReq);
        });
      });
    }

    // Detail Panel Logic
    const panel = document.getElementById('networkDetailsPanel');
    const closeBtn = document.getElementById('closeDetails');
    const dTabs = document.querySelectorAll('.d-tab');
    const dPanels = document.querySelectorAll('.d-panel');
    const dList = document.getElementById('detailsHeaders');

    function showDetails(req) {
      if (!req) return;
      panel.classList.add('open');
      renderDetailTab('headers', req);
    }

    closeBtn.addEventListener('click', () => {
      panel.classList.remove('open');
      selectedReq = null;
      renderNetwork();
    });

    dTabs.forEach(t => {
      t.addEventListener('click', () => {
        dTabs.forEach(i => i.classList.remove('active'));
        dPanels.forEach(i => i.classList.remove('active'));
        dList.classList.remove('active');
        t.classList.add('active');
        const tool = t.getAttribute('data-dtool');
        if (tool === 'headers') dList.classList.add('active');
        else document.getElementById('details'+tool.charAt(0).toUpperCase()+tool.slice(1)).classList.add('active');
        if (selectedReq) renderDetailTab(tool, selectedReq);
      });
    });

    function renderDetailTab(tab, req) {
      const pCont = document.getElementById('detailsPayload');
      const rCont = document.getElementById('detailsResponse');

      if (tab === 'headers') {
        let html = `
          <div class="detail-section">
            <div class="detail-section-header">General</div>
            <div class="detail-item"><div class="detail-label">Request URL:</div><div class="detail-value">${req.url}</div></div>
            <div class="detail-item"><div class="detail-label">Request Method:</div><div class="detail-value">${req.method}</div></div>
            <div class="detail-item"><div class="detail-label">Status Code:</div><div class="detail-value status-200">${req.status || '200'}</div></div>
          </div>`;
        
        if (req.responseHeaders) {
          html += `<div class="detail-section">
            <div class="detail-section-header">Response Headers</div>`;
          for (let k in req.responseHeaders) {
            html += `<div class="detail-item"><div class="detail-label">${k}:</div><div class="detail-value">${req.responseHeaders[k]}</div></div>`;
          }
          html += `</div>`;
        }

        if (req.requestHeaders) {
          html += `<div class="detail-section">
            <div class="detail-section-header">Request Headers</div>`;
          for (let k in req.requestHeaders) {
            html += `<div class="detail-item"><div class="detail-label">${k}:</div><div class="detail-value">${req.requestHeaders[k]}</div></div>`;
          }
          html += `</div>`;
        }
        dList.innerHTML = html;
      } else if (tab === 'payload') {
        pCont.innerHTML = req.isStatic ? '<div class="p-4 text-gray-500">Not available for static resources</div>' : `<div class="detail-value" style="white-space:pre-wrap;background:#f8f9fa;padding:16px;">${req.requestBody || '(No payload)'}</div>`;
      } else if (tab === 'response') {
        rCont.innerHTML = req.isStatic ? '<div class="p-4 text-gray-500">Not available for static resources</div>' : `<div class="detail-value" style="white-space:pre-wrap;background:#f8f9fa;padding:16px;">${req.responseBody || '(No response captured)'}</div>`;
      }
    }

    // Copy / cURL Handlers
    document.querySelectorAll('.details-header .pill-sm').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!selectedReq) return;
            const text = btn.innerText.toLowerCase();
            if (text === 'copy') {
                const body = selectedReq.responseBody || '';
                navigator.clipboard.writeText(body);
                btn.innerText = 'Copied!';
                setTimeout(() => btn.innerText = 'Copy', 2000);
            } else if (text === 'curl') {
                const curl = `curl '${selectedReq.url}' -X ${selectedReq.method} ${Object.entries(selectedReq.requestHeaders || {}).map(([k,v]) => `-H '${k}: ${v}'`).join(' ')}`;
                navigator.clipboard.writeText(curl);
                btn.innerText = 'Copied!';
                setTimeout(() => btn.innerText = 'cURL', 2000);
            }
        });
    });

    // Network Listeners
    document.getElementById('networkFilterInput').addEventListener('input', e => { nSearch = e.target.value; renderNetwork(); });
    document.getElementById('networkErrorsOnly').addEventListener('change', e => { nErrorsOnly = e.target.checked; renderNetwork(); });
    document.querySelectorAll('#networkPills button').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#networkPills button').forEach(b => b.classList.remove('active', 'pill-dark'));
        btn.classList.add('active', 'pill-dark');
        nTypeFilter = btn.getAttribute('data-filter');
        renderNetwork();
      });
    });

    renderNetwork();

    // --- ACTIONS LIST ---
    const aHtml = (sessionLogs.actions || []).map(a => {
        const match = (a.time || '').match(/\[(\d+:\d+)\]/);
        const t = match ? match[1] : '0:00';
        const sec = parseSec(a.time);
        const isNav = a.event && a.event.includes('Navigated');
        const isClick = a.event && a.event.includes('Click');
        const isInput = a.event && (a.event.includes('Typed') || a.event.includes('Input') || a.event.includes('Change'));
        
        let icon = '🪄', content = '', css = '';
        if (isNav) {
            icon = '🌐'; css = 'nav';
            const methodTag = a.method ? ` <span style="color:#888;font-size:11px">via ${a.method}</span>` : '';
            content = `Navigated to <a href="${a.element}" target="_blank" style="color: #1a73e8; text-decoration: none;">${a.element || 'Unknown URL'}</a>${methodTag}`;
        } else if (isClick) {
            icon = '🖱️'; css = 'clicked';
            const rawEl = a.element || '';
            const tagMatch = rawEl.match(/^<([a-z0-9]+)/i);
            const tagName = tagMatch ? tagMatch[1] : 'element';
            const attrs = rawEl.replace(/^<[a-z0-9]+/i, '').replace(/>$/, '').trim();
            const cleanFull = (a.fullHtml || a.element || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

            content = `Clicked <b>&lt;${tagName}</b> 
                      ${attrs ? `<span class="attr-text" style="color:#666; font-family:monospace;">${attrs.substring(0, 50)}${attrs.length > 50 ? '...' : ''}</span>` : ''}
                      <b>&gt;</b>
                      <span class="collapse-toggle" style="float:right;color:#1a73e8;cursor:pointer;font-size:11px;" onclick="event.stopPropagation(); const pre = this.parentElement.querySelector('pre'); pre.style.display = pre.style.display === 'block' ? 'none' : 'block'; this.innerText = pre.style.display === 'block' ? 'collapse' : 'expand';">expand</span>
                      <pre class="code-block" style="display:none;margin-top:8px;padding:10px;background:#f8f9fa;color:#d93025;border-radius:4px;font-size:11px;overflow-x:auto;border:1px solid #eee;white-space:pre-wrap;">${cleanFull}</pre>`;
        } else if (isInput) {
            icon = '⌨️'; css = 'typed';
            const val = a.value || '***';
            content = `Typed <b style="background:#f0f0f0;padding:2px 4px;border-radius:4px;font-family:monospace;font-weight:normal;border:1px solid #ddd;">${val}</b>`;
        } else {
            content = `<strong>${a.event}</strong><br><small>${a.element}</small>`;
        }

        return `<div class="u-entry ${css}" data-time="${sec}" style="cursor:pointer">
          <div class="u-time">${t}</div>
          <div class="u-icon">${icon}</div>
          <div class="u-cont">${content}</div>
        </div>`;
    }).join('');
    document.getElementById('actionLogs').innerHTML = aHtml || '<div class="u-entry" style="padding:20px; text-align:center; color:#999;">No actions recorded.</div>';

    // Click to seek in review
    document.querySelectorAll('#actionLogs .u-entry').forEach(el => {
      el.addEventListener('click', () => {
        const t = parseFloat(el.getAttribute('data-time'));
        videoPreview.currentTime = t;
      });
    });

    // Update Backend Logs
    if (sessionLogs.backend && sessionLogs.backend.length > 0) {
      const backendLogHtml = sessionLogs.backend.map(s => `
        <div class="log-entry error" style="padding:12px; border-bottom:1px solid #eee;">
          <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
            <strong style="color:#d93025;">${s.type}</strong>
            <span style="color:#888; font-size:11px;">${s.time}</span>
          </div>
          <div style="font-weight:bold; margin-bottom:8px;">${s.message}</div>
          ${s.stack ? `<pre style="background:#fff5f5; padding:10px; border-radius:4px; font-size:11px; overflow-x:auto; border:1px solid #ffd2cf; color:#444;">${s.stack}</pre>` : ''}
          ${s.source ? `<div style="font-size:11px; color:#666; margin-top:4px;">Source: ${s.source}</div>` : ''}
        </div>
      `).join('');
      document.getElementById('backendLogs').innerHTML = backendLogHtml;
    } else {
      document.getElementById('backendLogs').innerHTML = '<div class="log-entry" style="padding:20px; text-align:center; color:#999;">No backend errors detected during this session.</div>';
    }

    // URL Timeline Logic
    let tl = [];
    if (sessionLogs.info && sessionLogs.info.urlTimeline) {
      tl = sessionLogs.info.urlTimeline;
    } else if (sessionLogs.info && sessionLogs.info.url) {
      tl = [{ time: 0, url: sessionLogs.info.url }];
    } else {
      tl = [{ time: 0, url: '-' }];
    }
    
    const visitedUrlsList = document.getElementById('visitedUrlsList');
    if (visitedUrlsList) {
      function formatT(sec) {
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
      }
      
      const listHtml = tl.map((item, idx) => `
        <div class="url-item ${idx === 0 ? 'active' : ''}" data-time="${item.time}">
          <div class="url-time">${formatT(item.time)}</div>
          <a href="${item.url}" target="_blank" class="url-path" title="${item.url}">${item.url}</a>
        </div>
      `).join('');
      
      visitedUrlsList.innerHTML = listHtml || '<div class="log-entry">No URLs recorded</div>';
      
      const urlItems = visitedUrlsList.querySelectorAll('.url-item');
      urlItems.forEach(el => {
        el.addEventListener('click', () => {
          const t = parseFloat(el.getAttribute('data-time'));
          videoPreview.currentTime = t;
        });
      });
    }

    // Populate Environment Info (inside callback to use sessionLogs if needed)
    document.getElementById('infoBrowser').textContent = sessionLogs.info?.browser || getBrowserInfo();
    document.getElementById('infoOS').textContent = sessionLogs.info?.os || getOSInfo();
    document.getElementById('infoRes').textContent = sessionLogs.info?.resolution || (window.screen.width + 'x' + window.screen.height);
    document.getElementById('infoLocation').textContent = sessionLogs.info?.location || "-";
    document.getElementById('infoTimestamp').textContent = sessionLogs.info?.timestamp || "Unknown";

  }); // End storage get

  // Timeline tracker (attached to video preview)
  videoPreview.addEventListener('timeupdate', () => {
    const currentSec = videoPreview.currentTime;
    
    // Calculate active URL
    const items = document.querySelectorAll('.url-item');
    let activeIdx = 0;
    items.forEach((item, idx) => {
      const t = parseFloat(item.getAttribute('data-time') || 0);
      if (t <= currentSec) activeIdx = idx;
    });
    
    items.forEach((item, idx) => {
      if (idx === activeIdx) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });
    
    // Sync Console and Actions timelines
    ['consoleLogs', 'actionLogs'].forEach(containerId => {
      const container = document.getElementById(containerId);
      if (!container) return;
      const entries = container.querySelectorAll('.u-entry');
      let activeEl = null;

      entries.forEach(el => {
        const t = parseFloat(el.getAttribute('data-time') || 0);
        if (t <= currentSec) {
          activeEl = el;
        }
        el.classList.remove('active-timeline');
      });
      
      if (activeEl) {
        activeEl.classList.add('active-timeline');
      }
    });
  });

  // Fetch pending video from background
  chrome.runtime.sendMessage({ action: 'GET_PENDING_VIDEO' }, (res) => {
    if (res && res.videoBase64) {
      try {
        const byteCharacters = atob(res.videoBase64);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: 'video/webm' });
        
        const videoUrl = URL.createObjectURL(blob);
        videoPreview.src = videoUrl;
      } catch (e) {
        console.error("Base64 decode failed", e);
        errorMsg.textContent = "Error decoding video data.";
        errorMsg.classList.remove('hidden');
      }
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
        location: document.getElementById('infoLocation').textContent,
        timestamp: document.getElementById('infoTimestamp').textContent,
        url: "-"
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
