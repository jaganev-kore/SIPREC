# IVR testing — Kore Agent Assist SIPREC microphone test source

This Node.js prototype adds a **Start SIPREC & microphone** button. The browser captures one microphone channel, converts it to PCMU/8000, and sends 20 ms audio frames to the Node service over the page's WebSocket. The service initiates a SIPREC INVITE to the configured Kore SRS over UDP, TCP, or TLS signaling and sends the microphone audio as RTP. Stop sends SIP BYE.

The SIPREC INVITE includes the standard `Require: siprec`, `;+sip.src` Contact feature, SDP label, and RFC 7865 recording metadata. The session describes one synthetic web participant and one audio stream. This is suitable only as an initial connectivity experiment, not a complete contact-center call path.

## Important limits

- Kore is the SIPREC recording server (SRS); this Node service acts as the recording source (SRC) and initiates the SIPREC INVITE. This follows [RFC 7866](https://www.rfc-editor.org/rfc/rfc7866).
- The prototype offers a single `RTP/AVP` PCMU/8000 audio stream. It does not implement SRTP, RTCP feedback processing, SIP digest authentication, or media transcoding. TLS encrypts SIP signaling and metadata; UDP and plain TCP do not. The prototype's RTP media is **not encrypted** in any mode. Use non-sensitive test speech only, and do not use real customer calls.
- This client offers one send-only audio stream. Many Agent Assist deployments need both customer and agent audio legs, so Kore must confirm whether this single-stream test is accepted. Kore may accept the SIP session but not create the expected transcript without its required stream count or Kore-specific metadata.
- The metadata contains the participant name and SIP/tel URI entered in the UI. It does not invent an agent ID, customer ID, or Kore-specific metadata fields.
- The SIPREC test remains one-way. A separate Voice Gateway caller below supports a two-way voice call.
- SIPREC remains a one-way recording flow; the separate Voice Gateway page shows Google Speech-to-Text results for the caller and Kore audio.

## Configure

Requires Node.js 20 or newer and no npm packages. The application reads `config.json` in the project root; it no longer reads `.env`. If `config.json` does not exist, copy `config.example.json` to create it, then set `media.publicIp` to the reserved external IPv4 address assigned to the GCE VM. Keep the Kore SIP URIs and SIPREC identifier as provided in the Kore Voice Gateway setup. Protect `config.json` because it can contain SIP credentials and certificate paths.

You can also paste the primary and secondary Kore SIPREC URIs directly into the UI. Those values are saved in that browser's local storage and used immediately; they do not overwrite `config.json` and do not require a Node restart. The server accepts SIPREC URLs only for `kore.ai` hosts on ports 5060 or 5061. Browser-saved URIs take precedence over the corresponding `config.json` URI in that browser.

```sh
cp config.example.json config.json # only when creating config.json for the first time
chmod 600 config.json
npm start
```

The SIPREC and Voice Gateway pages let you select `UDP`, `TCP`, or `TLS` for each test session. The SIPREC page also uses the selection for its path check. Selections are saved in the browser; `kore.sipTransport` and `kore.voiceGatewayTransport` supply each page's default when no browser choice is saved. The TCP check tests connection reachability and the TLS check completes a verified handshake; neither sends SIP. UDP has no connection handshake, so its check only confirms DNS resolution and local UDP socket setup; it does not verify remote reachability. `kore.tlsCaFile`, `kore.tlsCertFile`, and `kore.tlsKeyFile` apply only to TLS. Set certificate and key together, using absolute paths. TLS uses certificate verification and TLS 1.2 or newer.

`media.profile` must remain `RTP/AVP` for this prototype. If Kore has Pad Crypto/SRTP enabled, do not start a test stream; this code does not implement SRTP.

## Kore Voice Gateway call

Open **Two-way voice** from the SIPREC page. It starts a separate SIP call using `kore.voiceBotSipUri` (or the URI entered on that page), offers send/receive PCMU/8000 RTP, forwards microphone audio to Kore, and plays Kore audio in the browser. The typed-text sending control has been removed. Kore automation controls the conversation and agent transfer. SIPREC remains separate and retains its existing behavior.

Set `kore.voiceGatewayTransport` to the transport Kore assigned (`UDP`, `TCP`, or `TLS`) and set `media.voiceGatewayRtpPort` to an even local UDP port. The Voice Gateway SIP URI must be a `sip:` or `sips:` URI on a Kore host and port 5060/5061. The caller currently offers PCMU/8000 RTP and does not support SRTP or SIP digest authentication.

The Two-way voice page exposes Google Cloud project, API URL, language, and model/voice settings. Browser changes are saved in that browser and apply to subsequent calls. Server defaults belong in the separate top-level `googleCloud` object in `config.json`:

```json
"googleCloud": {
  "projectId": "YOUR_GCP_PROJECT_ID",
  "textToSpeech": {
    "apiUrl": "https://texttospeech.googleapis.com/v1/text:synthesize",
    "languageCode": "en-US",
    "voiceName": ""
  },
  "speechToText": {
    "enabled": true,
    "apiUrl": "https://speech.googleapis.com/v1/speech:recognize",
    "languageCode": "en-US",
    "model": "phone_call"
  }
}
```

Each service has its own object and URL. The URL must be HTTPS on a Google `googleapis.com` service host and use the matching v1 endpoint path. Authentication uses the GCE VM's attached service account through the metadata server; the page never accepts a private key. Enable Cloud Speech-to-Text and Cloud Text-to-Speech APIs, grant the service account permission to use them (and Service Usage Consumer if a quota project ID is sent), and allow HTTPS egress to Google APIs. Local development without a GCE metadata identity cannot use these Google API calls.

Speech-to-Text recognizes the caller and Kore audio as separate speakers and displays finalized text in short batches (about every eight seconds). This adds Google API cost and transcription delay. Kore supplies spoken responses for the live call; Google TTS settings are retained for TTS configuration but synthesized text is no longer injected into the call.

Open the UI over HTTPS on the GCE VM. Browsers require a secure context to grant microphone access (localhost is allowed for local development). For Nginx, proxy WebSocket upgrades as well as regular HTTP requests:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

Restart Node after changing `config.json`.

## Google Cloud VM network

Use a Compute Engine VM and reserve a static external IPv4 address. Provide that actual egress/source address to Kore for allowlisting. Configure:

- Outbound UDP from the VM to the Kore SIP SBC on the configured SIP port (usually 5060) when using UDP signaling; allow return SIP responses through the stateful firewall.
- Outbound TCP from the VM to the Kore SIP SBC on port 5060 (plain SIP/TCP or TLS over TCP, according to the trunk configuration).
- Outbound SIP signaling to the Voice Gateway using `kore.voiceGatewayTransport` and the configured gateway port.
- Inbound UDP media on `media.voiceGatewayRtpPort` from Kore's media IP ranges, and outbound UDP to the RTP destination from the Voice Gateway's SDP answer.
- Outbound HTTPS to Google Cloud Speech-to-Text for live transcript batches and to Text-to-Speech when its backend endpoint is used.
- Outbound UDP from the VM to the RTP destination port returned in Kore's SDP answer.
- Inbound UDP for RTCP on `media.rtpPort + 1` from Kore's media IP ranges; the default local ports are 40000/40001. Confirm exact IP ranges and firewall direction with Kore.
- Inbound HTTPS to the UI only from trusted users. Keep Node bound to `127.0.0.1` behind Nginx or another HTTPS proxy, and restrict the GCP firewall. This prototype has no user login.

Google's [static external IP guide](https://docs.cloud.google.com/compute/docs/ip-addresses/configure-static-external-ip-address) covers reserving and assigning the address. Do not assume the free trial covers a VM, disk, static IP, or network usage indefinitely.

## Before sending audio to Kore

The Voice Gateway form details alone do not confirm media interoperability. Ask Kore Support to confirm:

1. Whether this Agent AI SIPREC trunk accepts an SRC-initiated SIPREC INVITE from this test client.
2. Whether a single audio m-line is supported, or both customer and agent directions are required.
3. The accepted codecs, RTP versus SRTP/Pad Crypto profile, RTP/RTCP port ranges, and source/destination IP ranges.
4. Which SIP transport and port the trunk accepts, and whether a TLS client certificate or SIP credentials are required. Client certificate files can be configured above for TLS; digest authentication is not implemented.
5. The metadata fields required to associate the stream with an Agent AI session, agent, and customer. The prototype currently sends RFC 7865 metadata with one synthetic participant.
6. Whether disabling “AgentAI Initiated transcription” causes transcription to begin automatically on the RTP stream sent by this source.

The UI shows a recording notice because the Kore trunk may retain recordings when “Record the calls” is enabled. Use test audio only until recording, encryption, metadata, and consent behavior are confirmed.
