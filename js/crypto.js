// BERIBUG Crypto Helper for Secure Token Proxying

const PROXY_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxb8mA44N8NJjmMitKaX/
ry+guX29L3kbfnWedEs72yXHUPmBDSIi2ZVDv2O5hVDCQZOkdFazuvMk7nnGZmJf
2DCuRYvKSHkADHwL0ljoZ6WXdc4Q5Ft/PyxFtB2CLWdnukJMmoJ/SORPOmGb4mRW
En9mRuLTUApRLA4yOjwnM+jvtbjDyrrg5YKfd0ZjfR0wO676aRHwUiMB8q7Vf3oC
InLiC41wlspu4uJr4RNqV/7jeB/BYcNXtsVQ6TMYAa6uFm064xp8rrS3YNT0446n
PRM/ics68dJv+OlWAU8f/7RGmyvzpoF1HLxPnVqzRKffUHnkwNsxXpbZKzknhb5d
iQIDAQAB
-----END PUBLIC KEY-----`;

// Utility: Convert base64 to ArrayBuffer
function base64ToArrayBuffer(base64) {
  const binary_string = window.atob(base64);
  const len = binary_string.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary_string.charCodeAt(i);
  }
  return bytes.buffer;
}

// Utility: Convert ArrayBuffer to base64
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

// Remove PEM headers and newlines
function stripPem(pem) {
  return pem.replace(/-----BEGIN PUBLIC KEY-----/g, '')
            .replace(/-----END PUBLIC KEY-----/g, '')
            .replace(/\n/g, '')
            .replace(/\r/g, '');
}

async function importPublicKey() {
  const pemStr = stripPem(PROXY_PUBLIC_KEY_PEM);
  const binaryDer = base64ToArrayBuffer(pemStr);

  return await window.crypto.subtle.importKey(
    "spki",
    binaryDer,
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
    },
    false,
    ["encrypt"]
  );
}

/**
 * Encrypts a JSON payload using AES-GCM, and encrypts the AES key using RSA-OAEP.
 * Returns a base64 encoded string: `base64(rsa(aesKey)) . base64(iv) . base64(aes(data))`
 */
export async function encryptPayloadForProxy(payloadObj) {
  const enc = new TextEncoder();
  const data = enc.encode(JSON.stringify(payloadObj));

  // 1. Generate AES-GCM Key (256-bit)
  const aesKey = await window.crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );

  // 2. Generate Random IV (96-bit is recommended for AES-GCM)
  const iv = window.crypto.getRandomValues(new Uint8Array(12));

  // 3. Encrypt the data with AES-GCM
  const encryptedData = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv },
    aesKey,
    data
  );

  // 4. Export the AES Key so we can encrypt it with RSA
  const exportedAesKeyBuffer = await window.crypto.subtle.exportKey("raw", aesKey);

  // 5. Encrypt the AES Key with RSA Public Key
  const rsaPubKey = await importPublicKey();
  const encryptedAesKey = await window.crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    rsaPubKey,
    exportedAesKeyBuffer
  );

  // 6. Concatenate and encode
  const part1 = arrayBufferToBase64(encryptedAesKey);
  const part2 = arrayBufferToBase64(iv);
  const part3 = arrayBufferToBase64(encryptedData);

  return `${part1}.${part2}.${part3}`;
}
