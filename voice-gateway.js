import crypto from 'node:crypto';
import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';

const CRLF = '\r\n';

function parseUri(uri) {
  const match = String(uri).match(/^sips?:([^@]+)@([^;?:]+)(?::(\d+))?(?:[?;].*)?$/i);
  if (!match) throw new Error('Enter a valid Kore Voice Gateway SIP URI.');
  const secure = /^sips:/i.test(uri);
  return { host: match[2], port: Number(match[3] || (secure ? 5061 : 5060)), secure };
}

function parseHeaders(text) {
  const lines = text.split(CRLF);
  const first = lines.shift() || '';
  const headers = new Map();
  for (const line of lines) {
    if (/^[\t ]/.test(line) && headers.size) {
      const key = [...headers.keys()].at(-1);
      headers.set(key, `${headers.get(key)} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { first, headers };
}

function parseMessage(packet) {
  const text = packet.toString('utf8');
  const boundary = text.indexOf(`${CRLF}${CRLF}`);
  if (boundary < 0) return null;
  const parsed = parseHeaders(text.slice(0, boundary));
  const bodyStart = boundary + 4;
  const length = Number(parsed.headers.get('content-length') || 0);
  if (text.length < bodyStart + length) return null;
  return { ...parsed, body: text.slice(bodyStart, bodyStart + length), bytes: bodyStart + length };
}

function makeRequest({ transport, method, uri, viaHost, from, to, callId, cseq, branch, body = '', contact = '', routes = [] }) {
  const lines = [
    `${method} ${uri} SIP/2.0`,
    `Via: SIP/2.0/${transport} ${viaHost};branch=${branch};rport`,
    'Max-Forwards: 70',
    `From: ${from}`,
    `To: ${to}`,
    `Call-ID: ${callId}`,
    `CSeq: ${cseq} ${method}`,
  ];
  for (const route of routes) lines.push(`Route: ${route}`);
  if (contact) lines.push(`Contact: ${contact}`);
  if (body) lines.push('Content-Type: application/sdp');
  lines.push(`Content-Length: ${Buffer.byteLength(body)}`, '', body);
  return lines.join(CRLF);
}

class SipDialog {
  constructor(socket, transport, remote = null) {
    this.socket = socket;
    this.transport = transport;
    this.remote = remote;
    this.buffer = '';
    this.responses = [];
    this.waiters = [];
    this.closed = false;
    socket.on(remote ? 'message' : 'data', (data) => this.receive(data));
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('Kore closed the Voice Gateway SIP connection.')));
  }

  receive(data) {
    this.buffer += data.toString('utf8');
    while (true) {
      const message = parseMessage(Buffer.from(this.buffer));
      if (!message) break;
      this.buffer = this.buffer.slice(message.bytes);
      if (/^SIP\/2\.0\s/i.test(message.first)) {
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(message);
        else this.responses.push(message);
        this.onResponse?.(message);
      } else this.onRequest?.(message);
    }
  }

  send(message) {
    if (this.closed) throw new Error('The Voice Gateway SIP connection is closed.');
    if (this.remote) this.socket.send(message);
    else this.socket.write(message);
  }

  nextResponse(timeoutMs = 30000) {
    if (this.responses.length) return Promise.resolve(this.responses.shift());
    if (this.closed) return Promise.reject(new Error('The Voice Gateway SIP connection is closed.'));
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new Error('Timed out waiting for the Voice Gateway SIP response.'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    this.onClose?.();
  }

  close() {
    if (this.remote) {
      try { this.socket.close(); } catch {}
    } else this.socket.destroy();
  }
}

function sdpAddress(sdp, field = 'c=IN IP4 ') {
  const line = sdp.split(/\r?\n/).find((item) => item.startsWith(field));
  return line?.slice(field.length).split('/')[0].trim() || '';
}

function parseAudioAnswer(sdp) {
  let inheritedAddress = sdpAddress(sdp);
  let sessionDirection = 'sendrecv';
  let audio = null;
  for (const raw of sdp.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('m=')) {
      const parts = line.slice(2).split(/\s+/);
      audio = parts[0] === 'audio' ? { port: Number(parts[1].split('/')[0]), profile: parts[2], payloads: parts.slice(3).map(Number), address: inheritedAddress, direction: sessionDirection } : null;
    } else if (audio && line.startsWith('c=IN IP4 ')) audio.address = line.slice(9).split('/')[0];
    else if (audio && /^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line)) audio.direction = line.slice(2);
    else if (!audio && /^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line)) sessionDirection = line.slice(2);
  }
  if (!audio || !audio.port || !audio.address || audio.profile !== 'RTP/AVP' || !audio.payloads.includes(0)) {
    throw new Error('Kore Voice Gateway did not accept the offered RTP/AVP PCMU/8000 audio stream.');
  }
  if (audio.direction !== 'sendrecv') throw new Error('Kore Voice Gateway must negotiate sendrecv audio for microphone input and spoken responses.');
  return audio;
}

function makeSdp(publicIp, rtpPort) {
  const version = Date.now();
  return [
    'v=0',
    `o=SignalDesk ${version} ${version} IN IP4 ${publicIp}`,
    's=Kore Voice Gateway call',
    `c=IN IP4 ${publicIp}`,
    't=0 0',
    `m=audio ${rtpPort} RTP/AVP 0`,
    'a=rtpmap:0 PCMU/8000',
    'a=ptime:20',
    'a=sendrecv',
    '',
  ].join(CRLF);
}

function makeRtp(payload, sequence, timestamp, ssrc) {
  const packet = Buffer.allocUnsafe(12 + payload.length);
  packet[0] = 0x80;
  packet[1] = 0;
  packet.writeUInt16BE(sequence & 0xffff, 2);
  packet.writeUInt32BE(timestamp >>> 0, 4);
  packet.writeUInt32BE(ssrc >>> 0, 8);
  payload.copy(packet, 12);
  return packet;
}

function parseRtpPayload(packet) {
  if (packet.length < 12 || (packet[0] >> 6) !== 2 || (packet[1] & 0x7f) !== 0) return null;
  let offset = 12 + (packet[0] & 0x0f) * 4;
  if (packet[0] & 0x10) {
    if (packet.length < offset + 4) return null;
    offset += 4 + packet.readUInt16BE(offset + 2) * 4;
  }
  let end = packet.length;
  if (packet[0] & 0x20) end -= packet[packet.length - 1];
  return end > offset ? packet.subarray(offset, end) : null;
}

export async function createVoiceGatewaySession({ uri, transport, publicIp, rtpPort, callerId = 'web-caller', logger = () => {} }) {
  const sipTransport = String(transport || 'UDP').trim().toUpperCase();
  if (!['UDP', 'TCP', 'TLS'].includes(sipTransport)) throw new Error('Voice Gateway signaling transport must be UDP, TCP, or TLS.');
  if (sipTransport === 'TLS' && !/^sips:/i.test(uri)) throw new Error('Use a SIPS URI when Voice Gateway signaling uses TLS.');
  if (sipTransport !== 'TLS' && /^sips:/i.test(uri)) throw new Error('Use a SIP URI for UDP or TCP signaling; SIPS requires TLS.');
  if (!net.isIPv4(publicIp)) throw new Error('Set media.publicIp to the GCP VM static external IPv4 address.');
  if (!Number.isInteger(rtpPort) || rtpPort < 1024 || rtpPort > 65534 || rtpPort % 2) throw new Error('Voice Gateway RTP port must be an even UDP port from 1024 through 65534.');
  const target = parseUri(uri);
  const rtpSocket = dgram.createSocket('udp4');
  try {
    await new Promise((resolve, reject) => {
      rtpSocket.once('error', reject);
      rtpSocket.bind(rtpPort, '0.0.0.0', resolve);
    });
  } catch (error) {
    try { rtpSocket.close(); } catch {}
    throw new Error(`Unable to bind Voice Gateway RTP port ${rtpPort}: ${error.message}`);
  }
  const rtpCallId = `${crypto.randomUUID()}@${publicIp}`;
  const tag = crypto.randomBytes(8).toString('hex');
  const fromScheme = sipTransport === 'TLS' ? 'sips' : 'sip';
  const fromUri = `${fromScheme}:${encodeURIComponent(callerId)}@${publicIp}${sipTransport === 'TLS' ? '' : `;transport=${sipTransport.toLowerCase()}`}`;
  const from = `<${fromUri}>;tag=${tag}`;
  const to = `<${uri}>`;
  const branch = `z9hG4bK${crypto.randomBytes(10).toString('hex')}`;
  const contact = `<${fromUri}>`;
  const localSdp = makeSdp(publicIp, rtpPort);
  let socket;
  let remote = null;
  if (sipTransport === 'UDP') {
    socket = dgram.createSocket('udp4');
    remote = { host: target.host, port: target.port };
    try {
      await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(0, '0.0.0.0', resolve); });
      await new Promise((resolve, reject) => { socket.once('error', reject); socket.connect(target.port, target.host, resolve); });
    } catch (error) {
      try { socket.close(); } catch {}
      rtpSocket.close();
      throw error;
    }
  } else {
    socket = sipTransport === 'TLS'
      ? tls.connect({ host: target.host, port: target.port, servername: target.host, minVersion: 'TLSv1.2', rejectUnauthorized: true })
      : net.connect({ host: target.host, port: target.port });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Timed out connecting to the Voice Gateway over ${sipTransport}.`)); }, 10000);
        socket.once(sipTransport === 'TLS' ? 'secureConnect' : 'connect', () => { clearTimeout(timer); resolve(); });
        socket.once('error', (error) => { clearTimeout(timer); reject(error); });
      });
    } catch (error) {
      rtpSocket.close();
      throw error;
    }
  }
  const sip = new SipDialog(socket, sipTransport, remote);
  const invite = makeRequest({ transport: sipTransport, method: 'INVITE', uri, viaHost: publicIp, from, to, callId: rtpCallId, cseq: 1, branch, contact, body: localSdp })
    .replace(`${CRLF}Content-Length:`, `${CRLF}Allow: INVITE, ACK, BYE, CANCEL, OPTIONS, INFO${CRLF}User-Agent: SignalDesk-Voice-Gateway/0.1${CRLF}Content-Length:`);
  let finalResponse;
  try {
    sip.send(invite);
    let retransmitMs = 500;
    let gotProvisional = false;
    const inviteDeadline = Date.now() + 32000;
    while (true) {
      let response;
      if (sipTransport === 'UDP') {
        const remaining = inviteDeadline - Date.now();
        if (remaining <= 0) throw new Error('Timed out waiting for the Voice Gateway SIP response.');
        try {
          response = await sip.nextResponse(gotProvisional ? remaining : Math.min(retransmitMs, remaining));
        } catch (error) {
          if (gotProvisional || !/Timed out waiting/.test(error.message)) throw error;
          sip.send(invite);
          retransmitMs = Math.min(retransmitMs * 2, 4000);
          continue;
        }
      } else response = await sip.nextResponse();
      const code = Number(response.first.match(/^SIP\/2\.0\s+(\d+)/i)?.[1]);
      if (!code) continue;
      if (code < 200) { gotProvisional = true; continue; }
      finalResponse = response;
      if (code >= 300) {
        sip.send(makeRequest({ transport: sipTransport, method: 'ACK', uri, viaHost: publicIp, from, to: response.headers.get('to') || to, callId: rtpCallId, cseq: 1, branch }));
        throw new Error(`Kore Voice Gateway rejected the call (${code} ${response.first.replace(/^SIP\/2\.0\s+\d+\s*/, '')}). Call-ID: ${rtpCallId}`);
      }
      break;
    }
    const remoteTag = finalResponse.headers.get('to')?.match(/;\s*tag=([^;\s,]+)/i)?.[1];
    if (!remoteTag) throw new Error('Kore accepted the call without a SIP dialog tag.');
    const remoteTarget = finalResponse.headers.get('contact')?.match(/<([^>]+)>/)?.[1] || uri;
    const routes = (finalResponse.headers.get('record-route') || '').split(/,\s*/).filter(Boolean).reverse();
    const successAck = makeRequest({ transport: sipTransport, method: 'ACK', uri: remoteTarget, viaHost: publicIp, from, to: finalResponse.headers.get('to'), callId: rtpCallId, cseq: 1, branch: `z9hG4bK${crypto.randomBytes(10).toString('hex')}`, routes });
    sip.send(successAck);
    let remoteMedia;
    try {
      remoteMedia = parseAudioAnswer(finalResponse.body);
    } catch (error) {
      try {
        sip.send(makeRequest({ transport: sipTransport, method: 'BYE', uri: remoteTarget, viaHost: publicIp, from, to: finalResponse.headers.get('to'), callId: rtpCallId, cseq: 2, branch: `z9hG4bK${crypto.randomBytes(10).toString('hex')}`, routes }));
      } catch {}
      throw error;
    }

    const remoteRtp = { address: remoteMedia.address, port: remoteMedia.port };
    let seq = crypto.randomInt(0, 65536);
    let timestamp = crypto.randomInt(0, 0x7fffffff);
    const ssrc = crypto.randomInt(1, 0xffffffff);
    let ended = false;
    const session = {
      id: crypto.randomUUID(),
      callId: rtpCallId,
      remoteMedia,
      sipTransport,
      sip,
      rtpSocket,
      rtpPort,
      get ended() { return ended; },
      sendAudio(frame) {
        if (ended || !Buffer.isBuffer(frame) || frame.length !== 160) return;
        const packet = makeRtp(frame, seq++, timestamp, ssrc);
        timestamp = (timestamp + 160) >>> 0;
        rtpSocket.send(packet, remoteRtp.port, remoteRtp.address, (error) => { if (error) logger(`RTP send error: ${error.message}`); });
      },
      async stop({ remote: wasRemote = false } = {}) {
        if (ended) return;
        ended = true;
        if (!wasRemote && !sip.closed) {
          try {
            sip.send(makeRequest({ transport: sipTransport, method: 'BYE', uri: remoteTarget, viaHost: publicIp, from, to: finalResponse.headers.get('to'), callId: rtpCallId, cseq: 2, branch: `z9hG4bK${crypto.randomBytes(10).toString('hex')}`, routes }));
            await sip.nextResponse(3000).catch(() => null);
          } catch (error) { logger(`SIP BYE error: ${error.message}`); }
        }
        try { rtpSocket.close(); } catch {}
        sip.close();
        session.onEnded?.();
      },
    };
    rtpSocket.on('message', (packet, rinfo) => {
      if (ended || rinfo.address !== remoteRtp.address) return;
      const payload = parseRtpPayload(packet);
      if (payload?.length) session.onAudio?.(Buffer.from(payload));
    });
    sip.onRequest = (request) => {
      const method = request.first.split(' ')[0]?.toUpperCase();
      if (method === 'BYE' || method === 'OPTIONS') {
        const responseLines = ['SIP/2.0 200 OK'];
        for (const name of ['via', 'from', 'to', 'call-id', 'cseq']) {
          const value = request.headers.get(name);
          if (value) responseLines.push(`${name}: ${value}`);
        }
        responseLines.push('Content-Length: 0', '', '');
        sip.send(responseLines.join(CRLF));
        if (method === 'BYE') session.stop({ remote: true });
      }
    };
    sip.onResponse = (response) => {
      if (/^SIP\/2\.0\s+2\d\d\s/i.test(response.first) && /\b1\s+INVITE\b/i.test(response.headers.get('cseq') || '')) {
        try { sip.send(successAck); } catch {}
      }
    };
    sip.onClose = () => { if (!ended) session.stop({ remote: true }); };
    logger(`SIP/${sipTransport} Voice Gateway call established; RTP ${remoteRtp.address}:${remoteRtp.port}, PCMU/8000.`);
    return session;
  } catch (error) {
    try { rtpSocket.close(); } catch {}
    sip.close();
    throw error;
  }
}

async function googleCloudToken() {
  let response;
  try {
    response = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    throw new Error('Google Cloud TTS credentials were unavailable. Run this service on GCP with an attached VM service account.');
  }
  if (!response.ok) throw new Error(`GCP metadata token request failed (${response.status}). Check the VM service account and access scopes.`);
  const data = await response.json();
  if (!data.access_token) throw new Error('The GCP metadata server returned no access token.');
  return data.access_token;
}

function readWavPcm(wav) {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Google TTS returned audio in an unexpected format.');
  let offset = 12;
  let format;
  let channels;
  let sampleRate;
  let bitsPerSample;
  let pcm;
  while (offset + 8 <= wav.length) {
    const name = wav.toString('ascii', offset, offset + 4);
    const length = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (name === 'fmt ' && length >= 16) {
      format = wav.readUInt16LE(start);
      channels = wav.readUInt16LE(start + 2);
      sampleRate = wav.readUInt32LE(start + 4);
      bitsPerSample = wav.readUInt16LE(start + 14);
    } else if (name === 'data') pcm = wav.subarray(start, start + length);
    offset = start + length + (length & 1);
  }
  if (format !== 1 || channels !== 1 || bitsPerSample !== 16 || !sampleRate || !pcm) throw new Error('Google TTS audio must be mono LINEAR16 PCM.');
  const inputSamples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  if (sampleRate === 8000) return Buffer.from(pcm);
  const outputLength = Math.floor(inputSamples.length * 8000 / sampleRate);
  const output = Buffer.alloc(outputLength * 2);
  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = i * sampleRate / 8000;
    const left = Math.floor(sourceIndex);
    const fraction = sourceIndex - left;
    const a = inputSamples[Math.min(left, inputSamples.length - 1)];
    const b = inputSamples[Math.min(left + 1, inputSamples.length - 1)];
    output.writeInt16LE(Math.round(a + (b - a) * fraction), i * 2);
  }
  return output;
}

export async function synthesizeGoogleTts(text, { languageCode = 'en-US', voiceName = '' } = {}) {
  const content = String(text || '').trim();
  if (!content || content.length > 2000) throw new Error('Enter text with 1 to 2,000 characters for speech.');
  const accessToken = await googleCloudToken();
  const voice = { languageCode };
  if (voiceName) voice.name = voiceName;
  const response = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ input: { text: content }, voice, audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000, speakingRate: 1 } }),
    signal: AbortSignal.timeout(20000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`Google Cloud TTS failed (${response.status}): ${result.error?.message || 'check the API, service-account role, and selected voice.'}`);
  if (!result.audioContent) throw new Error('Google Cloud TTS returned no audio.');
  return readWavPcm(Buffer.from(result.audioContent, 'base64'));
}
