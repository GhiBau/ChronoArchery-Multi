'use strict';

const QRCode = require('qrcode');

function wifiPayload(ssid, passphrase) {
  // Format standard reconnu par les appareils photo des téléphones pour
  // proposer de rejoindre un réseau WiFi en un geste.
  const esc = (s) => String(s).replace(/([\\;,:"])/g, '\\$1');
  return `WIFI:S:${esc(ssid)};T:WPA;P:${esc(passphrase)};;`;
}

async function dataUrl(text) {
  return QRCode.toDataURL(text, { margin: 1, scale: 6, color: { dark: '#12161c', light: '#f5f1e8' } });
}

module.exports = { wifiPayload, dataUrl };
