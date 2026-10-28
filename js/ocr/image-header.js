// Local header preflight, not an image decoder. Never read the original Blob's
// full arrayBuffer or start a bitmap/canvas/worker/network operation here.
// Layouts: W3C PNG3 §11.2.1; ITU T.81 B.2.2; Google WebP container/VP8L;
// RFC6386 §9.1 (VP8 key-frame uncompressed header).
export const MAX_IMAGE_HEADER_BYTES = 256 * 1024;
export const MAX_IMAGE_HEADER_RECORDS = 512;
// Reserve the pre-existing signature API's 12 bytes: combined recognition
// header IO never exceeds 256KiB, even when those bytes are read twice.
const READ_BUDGET = MAX_IMAGE_HEADER_BYTES - 12;
const MESSAGES = Object.freeze({
  image_header_invalid: '无法读取有效的静态截图尺寸，请更换图片后重试。',
  image_header_budget_exceeded: '截图头部过大或结构过于复杂，请重新导出截图。',
  image_header_animated: '不支持动态图片，请选择静态截图。',
  image_header_read_failed: '无法读取截图文件，请重新选择。',
  image_header_aborted: '截图预检已取消。',
});
export class ImageHeaderError extends Error {
  constructor(code = 'image_header_invalid') {
    const safe = Object.hasOwn(MESSAGES, code) ? code : 'image_header_invalid';
    super(MESSAGES[safe]); this.name = 'ImageHeaderError'; this.code = safe;
  }
}
const fail = code => { throw new ImageHeaderError(code); };
const text = bytes => String.fromCharCode(...bytes);
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const be32 = bytes => view(bytes).getUint32(0);
const le32 = bytes => view(bytes).getUint32(0, true);
const le24 = bytes => bytes[0] + bytes[1] * 256 + bytes[2] * 65536;
function aborted(signal) { if (signal?.aborted) fail('image_header_aborted'); }
function dimensions(format, width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
    || !Number.isSafeInteger(width * height)) fail();
  return { format, width, height };
}
function reader(file, signal) {
  let spent = 0, records = 0;
  return {
    size: file.size,
    record() { if (++records > MAX_IMAGE_HEADER_RECORDS) fail('image_header_budget_exceeded'); },
    async read(offset, length) {
      aborted(signal);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > file.size) fail();
      if (spent + length > READ_BUDGET) fail('image_header_budget_exceeded');
      spent += length;
      let buffer;
      try { buffer = await file.slice(offset, offset + length).arrayBuffer(); }
      catch (_) { aborted(signal); fail('image_header_read_failed'); }
      aborted(signal);
      if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== length) fail();
      return new Uint8Array(buffer);
    },
  };
}
function crc32(first, second) {
  let crc = 0xffffffff;
  for (const bytes of [first, second]) for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
async function pngHeader(input) {
  let offset = 8, result, color, palette = false, idat = false, ended = false, dataBytes = 0;
  while (offset < input.size) {
    input.record();
    const chunk = await input.read(offset, 8), length = be32(chunk), typeBytes = chunk.subarray(4), type = text(typeBytes);
    const end = offset + 12 + length;
    if (length > 0x7fffffff || end > input.size || !/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) fail();
    if (!result && (type !== 'IHDR' || length !== 13)) fail();
    if (['acTL', 'fcTL', 'fdAT'].includes(type)) fail('image_header_animated');
    if (type === 'IDAT') {
      if (ended || (color === 3 && !palette)) fail();
      idat = true; dataBytes += length;
      // Compressed pixels are not header material. Only validate their declared
      // bounds and continue to subsequent chunk headers (including APNG guards).
    } else {
      if (idat) ended = true;
      const bytes = await input.read(offset + 8, length + 4);
      if (crc32(typeBytes, bytes.subarray(0, length)) !== be32(bytes.subarray(length))) fail();
      if (type === 'IHDR') {
        if (result || length !== 13) fail();
        const width = be32(bytes), height = be32(bytes.subarray(4)), depth = bytes[8]; color = bytes[9];
        const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
        if (width > 0x7fffffff || height > 0x7fffffff || !depths[color]?.includes(depth)
          || bytes[10] !== 0 || bytes[11] !== 0 || bytes[12] > 1) fail();
        result = dimensions('png', width, height);
      } else if (type === 'PLTE') {
        if (palette || idat || [0, 4].includes(color) || !length || length > 768 || length % 3) fail();
        palette = true;
      } else if (type === 'IEND') {
        if (length || !idat || !dataBytes || end !== input.size) fail();
        return result;
      } else if ((typeBytes[0] & 32) === 0) fail();
    }
    offset = end;
  }
  fail();
}
async function jpegHeader(input) {
  const eoi = await input.read(input.size - 2, 2);
  if (eoi[0] !== 0xff || eoi[1] !== 0xd9) fail();
  let offset = 2;
  while (offset < input.size) {
    input.record();
    if (offset > READ_BUDGET - 8) fail('image_header_budget_exceeded');
    const marker = await input.read(offset, 2);
    if (marker[0] !== 0xff) fail();
    if (marker[1] === 0xff) { offset++; continue; }
    const type = marker[1], segment = await input.read(offset + 2, 2), length = view(segment).getUint16(0);
    if (length < 2 || offset + 2 + length > input.size) fail();
    if (offset + 2 + length > READ_BUDGET) fail('image_header_budget_exceeded');
    if ([0xc0, 0xc1, 0xc2].includes(type)) {
      if (length < 8 || offset + 2 + length > input.size - 4) fail();
      const body = await input.read(offset + 4, length - 2), components = body[5];
      if (!components || components > (type === 0xc2 ? 4 : 255) || length !== 8 + components * 3
        || !([8, 12].includes(body[0])) || (type === 0xc0 && body[0] !== 8)) fail();
      const ids = new Set();
      for (let index = 0; index < components; index++) {
        const start = 6 + index * 3, sampling = body[start + 1];
        if (ids.has(body[start]) || (sampling >>> 4) < 1 || (sampling >>> 4) > 4
          || (sampling & 15) < 1 || (sampling & 15) > 4 || body[start + 2] > 3) fail();
        ids.add(body[start]);
      }
      return dimensions('jpeg', view(body).getUint16(3), view(body).getUint16(1));
    }
    if (!(type >= 0xe0 && type <= 0xef) && ![0xfe, 0xdb, 0xc4, 0xcc, 0xdd].includes(type)) fail();
    offset += 2 + length;
  }
  fail();
}
async function webpHeader(input, riff) {
  if (le32(riff.subarray(4)) + 8 !== input.size) fail();
  let offset = 12, canvas = null, image = null, alpha = false;
  while (offset < input.size) {
    input.record();
    const chunk = await input.read(offset, 8), type = text(chunk.subarray(0, 4)), length = le32(chunk.subarray(4));
    const end = offset + 8 + length + length % 2;
    if (end > input.size || !/^[\x20-\x7e]{4}$/.test(type)) fail();
    if (length % 2 && (await input.read(end - 1, 1))[0] !== 0) fail();
    if (type === 'ANIM' || type === 'ANMF') fail('image_header_animated');
    if (type === 'VP8X') {
      if (offset !== 12 || canvas || length !== 10) fail();
      const body = await input.read(offset + 8, 10);
      if (body[0] & 2) fail('image_header_animated');
      if ((body[0] & 0xc1) || body[1] || body[2] || body[3]) fail();
      canvas = dimensions('webp', le24(body.subarray(4)) + 1, le24(body.subarray(7)) + 1);
      if (canvas.width * canvas.height > 0xffffffff) fail();
    } else if (type === 'VP8 ' || type === 'VP8L') {
      if (image || length < (type === 'VP8 ' ? 10 : 5)) fail();
      const body = await input.read(offset + 8, type === 'VP8 ' ? 10 : 5);
      if (type === 'VP8 ') {
        const tag = le24(body);
        if ((tag & 1) || !(tag & 16) || ((tag >>> 1) & 7) > 3 || (tag >>> 5) > length - 10
          || body[3] !== 0x9d || body[4] !== 1 || body[5] !== 0x2a) fail();
        image = dimensions('webp', view(body).getUint16(6, true) & 0x3fff, view(body).getUint16(8, true) & 0x3fff);
      } else {
        const bits = le32(body.subarray(1));
        if (body[0] !== 0x2f || (bits >>> 29) !== 0 || alpha) fail();
        image = dimensions('webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      if (canvas && (canvas.width !== image.width || canvas.height !== image.height)) fail();
    } else if (['ALPH', 'ICCP', 'EXIF', 'XMP '].includes(type)) {
      if (!canvas || (type === 'ALPH' && (image || alpha || !length))) fail();
      if (type === 'ALPH') alpha = true;
    } else if (offset === 12) fail();
    offset = end;
  }
  if (!image || offset !== input.size) fail();
  return canvas || image;
}
export async function readLocalImageHeader(file, { signal } = {}) {
  try {
    aborted(signal);
    if (!(typeof Blob !== 'undefined' && file instanceof Blob) || !Number.isSafeInteger(file.size) || file.size < 12) fail();
    const input = reader(file, signal), signature = await input.read(0, 12);
    if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => signature[index] === value)) return await pngHeader(input);
    if (signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff) return await jpegHeader(input);
    if (text(signature.subarray(0, 4)) === 'RIFF' && text(signature.subarray(8)) === 'WEBP') return await webpHeader(input, signature);
    fail();
  } catch (error) {
    if (error instanceof ImageHeaderError) throw error;
    throw new ImageHeaderError('image_header_read_failed');
  }
}
