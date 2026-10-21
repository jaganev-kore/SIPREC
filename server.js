import http from 'node:http';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import net, { isIPv4 } from 'node:net';
import dgram from 'node:dgram';
import { lookup } from 'node:dns/promises';
import { createSiprecSession } from './siprec-src.js';
import { createVoiceGatewaySession, recognizeGoogleSpeech, synthesizeGoogleTts } from './voice-gateway.js';

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
const googleCloudConfig = appConfig.googleCloud && typeof appConfig.googleCloud === 'object' ? appConfig.googleCloud : {};
const googleTtsConfig = googleCloudConfig.textToSpeech && typeof googleCloudConfig.textToSpeech === 'object' ? googleCloudConfig.textToSpeech : {};
const googleSttConfig = googleCloudConfig.speechToText && typeof googleCloudConfig.speechToText === 'object' ? googleCloudConfig.speechToText : {};
const mediaConfig = appConfig.media && typeof appConfig.media === 'object' ? appConfig.media : {};
const host = typeof appConfig.host === 'string' ? appConfig.host : '127.0.0.1';
const port = Number(appConfig.port || 3000);
const sipTransport = String(koreConfig.sipTransport || 'TLS').trim().toUpperCase();

const gateways = [
  { id: 'primary', label: 'Kore SBC 1', uri: typeof koreConfig.siprecPrimaryUri === 'string' ? koreConfig.siprecPrimaryUri : '' },
  { id: 'secondary', label: 'Kore SBC 2', uri: typeof koreConfig.siprecSecondaryUri === 'string' ? koreConfig.siprecSecondaryUri : '' },
];
const mediaPublicIp = typeof mediaConfig.publicIp === 'string' ? mediaConfig.publicIp : '';
const rtpPort = Number(mediaConfig.rtpPort || 40000);
const mediaProfile = typeof mediaConfig.profile === 'string' ? mediaConfig.profile : 'RTP/AVP';
const voiceGatewayUri = typeof koreConfig.voiceBotSipUri === 'string' ? koreConfig.voiceBotSipUri : '';
const voiceGatewayTransport = String(koreConfig.voiceGatewayTransport || 'UDP').trim().toUpperCase();
const voiceGatewayRtpPort = Number(mediaConfig.voiceGatewayRtpPort || 42000);
const voiceTtsLanguageCode = typeof googleTtsConfig.languageCode === 'string' ? googleTtsConfig.languageCode : (typeof koreConfig.voiceTtsLanguageCode === 'string' ? koreConfig.voiceTtsLanguageCode : 'en-US');
const voiceTtsName = typeof googleTtsConfig.voiceName === 'string' ? googleTtsConfig.voiceName : (typeof koreConfig.voiceTtsName === 'string' ? koreConfig.voiceTtsName : '');
const googleTtsApiUrl = typeof googleTtsConfig.apiUrl === 'string' ? googleTtsConfig.apiUrl : 'https://texttospeech.googleapis.com/v1/text:synthesize';
const speechLanguageCode = typeof googleSttConfig.languageCode === 'string' ? googleSttConfig.languageCode : (typeof koreConfig.speechLanguageCode === 'string' ? koreConfig.speechLanguageCode : 'en-US');
const speechModel = typeof googleSttConfig.model === 'string' ? googleSttConfig.model : (typeof koreConfig.speechModel === 'string' ? koreConfig.speechModel : 'phone_call');
const speechToTextEnabled = googleSttConfig.enabled === undefined ? koreConfig.speechToTextEnabled !== false : googleSttConfig.enabled !== false;
const googleSttApiUrl = typeof googleSttConfig.apiUrl === 'string' ? googleSttConfig.apiUrl : 'https://speech.googleapis.com/v1/speech:recognize';
const googleCloudProjectId = typeof googleCloudConfig.projectId === 'string' ? googleCloudConfig.projectId : (typeof koreConfig.googleCloudProjectId === 'string' ? koreConfig.googleCloudProjectId : '');
let activeSession = null;
let sessionStarting = false;
let activeVoiceSession = null;
let voiceSessionStarting = false;

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

function readJson(req, maxBytes = 4096) {
  return new Promise((resolveBody, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) {
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

function validGoogleApiUrl(value, service) {
  let parsed;
  try { parsed = new URL(String(value)); } catch { return false; }
  const allowedHost = service === 'tts'
    ? /^(?:[a-z0-9-]+-)?texttospeech\.googleapis\.com$/i.test(parsed.hostname)
    : /^(?:[a-z0-9-]+-)?speech\.googleapis\.com$/i.test(parsed.hostname);
  const expectedPath = service === 'tts' ? '/v1/text:synthesize' : '/v1/speech:recognize';
  return parsed.protocol === 'https:' && allowedHost && (!parsed.port || parsed.port === '443') && parsed.pathname === expectedPath && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
}

function parseSipUri(uri) {
  // The supplied Kore URIs use the form sip:user@host:port?headers.
  if (typeof uri !== 'string' || /[\s<>\r\n]/.test(uri)) return null;
  const match = uri.match(/^sips?:([^@]+)@([^;?:]+)(?::(\d+))?(?:[?;].*)?$/i);
  if (!match) return null;
  return { host: match[2], port: Number(match[3] || 5060), secure: /^sips:/i.test(uri) };
}

function parseKoreSipUri(uri) {
  if (typeof uri !== 'string' || uri.length > 512) return null;
  const target = parseSipUri(uri.trim());
  if (!target || !/(^|\.)kore\.ai$/i.test(target.host) || ![5060, 5061].includes(target.port)) return null;
  return target;
}

async function loadTlsOptions() {
  const caFile = typeof koreConfig.tlsCaFile === 'string' ? koreConfig.tlsCaFile : '';
  const certFile = typeof koreConfig.tlsCertFile === 'string' ? koreConfig.tlsCertFile : '';
  const keyFile = typeof koreConfig.tlsKeyFile === 'string' ? koreConfig.tlsKeyFile : '';
  if (Boolean(certFile) !== Boolean(keyFile)) {
    throw new Error('Set both kore.tlsCertFile and kore.tlsKeyFile to use a TLS client certificate.');
  }
  const [ca, cert, key] = await Promise.all([
    caFile ? readFile(caFile) : undefined,
    certFile ? readFile(certFile) : undefined,
    keyFile ? readFile(keyFile) : undefined,
  ]);
  return { ca, cert, key };
}

function probeSipTransport(target, transport, tlsOptions = {}) {
  if (!['TLS', 'TCP', 'UDP'].includes(transport)) {
    return Promise.reject(new Error(`SIP transport ${transport} is not supported. Choose UDP, TCP or TLS.`));
  }
  if (transport !== 'TLS' && target.secure) return Promise.reject(new Error('A SIPS URI requires TLS signaling; use a SIP URI for UDP or TCP.'));
  if (transport === 'UDP') {
    return lookup(target.host).then(() => new Promise((resolveProbe, rejectProbe) => {
      const socket = dgram.createSocket('udp4');
      const timer = setTimeout(() => socket.close(() => rejectProbe(new Error('UDP socket setup timed out'))), 7000);
      socket.once('error', (error) => { clearTimeout(timer); rejectProbe(error); });
      socket.bind(0, '0.0.0.0', () => {
        clearTimeout(timer);
        socket.close(() => resolveProbe({ reachable: true, transport, remoteReachabilityVerified: false }));
      });
    }));
  }
  return new Promise((resolveProbe, rejectProbe) => {
    const socket = transport === 'TLS'
      ? tls.connect({
        host: target.host,
        port: target.port,
        servername: target.host,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        ...tlsOptions,
      })
      : net.connect({ host: target.host, port: target.port });
    const connectedEvent = transport === 'TLS' ? 'secureConnect' : 'connect';
    const timer = setTimeout(() => socket.destroy(new Error(`${transport} connection timed out`)), 7000);
    socket.once(connectedEvent, () => {
      clearTimeout(timer);
      const result = { reachable: true, transport };
      if (transport === 'TLS') {
        const certificate = socket.getPeerCertificate();
        result.tlsVersion = socket.getProtocol();
        result.certificateSubject = certificate.subject?.CN || certificate.subject?.O || 'verified certificate';
      }
      resolveProbe(result);
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
      sipTransport,
      sipTransports: ['TLS', 'UDP', 'TCP'],
      siprecIdentifier: typeof koreConfig.siprecIdentifier === 'string' ? koreConfig.siprecIdentifier : '',
      dtmf: typeof koreConfig.dtmf === 'string' ? koreConfig.dtmf : 'RFC2833',
      sipCredentialsConfigured: Boolean(koreConfig.sipUsername && koreConfig.sipPassword),
      endpoints: gateways.map((gateway) => ({ ...gateway, configured: Boolean(gateway.uri) })),
      voiceBotConfigured: Boolean(voiceGatewayUri),
      voiceGatewayUri,
      voiceGatewayTransport,
      voiceGatewayRtpPort,
      voiceTtsLanguageCode,
      voiceTtsName,
      googleTtsApiUrl,
      speechLanguageCode,
      speechModel,
      speechToTextEnabled,
      googleSttApiUrl,
      googleCloudProjectId,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/voice/session/start') {
    if (activeVoiceSession || voiceSessionStarting) return json(res, 409, { error: 'A Voice Gateway call is already active or starting.' });
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Request body must be a JSON object.' });
    const uri = String(body.sipUri || voiceGatewayUri).trim();
    const requestedTransport = String(body.transport || voiceGatewayTransport).trim().toUpperCase();
    const target = parseKoreSipUri(uri);
    if (!target) return json(res, 400, { error: 'Enter the Kore Voice Gateway SIP URI (a kore.ai SIP/SIPS URI on port 5060 or 5061).' });
    if (!['UDP', 'TCP', 'TLS'].includes(requestedTransport)) return json(res, 400, { error: 'Voice Gateway transport must be UDP, TCP, or TLS.' });
    if (!isIPv4(mediaPublicIp)) return json(res, 400, { error: 'Set media.publicIp in config.json to the GCP VM static external IPv4 address.' });
    if (!Number.isInteger(voiceGatewayRtpPort) || voiceGatewayRtpPort < 1024 || voiceGatewayRtpPort > 65534 || voiceGatewayRtpPort % 2) return json(res, 400, { error: 'media.voiceGatewayRtpPort must be an even UDP port from 1024 through 65534.' });
    const selectedSpeechLanguage = String(body.speechLanguageCode || speechLanguageCode).trim();
    const selectedSpeechModel = String(body.speechModel || speechModel).trim();
    const selectedProjectId = String(body.googleCloudProjectId || googleCloudProjectId).trim();
    const selectedSttApiUrl = String(body.googleSttApiUrl || googleSttApiUrl).trim();
    const selectedTtsApiUrl = String(body.googleTtsApiUrl || googleTtsApiUrl).trim();
    if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(selectedSpeechLanguage)) return json(res, 400, { error: 'Enter a valid BCP-47 Speech-to-Text language code, such as en-US.' });
    if (!['phone_call', 'default', 'latest_short', 'latest_long'].includes(selectedSpeechModel)) return json(res, 400, { error: 'Choose a supported Speech-to-Text model.' });
    if (selectedProjectId && !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(selectedProjectId)) return json(res, 400, { error: 'Enter a valid Google Cloud project ID.' });
    if (!validGoogleApiUrl(selectedSttApiUrl, 'stt')) return json(res, 400, { error: 'Speech-to-Text URL must be an HTTPS Google Speech API URL ending in /v1/speech:recognize.' });
    if (!validGoogleApiUrl(selectedTtsApiUrl, 'tts')) return json(res, 400, { error: 'Text-to-Speech URL must be an HTTPS Google Text-to-Speech API URL ending in /v1/text:synthesize.' });
    const selectedTtsLanguage = String(body.voiceTtsLanguageCode || voiceTtsLanguageCode).trim();
    const selectedTtsName = String(body.voiceTtsName || voiceTtsName).trim().slice(0, 128);
    if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(selectedTtsLanguage)) return json(res, 400, { error: 'Enter a valid BCP-47 Text-to-Speech language code, such as en-US.' });
    voiceSessionStarting = true;
    try {
      const session = await createVoiceGatewaySession({
        uri,
        transport: requestedTransport,
        publicIp: mediaPublicIp,
        rtpPort: voiceGatewayRtpPort,
        callerId: typeof koreConfig.voiceCallerId === 'string' ? koreConfig.voiceCallerId : (koreConfig.siprecIdentifier || 'web-caller'),
        logger: (message) => console.log(`[voice] ${message}`),
      });
      const record = {
        session,
        token: crypto.randomBytes(32).toString('hex'),
        ws: null,
        speechLanguageCode: selectedSpeechLanguage,
        speechModel: selectedSpeechModel,
        googleCloudProjectId: selectedProjectId,
        googleSttApiUrl: selectedSttApiUrl,
        googleTtsApiUrl: selectedTtsApiUrl,
        speechToTextEnabled: body.speechToTextEnabled === undefined ? speechToTextEnabled : body.speechToTextEnabled === true,
        voiceTtsLanguageCode: selectedTtsLanguage,
        voiceTtsName: selectedTtsName,
        callerAudio: [],
        gatewayAudio: [],
        pendingTranscripts: [],
      };
      activeVoiceSession = record;
      record.pendingAudio = [];
      session.onAudio = (frame) => {
        if (record.speechToTextEnabled) record.gatewayAudio.push(Buffer.from(frame));
        if (record.ws && !record.ws.destroyed && !record.ws.writableEnded) record.ws.write(websocketBinaryFrame(frame));
        else {
          record.pendingAudio.push(Buffer.from(frame));
          if (record.pendingAudio.length > 100) record.pendingAudio.shift();
        }
      };
      record.connectTimer = setTimeout(() => {
        if (activeVoiceSession === record && !record.ws) {
          activeVoiceSession = null;
          record.session.stop().catch((error) => console.error(`[voice] cleanup after media connection timeout failed: ${error.message}`));
        }
      }, 20000);
      record.transcriptionTimer = setInterval(() => flushVoiceTranscription(record), 8000);
      session.onEnded = async () => {
        clearTimeout(record.connectTimer);
        clearInterval(record.transcriptionTimer);
        await flushVoiceTranscription(record);
        if (activeVoiceSession === record) activeVoiceSession = null;
        if (record.ws && !record.ws.destroyed && !record.ws.writableEnded) record.ws.end(Buffer.from([0x88, 0x00]));
      };
      return json(res, 201, { sessionId: session.id, streamToken: record.token, callId: session.callId, remoteMedia: session.remoteMedia });
    } catch (error) {
      return json(res, 502, { error: error.message || 'Could not call the Kore Voice Gateway.' });
    } finally {
      voiceSessionStarting = false;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/voice/session/stop') {
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Request body must be a JSON object.' });
    if (!activeVoiceSession) return json(res, 200, { stopped: true });
    if (!safeTokenEqual(body.streamToken, activeVoiceSession.token)) return json(res, 403, { error: 'Invalid Voice Gateway session token.' });
    const record = activeVoiceSession;
    clearInterval(record.transcriptionTimer);
    await flushVoiceTranscription(record);
    activeVoiceSession = null;
    if (record.ws && !record.ws.destroyed) record.ws.end(Buffer.from([0x88, 0x00]));
    await record.session.stop();
    return json(res, 200, { stopped: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/voice/session/tts') {
    const body = await readJson(req, 10000);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Request body must be a JSON object.' });
    if (!activeVoiceSession || !safeTokenEqual(body.streamToken, activeVoiceSession.token)) return json(res, 403, { error: 'Start a Voice Gateway call before sending speech.' });
    try {
      const audio = await synthesizeGoogleTts(body.text, { languageCode: activeVoiceSession.voiceTtsLanguageCode, voiceName: activeVoiceSession.voiceTtsName, projectId: activeVoiceSession.googleCloudProjectId, apiUrl: activeVoiceSession.googleTtsApiUrl });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': audio.length, 'cache-control': 'no-store', 'x-audio-sample-rate': '8000', 'x-audio-format': 's16le-mono' });
      return res.end(audio);
    } catch (error) {
      return json(res, 502, { error: error.message || 'Google Cloud TTS failed.' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/session/start') {
    if (activeSession || sessionStarting) return json(res, 409, { error: 'A SIPREC test session is already active or starting.' });
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Request body must be a JSON object.' });
    const endpoint = gateways.find((gateway) => gateway.id === body.endpoint);
    if (!endpoint) return json(res, 400, { error: 'Select a valid Kore SIPREC endpoint.' });
    const sipUri = String(body.sipUri || endpoint.uri || '').trim();
    const requestedTransport = String(body.transport || sipTransport).trim().toUpperCase();
    if (!sipUri) return json(res, 400, { error: 'Paste a Kore SIPREC URI into the endpoint field.' });
    if (!parseKoreSipUri(sipUri)) return json(res, 400, { error: 'Enter a SIP/SIPS URI for a Kore SBC on kore.ai using port 5060 or 5061.' });
    if (!['TLS', 'TCP', 'UDP'].includes(requestedTransport)) return json(res, 400, { error: 'SIP transport must be TLS, UDP, or TCP.' });
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
        sipTransport: requestedTransport,
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
    const requestedTransport = String(body.transport || sipTransport).trim().toUpperCase();
    if (!sipUri) return json(res, 400, { error: 'Paste a Kore SIPREC URI into the endpoint field' });
    const target = parseKoreSipUri(sipUri);
    if (!target) return json(res, 400, { error: 'Enter a SIP/SIPS URI for a Kore SBC on kore.ai using port 5060 or 5061' });

    try {
      if (!['TLS', 'TCP', 'UDP'].includes(requestedTransport)) {
        return json(res, 400, { error: 'SIP transport must be TLS, UDP, or TCP.' });
      }
      const tlsOptions = requestedTransport === 'TLS' ? await loadTlsOptions() : {};
      const result = await probeSipTransport(target, requestedTransport, tlsOptions);
      return json(res, 200, {
        endpoint: gateway.id,
        ...result,
        message: requestedTransport === 'UDP'
          ? 'Kore hostname resolved and a local UDP socket opened. UDP has no connection handshake; remote reachability was not verified and no SIP packet was sent.'
          : requestedTransport === 'TLS'
          ? 'TLS handshake succeeded. This does not send SIP signaling, SIPREC metadata, or audio.'
          : 'TCP connection succeeded. This does not send SIP signaling, SIPREC metadata, or audio.',
      });
    } catch (error) {
      return json(res, 502, {
        endpoint: gateway.id,
        reachable: false,
        error: error.code || error.message || `${requestedTransport} connection failed`,
        message: requestedTransport === 'TLS'
          ? 'Check DNS, outbound TCP/TLS, Kore IP allowlisting, TLS requirements, and the configured port.'
          : requestedTransport === 'UDP'
            ? 'Check DNS, outbound UDP, Kore IP allowlisting, and the configured port.'
            : 'Check DNS, outbound TCP, Kore IP allowlisting, and the configured port.',
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

function websocketBinaryFrame(payload) {
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x82, payload.length]), payload]);
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x82;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x82;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

function websocketTextFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

function flushVoiceTranscription(record) {
  if (!record.speechToTextEnabled || !activeVoiceSession || activeVoiceSession !== record) return;
  const requests = [];
  for (const [speaker, key] of [['caller', 'callerAudio'], ['kore', 'gatewayAudio']]) {
    const chunks = record[key].splice(0);
    if (!chunks.length) continue;
    const audio = Buffer.concat(chunks);
    requests.push(recognizeGoogleSpeech(audio, { languageCode: record.speechLanguageCode, model: record.speechModel, projectId: record.googleCloudProjectId, apiUrl: record.googleSttApiUrl })
      .then((transcript) => {
        if (!transcript || activeVoiceSession !== record) return;
        const message = { type: 'transcript', speaker, text: transcript, timestamp: new Date().toISOString() };
        if (record.ws && !record.ws.destroyed && !record.ws.writableEnded) record.ws.write(websocketTextFrame(message));
        else {
          record.pendingTranscripts.push(message);
          if (record.pendingTranscripts.length > 100) record.pendingTranscripts.shift();
        }
      })
      .catch((error) => {
        console.error(`[voice] ${speaker} transcription failed: ${error.message}`);
        if (activeVoiceSession === record && record.ws && !record.ws.destroyed && !record.ws.writableEnded) {
          record.ws.write(websocketTextFrame({ type: 'transcription-error', message: error.message }));
        }
      }));
  }
  return Promise.allSettled(requests);
}

function acceptVoiceWebSocket(req, socket, head, requestUrl) {
  const origin = req.headers.origin;
  let originMatchesHost = false;
  try { originMatchesHost = new URL(origin).host === req.headers.host; } catch {}
  const record = activeVoiceSession;
  const token = requestUrl.searchParams.get('token');
  const key = req.headers['sec-websocket-key'];
  if (!record || !safeTokenEqual(token, record.token) || !key || !originMatchesHost) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
  socket.setNoDelay(true);
  clearTimeout(record.connectTimer);
  record.ws = socket;
  for (const transcript of record.pendingTranscripts.splice(0)) socket.write(websocketTextFrame(transcript));
  for (const frame of record.pendingAudio.splice(0)) socket.write(websocketBinaryFrame(frame));
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
      if (!(first & 0x80) || !(second & 0x80)) return closeWithCode(1002);
      const opcode = first & 0x0f;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (pending.length < 4) return;
        length = pending.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (pending.length < 10) return;
        const longLength = pending.readBigUInt64BE(2);
        if (longLength > 2048n) return closeWithCode(1009);
        length = Number(longLength);
        offset = 10;
      }
      if (length > 2048) return closeWithCode(1009);
      const frameLength = offset + 4 + length;
      if (pending.length < frameLength) return;
      const mask = pending.subarray(offset, offset + 4);
      const payload = Buffer.from(pending.subarray(offset + 4, frameLength));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      pending = pending.subarray(frameLength);
      if (opcode === 0x8) { socket.end(Buffer.from([0x88, 0x00])); return; }
      if (opcode === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
      if (opcode !== 0x2 || payload.length !== 160) return closeWithCode(1003);
      if (record.speechToTextEnabled) record.callerAudio.push(Buffer.from(payload));
      record.session.sendAudio(payload);
    }
  };
  socket.on('data', (chunk) => { pending = Buffer.concat([pending, chunk]); processFrames(); });
  const onClose = () => {
    if (record.ws === socket) record.ws = null;
    if (activeVoiceSession === record) {
      activeVoiceSession = null;
      record.session.stop().catch((error) => console.error(`[voice] stop after media socket close failed: ${error.message}`));
    }
  };
  socket.on('close', onClose);
  socket.on('error', onClose);
  processFrames();
}

function acceptMediaWebSocket(req, socket, head) {
  const origin = req.headers.origin;
  let originMatchesHost = false;
  try { originMatchesHost = new URL(origin).host === req.headers.host; } catch {}
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (requestUrl.pathname === '/api/voice/media') return acceptVoiceWebSocket(req, socket, head, requestUrl);
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
