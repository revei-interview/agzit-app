// AudioWorklet processor for browser → Vokeva direct WebSocket audio
// Captures mic at native sample rate, resamples to 8kHz, encodes mulaw.
// Also decodes incoming mulaw 8kHz for playback.

class MulawCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    // Send a chunk every ~20ms at 8kHz = 160 samples
    this._chunkSize = 160;
  }

  // Resample from source rate to 8000Hz using linear interpolation
  static resample(input, fromRate, toRate) {
    if (fromRate === toRate) return input;
    const ratio = fromRate / toRate;
    const outLen = Math.floor(input.length / ratio);
    const output = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcIdx = i * ratio;
      const idx = Math.floor(srcIdx);
      const frac = srcIdx - idx;
      const s0 = input[idx] || 0;
      const s1 = input[idx + 1] || 0;
      output[i] = s0 + frac * (s1 - s0);
    }
    return output;
  }

  // Encode a 16-bit signed PCM sample to mulaw byte
  static encodeMulaw(sample) {
    const MULAW_MAX = 0x1FFF;
    const MULAW_BIAS = 33;
    let sign = 0;
    if (sample < 0) { sign = 0x80; sample = -sample; }
    if (sample > MULAW_MAX) sample = MULAW_MAX;
    sample += MULAW_BIAS;
    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
    const mantissa = (sample >> (exponent + 3)) & 0x0F;
    return ~(sign | (exponent << 4) | mantissa) & 0xFF;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;

    const floatData = input[0]; // mono channel, Float32 [-1,1]

    // Resample to 8kHz
    const resampled = MulawCaptureProcessor.resample(floatData, sampleRate, 8000);

    // Buffer resampled samples
    for (let i = 0; i < resampled.length; i++) {
      this._buffer.push(resampled[i]);
    }

    // When we have enough for a chunk, encode and send
    while (this._buffer.length >= this._chunkSize) {
      const chunk = this._buffer.splice(0, this._chunkSize);

      // Noise gate: compute RMS energy of the chunk
      let sumSq = 0;
      for (let i = 0; i < chunk.length; i++) sumSq += chunk[i] * chunk[i];
      const rms = Math.sqrt(sumSq / chunk.length);

      const encoded = new Uint8Array(chunk.length);
      if (rms < 0.005) {
        // Below noise floor — send mulaw silence (0xFF) to avoid triggering VAD
        encoded.fill(0xFF);
      } else {
        for (let i = 0; i < chunk.length; i++) {
          // Float32 [-1,1] → Int16 → mulaw
          const s = Math.max(-1, Math.min(1, chunk[i]));
          const pcm16 = Math.floor(s * 32767);
          encoded[i] = MulawCaptureProcessor.encodeMulaw(pcm16);
        }
      }
      this.port.postMessage(encoded.buffer, [encoded.buffer]);
    }

    return true;
  }
}

registerProcessor('mulaw-capture-processor', MulawCaptureProcessor);
