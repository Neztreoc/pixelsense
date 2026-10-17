// Runs Whisper speech-to-text in the browser, off the main thread. Nothing is uploaded:
// only the library and the model are downloaded (then cached by the browser).
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;

const MODEL = 'onnx-community/whisper-base';
const CHUNK = 30, STRIDE = 5; // seconds; each window advances CHUNK - 2*STRIDE
let asr = null;

const files = {};
function onLoad(p) {
  if (p.status === 'progress' && p.total) {
    files[p.file] = { loaded: p.loaded, total: p.total };
    let loaded = 0, total = 0;
    for (const f of Object.values(files)) { loaded += f.loaded; total += f.total; }
    postMessage({ type: 'load', loaded, total });
  }
}

async function getAsr() {
  if (asr) return asr;
  const gpu = !!(self.navigator && self.navigator.gpu);
  if (gpu) {
    try {
      asr = await pipeline('automatic-speech-recognition', MODEL, {
        device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, progress_callback: onLoad
      });
      postMessage({ type: 'device', device: 'GPU' });
      return asr;
    } catch (e) { asr = null; } // fall back to the CPU version below
  }
  asr = await pipeline('automatic-speech-recognition', MODEL, { dtype: 'q8', progress_callback: onLoad });
  postMessage({ type: 'device', device: 'CPU' });
  return asr;
}

self.onmessage = async ({ data }) => {
  if (data.type !== 'transcribe') return;
  try {
    const model = await getAsr();
    postMessage({ type: 'ready' });
    const expected = Math.max(1, Math.ceil(data.audio.length / 16000 / (CHUNK - 2 * STRIDE)));
    let done = 0;
    const out = await model(data.audio, {
      language: 'english', task: 'transcribe',
      chunk_length_s: CHUNK, stride_length_s: STRIDE, return_timestamps: true,
      chunk_callback: () => postMessage({ type: 'progress', value: Math.min(++done / expected, 0.99) })
    });
    postMessage({ type: 'done', chunks: out.chunks || [{ timestamp: [0, null], text: out.text }] });
  } catch (e) {
    postMessage({ type: 'error', message: String((e && e.message) || e) });
  }
};
