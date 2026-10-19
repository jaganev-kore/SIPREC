const endpointsContainer = document.querySelector('#endpoints');
const gatewayMeta = document.querySelector('#gateway-meta');
const connectionStatus = document.querySelector('#connection-status');
const startSessionButton = document.querySelector('#start-session');
const stopSessionButton = document.querySelector('#stop-session');
const mediaSessionStatus = document.querySelector('#media-session-status');
let activeMediaSession = null;

function setConnection(ready, message) {
  connectionStatus.classList.toggle('connected', ready);
  connectionStatus.classList.toggle('disconnected', !ready);
  connectionStatus.replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  connectionStatus.append(dot, document.createTextNode(message));
}

function buildEndpointCard(endpoint) {
  const card = document.createElement('article');
  card.className = 'endpoint-card';

  const heading = document.createElement('div');
  heading.className = 'endpoint-heading';
  const name = document.createElement('strong');
  name.textContent = endpoint.label;
  const badge = document.createElement('span');
  badge.className = 'endpoint-badge';
  badge.textContent = endpoint.configured ? 'CONFIGURED' : 'NOT SET';
  heading.append(name, badge);

  const uri = document.createElement('code');
  uri.className = 'sip-uri';
  uri.textContent = endpoint.uri || 'Set KORE_SIPREC_PRIMARY_URI / SECONDARY_URI';

  const row = document.createElement('div');
  row.className = 'probe-row';
  const result = document.createElement('p');
  result.className = 'probe-result';
  result.textContent = endpoint.configured ? 'No TLS check run yet.' : 'Configure the URI in the server environment.';
  result.setAttribute('aria-live', 'polite');

  const button = document.createElement('button');
  button.className = 'probe-button';
  button.type = 'button';
  button.dataset.endpoint = endpoint.id;
  button.textContent = 'Test TLS path';
  button.disabled = !endpoint.configured;
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Checking…';
    result.classList.remove('success', 'failure');
    result.textContent = 'Opening TLS connection from this Node server…';
    try {
      const response = await fetch('/api/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: endpoint.id }),
      });
      const data = await response.json();
      if (!response.ok || !data.reachable) throw new Error(data.message || data.error || 'TLS check failed');
      result.classList.add('success');
      result.textContent = `TLS ${data.tlsVersion} verified (${data.certificateSubject}). No SIP or media was sent.`;
    } catch (error) {
      result.classList.add('failure');
      result.textContent = error.message || 'Unable to reach Kore over TLS.';
    } finally {
      button.disabled = false;
      button.textContent = 'Test TLS path';
    }
  });

  row.append(result, button);
  card.append(heading, uri, row);
  return card;
}

function setMediaStatus(message, state = '') {
  mediaSessionStatus.textContent = message;
  mediaSessionStatus.classList.toggle('success', state === 'success');
  mediaSessionStatus.classList.toggle('failure', state === 'failure');
}

async function stopMediaSession() {
  const current = activeMediaSession;
  if (!current) return;
  activeMediaSession = null;
  stopSessionButton.disabled = true;
  current.processor?.disconnect();
  current.source?.disconnect();
  current.stream?.getTracks().forEach((track) => track.stop());
  if (current.ws && current.ws.readyState < WebSocket.CLOSING) current.ws.close();
  if (current.audioContext && current.audioContext.state !== 'closed') await current.audioContext.close();
  try {
    await fetch('/api/session/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ streamToken: current.streamToken }),
    });
  } catch {}
  startSessionButton.disabled = false;
  setMediaStatus('SIPREC session stopped.');
}

function connectMediaSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('Timed out connecting the microphone to the media server.'));
    }, 10000);
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Could not connect the browser audio stream to the media server.')); }, { once: true });
  });
}

async function startMediaSession() {
  startSessionButton.disabled = true;
  setMediaStatus('Requesting microphone access…');
  let current;
  let pendingStream;
  let pendingAudioContext;
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone access requires HTTPS (or localhost). Open the app through its HTTPS URL on the GCP VM.');
    }
    pendingStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    pendingAudioContext = new AudioContext({ sampleRate: 48000 });
    if (pendingAudioContext.sampleRate !== 48000) throw new Error(`This browser created ${pendingAudioContext.sampleRate} Hz audio; the test source needs 48 kHz input.`);
    await pendingAudioContext.audioWorklet.addModule('/audio-worklet.js');

    setMediaStatus('Opening a SIPREC session to Kore over TLS…');
    const response = await fetch('/api/session/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: document.querySelector('#session-endpoint').value,
        participantName: document.querySelector('#participant-name').value,
        participantUri: document.querySelector('#participant-uri').value,
      }),
    });
    const session = await response.json();
    if (!response.ok) throw new Error(session.error || 'Kore rejected the SIPREC session.');
    current = { ...session, stream: pendingStream, audioContext: pendingAudioContext, ws: null, source: null, processor: null };
    pendingStream = null;
    pendingAudioContext = null;
    activeMediaSession = current;

    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    current.ws = await connectMediaSocket(`${wsProtocol}//${location.host}/api/session/media?token=${encodeURIComponent(session.streamToken)}`);
    current.source = current.audioContext.createMediaStreamSource(current.stream);
    current.processor = new AudioWorkletNode(current.audioContext, 'pcmu-uplink', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    current.processor.port.onmessage = (event) => {
      if (activeMediaSession === current && current.ws.readyState === WebSocket.OPEN) current.ws.send(event.data);
    };
    current.source.connect(current.processor);
    current.processor.connect(current.audioContext.destination);
    stopSessionButton.disabled = false;
    setMediaStatus(`SIPREC established to ${session.endpoint}; sending PCMU/8000 microphone audio.`, 'success');

    current.ws.addEventListener('close', () => {
      if (activeMediaSession !== current) return;
      current.processor?.disconnect();
      current.source?.disconnect();
      current.stream?.getTracks().forEach((track) => track.stop());
      if (current.audioContext.state !== 'closed') current.audioContext.close();
      activeMediaSession = null;
      startSessionButton.disabled = false;
      stopSessionButton.disabled = true;
      setMediaStatus('Media connection closed. The Kore SIPREC session may have ended; start a new test to reconnect.', 'failure');
    });
  } catch (error) {
    if (current) {
      activeMediaSession = current;
      await stopMediaSession();
      setMediaStatus(error.message || 'Unable to start the SIPREC test session.', 'failure');
    } else {
      pendingStream?.getTracks().forEach((track) => track.stop());
      if (pendingAudioContext && pendingAudioContext.state !== 'closed') await pendingAudioContext.close();
      startSessionButton.disabled = false;
      setMediaStatus(error.message || 'Unable to start the SIPREC test session.', 'failure');
    }
  }
}

startSessionButton.addEventListener('click', startMediaSession);
stopSessionButton.addEventListener('click', stopMediaSession);

async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error('Configuration endpoint is unavailable.');
    const config = await response.json();
    endpointsContainer.replaceChildren(...config.endpoints.map(buildEndpointCard));
    const endpointSelect = document.querySelector('#session-endpoint');
    for (const option of endpointSelect.options) {
      option.disabled = !config.endpoints.find((endpoint) => endpoint.id === option.value)?.configured;
    }
    const firstConfiguredEndpoint = config.endpoints.find((endpoint) => endpoint.configured);
    if (firstConfiguredEndpoint) endpointSelect.value = firstConfiguredEndpoint.id;
    document.querySelector('#participant-uri').value = `sip:web-mic@${location.hostname}`;
    const mediaReady = config.mediaServerReady && Boolean(firstConfiguredEndpoint);
    startSessionButton.disabled = !mediaReady;
    setMediaStatus(mediaReady
      ? `Ready for a single PCMU/8000 stream (${config.mediaProfile}).`
      : 'Configure a Kore SIPREC URI, set MEDIA_PUBLIC_IP to the VM static external IPv4, and keep KORE_MEDIA_PROFILE=RTP/AVP.',
      mediaReady ? '' : 'failure');

    const items = [
      ['Config source', config.configSource || 'Server environment'],
      ['SIPREC identifier', config.siprecIdentifier || 'Not configured'],
      ['Transport', config.sipTransport || 'Not configured'],
      ['Advertised media IP', config.mediaPublicIp || 'Not configured'],
      ['Local RTP / RTCP', `${config.rtpPort} / ${Number(config.rtpPort) + 1}`],
      ['Media profile', config.mediaProfile || 'Not configured'],
      ['DTMF', config.dtmf || 'Not configured'],
      ['SIP credentials', config.sipCredentialsConfigured ? 'Configured' : 'Not set'],
    ];
    gatewayMeta.replaceChildren(...items.map(([label, value]) => {
      const item = document.createElement('div');
      const caption = document.createElement('span');
      caption.textContent = label;
      const content = document.createElement('strong');
      content.textContent = value;
      item.append(caption, content);
      return item;
    }));

    document.querySelector('#voice-bot-status').textContent = config.voiceBotConfigured
      ? 'A separate voice-bot URI is configured, but this test source still sends one-way SIPREC audio only.'
      : 'No separate Kore voice-bot SIP URI is configured. This SIPREC test source does not return spoken AI audio.';

    const configuredCount = config.endpoints.filter((endpoint) => endpoint.configured).length;
    setConnection(configuredCount === 2, `${configuredCount}/2 endpoints configured`);
  } catch (error) {
    endpointsContainer.textContent = error.message || 'Unable to load Kore endpoint configuration.';
    setConnection(false, 'Configuration unavailable');
  }
}

loadConfig();
