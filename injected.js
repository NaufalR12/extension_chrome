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

  // Catch global errors (Backend Sentry-like feature)
  window.addEventListener('error', (event) => {
    sendLog('BACKEND', {
      time: new Date().toISOString(),
      type: 'Unhandled Error',
      message: event.message || 'Unknown Error',
      stack: event.error && event.error.stack ? event.error.stack : ''
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    sendLog('BACKEND', {
      time: new Date().toISOString(),
      type: 'Unhandled Promise Rejection',
      message: event.reason ? (event.reason.message || event.reason) : 'Unknown Reason',
      stack: event.reason && event.reason.stack ? event.reason.stack : ''
    });
  });

  // Override Fetch
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const time = new Date().toISOString();
    let url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : 'unknown');
    let method = args[1] && args[1].method ? args[1].method : 'GET';

    sendLog('NETWORK', { time, method, url, status: 'PENDING' });

    try {
      const response = await originalFetch.apply(this, args);
      sendLog('NETWORK', { time: new Date().toISOString(), method, url, status: response.status });
      return response;
    } catch (err) {
      sendLog('NETWORK', { time: new Date().toISOString(), method, url, status: 'ERROR' });
      throw err;
    }
  };

  // Override XHR
  const originalXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function() {
    const xhr = new originalXHR();
    let method = 'GET';
    let url = '';

    const originalOpen = xhr.open;
    xhr.open = function(...args) {
      method = args[0];
      url = args[1];
      originalOpen.apply(this, args);
    };

    const originalSend = xhr.send;
    xhr.send = function(...args) {
      sendLog('NETWORK', { time: new Date().toISOString(), method, url, status: 'PENDING' });
      xhr.addEventListener('load', function() {
        sendLog('NETWORK', { time: new Date().toISOString(), method, url, status: xhr.status });
      });
      xhr.addEventListener('error', function() {
        sendLog('NETWORK', { time: new Date().toISOString(), method, url, status: 'ERROR' });
      });
      originalSend.apply(this, args);
    };
    return xhr;
  };
})();
