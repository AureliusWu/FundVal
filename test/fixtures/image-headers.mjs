// Synthetic container/header fixtures only; no private image or OCR text.
export const concat = (...parts) => new Uint8Array(parts.flatMap(part => Array.from(part)));
export const ascii = text => new Uint8Array(Array.from(text, char => char.charCodeAt(0)));
export function uint(value, size = 4, little = false) {
  const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
  if (size === 4) view.setUint32(0, value, little);
  else if (size === 2) view.setUint16(0, value, little);
  else for (let index = 0; index < size; index++) bytes[index] = Math.floor(value / 256 ** (little ? index : size - index - 1)) % 256;
  return bytes;
}
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function pngChunk(type, data = new Uint8Array()) {
  const covered = concat(ascii(type), data);
  return concat(uint(data.length), covered, uint(crc32(covered)));
}
export function png(width = 100, height = 100, { before = [], after = [], color = 2, depth = 8 } = {}) {
  const ihdr = concat(uint(width), uint(height), [depth, color, 0, 0, 0]);
  return concat([137, 80, 78, 71, 13, 10, 26, 10], pngChunk('IHDR', ihdr), ...before,
    pngChunk('IDAT', [0]), ...after, pngChunk('IEND'));
}
export function jpeg(width = 100, height = 100, { marker = 0xc0, prefix = [] } = {}) {
  const frame = concat([8], uint(height, 2), uint(width, 2), [3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);
  return concat([0xff, 0xd8], ...prefix, [0xff, marker], uint(frame.length + 2, 2), frame,
    [0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0, 0xff, 0xd9]);
}
export const jpegSegment = (marker, data) => concat([0xff, marker], uint(data.length + 2, 2), data);
export function riffChunk(type, data) {
  return concat(ascii(type), uint(data.length, 4, true), data, data.length % 2 ? [0] : []);
}
export function webpContainer(chunks) {
  const body = concat(ascii('WEBP'), ...chunks);
  return concat(ascii('RIFF'), uint(body.length, 4, true), body);
}
export function vp8(width, height) {
  return riffChunk('VP8 ', concat([0x30, 0, 0, 0x9d, 1, 0x2a], uint(width, 2, true), uint(height, 2, true), [0]));
}
export function vp8l(width, height, { version = 0 } = {}) {
  const bits = (width - 1) + (height - 1) * 16384 + version * 2 ** 29;
  return riffChunk('VP8L', concat([0x2f], uint(bits, 4, true), [0]));
}
export function vp8x(width, height, flags = 0) {
  return riffChunk('VP8X', concat([flags, 0, 0, 0], uint(width - 1, 3, true), uint(height - 1, 3, true)));
}
