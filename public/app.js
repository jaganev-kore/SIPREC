const endpointsContainer = document.querySelector('#endpoints');
const gatewayMeta = document.querySelector('#gateway-meta');
const connectionStatus = document.querySelector('#connection-status');
const startSessionButton = document.querySelector('#start-session');
const stopSessionButton = document.querySelector('#stop-session');
const mediaSessionStatus = document.querySelector('#media-session-status');
let activeMediaSession = null;
let configuredEndpoints = [];
let serverConfig = null;

function currentSipTransport() {
  return String(serverConfig?.sipTransport || 'TLS').trim().toUpperCase();
}

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
  heading.append(name, badge);

  const uriLabel = document.createElement('label');
  uriLabel.className = 'endpoint-uri-label';
  uriLabel.textContent = 'SIPREC URL';
  const uri = document.createElement('input');
  uri.className = 'sip-uri-input';
  uri.type = 'text';
  uri.autocomplete = 'off';
  uri.spellcheck = false;
  const exampleSbc = endpoint.id === 'secondary' ? 'savg-sbc2' : 'savg-sbc1';
  uri.placeholder = `sip:user@${exampleSbc}.kore.ai:5060?X-agentAssist=tru1`;
  uri.value = endpoint.uri || '';
  uri.setAttribute('aria-label', `${endpoint.label} SIPREC URL`);
  uriLabel.append(uri);

  const row = document.createElement('div');
  row.className = 'probe-row';
  const result = document.createElement('p');
  result.className = 'probe-result';
  result.textContent = endpoint.uri ? `No ${currentSipTransport()} check run yet.` : 'Paste the SIPREC URL to configure this endpoint.';
  result.setAttribute('aria-live', 'polite');

  const button = document.createElement('button');
  button.className = 'probe-button';
  button.type = 'button';
  button.dataset.endpoint = endpoint.id;
  button.textContent = `Test ${currentSipTransport()} path`;
  button.disabled = !endpoint.uri;
  button.addEventListener('click', async () => {
    if (!endpoint.uri.trim()) return;
    button.disabled = true;
    button.textContent = 'Checking…';
    result.classList.remove('success', 'failure');
    const transport = currentSipTransport();
    result.textContent = `Opening ${transport} connection from this Node server…`;
    try {
      const response = await fetch('/api/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: endpoint.id, sipUri: endpoint.uri.trim() }),
      });
      const data = await response.json();
      if (!response.ok || !data.reachable) throw new Error(data.message || data.error || `${transport} check failed`);
      result.classList.add('success');
      result.textContent = data.transport === 'TLS'
        ? `TLS ${data.tlsVersion} verified (${data.certificateSubject}). No SIP or media was sent.`
        : 'TCP connection succeeded. No SIP or media was sent.';
    } catch (error) {
      result.classList.add('failure');
      result.textContent = error.message || `Unable to reach Kore over ${transport}.`;
    } finally {
      button.disabled = !endpoint.uri.trim();
      button.textContent = `Test ${currentSipTransport()} path`;
    }
  });

  uri.addEventListener('input', () => {
    endpoint.uri = uri.value.trim();
    try { localStorage.setItem(`kore-siprec-uri:${endpoint.id}`, endpoint.uri); } catch {}
    badge.textContent = endpoint.uri ? 'URL ADDED' : 'ADD SIPREC URL';
    button.disabled = !endpoint.uri;
    result.classList.remove('success', 'failure');
    result.textContent = endpoint.uri ? `No ${currentSipTransport()} check run yet.` : 'Paste the SIPREC URL to configure this endpoint.';
    updateEndpointReadiness();
  });

  row.append(result, button);
  card.append(heading, uriLabel, row);
  badge.textContent = endpoint.uri ? 'URL ADDED' : 'ADD SIPREC URL';
  return card;
}

function endpointForId(id) {
  return configuredEndpoints.find((endpoint) => endpoint.id === id);
}

function updateEndpointReadiness() {
  const endpointSelect = document.querySelector('#session-endpoint');
  for (const option of endpointSelect.options) {
    option.disabled = !endpointForId(option.value)?.uri.trim();
  }
  let selectedEndpoint = endpointForId(endpointSelect.value);
  if (!selectedEndpoint?.uri.trim()) {
    selectedEndpoint = configuredEndpoints.find((endpoint) => endpoint.uri.trim());
    if (selectedEndpoint) endpointSelect.value = selectedEndpoint.id;
  }
  const selectedUri = selectedEndpoint?.uri?.trim() || '';
  const configuredCount = configuredEndpoints.filter((endpoint) => endpoint.uri.trim()).length;
  const mediaReady = Boolean(serverConfig?.mediaServerReady);
  startSessionButton.disabled = Boolean(activeMediaSession) || !mediaReady || !selectedUri;

  if (!activeMediaSession) {
    if (!selectedUri) {
      setMediaStatus('Paste a Kore SIPREC URL above and select that SBC.', 'failure');
    } else if (!mediaReady) {
      setMediaStatus('Set media.publicIp to the VM static external IPv4 and keep media.profile=RTP/AVP in config.json.', 'failure');
    } else {
      setMediaStatus(`Ready for a single PCMU/8000 stream (${serverConfig.mediaProfile}).`);
    }
  }
  setConnection(configuredCount === 2, `${configuredCount}/2 endpoints configured`);
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

    setMediaStatus(`Opening a SIPREC session to Kore over ${currentSipTransport()}…`);
    const response = await fetch('/api/session/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: document.querySelector('#session-endpoint').value,
        sipUri: endpointForId(document.querySelector('#session-endpoint').value)?.uri || '',
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
document.querySelector('#session-endpoint').addEventListener('change', updateEndpointReadiness);

async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error('Configuration endpoint is unavailable.');
    const config = await response.json();
    serverConfig = config;
    document.querySelector('#transport-label').textContent = currentSipTransport();
    document.querySelector('#media-warning').textContent = currentSipTransport() === 'TCP'
      ? 'SIP signaling and SIPREC metadata use unencrypted TCP. This prototype also streams unencrypted RTP/PCMU media and one audio direction. Use only non-sensitive test speech until Kore confirms the required crypto, codecs, and stream metadata. SIPREC sends audio to Agent Assist; it does not return a spoken Kore response.'
      : 'Signaling uses TLS. This prototype streams unencrypted RTP/PCMU media and one audio direction. Use only non-sensitive test speech until Kore confirms the required crypto, codecs, and stream metadata. SIPREC sends audio to Agent Assist; it does not return a spoken Kore response.';
    configuredEndpoints = config.endpoints.map((endpoint) => {
      let uri = endpoint.uri || '';
      try {
        const savedUri = localStorage.getItem(`kore-siprec-uri:${endpoint.id}`);
        if (savedUri !== null) uri = savedUri;
      } catch {}
      return { ...endpoint, uri };
    });
    endpointsContainer.replaceChildren(...configuredEndpoints.map(buildEndpointCard));
    const endpointSelect = document.querySelector('#session-endpoint');
    for (const option of endpointSelect.options) {
      option.disabled = !endpointForId(option.value)?.uri.trim();
    }
    const firstConfiguredEndpoint = configuredEndpoints.find((endpoint) => endpoint.uri.trim());
    if (firstConfiguredEndpoint && !endpointForId(endpointSelect.value)?.uri.trim()) endpointSelect.value = firstConfiguredEndpoint.id;
    document.querySelector('#participant-uri').value = `sip:web-mic@${location.hostname}`;
    updateEndpointReadiness();

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

  } catch (error) {
    endpointsContainer.textContent = error.message || 'Unable to load Kore endpoint configuration.';
    setConnection(false, 'Configuration unavailable');
  }
}

loadConfig();
