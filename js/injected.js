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

  // Circular reference-safe JSON replacer
  const getCircularReplacer = () => {
    const seen = new WeakSet();
    return (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular Reference]';
        seen.add(value);
      }
      return value;
    };
  };

  // Safely serialize a single value for transport
  function safeSerialize(a) {
    if (a === null) return null;
    if (a === undefined) return undefined;
    if (typeof a !== 'object' && typeof a !== 'function') return a;
    try { return JSON.parse(JSON.stringify(a, getCircularReplacer())); }
    catch(e) { return String(a); }
  }

  // Override Console
  const overrideConsole = (method) => {
    const original = console[method];
    console[method] = function(...args) {
      const stack = method === 'error' || method === 'warn'
        ? (new Error().stack || '').split('\n').slice(2).join('\n')
        : '';
      sendLog('CONSOLE', {
        level: method,
        message: args.map(a => typeof a === 'object' ? JSON.stringify(a, getCircularReplacer()) : String(a)).join(' '),
        args: args.map(safeSerialize),
        stack: stack,
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
  try {
    resourceObserver.observe({ type: 'resource', buffered: true });
  } catch (e) {
    // Fallback for older browsers
    resourceObserver.observe({ entryTypes: ['resource'] });
  }

  // Serialize request body properly
  async function serializeRequestBody(body, contentType) {
    if (!body) return { payloadText: null, parsedPayload: null, payloadType: 'empty' };
    
    const ct = (contentType || '').toLowerCase();
    
    // FormData
    if (body instanceof FormData) {
      const entries = {};
      const pairs = [];
      for (let [key, value] of body) {
        if (!entries[key]) entries[key] = [];
        if (value instanceof File) {
          entries[key].push({ name: value.name, size: value.size, type: value.type });
          pairs.push(`${key}=[File: ${value.name}]`);
        } else {
          entries[key].push(String(value));
          pairs.push(`${key}=${String(value)}`);
        }
      }
      const payloadText = pairs.join('&');
      console.log('[BERIBUG] Captured FormData payload:', { payloadText, entries });
      return { 
        payloadText, 
        parsedPayload: entries, 
        payloadType: 'multipart/form-data'
      };
    }
    
    // Blob
    if (body instanceof Blob) {
      try {
        const text = await body.text();
        const truncated = text.length > 50000 ? text.substring(0, 50000) + '... (TRUNCATED)' : text;
        if (ct.includes('application/json')) {
          const parsed = JSON.parse(text);
          console.log('[BERIBUG] Captured Blob JSON payload');
          return { payloadText: truncated, parsedPayload: parsed, payloadType: 'application/json' };
        } else if (ct.includes('application/x-www-form-urlencoded')) {
          const params = new URLSearchParams(text);
          const obj = {};
          for (let [k, v] of params) obj[k] = v;
          console.log('[BERIBUG] Captured Blob form-urlencoded payload');
          return { payloadText: truncated, parsedPayload: obj, payloadType: 'application/x-www-form-urlencoded' };
        }
        console.log('[BERIBUG] Captured Blob raw payload');
        return { payloadText: truncated, parsedPayload: null, payloadType: ct || 'text/plain' };
      } catch (e) {
        console.warn('[BERIBUG] Failed to serialize Blob:', e.message);
        return { payloadText: null, parsedPayload: null, payloadType: 'binary' };
      }
    }
    
    // String or other types
    const bodyStr = String(body);
    if (!bodyStr.trim()) {
      return { payloadText: null, parsedPayload: null, payloadType: 'empty' };
    }
    
    // Try JSON
    if (ct.includes('application/json') || bodyStr.trim().startsWith('{') || bodyStr.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(bodyStr);
        const displayStr = bodyStr.length > 50000 ? bodyStr.substring(0, 50000) + '... (TRUNCATED)' : bodyStr;
        console.log('[BERIBUG] Captured JSON payload, length:', bodyStr.length);
        return { 
          payloadText: displayStr, 
          parsedPayload: parsed, 
          payloadType: 'application/json'
        };
      } catch (e) {
        console.log('[BERIBUG] Body looks like JSON but failed to parse');
      }
    }
    
    // Try form-urlencoded
    if (ct.includes('application/x-www-form-urlencoded') || (bodyStr.includes('=') && bodyStr.includes('&'))) {
      try {
        const params = new URLSearchParams(bodyStr);
        const obj = {};
        for (let [k, v] of params) obj[k] = v;
        console.log('[BERIBUG] Captured form-urlencoded payload');
        return { 
          payloadText: bodyStr, 
          parsedPayload: obj, 
          payloadType: 'application/x-www-form-urlencoded'
        };
      } catch (e) {
        console.log('[BERIBUG] Failed to parse as form-urlencoded');
      }
    }
    
    // GraphQL detection
    if ((bodyStr.includes('query') && bodyStr.includes('operationName')) || ct.includes('graphql')) {
      try {
        const parsed = JSON.parse(bodyStr);
        console.log('[BERIBUG] Detected GraphQL payload');
        return { 
          payloadText: bodyStr, 
          parsedPayload: parsed, 
          payloadType: 'graphql'
        };
      } catch (e) {}
    }
    
    // Default: raw text
    const displayStr = bodyStr.length > 50000 ? bodyStr.substring(0, 50000) + '... (TRUNCATED)' : bodyStr;
    console.log('[BERIBUG] Captured raw payload, length:', bodyStr.length);
    return { 
      payloadText: displayStr, 
      parsedPayload: null, 
      payloadType: ct || 'text/plain'
    };
  }

  // Override Fetch
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const startTime = performance.now();
    const time = new Date().toISOString();

    // Support calling fetch(Request) and fetch(url, init)
    let url = 'unknown';
    let method = 'GET';
    let requestHeaders = {};
    let rawBody = null;

    try {
      if (args[0] && args[0] instanceof Request) {
        const reqObj = args[0];
        url = reqObj.url || 'unknown';
        method = (reqObj.method || 'GET').toUpperCase();
        // Read headers from Request
        try { reqObj.headers.forEach((v, k) => (requestHeaders[k] = v)); } catch (e) {}
        // Try to read body (may be stream) via clone()
        try {
          const cloned = reqObj.clone();
          rawBody = await cloned.text();
        } catch (e) {
          rawBody = null;
        }
      } else {
        url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : 'unknown');
        const init = args[1] || {};
        method = (init.method || 'GET').toUpperCase();
        const hdrs = init.headers || {};
        // Normalize headers: Headers instance, array or plain object
        if (hdrs instanceof Headers) {
          try { hdrs.forEach((v, k) => (requestHeaders[k] = v)); } catch (e) {}
        } else if (Array.isArray(hdrs)) {
          hdrs.forEach(([k, v]) => (requestHeaders[k] = v));
        } else if (typeof hdrs === 'object') {
          requestHeaders = Object.assign({}, hdrs);
        }
        rawBody = init.body || null;
      }
    } catch (e) {
      console.warn('[BERIBUG] Failed to normalize fetch args', e && e.message);
    }

    // Get Content-Type header
    let contentType = '';
    try {
      for (let k in requestHeaders) {
        if (k.toLowerCase() === 'content-type') {
          contentType = requestHeaders[k];
          break;
        }
      }
    } catch (e) {}

    // If rawBody is a string (from Request.clone().text()) keep as-is, else pass through serializer
    const bodyInfo = typeof rawBody === 'string' ? await serializeRequestBody(rawBody, contentType) : await serializeRequestBody(rawBody, contentType);
    const maskedBody = maskSensitiveData(bodyInfo.payloadText);

    const baseData = {
      time,
      method,
      url,
      requestHeaders: maskHeaders(requestHeaders),
      requestBody: maskedBody,
      payloadText: maskedBody,
      parsedPayload: bodyInfo.parsedPayload,
      payloadType: bodyInfo.payloadType,
      status: 'PENDING',
      type: 'fetch'
    };
    sendLog('NETWORK', baseData);

    try {
      const response = await originalFetch.apply(this, args);
      const clonedResponse = response.clone();
      const duration = Math.round(performance.now() - startTime);

      let responseBody = '';
      try {
        responseBody = await clonedResponse.text();
        if (responseBody && responseBody.length > 50000) responseBody = responseBody.substring(0, 50000) + '... (TRUNCATED)';
        console.log('[BERIBUG] Captured fetch response, status:', response.status, 'length:', responseBody ? responseBody.length : 0);
      } catch (e) {
        console.warn('[BERIBUG] Failed to capture fetch response:', e.message);
      }

      const responseHeaders = {};
      try { clonedResponse.headers.forEach((v, k) => { responseHeaders[k] = v; }); } catch (e) {}

      sendLog('NETWORK', {
        ...baseData,
        time: new Date().toISOString(),
        status: response.status,
        responseHeaders: maskHeaders(responseHeaders),
        responseBody: responseBody,
        size: responseBody ? responseBody.length : 0,
        duration: duration
      });
      return response;
    } catch (err) {
      console.error('[BERIBUG] Fetch error:', err && err.message);
      sendLog('NETWORK', { ...baseData, time: new Date().toISOString(), status: 'ERROR', duration: Math.round(performance.now() - startTime) });
      throw err;
    }
  };

  // Serialize request body for synchronous handling (XHR)
  function serializeRequestBodySync(body, contentType) {
    if (!body) return { payloadText: null, parsedPayload: null, payloadType: 'empty' };
    
    const ct = (contentType || '').toLowerCase();
    
    // FormData
    if (body instanceof FormData) {
      const entries = {};
      const pairs = [];
      for (let [key, value] of body) {
        if (!entries[key]) entries[key] = [];
        if (value instanceof File) {
          entries[key].push({ name: value.name, size: value.size, type: value.type });
          pairs.push(`${key}=[File: ${value.name}]`);
        } else {
          entries[key].push(String(value));
          pairs.push(`${key}=${String(value)}`);
        }
      }
      const payloadText = pairs.join('&');
      console.log('[BERIBUG] Captured FormData payload (sync):', { payloadText });
      return { 
        payloadText, 
        parsedPayload: entries, 
        payloadType: 'multipart/form-data'
      };
    }
    
    // Blob - can't read async in sync context, just mark as binary
    if (body instanceof Blob) {
      console.log('[BERIBUG] Blob payload detected - async read required');
      return { payloadText: '[Blob - async read]', parsedPayload: null, payloadType: 'binary' };
    }
    
    // String or other types
    const bodyStr = String(body);
    if (!bodyStr.trim()) {
      return { payloadText: null, parsedPayload: null, payloadType: 'empty' };
    }
    
    // Try JSON
    if (ct.includes('application/json') || bodyStr.trim().startsWith('{') || bodyStr.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(bodyStr);
        const displayStr = bodyStr.length > 50000 ? bodyStr.substring(0, 50000) + '... (TRUNCATED)' : bodyStr;
        console.log('[BERIBUG] Captured JSON payload (sync), length:', bodyStr.length);
        return { 
          payloadText: displayStr, 
          parsedPayload: parsed, 
          payloadType: 'application/json'
        };
      } catch (e) {
        console.log('[BERIBUG] Body looks like JSON but failed to parse');
      }
    }
    
    // Try form-urlencoded
    if (ct.includes('application/x-www-form-urlencoded') || (bodyStr.includes('=') && bodyStr.includes('&'))) {
      try {
        const params = new URLSearchParams(bodyStr);
        const obj = {};
        for (let [k, v] of params) obj[k] = v;
        console.log('[BERIBUG] Captured form-urlencoded payload (sync)');
        return { 
          payloadText: bodyStr, 
          parsedPayload: obj, 
          payloadType: 'application/x-www-form-urlencoded'
        };
      } catch (e) {
        console.log('[BERIBUG] Failed to parse as form-urlencoded');
      }
    }
    
    // GraphQL detection
    if ((bodyStr.includes('query') && bodyStr.includes('operationName')) || ct.includes('graphql')) {
      try {
        const parsed = JSON.parse(bodyStr);
        console.log('[BERIBUG] Detected GraphQL payload (sync)');
        return { 
          payloadText: bodyStr, 
          parsedPayload: parsed, 
          payloadType: 'graphql'
        };
      } catch (e) {}
    }
    
    // Default: raw text
    const displayStr = bodyStr.length > 50000 ? bodyStr.substring(0, 50000) + '... (TRUNCATED)' : bodyStr;
    console.log('[BERIBUG] Captured raw payload (sync), length:', bodyStr.length);
    return { 
      payloadText: displayStr, 
      parsedPayload: null, 
      payloadType: ct || 'text/plain'
    };
  }

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
      const rawBody = args[0] || null;
      
      // Get Content-Type header
      let contentType = '';
      for (let k in reqHeaders) {
        if (k.toLowerCase() === 'content-type') {
          contentType = reqHeaders[k];
          break;
        }
      }
      
      // Serialize the body (synchronous)
      const bodyInfo = serializeRequestBodySync(rawBody, contentType);
      const maskedBody = maskSensitiveData(bodyInfo.payloadText);
      
      const baseData = { 
        time: new Date().toISOString(), 
        method, 
        url, 
        requestHeaders: maskHeaders(reqHeaders), 
        requestBody: maskedBody,
        payloadText: maskedBody,
        parsedPayload: bodyInfo.parsedPayload,
        payloadType: bodyInfo.payloadType,
        status: 'PENDING', 
        type: 'xhr' 
      };
      sendLog('NETWORK', baseData);

      xhr.addEventListener('load', function() {
        const duration = Math.round(performance.now() - startTime);
        let respBody = '';
        try { 
          respBody = xhr.responseText; 
          if (respBody.length > 50000) respBody = respBody.substring(0, 50000) + '... (TRUNCATED)';
          console.log('[BERIBUG] Captured XHR response, status:', xhr.status, 'length:', respBody.length);
        } catch(e) {
          console.warn('[BERIBUG] Failed to capture XHR response:', e.message);
        }

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
        console.error('[BERIBUG] XHR error:', url);
        sendLog('NETWORK', { ...baseData, time: new Date().toISOString(), status: 'ERROR', duration: Math.round(performance.now() - startTime) });
      });
      
      originalSend.apply(this, args);
    };
    return xhr;
  };
})();


