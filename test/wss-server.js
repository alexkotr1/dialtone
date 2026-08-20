/**
 * A throwaway TLS WebSocket server with a self-signed certificate.
 *
 * Exists to prove one thing that cannot be checked any other way: that
 * Electron's certificate-error path actually fires for a WebSocket (not only
 * for page loads), and that trusting the fingerprint really does let the
 * socket open on the next attempt.
 *
 * It speaks no SIP. Getting the TLS handshake and the WebSocket upgrade to
 * complete is the whole test — everything past that is JsSIP's business and
 * is covered by the rest of the suite.
 *
 *   node test/wss-server.js [port]
 *
 * Prints the SHA-256 fingerprint on startup so it can be compared against
 * whatever the app reports, which is the same check a person does for real.
 */

'use strict';

const https = require('node:https');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.argv[2] || 7443);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dialtone-wss-'));
const keyFile = path.join(dir, 'key.pem');
const certFile = path.join(dir, 'cert.pem');

// Generated fresh each run rather than committed: a private key in a repo is
// a bad habit even when the key is worthless.
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', keyFile, '-out', certFile,
  '-days', '1', '-subj', '/CN=localhost',
  '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
], { stdio: 'pipe' });

const cert = fs.readFileSync(certFile);
const der = crypto.X509Certificate ? new crypto.X509Certificate(cert).raw : null;
const fingerprint = der
  ? crypto.createHash('sha256').update(der).digest('hex').match(/../g).join(':').toUpperCase()
  : '(unavailable)';

const server = https.createServer({ key: fs.readFileSync(keyFile), cert });

/** The 16 bytes of magic that turn an HTTP upgrade into a WebSocket. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      'Sec-WebSocket-Protocol: sip\r\n\r\n'
  );
  console.log('UPGRADED  a WebSocket completed the TLS handshake and upgraded');
  // Held open deliberately: closing here would look like a connection failure
  // to the client and muddy what this test is measuring.
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`listening wss://127.0.0.1:${PORT}`);
  console.log(`fingerprint sha256/${fingerprint}`);
});
