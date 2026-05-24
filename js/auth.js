const CLIENT_ID = '3ad48569-7b99-4e88-8c71-a269bc35b26a';
const SCOPES = 'files.readwrite User.Read offline_access';
const REDIRECT_URI = chrome.identity.getRedirectURL();

function generateCodeVerifier() {
  const array = new Uint8Array(64);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return crypto.subtle.digest('SHA-256', data);
}

function base64urlencode(a) {
  let str = "";
  const bytes = new Uint8Array(a);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function generateCodeChallenge(v) {
  const hashed = await sha256(v);
  return base64urlencode(hashed);
}

export async function login() {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);

  await chrome.storage.local.set({ msCodeVerifier: verifier });

  const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?` +
    `client_id=${CLIENT_ID}&` +
    `response_type=code&` +
    `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
    `scope=${encodeURIComponent(SCOPES)}&` +
    `code_challenge=${challenge}&` +
    `code_challenge_method=S256&` +
    `prompt=select_account`;

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async (redirectUrl) => {
      if (chrome.runtime.lastError || !redirectUrl) {
        reject(chrome.runtime.lastError || new Error('Auth flow cancelled or failed'));
        return;
      }

      try {
        const url = new URL(redirectUrl);
        const code = url.searchParams.get('code');
        if (!code) {
          reject(new Error('No auth code returned'));
          return;
        }

        const token = await exchangeCodeForToken(code, verifier);
        resolve(token);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function exchangeCodeForToken(code, verifier) {
  const tokenUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
  const bodyParams = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    scope: SCOPES
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: bodyParams.toString()
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Token exchange failed: ${res.status} - ${errText}`);
  }

  const json = await res.json();
  const tokenData = {
    msAccessToken: json.access_token,
    msRefreshToken: json.refresh_token,
    tokenExpiry: Date.now() + (json.expires_in - 60) * 1000
  };

  await chrome.storage.local.set(tokenData);
  return json.access_token;
}

export async function getAccessToken() {
  const data = await chrome.storage.local.get(['msAccessToken', 'msRefreshToken', 'tokenExpiry']);

  if (data.msAccessToken && data.tokenExpiry && Date.now() < data.tokenExpiry) {
    return data.msAccessToken;
  }

  if (data.msRefreshToken) {
    try {
      return await refreshAccessToken(data.msRefreshToken);
    } catch (e) {
      console.warn('Failed to refresh Microsoft token silently:', e);
    }
  }

  return null;
}

async function refreshAccessToken(refreshToken) {
  const tokenUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
  const bodyParams = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: SCOPES
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: bodyParams.toString()
  });

  if (!res.ok) {
    await chrome.storage.local.remove(['msAccessToken', 'msRefreshToken', 'tokenExpiry']);
    const errText = await res.text();
    throw new Error(`Token refresh failed: ${res.status} - ${errText}`);
  }

  const json = await res.json();
  const tokenData = {
    msAccessToken: json.access_token,
    msRefreshToken: json.refresh_token || refreshToken,
    tokenExpiry: Date.now() + (json.expires_in - 60) * 1000
  };

  await chrome.storage.local.set(tokenData);
  return json.access_token;
}

export async function logout() {
  await chrome.storage.local.remove(['msAccessToken', 'msRefreshToken', 'tokenExpiry']);
}
