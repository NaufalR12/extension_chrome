(function() {
  if (window.__BUG_REPORTER_INJECTED__) return;
  window.__BUG_REPORTER_INJECTED__ = true;

  // Send message back to content script
  function sendLog(type, data) {
    window.postMessage({
      source: 'BUG_REPORTER_INJECTED',
      type: type,
      payload: data
    }, '*');
  }

  // Override Console
  const overrideConsole = (method) => {
    const original = console[method];
    console[method] = function(...args) {
      sendLog('CONSOLE', {
        level: method,
        message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '),
        time: new Date().toISOString()
      });
      original.apply(console, args);
    };
  };

  ['log', 'info', 'warn', 'error'].forEach(overrideConsole);

  window.addEventListener('error', (event) => {
    const errorData = {
      time: new Date().toISOString(),
      type: 'Unhandled Error',
      message: event.message || 'Unknown Error',
      stack: (event.error && event.error.stack) ? event.error.stack : (event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : 'No stack available'),
      source: event.filename || 'internal'
    };
    sendLog('BACKEND', errorData);
    // Silent duplicate for easy debugging in console if needed
    console.debug('[Bug Reporter] Captured Backend Error:', errorData.message);
  });

  window.addEventListener('unhandledrejection', (event) => {
    sendLog('BACKEND', {
      time: new Date().toISOString(),
      type: 'Unhandled Promise Rejection',
      message: event.reason ? (event.reason.message || String(event.reason)) : 'Unknown Reason',
      stack: event.reason && event.reason.stack ? event.reason.stack : ''
    });
  });

  // History API Hook for SPA Navigation
  const wrapHistory = (type) => {
    const original = history[type];
    return function(...args) {
      const result = original.apply(this, args);
      sendLog('ACTIONS', {
        time: new Date().toISOString(),
        event: '🧭 Navigated to',
        element: window.location.href,
        method: 'History API'
      });
      return result;
    };
  };
  history.pushState = wrapHistory('pushState');
  history.replaceState = wrapHistory('replaceState');
  window.addEventListener('popstate', () => {
    sendLog('ACTIONS', {
      time: new Date().toISOString(),
      event: '🧭 Navigated to',
      element: window.location.href,
      method: 'History API'
    });
  });

  // Smart Masking for Payloads
  function maskSensitiveData(data) {
    if (!data) return data;
    const sensitiveKeys = ['password', 'pwd', 'secret', 'token', 'otp', 'authorization', 'api_key', 'apikey'];
    
    if (typeof data === 'string') {
      try {
        const obj = JSON.parse(data);
        maskObjectRecursive(obj, sensitiveKeys);
        return JSON.stringify(obj, null, 2);
      } catch (e) {
        // Not JSON, try URLSearchParams
        if (data.includes('=') && (data.includes('&') || data.length > 3)) {
          const params = new URLSearchParams(data);
          let changed = false;
          sensitiveKeys.forEach(key => {
            if (params.has(key)) {
              params.set(key, 'JAM_DOES_NOT_SAVE_SECRETS');
              changed = true;
            }
          });
          return changed ? params.toString() : data;
        }
        return data;
      }
    } else if (typeof data === 'object') {
      const cloned = JSON.parse(JSON.stringify(data));
      maskObjectRecursive(cloned, sensitiveKeys);
      return cloned;
    }
    return data;
  }

  function maskObjectRecursive(obj, keys) {
    for (let key in obj) {
      if (keys.includes(key.toLowerCase())) {
        obj[key] = 'JAM_DOES_NOT_SAVE_SECRETS';
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        maskObjectRecursive(obj[key], keys);
      }
    }
  }

  // Mask sensitive headers
  function maskHeaders(headers) {
    if (!headers) return headers;
    const sensitive = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key'];
    const masked = {};
    for (let key in headers) {
      if (sensitive.includes(key.toLowerCase())) {
        masked[key] = '***** Auto-filtered';
      } else {
        masked[key] = headers[key];
      }
    }
    return masked;
  }

  // Resource Tracking (JS, CSS, Font, Media)
  const resourceObserver = new PerformanceObserver((list) => {
    list.getEntries().forEach((entry) => {
      // Avoid fetch/xhr here as they are monkey-patched
      if (['fetch', 'xmlhttprequest'].includes(entry.initiatorType)) return;

      let type = entry.initiatorType || 'other';
      const url = entry.name.toLowerCase();
      if (url.includes('.js') || url.includes('/static/chunks/') || type === 'script') type = 'script';
      else if (url.includes('.css') || type === 'css' || type === 'link') {
        if (['woff', 'woff2', 'ttf', 'otf'].some(ext => url.includes('.' + ext))) type = 'font';
        else type = 'stylesheet';
      }
      else if (['woff', 'woff2', 'ttf', 'otf'].some(ext => url.includes('.' + ext))) type = 'font';
      else if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].some(ext => url.includes('.' + ext)) || type === 'img') type = 'img';

      sendLog('NETWORK', {
        time: new Date(performance.timeOrigin + entry.startTime).toISOString(),
        method: 'GET',
        url: entry.name,
        status: 200,
        type: type,
        size: entry.transferSize,
        duration: Math.round(entry.duration),
        isStatic: true,
        responseHeaders: { 'Content-Type': type }
      });
    });
  });
  resourceObserver.observe({ entryTypes: ['resource'], buffered: true });

  // Override Fetch
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const startTime = performance.now();
    const time = new Date().toISOString();
    let url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : 'unknown');
    let method = args[1] && args[1].method ? args[1].method : 'GET';
    let requestHeaders = maskHeaders(args[1] && args[1].headers ? args[1].headers : {});
    let requestBody = maskSensitiveData(args[1] && args[1].body ? String(args[1].body) : null);

    const baseData = { time, method, url, requestHeaders, requestBody, status: 'PENDING', type: 'fetch' };
    sendLog('NETWORK', baseData);

    try {
      const response = await originalFetch.apply(this, args);
      const clonedResponse = response.clone();
      const duration = Math.round(performance.now() - startTime);
      
      let responseBody = '';
      try {
        responseBody = await clonedResponse.text();
        if (responseBody.length > 50000) responseBody = responseBody.substring(0, 50000) + '... (TRUNCATED)';
      } catch (e) {}

      const responseHeaders = {};
      clonedResponse.headers.forEach((v, k) => {
        responseHeaders[k] = v;
      });

      sendLog('NETWORK', { 
        ...baseData, 
        time: new Date().toISOString(), 
        status: response.status,
        responseHeaders: maskHeaders(responseHeaders),
        responseBody: responseBody,
        size: responseBody.length,
        duration: duration
      });
      return response;
    } catch (err) {
      sendLog('NETWORK', { ...baseData, time: new Date().toISOString(), status: 'ERROR', duration: Math.round(performance.now() - startTime) });
      throw err;
    }
  };

  // Override XHR
  const originalXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function() {
    const xhr = new originalXHR();
    let method = 'GET';
    let url = '';
    let reqHeaders = {};
    let reqBody = null;
    let startTime = 0;

    const originalOpen = xhr.open;
    xhr.open = function(...args) {
      method = args[0];
      url = args[1];
      originalOpen.apply(this, args);
    };

    const originalSetRequestHeader = xhr.setRequestHeader;
    xhr.setRequestHeader = function(header, value) {
      reqHeaders[header] = value;
      originalSetRequestHeader.apply(this, [header, value]);
    };

    const originalSend = xhr.send;
    xhr.send = function(...args) {
      startTime = performance.now();
      reqBody = maskSensitiveData(args[0] ? String(args[0]) : null);
      const baseData = { time: new Date().toISOString(), method, url, requestHeaders: maskHeaders(reqHeaders), requestBody: reqBody, status: 'PENDING', type: 'xhr' };
      sendLog('NETWORK', baseData);

      xhr.addEventListener('load', function() {
        const duration = Math.round(performance.now() - startTime);
        let respBody = '';
        try { 
          respBody = xhr.responseText; 
          if (respBody.length > 50000) respBody = respBody.substring(0, 50000) + '... (TRUNCATED)';
        } catch(e){}

        const rawHeaders = xhr.getAllResponseHeaders();
        const responseHeaders = {};
        rawHeaders.split('\r\n').forEach(line => {
          const parts = line.split(': ');
          if (parts.length === 2) responseHeaders[parts[0]] = parts[1];
        });

        sendLog('NETWORK', { 
          ...baseData, 
          time: new Date().toISOString(), 
          status: xhr.status,
          responseHeaders: maskHeaders(responseHeaders),
          responseBody: respBody,
          size: respBody.length,
          duration: duration
        });
      });
      xhr.addEventListener('error', function() {
        sendLog('NETWORK', { ...baseData, time: new Date().toISOString(), status: 'ERROR', duration: Math.round(performance.now() - startTime) });
      });
      originalSend.apply(this, args);
    };
    return xhr;
  };
})();


