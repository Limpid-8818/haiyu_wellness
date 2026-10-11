import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const media = path.join(projectRoot, 'server/media/mood');
const speech = [
  ['breathing', 'Tingting'],
  ['body-scan', 'Tingting'],
  ['seaside-meditation', 'Tingting']
];
const manifest = [];

function readDuration(file) {
  const info = execFileSync('afinfo', [file], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const duration = Number(info.match(/estimated duration:\s*([0-9.]+) sec/i)?.[1]);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`could not read duration for ${file}`);
  return Number(duration.toFixed(3));
}

for (const [name, voice] of speech) {
  const script = path.join(media, 'scripts', `${name}.txt`);
  const aiff = path.join(media, `${name}.aiff`);
  const output = path.join(media, `${name}.wav`);
  if (fs.existsSync(output)) {
    manifest.push({ id: name, durationSeconds: readDuration(output), bytes: fs.statSync(output).size, voice, sourceText: path.relative(projectRoot, script), reused: true });
    continue;
  }
  try {
    execFileSync('say', ['-v', voice, '-r', '145', '-f', script, '-o', aiff], { timeout: 120_000, stdio: 'pipe' });
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@24000', aiff, output], { timeout: 120_000, stdio: 'pipe' });
  } catch (error) {
    fs.rmSync(output, { force: true });
    throw error;
  } finally { fs.rmSync(aiff, { force: true }); }
  manifest.push({ id: name, durationSeconds: readDuration(output), bytes: fs.statSync(output).size, voice, sourceText: path.relative(projectRoot, script) });
}

const sampleRate = 24_000;
const durationSeconds = 60;
const channels = 2;
const sampleCount = sampleRate * durationSeconds;
const pcm = Buffer.alloc(sampleCount * channels * 2);
let seed = 0x5a17cafe;
let lowLeft = 0;
let lowRight = 0;
const random = () => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return ((seed >>> 0) / 0xffffffff) * 2 - 1;
};
for (let index = 0; index < sampleCount; index += 1) {
  const time = index / sampleRate;
  const swell = Math.pow(Math.max(0, Math.sin((2 * Math.PI * time) / 10 - Math.PI / 2)), 2.2);
  lowLeft = lowLeft * 0.986 + random() * 0.014;
  lowRight = lowRight * 0.986 + random() * 0.014;
  const harmonic = 0.055 * Math.sin(2 * Math.PI * 74 * time) + 0.025 * Math.sin(2 * Math.PI * 119 * time + 0.4);
  const left = (lowLeft * 0.62 + random() * 0.035 + harmonic) * (0.13 + 0.55 * swell);
  const right = (lowRight * 0.62 + random() * 0.035 + harmonic * 0.96) * (0.13 + 0.55 * swell);
  for (let channel = 0; channel < channels; channel += 1) {
    const value = Math.max(-0.92, Math.min(0.92, channel ? right : left));
    pcm.writeInt16LE(Math.round(value * 32767), (index * channels + channel) * 2);
  }
}
const wave = Buffer.alloc(44 + pcm.length);
wave.write('RIFF', 0); wave.writeUInt32LE(36 + pcm.length, 4); wave.write('WAVE', 8);
wave.write('fmt ', 12); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20);
wave.writeUInt16LE(channels, 22); wave.writeUInt32LE(sampleRate, 24);
wave.writeUInt32LE(sampleRate * channels * 2, 28); wave.writeUInt16LE(channels * 2, 32);
wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(pcm.length, 40); pcm.copy(wave, 44);
const oceanPath = path.join(media, 'ocean-waves.wav');
const oceanAlreadyExisted = fs.existsSync(oceanPath);
if (!oceanAlreadyExisted) fs.writeFileSync(oceanPath, wave);
if (fs.existsSync(oceanPath)) {
  manifest.push({ id: 'ocean-waves', durationSeconds: readDuration(oceanPath), bytes: fs.statSync(oceanPath).size, source: 'generated-original-stereo-swell', reused: oceanAlreadyExisted });
}

process.stdout.write(`STAGE18_MEDIA ${JSON.stringify(manifest)}\n`);
