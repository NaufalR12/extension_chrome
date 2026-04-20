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

    // Helper to jump video time and highlight log
    function jumpToVideoTime(timeMs, element) {
      if (!videoPreview || timeMs === undefined || timeMs === null) return;
      
      // Precise jump (no buffer)
      const targetSec = timeMs / 1000;
      videoPreview.currentTime = targetSec;
      
      // Visual feedback: remove highlight from others, add to this one
      document.querySelectorAll('.log-entry-active').forEach(el => el.classList.remove('log-entry-active'));
      if (element) {
        element.classList.add('log-entry-active');
        // Smooth scroll to keep element in view if needed
        element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }

    // --- JSON TREE RENDERER ---
    // Fungsi rekursif yang menghasilkan HTML tree seperti DevTools
    let _jtCounter = 0; // unique ID per node untuk toggle tanpa framework
    function renderJsonTree(value, depth) {
      depth = depth || 0;
      const uid = '_jt' + (++_jtCounter);

      if (value === null) return `<span class="jt-val-null">null</span>`;
      if (value === undefined) return `<span class="jt-val-undefined">undefined</span>`;

      const type = typeof value;
      if (type === 'string') {
        const safe = value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        const short = safe.length > 80 ? safe.substring(0, 80) + '…' : safe;
        return `<span class="jt-val-string">"${short}"</span>`;
      }
      if (type === 'number') return `<span class="jt-val-number">${value}</span>`;
      if (type === 'boolean') return `<span class="jt-val-boolean">${value}</span>`;

      if (Array.isArray(value)) {
        if (value.length === 0) return `<span class="jt-bracket">[]</span>`;
        const summary = `Array(${value.length})`;
        const items = value.slice(0, 50).map((v, i) =>
          `<span class="jt-node"><span class="jt-key">${i}</span><span class="jt-punct">: </span>${renderJsonTree(v, depth+1)}</span>`
        ).join('');
        return `<span class="jt-toggle" data-toggle="json" data-target="${uid}"><span class="jt-caret">▶</span><span class="jt-bracket">[</span><span class="jt-summary">${summary}</span><span class="jt-bracket">]</span></span><span class="jt-children" id="${uid}">${items}${value.length > 50 ? '<span class="jt-val-null">…'+value.length+' items</span>' : ''}</span>`;
      }

      if (type === 'object') {
        const keys = Object.keys(value);
        if (keys.length === 0) return `<span class="jt-bracket">{}</span>`;
        const summary = `{${keys.slice(0,3).join(', ')}${keys.length > 3 ? ', …' : ''}}`;
        const items = keys.slice(0, 50).map(k => {
          const safeK = k.replace(/&/g,'&amp;');
          return `<span class="jt-node"><span class="jt-key">"${safeK}"</span><span class="jt-punct">: </span>${renderJsonTree(value[k], depth+1)}</span>`;
        }).join('');
        return `<span class="jt-toggle" data-toggle="json" data-target="${uid}"><span class="jt-caret">▶</span><span class="jt-bracket">{</span><span class="jt-summary">${summary}</span><span class="jt-bracket">}</span></span><span class="jt-children" id="${uid}">${items}${keys.length > 50 ? '<span class="jt-val-null">…'+keys.length+' keys</span>' : ''}</span>`;
      }

      return `<span>${String(value)}</span>`;
    }

    // Render satu console log entry dengan expand/collapse DevTools-style
    function renderConsoleEntry(item, uid) {
      const level = item.level || 'log';
      const t = (item.time || '').match(/\[(\d+:\d+)\]/);
      const timeStr = t ? t[1] : '0:00';
      const sec = parseSec(item.time);
      const hasArgs = item.args && item.args.length > 0;
      const hasStack = item.stack && item.stack.trim();
      const isExpandable = hasArgs || hasStack;

      // Short message preview (always visible)
      const msgShort = (item.message || '').substring(0, 120);

      // Build expanded body: json tree per arg
      let bodyHtml = '';
      if (hasArgs) {
        bodyHtml += `<div class="jt-root">`;
        bodyHtml += item.args.map((a, i) => {
          if (a === null || a === undefined || typeof a !== 'object') {
            return `<div class="jt-node">${renderJsonTree(a)}</div>`;
          }
          return `<div class="jt-node">${renderJsonTree(a)}</div>`;
        }).join('<hr style="border:none;border-top:1px solid #eee;margin:4px 0;">');
        bodyHtml += `</div>`;
      } else {
        // fallback: full message text
        bodyHtml += `<div style="font-family:monospace;font-size:11px;white-space:pre-wrap;">${(item.message||'').replace(/</g,'&lt;')}</div>`;
      }
      if (hasStack) {
        bodyHtml += `<div class="log-stack-label" style="margin-top:6px;">Stack Trace</div>`;
        bodyHtml += `<div class="log-stack-trace">${item.stack.replace(/</g,'&lt;')}</div>`;
      }

      const chevronSection = isExpandable
        ? `<span class="log-chevron" id="chev_${uid}">▶</span>`
        : `<span class="log-chevron" style="visibility:hidden;">▶</span>`;

      const headerData = isExpandable
        ? `data-toggle="console" data-target="${uid}"`
        : '';

      const jumpIcon = `<span class="log-jump-btn" title="Jump to video time">⏯️</span>`;

      return `<div class="log-entry-expandable log-jump-target" data-time="${sec}" data-time-ms="${item.relativeMs || (sec * 1000)}">
        <div class="log-entry-header" ${headerData}>
          ${jumpIcon}
          ${chevronSection}
          <span class="log-level-badge ${level}">${level}</span>
          <span class="log-message-short">${msgShort.replace(/</g,'&lt;')}</span>
          <span class="log-time-badge">${timeStr}</span>
        </div>
        ${isExpandable ? `<div class="log-entry-body" id="body_${uid}">${bodyHtml}</div>` : ''}
      </div>`;
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
    let showThirdParty = true;

    // Deteksi domain utama dari sessionLogs.info
    const mainDomain = (() => {
      try {
        const url = sessionLogs.info && sessionLogs.info.url ? sessionLogs.info.url : '';
        return url ? new URL(url).hostname : '';
      } catch(e) { return ''; }
    })();
    
    function renderUnified() {
      const filtered = unified.filter(item => {
        if (!showPageNav && item._cat === 'action' && item.event && item.event.includes('Navigated')) return false;
        if (!showNetErr && item._cat === 'network') {
            const isErr = (item.status === 'CACHE_MISS' || (item.status && item.status >= 400));
            if (!isErr) return false;
        }
        if (!showUsrAct && item._cat === 'action' && !item.event.includes('Navigated')) return false;
        if (!showThirdParty && item._cat === 'network' && mainDomain) {
          try { 
            const itemDomain = new URL(item.url).hostname;
            if (itemDomain !== mainDomain) return false;
          } catch(e) {}
        }
        if (!showThirdParty && item._cat === 'console') {
          // Filter log dari URL yang berbeda domain jika tersedia
          if (item.url && mainDomain) {
            try { if (new URL(item.url).hostname !== mainDomain) return false; } catch(e) {}
          }
        }
        
        if (uSearch) {
          const lowerS = uSearch.toLowerCase();
          const str = JSON.stringify(item).toLowerCase();
          if (!str.includes(lowerS)) return false;
        }
        return true;
      });
      
      const cHtml = filtered.map((item, idx) => {
        const match = (item.time || '').match(/\[(\d+:\d+)\]/);
        const t = match ? match[1] : '0:00';
        const sec = parseSec(item.time);
        
        // Console items: gunakan renderer baru dengan object inspector
        if (item._cat === 'console') {
          return renderConsoleEntry(item, 'u_' + idx + '_' + sec);
        }
        
        let icon = '', content = '', css = '';
        if (item._cat === 'network') {
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
            const xpathLine = item.xpath ? `<div style="font-size:10px;color:#888;margin-top:2px;font-family:monospace;">XPath: ${item.xpath}</div>` : '';
            
            // Detail panel HTML
            const detailUid = 'ud_' + idx + '_' + sec;
            const detailHtml = `<div class="action-detail-panel" id="dp_${detailUid}">
              ${item.cssSelector ? `<div class="action-detail-row"><span class="action-detail-label">Selector</span><span class="action-detail-value selector">${item.cssSelector}</span></div>` : ''}
              ${item.xpath ? `<div class="action-detail-row"><span class="action-detail-label">XPath</span><span class="action-detail-value xpath">${item.xpath}</span></div>` : ''}
              ${(item.clientX != null) ? `<div class="action-detail-row"><span class="action-detail-label">Viewport (x,y)</span><span class="action-detail-value coord">${item.clientX}, ${item.clientY}</span></div>` : ''}
              ${(item.pageX != null) ? `<div class="action-detail-row"><span class="action-detail-label">Page (x,y)</span><span class="action-detail-value coord">${item.pageX}, ${item.pageY}</span></div>` : ''}
              ${item.textContent ? `<div class="action-detail-row"><span class="action-detail-label">Text</span><span class="action-detail-value text">${item.textContent.replace(/</g,'&lt;')}</span></div>` : ''}
            </div>`;
            
            content = `Clicked <b>&lt;${tagName}</b> 
                      ${attrs ? `<span class="attr-text" style="color:#666; font-family:monospace;">${attrs.substring(0, 50)}${attrs.length > 50 ? '...' : ''}</span>` : ''}
                      <b>&gt;</b>
                      <button class="action-expand-btn" data-toggle="action" data-target="${detailUid}">▶ details</button>
                      ${xpathLine}
                      ${detailHtml}`;
          } else if (isType) {
            icon = '⌨️';
            css = 'typed';
            content = `Typed <b style="background:#f0f0f0;padding:2px 4px;border-radius:4px;font-family:monospace;font-weight:normal;border:1px solid #ddd;">${item.value || '***'}</b>`;
          } else {
            icon = '🪄';
            content = `${item.event} ${item.element}`;
          }
        }
        const jumpIcon = `<span class="log-jump-btn" style="margin-right:4px;">⏯️</span>`;
        return `<div class="u-entry ${css} log-jump-target" data-time="${sec}" data-time-ms="${item.relativeMs || (sec * 1000)}">
          <div class="u-time">${t} ${jumpIcon}</div>
          <div class="u-icon">${icon}</div>
          <div class="u-cont">${content}</div>
        </div>`;
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
    const tThird = document.getElementById('toggleThirdParty');
    if (tThird) tThird.addEventListener('click', () => { showThirdParty = !showThirdParty; tThird.classList.toggle('active', showThirdParty); renderUnified(); });

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
        
        return `<tr class="${isErr?'error-row':''} ${selectedReq === n ? 'selected' : ''} log-jump-target" data-idx="${netArr.indexOf(n)}" data-time-ms="${n.relativeMs || (parseSec(n.time) * 1000)}">
          <td>${i+1}</td>
          <td><div title="${n.url}"><span class="log-jump-btn" style="margin-right:4px;">⏯️</span> ${name}</div></td>
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
        const isScroll = a.event && a.event.includes('Scroll');
        
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
            const xpathLine = a.xpath ? `<div style="font-size:10px;color:#888;margin-top:2px;font-family:monospace;">XPath: ${a.xpath}</div>` : '';

            // Detail panel dengan koordinat dan CSS selector
            const detailUid = 'ap_' + Math.random().toString(36).substr(2,6);
            const detailHtml = `<div class="action-detail-panel" id="dp_${detailUid}">
              ${a.cssSelector ? `<div class="action-detail-row"><span class="action-detail-label">Selector</span><span class="action-detail-value selector">${a.cssSelector}</span></div>` : ''}
              ${a.xpath ? `<div class="action-detail-row"><span class="action-detail-label">XPath</span><span class="action-detail-value xpath">${a.xpath}</span></div>` : ''}
              ${(a.clientX != null) ? `<div class="action-detail-row"><span class="action-detail-label">Viewport (x,y)</span><span class="action-detail-value coord">${a.clientX}, ${a.clientY}</span></div>` : ''}
              ${(a.pageX != null) ? `<div class="action-detail-row"><span class="action-detail-label">Page (x,y)</span><span class="action-detail-value coord">${a.pageX}, ${a.pageY}</span></div>` : ''}
              ${a.textContent ? `<div class="action-detail-row"><span class="action-detail-label">Text</span><span class="action-detail-value text">${a.textContent.replace(/</g,'&lt;')}</span></div>` : ''}
              <div class="action-detail-row" style="margin-top:6px;border-top:1px solid #eee;padding-top:6px;">
                <span class="action-detail-label">Full HTML</span>
                <pre style="margin:0;font-size:10px;color:#d93025;white-space:pre-wrap;overflow-x:auto;">${cleanFull}</pre>
              </div>
            </div>`;

            content = `Clicked <b>&lt;${tagName}</b> 
                      ${attrs ? `<span class="attr-text" style="color:#666; font-family:monospace;">${attrs.substring(0, 50)}${attrs.length > 50 ? '...' : ''}</span>` : ''}
                      <b>&gt;</b>
                      <button class="action-expand-btn" data-toggle="action" data-target="${detailUid}">▶ details</button>
                      ${xpathLine}
                      ${detailHtml}`;
        } else if (isInput) {
            icon = '⌨️'; css = 'typed';
            const val = a.value || '***';
            content = `Typed <b style="background:#f0f0f0;padding:2px 4px;border-radius:4px;font-family:monospace;font-weight:normal;border:1px solid #ddd;">${val}</b>`;
        } else if (isScroll) {
            icon = '📜'; css = '';
            content = `<span style="color:#5f6368;">Scrolled</span> <b style="background:#f0f0f0;padding:2px 4px;border-radius:4px;font-family:monospace;font-weight:normal;border:1px solid #ddd;">${a.value || '?'}</b>`;
        } else {
            content = `<strong>${a.event}</strong><br><small>${a.element}</small>`;
        }

        return `<div class="u-entry ${css} log-jump-target" data-time="${sec}" data-time-ms="${a.relativeMs || (sec * 1000)}" style="cursor:pointer">
          <div class="u-time">${t} <span class="log-jump-btn" style="display:block;margin-top:4px;">⏯️</span></div>
          <div class="u-icon">${icon}</div>
          <div class="u-cont">${content}</div>
        </div>`;
    }).join('');
    document.getElementById('actionLogs').innerHTML = aHtml || '<div class="u-entry" style="padding:20px; text-align:center; color:#999;">No actions recorded.</div>';

    // Click to seek in review
    // Click to seek in review (Legacy handler merged into global delegator below)
    /*
    document.querySelectorAll('#actionLogs .u-entry').forEach(el => {
      el.addEventListener('click', () => {
        const t = parseFloat(el.getAttribute('data-time'));
        videoPreview.currentTime = t;
      });
    });
    */

    // --- AUTO-STEPS GENERATOR (Copy Steps Button) ---
    function generateAutoSteps(actions) {
      return actions.map((a, i) => {
        const n = i + 1;
        const t = (a.time || '').replace(/[\[\]]/g, '').trim();
        const timeStr = t ? `[${t}]` : '';
        const isNav = a.event && a.event.includes('Navigated');
        const isClick = a.event && a.event.includes('Click');
        const isTyped = a.event && a.event.includes('Typed');
        const isScroll = a.event && a.event.includes('Scroll');

        if (isNav) return `${n}. ${timeStr} Navigated to ${a.element || '?'}`;
        if (isClick) {
          const tagMatch = (a.element || '').match(/^<([a-z0-9]+)/i);
          const tag = tagMatch ? tagMatch[1] : 'element';
          const idMatch = (a.element || '').match(/id="([^"]+)"/);
          const id = idMatch ? `#${idMatch[1]}` : '';
          const textContent = (a.fullHtml || '').replace(/<[^>]+>/g, '').trim().substring(0, 40);
          return `${n}. ${timeStr} Clicked <${tag}>${id}${textContent ? ` "${textContent}"` : ''}`;
        }
        if (isTyped) {
          const val = a.value === '***' ? '[password]' : (a.value || '').substring(0, 50);
          const tagMatch = (a.element || '').match(/id="([^"]+)"/);
          const id = tagMatch ? `#${tagMatch[1]}` : (a.element || '').match(/^<([a-z0-9]+)/i)?.[1] || 'input';
          return `${n}. ${timeStr} Typed "${val}" in ${id}`;
        }
        if (isScroll) return `${n}. ${timeStr} Scrolled ${a.value || '?'}`;
        return `${n}. ${timeStr} ${a.event || 'Action'}: ${a.element || ''}`;
      }).join('\n');
    }

    const btnCopySteps = document.getElementById('btnCopySteps');
    if (btnCopySteps) {
      btnCopySteps.addEventListener('click', () => {
        const steps = generateAutoSteps(sessionLogs.actions || []);
        if (!steps) {
          btnCopySteps.textContent = 'No steps!';
          setTimeout(() => { btnCopySteps.innerHTML = '📋 Copy Steps'; }, 2000);
          return;
        }
        navigator.clipboard.writeText(steps).then(() => {
          btnCopySteps.textContent = 'Copied!';
          setTimeout(() => { btnCopySteps.innerHTML = '📋 Copy Steps'; }, 2000);
        });
      });
    }

    // Update Backend Logs
    if (sessionLogs.backend && sessionLogs.backend.length > 0) {
      const backendLogHtml = sessionLogs.backend.map(s => `
        <div class="log-entry error log-jump-target" data-time-ms="${s.relativeMs || (parseSec(s.time) * 1000)}" style="padding:12px; border-bottom:1px solid #eee; cursor:pointer;">
          <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
            <strong style="color:#d93025;"><span class="log-jump-btn">⏯️</span> ${s.type}</strong>
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

    // Populate Environment Info
    document.getElementById('infoBrowser').textContent = sessionLogs.info?.browser || getBrowserInfo();
    document.getElementById('infoOS').textContent = sessionLogs.info?.os || getOSInfo();
    document.getElementById('infoRes').textContent = sessionLogs.info?.resolution || (window.screen.width + 'x' + window.screen.height);
    document.getElementById('infoLocation').textContent = sessionLogs.info?.location || "-";
    document.getElementById('infoTimestamp').textContent = sessionLogs.info?.timestamp || "Unknown";

    // Render environment snapshot if available
    const env = sessionLogs.info?.environment;
    if (env) {
      // Timezone, Language, Cookies
      const tzEl = document.getElementById('infoTimezone');
      if (tzEl) tzEl.textContent = env.timezone || '-';
      const langEl = document.getElementById('infoLanguage');
      if (langEl) langEl.textContent = env.language || '-';
      const cookieEl = document.getElementById('infoCookies');
      if (cookieEl) cookieEl.textContent = env.cookieCount != null ? `${env.cookieCount} cookies (${(env.cookieNames || []).slice(0,5).join(', ')}${env.cookieCount > 5 ? '...' : ''})` : '-';

      // --- APP STATE REPORTING (Advanced UI) ---
      const envSection = document.getElementById('envSection');
      if (envSection) envSection.style.display = 'block';

      let currentLS = env.localStorage || {};
      let currentSS = env.sessionStorage || {};
      let currentCK = []; // Will fetch from BG or logs

      // 1. Initial Render
      renderEnvTable('LS', currentLS);
      renderEnvTable('SS', currentSS);

      // Fetch cookies from background if available, else use logs
      chrome.runtime.sendMessage({ 
        action: 'BUGLENS_GET_COOKIES', 
        url: sessionLogs.info?.url 
      }, (res) => {
        if (res && res.cookies) {
          currentCK = res.cookies;
          renderEnvTable('CK', currentCK);
        }
      });

      // 2. Toggles
      document.querySelectorAll('[data-toggle-env]').forEach(h => {
        h.addEventListener('click', () => {
          const type = h.getAttribute('data-toggle-env').toUpperCase();
          const body = document.getElementById(`envBody${type}`);
          if (body) body.style.display = body.style.display === 'none' ? 'block' : 'none';
        });
      });

      // 3. Search handling
      document.querySelectorAll('.env-search').forEach(input => {
        input.addEventListener('input', (e) => {
          const type = input.getAttribute('data-filter-env').toUpperCase();
          const query = e.target.value.toLowerCase();
          const data = type === 'LS' ? currentLS : (type === 'SS' ? currentSS : currentCK);
          renderEnvTable(type, data, query);
        });
      });

      // 4. Copy All handling
      document.querySelectorAll('.btn-copy-env').forEach(btn => {
        btn.addEventListener('click', () => {
          const type = btn.getAttribute('data-copy-env').toUpperCase();
          const data = type === 'LS' ? currentLS : (type === 'SS' ? currentSS : currentCK);
          navigator.clipboard.writeText(JSON.stringify(data, null, 2));
          btn.textContent = 'Copied!';
          setTimeout(() => btn.textContent = 'Copy All', 2000);
        });
      });

      // 5. JSON Parsing Helper
      function smartParse(str) {
        try {
          const obj = JSON.parse(str);
          if (obj && typeof obj === 'object') return { isJson: true, val: JSON.stringify(obj, null, 2) };
        } catch(e) {}
        return { isJson: false, val: str };
      }

      function renderEnvTable(type, data, filter = '') {
        const tbody = document.querySelector(`#table${type} tbody`);
        if (!tbody) return;
        tbody.innerHTML = '';
        
        let count = 0;
        if (type === 'CK') {
          const filtered = data.filter(c => 
            c.name.toLowerCase().includes(filter) || 
            (c.value||'').toLowerCase().includes(filter) || 
            (c.domain||'').toLowerCase().includes(filter)
          );
          count = filtered.length;
          tbody.innerHTML = filtered.map(c => `
            <tr>
              <td><strong>${c.name}</strong></td>
              <td class="val-raw">${c.value}</td>
              <td>${c.domain}</td>
              <td style="text-align:center">${c.httpOnly ? '<span class="lock-icon" title="HttpOnly">🔒</span>' : ''}</td>
              <td><button class="btn-copy-row" data-copy-val='${JSON.stringify(c).replace(/'/g,"&apos;")}'>Copy</button></td>
            </tr>
          `).join('');
        } else {
          const keys = Object.keys(data).filter(k => 
            k.toLowerCase().includes(filter) || 
            (data[k]||'').toLowerCase().includes(filter)
          );
          count = keys.length;
          tbody.innerHTML = keys.map(k => {
            const { isJson, val } = smartParse(data[k]);
            return `
              <tr>
                <td><strong>${k}</strong></td>
                <td class="${isJson ? 'val-pretty' : 'val-raw'}">${val}</td>
                <td><button class="btn-copy-row" data-copy-val='${JSON.stringify({key:k, value:data[k]}).replace(/'/g,"&apos;")}'>Copy</button></td>
              </tr>
            `;
          }).join('');
        }
        document.getElementById(`count${type}`).textContent = count;

        // Attach row copy listeners
        tbody.querySelectorAll('.btn-copy-row').forEach(btn => {
          btn.onclick = (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(btn.getAttribute('data-copy-val'));
            const og = btn.textContent;
            btn.textContent = 'Copied';
            setTimeout(() => btn.textContent = og, 2000);
          };
        });
      }

      // 6. Real-time Cookie Update Listener
      chrome.runtime.onMessage.addListener((req) => {
        if (req.action === 'BUGLENS_COOKIE_CHANGED') {
          // Re-fetch all to be accurate
          chrome.runtime.sendMessage({ action: 'BUGLENS_GET_COOKIES' }, (res) => {
            if (res && res.cookies) {
              currentCK = res.cookies;
              const filter = document.querySelector('[data-filter-env="ck"]').value;
              renderEnvTable('CK', currentCK, filter.toLowerCase());
            }
          });
        }
      });
    }

    // --- GLOBAL EVENT DELEGATION (Fix CSP onclick issue) ---
    document.addEventListener('click', (e) => {
      // 1. Log Jump to Video (Priority)
      const jumpTrigger = e.target.closest('.log-jump-target');
      if (jumpTrigger) {
        // Check if we should skip jump (e.g. clicking strict detail buttons like in Actions)
        const isActionDetailBtn = e.target.classList.contains('action-expand-btn');
        const isJsonToggle = e.target.closest('[data-toggle="json"]');
        
        if (!isActionDetailBtn && !isJsonToggle) {
          const timeMs = parseInt(jumpTrigger.getAttribute('data-time-ms'));
          if (!isNaN(timeMs)) {
            jumpToVideoTime(timeMs, jumpTrigger);
          }
        }
      }

      // 2. JSON Tree Toggle
      const jtToggle = e.target.closest('[data-toggle="json"]');
      if (jtToggle) {
        // stopPropagation removed to allow bubbling/other logic if needed, 
        // but since it's document listener, we just handle logic
        const targetId = jtToggle.getAttribute('data-target');
        const content = document.getElementById(targetId);
        const caret = jtToggle.querySelector('.jt-caret');
        if (content) content.classList.toggle('open');
        if (caret) caret.classList.toggle('open');
        return;
      }

      // 3. Console Entry Toggle
      const consoleToggle = e.target.closest('[data-toggle="console"]');
      if (consoleToggle) {
        const targetId = consoleToggle.getAttribute('data-target');
        const body = document.getElementById('body_' + targetId);
        const chev = document.getElementById('chev_' + targetId);
        if (body) body.classList.toggle('open');
        if (chev) chev.classList.toggle('open');
        return;
      }

      // 4. Action Detail Toggle
      const actionToggle = e.target.closest('[data-toggle="action"]');
      if (actionToggle) {
        const targetId = actionToggle.getAttribute('data-target');
        const detailPanel = document.getElementById('dp_' + targetId);
        if (detailPanel) {
          detailPanel.classList.toggle('open');
          actionToggle.textContent = detailPanel.classList.contains('open') ? '▼ collapse' : '▶ details';
        }
        return;
      }
    });

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
