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
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (output) output.fill(0);
    if (!input) return true;

    // AudioContext is requested at 48 kHz; average each six samples to 8 kHz.
    for (const sample of input) {
      this.sampleSum += sample;
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
