# Kore Agent Assist SIPREC microphone test source

This Node.js prototype adds a **Start SIPREC & microphone** button. The browser captures one microphone channel, converts it to PCMU/8000, and sends 20 ms audio frames to the Node service over the page's WebSocket. The service initiates a SIPREC INVITE to the configured Kore SRS over TLS and sends the microphone audio as RTP. Stop sends SIP BYE.

The SIPREC INVITE includes the standard `Require: siprec`, `;+sip.src` Contact feature, SDP label, and RFC 7865 recording metadata. The session describes one synthetic web participant and one audio stream. This is suitable only as an initial connectivity experiment, not a complete contact-center call path.

## Important limits

- Kore is the SIPREC recording server (SRS); this Node service acts as the recording source (SRC) and initiates the SIPREC INVITE. This follows [RFC 7866](https://www.rfc-editor.org/rfc/rfc7866).
- The prototype offers a single `RTP/AVP` PCMU/8000 audio stream. It does not implement SRTP, RTCP feedback processing, SIP digest authentication, or media transcoding. TLS protects SIP signaling and metadata; the prototype's RTP media is **not encrypted**. Use non-sensitive test speech only, and do not use real customer calls.
- This client offers one send-only audio stream. Many Agent Assist deployments need both customer and agent audio legs, so Kore must confirm whether this single-stream test is accepted. Kore may accept the SIP session but not create the expected transcript without its required stream count or Kore-specific metadata.
- The metadata contains the participant name and SIP/tel URI entered in the UI. It does not invent an agent ID, customer ID, or Kore-specific metadata fields.
- SIPREC does not return Kore's spoken response. A two-way voice bot requires a separate Kore Voice AI SIP URI and a different call flow.
- The page does not display transcripts. Check the session in Kore.ai.

## Configure

Requires Node.js 20 or newer and no npm packages. The application reads `config.json` in the project root; it no longer reads `.env`. If `config.json` does not exist, copy `config.example.json` to create it, then set `media.publicIp` to the reserved external IPv4 address assigned to the GCE VM. Keep the Kore SIP URIs and SIPREC identifier as provided in the Kore Voice Gateway setup. Protect `config.json` because it can contain SIP credentials and certificate paths.

You can also paste the primary and secondary Kore SIPREC URIs directly into the UI. Those values are saved in that browser's local storage and used immediately; they do not overwrite `config.json` and do not require a Node restart. The server accepts SIPREC URLs only for `kore.ai` hosts on ports 5060 or 5061. Browser-saved URIs take precedence over the corresponding `config.json` URI in that browser.

```sh
cp config.example.json config.json # only when creating config.json for the first time
chmod 600 config.json
npm start
```

`media.profile` must remain `RTP/AVP` for this prototype. If Kore has Pad Crypto/SRTP enabled, do not start a test stream; this code does not implement SRTP. `kore.tlsCaFile`, `kore.tlsCertFile`, and `kore.tlsKeyFile` support optional CA/client-certificate files. Set certificate and key together, using absolute paths. The server already supports certificate-verified TLS 1.2+ to Kore.

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

- Outbound TCP/TLS from the VM to the Kore SIP SBC on port 5060.
- Outbound UDP from the VM to the RTP destination port returned in Kore's SDP answer.
- Inbound UDP for RTCP on `media.rtpPort + 1` from Kore's media IP ranges; the default local ports are 40000/40001. Confirm exact IP ranges and firewall direction with Kore.
- Inbound HTTPS to the UI only from trusted users. Keep Node bound to `127.0.0.1` behind Nginx or another HTTPS proxy, and restrict the GCP firewall. This prototype has no user login.

Google's [static external IP guide](https://docs.cloud.google.com/compute/docs/ip-addresses/configure-static-external-ip-address) covers reserving and assigning the address. Do not assume the free trial covers a VM, disk, static IP, or network usage indefinitely.

## Before sending audio to Kore

The Voice Gateway form details alone do not confirm media interoperability. Ask Kore Support to confirm:

1. Whether this Agent AI SIPREC trunk accepts an SRC-initiated SIPREC INVITE from this test client.
2. Whether a single audio m-line is supported, or both customer and agent directions are required.
3. The accepted codecs, RTP versus SRTP/Pad Crypto profile, RTP/RTCP port ranges, and source/destination IP ranges.
4. Whether a TLS client certificate or SIP credentials are required. The client certificate files can be configured above; digest authentication is not implemented.
5. The metadata fields required to associate the stream with an Agent AI session, agent, and customer. The prototype currently sends RFC 7865 metadata with one synthetic participant.
6. Whether disabling “AgentAI Initiated transcription” causes transcription to begin automatically on the RTP stream sent by this source.

The UI shows a recording notice because the Kore trunk may retain recordings when “Record the calls” is enabled. Use test audio only until recording, encryption, metadata, and consent behavior are confirmed.
