import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import net from 'node:net';
import tls from 'node:tls';

const CRLF = '\r\n';
const MAX_SIP_RESPONSE_BYTES = 1024 * 1024;

function sipHeaders(raw) {
  const lines = raw.split(CRLF);
  const first = lines.shift() || '';
  const headers = new Map();
  for (const line of lines) {
    if (/^[ \t]/.test(line) && headers.size) {
      const lastKey = [...headers.keys()].at(-1);
      headers.set(lastKey, `${headers.get(lastKey)} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (headers.has(key)) headers.set(key, `${headers.get(key)}, ${value}`);
    else headers.set(key, value);
  }
  return { first, headers };
}

function parseSipUri(uri) {
  const match = uri.match(/^sips?:([^@]+)@([^;?:]+)(?::(\d+))?(?:[?;].*)?$/i);
  if (!match) throw new Error('The configured Kore SIP URI is invalid.');
  return { user: match[1], host: match[2], port: Number(match[3] || 5060) };
}

function randomTag() {
  return crypto.randomBytes(8).toString('hex');
}

function base64Uuid() {
  return Buffer.from(crypto.randomUUID().replaceAll('-', ''), 'hex').toString('base64');
}

function xmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[char]);
}

function buildMetadata({ callId, participantName, participantUri, startedAt }) {
  const sessionId = base64Uuid();
  const participantId = base64Uuid();
  const streamId = base64Uuid();
  const time = startedAt.toISOString();
  const sipSessionId = callId.replace(/[^A-Za-z0-9]/g, '').slice(0, 64);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\r\n` +
    `<recording xmlns="urn:ietf:params:xml:ns:recording:1">` +
    `<datamode>complete</datamode>` +
    `<session session_id="${sessionId}"><sipSessionID>${sipSessionId}</sipSessionID></session>` +
    `<participant participant_id="${participantId}"><nameID aor="${xmlEscape(participantUri)}"><name>${xmlEscape(participantName)}</name></nameID></participant>` +
    `<stream stream_id="${streamId}" session_id="${sessionId}"><label>1</label></stream>` +
    `<sessionrecordingassoc session_id="${sessionId}"><associate-time>${time}</associate-time></sessionrecordingassoc>` +
    `<participantsessionassoc participant_id="${participantId}" session_id="${sessionId}"><associate-time>${time}</associate-time></participantsessionassoc>` +
    `<participantstreamassoc participant_id="${participantId}"><send>${streamId}</send></participantstreamassoc>` +
    `</recording>`;
  return xml;
}

function makeSdp(publicIp, rtpPort) {
  const sessionVersion = Date.now();
  return [
    'v=0',
    `o=SignalDesk ${sessionVersion} ${sessionVersion} IN IP4 ${publicIp}`,
    's=Kore Agent Assist SIPREC test',
    `c=IN IP4 ${publicIp}`,
    't=0 0',
    `m=audio ${rtpPort} RTP/AVP 0`,
    'a=rtpmap:0 PCMU/8000',
    'a=ptime:20',
    'a=sendonly',
    'a=label:1',
    `a=rtcp:${rtpPort + 1} IN IP4 ${publicIp}`,
    '',
  ].join(CRLF);
}

function makeInviteBody(sdp, metadata) {
  const boundary = `siprec-${crypto.randomBytes(12).toString('hex')}`;
  const body = [
    `--${boundary}`,
    'Content-Type: application/sdp',
    'Content-Disposition: session',
    '',
    sdp.trimEnd(),
    `--${boundary}`,
    'Content-Type: application/rs-metadata+xml; charset=utf-8',
    'Content-Disposition: recording-session',
    '',
    metadata,
    `--${boundary}--`,
    '',
  ].join(CRLF);
  return {
    body,
    contentType: `multipart/mixed; boundary="${boundary}"`,
  };
}

function parseSipMessage(packet) {
  const marker = packet.indexOf('\r\n\r\n');
  if (marker < 0) return null;
  const headerText = packet.slice(0, marker);
  const parsed = sipHeaders(headerText);
  const length = Number(parsed.headers.get('content-length') || 0);
  const bodyStart = marker + 4;
  if (packet.length < bodyStart + length) return null;
  return {
    ...parsed,
    body: packet.slice(bodyStart, bodyStart + length),
    bytes: bodyStart + length,
  };
}

class SipConnection {
  constructor(socket, transport) {
    this.socket = socket;
    this.transport = transport;
    this.buffer = '';
    this.messages = [];
    this.waiters = [];
    this.closedError = null;
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => {
      this.fail(new Error(`Kore closed the SIP/${this.transport} connection.`));
      this.onClose?.();
    });
  }

  onData(chunk) {
    this.buffer += chunk.toString('utf8');
    if (Buffer.byteLength(this.buffer) > MAX_SIP_RESPONSE_BYTES) {
      this.fail(new Error('Kore SIP response exceeded the size limit.'));
      this.socket.destroy();
      return;
    }
    while (true) {
      const message = parseSipMessage(this.buffer);
      if (!message) break;
      this.buffer = this.buffer.slice(message.bytes);
      if (/^SIP\/2\.0\s/i.test(message.first)) {
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(message);
        else this.messages.push(message);
      } else {
        this.handleRequest(message);
      }
    }
  }

  handleRequest(message) {
    const { first, headers } = message;
    const method = first.split(' ')[0]?.toUpperCase();
    if (method === 'BYE' || method === 'OPTIONS') {
      const responseHeaders = ['SIP/2.0 200 OK'];
      for (const name of ['via', 'from', 'to', 'call-id', 'cseq']) {
        const value = headers.get(name);
        if (value) responseHeaders.push(`${name.replace(/(^|-)([a-z])/g, (_, sep, letter) => sep + letter.toUpperCase())}: ${value}`);
      }
      responseHeaders.push('Content-Length: 0', '', '');
      this.socket.write(responseHeaders.join(CRLF));
      if (method === 'BYE') this.onRemoteBye?.();
      return;
    }
    this.socket.write('SIP/2.0 501 Not Implemented\r\nContent-Length: 0\r\n\r\n');
  }

  fail(error) {
    if (this.closedError) return;
    this.closedError = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  write(message) {
    if (this.closedError || this.socket.destroyed) throw this.closedError || new Error(`SIP/${this.transport} connection is closed.`);
    this.socket.write(message);
  }

  async nextResponse(timeoutMs = 12000) {
    if (this.messages.length) return this.messages.shift();
    if (this.closedError) throw this.closedError;
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (message) => { clearTimeout(timer); resolve(message); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        reject(new Error('Timed out waiting for a SIP response from Kore.'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

function getSdp(body, contentType = '') {
  const boundaryMatch = contentType.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1] || boundaryMatch[2];
    for (const part of body.split(`--${boundary}`)) {
      if (!/content-type:\s*application\/sdp/i.test(part)) continue;
      const start = part.indexOf('\r\n\r\n');
      if (start >= 0) return part.slice(start + 4).replace(/\r\n--?$/, '').trim();
    }
  }
  const start = body.indexOf('v=0');
  return start >= 0 ? body.slice(start).trim() : '';
}

function parseSdpAnswer(sdp, defaultHost) {
  let sessionAddress = null;
  let currentMedia = null;
  const media = [];
  for (const rawLine of sdp.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('c=IN IP4 ')) {
      const address = line.slice('c=IN IP4 '.length).split('/')[0];
      if (currentMedia) currentMedia.address = address;
      else sessionAddress = address;
    } else if (line.startsWith('m=')) {
      const fields = line.slice(2).split(/\s+/);
      currentMedia = {
        kind: fields[0],
        port: Number(fields[1]?.split('/')[0]),
        profile: fields[2],
        payloads: fields.slice(3).map(Number),
        address: sessionAddress,
        direction: 'sendrecv',
        rtcpPort: null,
        rtcpAddress: null,
        rtcpMux: false,
        rtpmap: new Map(),
      };
      media.push(currentMedia);
    } else if (currentMedia && /^a=(sendonly|recvonly|inactive|sendrecv)$/.test(line)) {
      currentMedia.direction = line.slice(2);
    } else if (currentMedia && line.startsWith('a=rtcp:')) {
      const rtcp = line.slice(7).split(/\s+/);
      currentMedia.rtcpPort = Number(rtcp[0]);
      if (rtcp[2] === 'IP4' && rtcp[3]) currentMedia.rtcpAddress = rtcp[3];
    } else if (currentMedia && line === 'a=rtcp-mux') {
      currentMedia.rtcpMux = true;
    } else if (currentMedia && line.startsWith('a=rtpmap:')) {
      const match = line.match(/^a=rtpmap:(\d+)\s+([^/]+)\/(\d+)/i);
      if (match) currentMedia.rtpmap.set(Number(match[1]), { codec: match[2].toUpperCase(), rate: Number(match[3]) });
    }
  }
  const audio = media.find((item) => item.kind === 'audio');
  if (!audio || !audio.port || audio.port === 0) throw new Error('Kore did not accept the offered audio stream in its SDP answer.');
  const payload = audio.payloads.find((item) => item === 0 && (!audio.rtpmap.has(item) || (audio.rtpmap.get(item).codec === 'PCMU' && audio.rtpmap.get(item).rate === 8000)));
  if (payload === undefined) throw new Error('Kore did not accept PCMU/8000. Confirm the codec with Kore Support.');
  if (audio.direction === 'inactive' || audio.direction === 'sendonly') throw new Error(`Kore SDP answer marked the audio stream ${audio.direction}; no incoming recording stream is ready.`);
  if (audio.rtcpMux) throw new Error('Kore selected RTCP multiplexing, which this prototype does not offer.');
  const address = audio.address || sessionAddress || defaultHost;
  if (!address || address === '0.0.0.0') throw new Error('Kore returned an unusable media address in SDP.');
  return {
    address,
    rtcpAddress: audio.rtcpAddress || address,
    port: audio.port,
    rtcpPort: audio.rtcpPort || audio.port + 1,
    payload,
  };
}

function makeRtp(payload, sequence, timestamp, ssrc) {
  const packet = Buffer.allocUnsafe(12 + payload.length);
  packet[0] = 0x80;
  packet[1] = 0; // PCMU payload type 0, marker bit clear
  packet.writeUInt16BE(sequence & 0xffff, 2);
  packet.writeUInt32BE(timestamp >>> 0, 4);
  packet.writeUInt32BE(ssrc >>> 0, 8);
  payload.copy(packet, 12);
  return packet;
}

function makeRtcpSenderReport({ ssrc, rtpTimestamp, packetCount, octetCount, cname }) {
  const now = Date.now();
  const ntpSeconds = Math.floor(now / 1000) + 2208988800;
  const ntpFraction = Math.floor((now % 1000) * 0x100000000 / 1000);
  const senderReport = Buffer.alloc(28);
  senderReport[0] = 0x80;
  senderReport[1] = 200;
  senderReport.writeUInt16BE(6, 2);
  senderReport.writeUInt32BE(ssrc >>> 0, 4);
  senderReport.writeUInt32BE(ntpSeconds >>> 0, 8);
  senderReport.writeUInt32BE(ntpFraction >>> 0, 12);
  senderReport.writeUInt32BE(rtpTimestamp >>> 0, 16);
  senderReport.writeUInt32BE(packetCount >>> 0, 20);
  senderReport.writeUInt32BE(octetCount >>> 0, 24);

  const cnameBytes = Buffer.from(cname.slice(0, 255));
  const chunkLength = 4 + 2 + cnameBytes.length + 1;
  const paddedLength = Math.ceil(chunkLength / 4) * 4;
  const sdes = Buffer.alloc(paddedLength + 4);
  sdes[0] = 0x81;
  sdes[1] = 202;
  sdes.writeUInt16BE(sdes.length / 4 - 1, 2);
  sdes.writeUInt32BE(ssrc >>> 0, 4);
  sdes[8] = 1;
  sdes[9] = cnameBytes.length;
  cnameBytes.copy(sdes, 10);
  sdes[10 + cnameBytes.length] = 0;
  return Buffer.concat([senderReport, sdes]);
}

function makeSipRequest({ transport, method, requestUri, viaHost, from, to, callId, cseq, routeHeaders = [], body = '', contentType = null, contact = null }) {
  const branch = `z9hG4bK${crypto.randomBytes(10).toString('hex')}`;
  const lines = [
    `${method} ${requestUri} SIP/2.0`,
    `Via: SIP/2.0/${transport} ${viaHost};branch=${branch};rport`,
    'Max-Forwards: 70',
    `From: ${from}`,
    `To: ${to}`,
    `Call-ID: ${callId}`,
    `CSeq: ${cseq} ${method}`,
  ];
  for (const route of routeHeaders) lines.push(`Route: ${route}`);
  if (contact) lines.push(`Contact: ${contact}`);
  if (contentType) lines.push(`Content-Type: ${contentType}`);
  lines.push(`Content-Length: ${Buffer.byteLength(body)}`, '', body);
  return lines.join(CRLF);
}

function getContactUri(value) {
  const match = value?.match(/<([^>]+)>/);
  return match?.[1] || value?.split(',')[0]?.trim() || '';
}

async function loadTlsFiles({ caFile, certFile, keyFile }) {
  if (Boolean(certFile) !== Boolean(keyFile)) throw new Error('Set both KORE_TLS_CERT_FILE and KORE_TLS_KEY_FILE to use a client certificate.');
  const [ca, cert, key] = await Promise.all([
    caFile ? fs.readFile(caFile) : undefined,
    certFile ? fs.readFile(certFile) : undefined,
    keyFile ? fs.readFile(keyFile) : undefined,
  ]);
  return { ca, cert, key };
}

export async function createSiprecSession({
  uri,
  sipTransport = 'TLS',
  siprecIdentifier,
  participantName,
  participantUri,
  publicIp,
  rtpPort,
  caFile,
  certFile,
  keyFile,
  logger = () => {},
}) {
  const transport = String(sipTransport).trim().toUpperCase();
  if (!['TLS', 'TCP'].includes(transport)) throw new Error(`SIP transport ${transport} is not supported. Choose TCP or TLS.`);
  if (!publicIp) throw new Error('Set media.publicIp in config.json to the VM static external IPv4 address before starting a stream.');
  if (!Number.isInteger(rtpPort) || rtpPort < 1024 || rtpPort > 65534 || rtpPort % 2 !== 0) {
    throw new Error('media.rtpPort in config.json must be an even UDP port from 1024 through 65534.');
  }
  const target = parseSipUri(uri);
  const tlsFiles = transport === 'TLS' ? await loadTlsFiles({ caFile, certFile, keyFile }) : {};
  const startedAt = new Date();
  const callId = `${crypto.randomUUID()}@${publicIp}`;
  const fromTag = randomTag();
  const transportParam = transport.toLowerCase();
  const fromUri = `sip:${encodeURIComponent(siprecIdentifier || 'src')}@${publicIp};transport=${transportParam}`;
  const contact = `<sip:${encodeURIComponent(siprecIdentifier || 'src')}@${publicIp};transport=${transportParam}>;+sip.src`;
  const from = `<${fromUri}>;tag=${fromTag}`;
  const to = `<${uri}>`;
  const metadata = buildMetadata({ callId, participantName, participantUri, startedAt });
  const sdp = makeSdp(publicIp, rtpPort);
  const mime = makeInviteBody(sdp, metadata);

  const socket = transport === 'TLS'
    ? tls.connect({
      host: target.host,
      port: target.port,
      servername: target.host,
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
      ...tlsFiles,
    })
    : net.connect({ host: target.host, port: target.port });
  const connectedEvent = transport === 'TLS' ? 'secureConnect' : 'connect';
  const connectTimeout = setTimeout(() => socket.destroy(new Error(`Timed out connecting to Kore over ${transport}.`)), 10000);
  try {
    await new Promise((resolve, reject) => {
      socket.once(connectedEvent, resolve);
      socket.once('error', reject);
    });
  } finally {
    clearTimeout(connectTimeout);
  }
  const sip = new SipConnection(socket, transport);
  logger(`SIP/${transport} connected to ${target.host}:${target.port}`);

  const invite = makeSipRequest({
    transport,
    method: 'INVITE',
    requestUri: uri,
    viaHost: publicIp,
    from,
    to,
    callId,
    cseq: 1,
    contact,
    contentType: mime.contentType,
    body: mime.body,
  }).replace(/\r\nContent-Length:/, `\r\nRequire: siprec\r\nAccept: application/sdp, application/rs-metadata+xml\r\nDate: ${startedAt.toUTCString()}\r\nUser-Agent: SignalDesk-SIPREC-SRC/0.1\r\nContent-Length:`);
  let finalResponse;
  try {
    sip.write(invite);
    while (true) {
      const response = await sip.nextResponse();
      const code = Number(response.first.match(/^SIP\/2\.0\s+(\d+)/i)?.[1]);
      if (!code) continue;
      if (code < 200) continue;
      finalResponse = response;
      if (code >= 300) {
        const reason = response.first.replace(/^SIP\/2\.0\s+\d+\s*/, '');
        throw new Error(`Kore rejected the SIPREC INVITE (${code} ${reason}).${code === 401 || code === 407 ? ' SIP credentials or client-certificate requirements may be missing.' : ''}`);
      }
      break;
    }
  } catch (error) {
    socket.destroy();
    throw error;
  }

  const responseTo = finalResponse.headers.get('to') || to;
  const remoteTag = responseTo.match(/;\s*tag=([^;\s,]+)/i)?.[1];
  if (!remoteTag) {
    socket.destroy();
    throw new Error('Kore accepted the INVITE without a To tag; the SIP dialog is incomplete.');
  }
  const contactValue = finalResponse.headers.get('contact');
  const remoteTarget = getContactUri(contactValue) || uri;
  const routeSet = (finalResponse.headers.get('record-route') || '').split(/,\s*/).filter(Boolean).reverse();
  const firstRoute = routeSet[0] || '';
  const strictRoute = firstRoute && !/;\s*lr(?:[;>]|$)/i.test(firstRoute);
  const dialogTarget = strictRoute ? getContactUri(firstRoute) : remoteTarget;
  const dialogRoutes = strictRoute ? [...routeSet.slice(1), `<${remoteTarget}>`] : routeSet;
  const sendBye = async () => {
    sip.write(makeSipRequest({
      transport,
      method: 'BYE', requestUri: dialogTarget, viaHost: publicIp,
      from, to: responseTo, callId, cseq: 2, routeHeaders: dialogRoutes,
    }));
    await sip.nextResponse(3000).catch(() => null);
  };
  sip.write(makeSipRequest({
    transport,
    method: 'ACK', requestUri: dialogTarget, viaHost: publicIp,
    from, to: responseTo, callId, cseq: 1, routeHeaders: dialogRoutes,
  }));

  let remoteMedia;
  try {
    const responseSdp = getSdp(finalResponse.body, finalResponse.headers.get('content-type') || '');
    remoteMedia = parseSdpAnswer(responseSdp, target.host);
  } catch (error) {
    await sendBye().catch(() => {});
    socket.destroy();
    throw error;
  }

  const rtpSocket = dgram.createSocket('udp4');
  const rtcpSocket = dgram.createSocket('udp4');
  rtpSocket.on('error', (error) => logger(`RTP socket error: ${error.message}`));
  rtcpSocket.on('error', (error) => logger(`RTCP socket error: ${error.message}`));
  await Promise.all([
    new Promise((resolve, reject) => { rtpSocket.once('error', reject); rtpSocket.bind(rtpPort, '0.0.0.0', resolve); }),
    new Promise((resolve, reject) => { rtcpSocket.once('error', reject); rtcpSocket.bind(rtpPort + 1, '0.0.0.0', resolve); }),
  ]).catch(async (error) => {
    try { rtpSocket.close(); } catch {}
    try { rtcpSocket.close(); } catch {}
    await sendBye().catch(() => {});
    socket.destroy();
    throw new Error(`Unable to bind RTP/RTCP ports ${rtpPort}/${rtpPort + 1}: ${error.message}`);
  });

  let sequence = crypto.randomInt(0, 65536);
  let timestamp = crypto.randomInt(0, 0x7fffffff);
  const ssrc = crypto.randomInt(1, 0xffffffff);
  let packetCount = 0;
  let octetCount = 0;
  let ended = false;
  const cname = `src-${crypto.randomBytes(8).toString('hex')}@${publicIp}`;
  const sendRtcp = () => {
    if (ended) return;
    const packet = makeRtcpSenderReport({ ssrc, rtpTimestamp: timestamp, packetCount, octetCount, cname });
    rtcpSocket.send(packet, remoteMedia.rtcpPort, remoteMedia.rtcpAddress, (error) => {
      if (error) logger(`RTCP send error: ${error.message}`);
    });
  };
  const rtcpTimer = setInterval(sendRtcp, 5000);
  const session = {
    id: crypto.randomUUID(),
    callId,
    remoteMedia,
    sip,
    socket,
    rtpSocket,
    rtcpSocket,
    rtcpTimer,
    ssrc,
    get ended() { return ended; },
    sendAudio(frame) {
      if (ended || !Buffer.isBuffer(frame) || frame.length !== 160) return;
      const packet = makeRtp(frame, sequence++, timestamp, ssrc);
      timestamp = (timestamp + 160) >>> 0;
      packetCount++;
      octetCount += frame.length;
      rtpSocket.send(packet, remoteMedia.port, remoteMedia.address, (error) => {
        if (error) logger(`RTP send error: ${error.message}`);
      });
    },
    async stop({ remote = false } = {}) {
      if (ended) return;
      ended = true;
      clearInterval(rtcpTimer);
      if (!remote && !socket.destroyed) {
        try {
          await sendBye();
        } catch (error) {
          logger(`SIP BYE error: ${error.message}`);
        }
      }
      rtpSocket.close();
      rtcpSocket.close();
      socket.destroy();
      session.onEnded?.();
    },
  };
  sip.onRemoteBye = () => {
    logger('Kore ended the SIPREC session.');
    session.stop({ remote: true });
  };
  sip.onClose = () => {
    if (!ended) {
      logger(`SIP/${transport} connection closed; stopping the media stream.`);
      session.stop({ remote: true });
    }
  };
  logger(`SIPREC session established over ${transport}; Kore media destination ${remoteMedia.address}:${remoteMedia.port}, PCMU/8000.`);
  return session;
}
