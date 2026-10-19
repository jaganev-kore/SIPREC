import http from 'node:http';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIPv4 } from 'node:net';
import { createSiprecSession } from './siprec-src.js';

const appDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(appDirectory, 'public');

async function loadConfigurationFile() {
  try {
    const contents = await readFile(resolve(appDirectory, 'config.json'), 'utf8');
    const parsed = JSON.parse(contents);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('config.json must contain a JSON object.');
    }
    return { loaded: true, value: parsed };
  } catch (error) {
    if (error.code === 'ENOENT') return { loaded: false, value: {} };
    throw error;
  }
}

const loadedConfig = await loadConfigurationFile();
const appConfig = loadedConfig.value;
const koreConfig = appConfig.kore && typeof appConfig.kore === 'object' ? appConfig.kore : {};
const mediaConfig = appConfig.media && typeof appConfig.media === 'object' ? appConfig.media : {};
const host = typeof appConfig.host === 'string' ? appConfig.host : '127.0.0.1';
const port = Number(appConfig.port || 3000);

const gateways = [
  { id: 'primary', label: 'Kore SBC 1', uri: typeof koreConfig.siprecPrimaryUri === 'string' ? koreConfig.siprecPrimaryUri : '' },
  { id: 'secondary', label: 'Kore SBC 2', uri: typeof koreConfig.siprecSecondaryUri === 'string' ? koreConfig.siprecSecondaryUri : '' },
];
const mediaPublicIp = typeof mediaConfig.publicIp === 'string' ? mediaConfig.publicIp : '';
const rtpPort = Number(mediaConfig.rtpPort || 40000);
const mediaProfile = typeof mediaConfig.profile === 'string' ? mediaConfig.profile : 'RTP/AVP';
let activeSession = null;
let sessionStarting = false;

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolveBody, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > 4096) {
        reject(Object.assign(new Error('Request body is too large'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolveBody(body ? JSON.parse(body) : {});
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function safeTokenEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseSipUri(uri) {
  // The supplied Kore URIs use the form sip:user@host:port?headers.
  if (typeof uri !== 'string' || /[\s<>\r\n]/.test(uri)) return null;
  const match = uri.match(/^sips?:([^@]+)@([^;?:]+)(?::(\d+))?(?:[?;].*)?$/i);
  if (!match) return null;
  return { host: match[2], port: Number(match[3] || 5060) };
}

function parseKoreSipUri(uri) {
  if (typeof uri !== 'string' || uri.length > 512) return null;
  const target = parseSipUri(uri.trim());
  if (!target || !/(^|\.)kore\.ai$/i.test(target.host) || ![5060, 5061].includes(target.port)) return null;
  return target;
}

function probeTls(target) {
  return new Promise((resolveProbe, rejectProbe) => {
    const socket = tls.connect({
      host: target.host,
      port: target.port,
      servername: target.host,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    });

    const timer = setTimeout(() => socket.destroy(new Error('TLS connection timed out')), 7000);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const certificate = socket.getPeerCertificate();
      resolveProbe({
        reachable: true,
        tlsVersion: socket.getProtocol(),
        certificateSubject: certificate.subject?.CN || certificate.subject?.O || 'verified certificate',
      });
      socket.end();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      rejectProbe(error);
    });
  });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/api/config') {
    return json(res, 200, {
      product: 'Kore.ai Agent Assist',
      configSource: loadedConfig.loaded ? 'config.json' : 'configuration defaults (config.json missing)',
      mediaServerReady: Boolean(isIPv4(mediaPublicIp) && Number.isInteger(rtpPort) && rtpPort >= 1024 && rtpPort <= 65534 && rtpPort % 2 === 0 && mediaProfile === 'RTP/AVP'),
      mediaPublicIp: isIPv4(mediaPublicIp) ? mediaPublicIp : '',
      rtpPort,
      mediaProfile,
      mediaCodec: 'PCMU/8000',
      sipTransport: typeof koreConfig.sipTransport === 'string' ? koreConfig.sipTransport : 'TLS',
      siprecIdentifier: typeof koreConfig.siprecIdentifier === 'string' ? koreConfig.siprecIdentifier : '',
      dtmf: typeof koreConfig.dtmf === 'string' ? koreConfig.dtmf : 'RFC2833',
      sipCredentialsConfigured: Boolean(koreConfig.sipUsername && koreConfig.sipPassword),
      endpoints: gateways.map((gateway) => ({ ...gateway, configured: Boolean(gateway.uri) })),
      voiceBotConfigured: Boolean(koreConfig.voiceBotSipUri),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/session/start') {
    if (activeSession || sessionStarting) return json(res, 409, { error: 'A SIPREC test session is already active or starting.' });
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Request body must be a JSON object.' });
    const endpoint = gateways.find((gateway) => gateway.id === body.endpoint);
    if (!endpoint) return json(res, 400, { error: 'Select a valid Kore SIPREC endpoint.' });
    const sipUri = String(body.sipUri || endpoint.uri || '').trim();
    if (!sipUri) return json(res, 400, { error: 'Paste a Kore SIPREC URI into the endpoint field.' });
    if (!parseKoreSipUri(sipUri)) return json(res, 400, { error: 'Enter a SIP/SIPS URI for a Kore SBC on kore.ai using port 5060 or 5061.' });
    if (!isIPv4(mediaPublicIp)) return json(res, 400, { error: 'Set media.publicIp in config.json to the GCE VM static external IPv4 address.' });
    if (!Number.isInteger(rtpPort) || rtpPort < 1024 || rtpPort > 65534 || rtpPort % 2 !== 0) return json(res, 400, { error: 'media.rtpPort in config.json must be an even UDP port from 1024 through 65534.' });
    if (mediaProfile !== 'RTP/AVP') {
      return json(res, 400, { error: 'This test source currently sends RTP/AVP only. SRTP must not be enabled until SRTP support is added.' });
    }
    const participantName = String(body.participantName || 'Web microphone').trim().slice(0, 80);
    const participantUri = String(body.participantUri || '').trim();
    if (!participantName || !/^(sips?:|tel:)[^\s<>\r\n]{1,240}$/i.test(participantUri)) {
      return json(res, 400, { error: 'Enter a participant name and a SIP/SIPS or tel URI for the SIPREC metadata.' });
    }
    sessionStarting = true;
    try {
      const session = await createSiprecSession({
        uri: sipUri,
        siprecIdentifier: typeof koreConfig.siprecIdentifier === 'string' ? koreConfig.siprecIdentifier : '',
        participantName,
        participantUri,
        publicIp: mediaPublicIp,
        rtpPort,
        caFile: typeof koreConfig.tlsCaFile === 'string' ? koreConfig.tlsCaFile : '',
        certFile: typeof koreConfig.tlsCertFile === 'string' ? koreConfig.tlsCertFile : '',
        keyFile: typeof koreConfig.tlsKeyFile === 'string' ? koreConfig.tlsKeyFile : '',
        logger: (message) => console.log(`[siprec] ${message}`),
      });
      const record = { session, endpointId: endpoint.id, token: crypto.randomBytes(32).toString('hex'), ws: null };
      activeSession = record;
      record.connectTimer = setTimeout(() => {
        if (activeSession === record && !record.ws) {
          activeSession = null;
          record.session.stop().catch((error) => console.error(`[siprec] cleanup after media connection timeout failed: ${error.message}`));
        }
      }, 20000);
      session.onEnded = () => {
        clearTimeout(record.connectTimer);
        if (activeSession === record) activeSession = null;
        if (record.ws && !record.ws.destroyed && !record.ws.writableEnded) record.ws.end(Buffer.from([0x88, 0x00]));
      };
      return json(res, 201, {
        sessionId: session.id,
        streamToken: record.token,
        endpoint: endpoint.label,
        mediaDestination: `${session.remoteMedia.address}:${session.remoteMedia.port}`,
        codec: 'PCMU/8000',
        mediaProfile,
      });
    } catch (error) {
      return json(res, 502, { error: error.message || 'Could not establish the SIPREC session.' });
    } finally {
      sessionStarting = false;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/session/stop') {
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Request body must be a JSON object.' });
    if (!activeSession) return json(res, 200, { stopped: true, message: 'No active SIPREC session.' });
    if (!safeTokenEqual(body.streamToken, activeSession.token)) return json(res, 403, { error: 'Invalid session token.' });
    const record = activeSession;
    activeSession = null;
    if (record.ws && !record.ws.destroyed) record.ws.end(Buffer.from([0x88, 0x00]));
    await record.session.stop();
    return json(res, 200, { stopped: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/probe') {
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json(res, 400, { error: 'Request body must be a JSON object' });
    }
    const gateway = gateways.find((candidate) => candidate.id === body.endpoint);
    if (!gateway) return json(res, 400, { error: 'Select a valid Kore SIPREC endpoint' });
    const sipUri = String(body.sipUri || gateway.uri || '').trim();
    if (!sipUri) return json(res, 400, { error: 'Paste a Kore SIPREC URI into the endpoint field' });
    const target = parseKoreSipUri(sipUri);
    if (!target) return json(res, 400, { error: 'Enter a SIP/SIPS URI for a Kore SBC on kore.ai using port 5060 or 5061' });

    try {
      const result = await probeTls(target);
      return json(res, 200, {
        endpoint: gateway.id,
        ...result,
        message: 'TLS handshake succeeded. This does not send SIP signaling, SIPREC metadata, or audio.',
      });
    } catch (error) {
      return json(res, 502, {
        endpoint: gateway.id,
        reachable: false,
        error: error.code || error.message || 'TLS handshake failed',
        message: 'Check DNS, outbound TCP/TLS, Kore IP allowlisting, certificate requirements, and the configured port.',
      });
    }
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/')) {
    return json(res, 404, { error: 'API route not found' });
  }

  let relative;
  try {
    relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  } catch {
    return json(res, 400, { error: 'Invalid path' });
  }
  const filePath = resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) return json(res, 403, { error: 'Forbidden' });
  try {
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile()) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'content-type': mimeTypes[extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self'; script-src 'self'; img-src 'self' data:; media-src 'self' blob:; frame-ancestors 'none'",
    });
    const file = createReadStream(filePath);
    file.on('error', () => res.destroy());
    return file.pipe(res);
  } catch {
    return json(res, 404, { error: 'Not found' });
  }
}

function acceptMediaWebSocket(req, socket, head) {
  const origin = req.headers.origin;
  let originMatchesHost = false;
  try { originMatchesHost = new URL(origin).host === req.headers.host; } catch {}
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const record = activeSession;
  const token = requestUrl.searchParams.get('token');
  const key = req.headers['sec-websocket-key'];
  if (requestUrl.pathname !== '/api/session/media' || !record || !safeTokenEqual(token, record.token) || !key || !originMatchesHost) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n'));
  socket.setNoDelay(true);
  clearTimeout(record.connectTimer);
  record.ws = socket;
  let pending = head || Buffer.alloc(0);
  const closeWithCode = (code) => {
    const frame = Buffer.alloc(4);
    frame[0] = 0x88;
    frame[1] = 2;
    frame.writeUInt16BE(code, 2);
    if (!socket.destroyed) socket.end(frame);
  };
  const processFrames = () => {
    while (pending.length >= 2) {
      const first = pending[0];
      const second = pending[1];
      const final = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (!masked || !final) return closeWithCode(1002);
      if (length === 126) {
        if (pending.length < 4) return;
        length = pending.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (pending.length < 10) return;
        const longLength = pending.readBigUInt64BE(2);
        if (longLength > 1024n) return closeWithCode(1009);
        length = Number(longLength);
        offset = 10;
      }
      if (length > 1024) return closeWithCode(1009);
      const frameLength = offset + 4 + length;
      if (pending.length < frameLength) return;
      const mask = pending.subarray(offset, offset + 4);
      const payload = Buffer.from(pending.subarray(offset + 4, frameLength));
      for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index & 3];
      pending = pending.subarray(frameLength);
      if (opcode === 0x8) {
        socket.end(Buffer.from([0x88, 0x00]));
        return;
      }
      if (opcode === 0x9) {
        if (payload.length < 126) socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
        continue;
      }
      if (opcode !== 0x2 || payload.length !== 160) return closeWithCode(1003);
      record.session.sendAudio(payload);
    }
  };
  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    processFrames();
  });
  const handleSocketClose = () => {
    if (record.ws === socket) record.ws = null;
    if (activeSession === record) {
      activeSession = null;
      record.session.stop().catch((error) => console.error(`[siprec] stop after media socket close failed: ${error.message}`));
    }
  };
  socket.on('close', handleSocketClose);
  socket.on('error', handleSocketClose);
  processFrames();
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (res.headersSent) return res.end();
    json(res, error.status || 500, { error: error.message || 'Unexpected server error' });
  });
});
server.on('upgrade', acceptMediaWebSocket);
server.listen(port, host, () => {
  console.log(`Kore SIPREC test source and UI listening on http://${host}:${port}`);
});
