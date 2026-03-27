// AudioWorklet processor for browser → Vokeva direct WebSocket audio
// Captures mic at native sample rate, resamples to 16kHz, encodes linear16 (Int16).
// High-quality pipeline: 16kHz linear16 gives Deepgram much better transcription accuracy.

class MulawCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    // Send a chunk every ~20ms at 16kHz = 320 samples
    this._chunkSize = 320;
  }

  // Resample from source rate to target rate using linear interpolation
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

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;

    const floatData = input[0]; // mono channel, Float32 [-1,1]

    // Resample to 16kHz
    const resampled = MulawCaptureProcessor.resample(floatData, sampleRate, 16000);

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

      const encoded = new Int16Array(chunk.length);
      if (rms < 0.005) {
        // Below noise floor — send silence
        encoded.fill(0);
      } else {
        for (let i = 0; i < chunk.length; i++) {
          // Float32 [-1,1] → Int16
          const s = Math.max(-1, Math.min(1, chunk[i]));
          encoded[i] = Math.max(-32768, Math.min(32767, Math.floor(s * 32767)));
        }
      }
      this.port.postMessage(encoded.buffer, [encoded.buffer]);
    }

    return true;
  }
}

registerProcessor('mulaw-capture-processor', MulawCaptureProcessor);
