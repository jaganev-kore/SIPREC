function pcmuEncode(sample) {
  let value = Math.max(-1, Math.min(1, sample));
  let pcm = value < 0 ? Math.round(value * 32768) : Math.round(value * 32767);
  const sign = (pcm >> 8) & 0x80;
  if (sign) pcm = -pcm;
  pcm = Math.min(32635, pcm) + 0x84;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (pcm & mask) === 0; mask >>= 1) exponent--;
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

class PcmuUplinkProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sampleSum = 0;
    this.samplesInGroup = 0;
    this.frame = new Uint8Array(160);
    this.frameOffset = 0;
  }

  process(inputs, outputs) {
    const inputCount = Math.max(0, ...inputs.map((input) => input[0]?.length || 0));
    const output = outputs[0]?.[0];
    if (output) output.fill(0);
    if (!inputCount) return true;

    // AudioContext is requested at 48 kHz; average each six samples to 8 kHz.
    for (let index = 0; index < inputCount; index++) {
      let mixedSample = 0;
      for (const input of inputs) {
        if (input[0]?.length > index) mixedSample += input[0][index];
      }
      this.sampleSum += Math.max(-1, Math.min(1, mixedSample));
      this.samplesInGroup++;
      if (this.samplesInGroup === 6) {
        this.frame[this.frameOffset++] = pcmuEncode(this.sampleSum / 6);
        this.sampleSum = 0;
        this.samplesInGroup = 0;
      }
      if (this.frameOffset === 160) {
        const frame = this.frame;
        this.frame = new Uint8Array(160);
        this.frameOffset = 0;
        this.port.postMessage(frame.buffer, [frame.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('pcmu-uplink', PcmuUplinkProcessor);

function pcmuDecode(byte) {
  const value = (~byte) & 0xff;
  let sample = ((value & 0x0f) << 3) + 0x84;
  sample <<= (value & 0x70) >> 4;
  sample -= 0x84;
  return (value & 0x80) ? -sample / 32768 : sample / 32768;
}

class PcmuDownlinkProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(96000);
    this.readIndex = 0;
    this.writeIndex = 0;
    this.port.onmessage = (event) => {
      const bytes = new Uint8Array(event.data);
      for (const byte of bytes) {
        const sample = pcmuDecode(byte);
        for (let repeat = 0; repeat < 6; repeat++) {
          this.samples[this.writeIndex] = sample;
          this.writeIndex = (this.writeIndex + 1) % this.samples.length;
          if (this.writeIndex === this.readIndex) this.readIndex = (this.readIndex + 1) % this.samples.length;
        }
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;
    for (let i = 0; i < output.length; i++) {
      if (this.readIndex === this.writeIndex) {
        output[i] = 0;
      } else {
        output[i] = this.samples[this.readIndex];
        this.readIndex = (this.readIndex + 1) % this.samples.length;
      }
    }
    return true;
  }
}

registerProcessor('pcmu-downlink', PcmuDownlinkProcessor);
