const status = document.querySelector('#voice-call-status');
const startButton = document.querySelector('#voice-call-start');
const stopButton = document.querySelector('#voice-call-stop');
const transcriptStatus = document.querySelector('#transcript-status');
const transcriptList = document.querySelector('#transcript-list');
let activeCall = null;
let appConfig = null;

function setStatus(message, state = '') {
  status.textContent = message;
  status.classList.toggle('success', state === 'success');
  status.classList.toggle('failure', state === 'failure');
}

function saveSetting(id, key) {
  const control = document.querySelector(`#${id}`);
  const value = control.type === 'checkbox' ? control.checked : control.value.trim();
  try { localStorage.setItem(`voice-setting:${key}`, String(value)); } catch {}
}

function loadSetting(id, key, fallback = '') {
  let value = fallback;
  try {
    const saved = localStorage.getItem(`voice-setting:${key}`);
    if (saved !== null) value = saved;
  } catch {}
  const control = document.querySelector(`#${id}`);
  if (control.type === 'checkbox') control.checked = value === true || value === 'true';
  else control.value = value || '';
}

function addTranscript(item) {
  if (transcriptList.querySelector('.transcript-empty')) transcriptList.replaceChildren();
  const row = document.createElement('li');
  row.className = `transcript-item ${item.speaker === 'kore' ? 'kore' : 'caller'}`;
  const speaker = document.createElement('span');
  speaker.className = 'transcript-speaker';
  speaker.textContent = item.speaker === 'kore' ? 'Kore' : 'You';
  const text = document.createElement('span');
  text.textContent = item.text;
  const time = document.createElement('span');
  time.className = 'transcript-time';
  time.textContent = new Date(item.timestamp || Date.now()).toLocaleTimeString();
  row.append(speaker, text, time);
  transcriptList.append(row);
  transcriptList.scrollTop = transcriptList.scrollHeight;
}

function cleanupCall(current) {
  current.processor?.disconnect();
  current.downlink?.disconnect();
  current.source?.disconnect();
  current.stream?.getTracks().forEach((track) => track.stop());
  if (current.audioContext && current.audioContext.state !== 'closed') current.audioContext.close();
}

async function endCall() {
  const current = activeCall;
  if (!current) return;
  current.stopping = true;
  stopButton.disabled = true;
  current.stream?.getTracks().forEach((track) => track.stop());
  setStatus('Stopping the call and finishing transcript recognition…');
  try {
    await fetch('/api/voice/session/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ streamToken: current.streamToken }),
    });
  } catch {}
  if (current.ws && current.ws.readyState < WebSocket.CLOSING) current.ws.close();
  cleanupCall(current);
  activeCall = null;
  startButton.disabled = false;
  stopButton.disabled = true;
  setStatus('Voice Gateway call ended.');
  transcriptStatus.textContent = 'Call ended. Transcript remains available above.';
}

function handleSocketMessage(current, event) {
  if (event.data instanceof ArrayBuffer) {
    if (activeCall === current) current.downlink.port.postMessage(event.data, [event.data]);
    return;
  }
  if (typeof event.data !== 'string') return;
  let message;
  try { message = JSON.parse(event.data); } catch { return; }
  if (message.type === 'transcript') addTranscript(message);
  if (message.type === 'transcription-error') {
    transcriptStatus.textContent = `Speech-to-Text error: ${message.message}`;
    transcriptStatus.classList.add('failure');
  }
}

async function startCall() {
  startButton.disabled = true;
  setStatus('Requesting microphone access…');
  transcriptStatus.classList.remove('failure');
  transcriptStatus.textContent = document.querySelector('#speech-enabled').checked
    ? 'Connecting. Transcript recognition runs in short audio batches.'
    : 'Speech-to-Text is disabled in the Google Cloud settings.';
  let stream;
  let audioContext;
  let current;
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access requires HTTPS (or localhost).');
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    audioContext = new AudioContext({ sampleRate: 48000 });
    await audioContext.resume();
    if (audioContext.sampleRate !== 48000) throw new Error('The browser did not provide a 48 kHz audio context.');
    await audioContext.audioWorklet.addModule('/audio-worklet.js');
    const response = await fetch('/api/voice/session/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sipUri: document.querySelector('#voice-gateway-uri').value.trim(),
        googleCloudProjectId: document.querySelector('#google-project-id').value.trim(),
        googleSttApiUrl: document.querySelector('#google-stt-url').value.trim(),
        googleTtsApiUrl: document.querySelector('#google-tts-url').value.trim(),
        speechLanguageCode: document.querySelector('#speech-language').value.trim(),
        speechModel: document.querySelector('#speech-model').value,
        speechToTextEnabled: document.querySelector('#speech-enabled').checked,
        voiceTtsLanguageCode: document.querySelector('#tts-language').value.trim(),
        voiceTtsName: document.querySelector('#tts-voice').value.trim(),
      }),
    });
    const session = await response.json();
    if (!response.ok) throw new Error(session.error || 'The Voice Gateway call could not be started.');
    current = { ...session, stream, audioContext, stopping: false };
    stream = null;
    audioContext = null;
    activeCall = current;
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    current.ws = await connectMediaSocket(`${wsProtocol}//${location.host}/api/voice/media?token=${encodeURIComponent(session.streamToken)}`);
    current.ws.binaryType = 'arraybuffer';
    current.source = current.audioContext.createMediaStreamSource(current.stream);
    current.processor = new AudioWorkletNode(current.audioContext, 'pcmu-uplink', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    current.downlink = new AudioWorkletNode(current.audioContext, 'pcmu-downlink', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    current.processor.port.onmessage = (event) => {
      if (activeCall === current && current.ws.readyState === WebSocket.OPEN) current.ws.send(event.data);
    };
    current.ws.addEventListener('message', (event) => handleSocketMessage(current, event));
    current.source.connect(current.processor);
    current.processor.connect(current.audioContext.destination);
    current.downlink.connect(current.audioContext.destination);
    current.ws.addEventListener('close', () => {
      if (current.stopping || activeCall !== current) return;
      activeCall = null;
      cleanupCall(current);
      startButton.disabled = false;
      stopButton.disabled = true;
      setStatus('Voice Gateway call closed.', 'failure');
      transcriptStatus.textContent = 'Call closed. Transcript remains available above.';
    });
    stopButton.disabled = false;
    setStatus(`Connected to Kore Voice Gateway (${session.remoteMedia.address}:${session.remoteMedia.port}). Speak into your microphone.`, 'success');
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    if (audioContext && audioContext.state !== 'closed') await audioContext.close();
    if (current) {
      activeCall = current;
      await endCall();
    } else startButton.disabled = false;
    setStatus(error.message || 'Unable to call the Voice Gateway.', 'failure');
  }
}

function connectMediaSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.close(); reject(new Error('Timed out connecting the browser audio stream to the media server.')); }, 10000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Could not connect the browser audio stream to the media server.')); }, { once: true });
  });
}

document.querySelector('#voice-call-start').addEventListener('click', startCall);
document.querySelector('#voice-call-stop').addEventListener('click', endCall);
document.querySelector('#clear-transcript').addEventListener('click', () => {
  transcriptList.replaceChildren(Object.assign(document.createElement('li'), { className: 'transcript-empty', textContent: 'No transcript yet.' }));
});
for (const [id, key] of [
  ['voice-gateway-uri', 'sipUri'],
  ['google-project-id', 'projectId'],
  ['google-stt-url', 'sttApiUrl'],
  ['google-tts-url', 'ttsApiUrl'],
  ['speech-enabled', 'speechEnabled'],
  ['speech-language', 'speechLanguage'],
  ['speech-model', 'speechModel'],
  ['tts-language', 'ttsLanguage'],
  ['tts-voice', 'ttsVoice'],
]) {
  const control = document.querySelector(`#${id}`);
  control.addEventListener('change', () => saveSetting(id, key));
  control.addEventListener('input', () => saveSetting(id, key));
}

async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error('Could not load server configuration.');
    appConfig = await response.json();
    loadSetting('voice-gateway-uri', 'sipUri', appConfig.voiceGatewayUri);
    loadSetting('google-project-id', 'projectId', appConfig.googleCloudProjectId);
    loadSetting('google-stt-url', 'sttApiUrl', appConfig.googleSttApiUrl || 'https://speech.googleapis.com/v1/speech:recognize');
    loadSetting('google-tts-url', 'ttsApiUrl', appConfig.googleTtsApiUrl || 'https://texttospeech.googleapis.com/v1/text:synthesize');
    loadSetting('speech-enabled', 'speechEnabled', appConfig.speechToTextEnabled);
    loadSetting('speech-language', 'speechLanguage', appConfig.speechLanguageCode || 'en-US');
    loadSetting('speech-model', 'speechModel', appConfig.speechModel || 'phone_call');
    loadSetting('tts-language', 'ttsLanguage', appConfig.voiceTtsLanguageCode || 'en-US');
    loadSetting('tts-voice', 'ttsVoice', appConfig.voiceTtsName || '');
    setStatus(appConfig.voiceGatewayUri ? `Ready for a ${appConfig.voiceGatewayTransport} Voice Gateway call.` : 'Enter the SIP URI Kore assigned to the Voice Gateway.');
  } catch (error) {
    setStatus(error.message || 'Could not load server configuration.', 'failure');
  }
}

loadConfig();
