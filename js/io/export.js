// Raster export helpers (DEVTEST package; used by the device test page now and by the editor in stage C).
//
// - canvasToBlob: canvas → PNG / JPEG blob (opts.dpi: the file says its resolution; withDpi, readDpi).
// - buildRasterPdf: a minimal, hand-written PDF 1.4 with one page and one JPEG image (DCTDecode)
//   drawn over the whole page. Because the image covers the page exactly, the printed physical size
//   is exact when the user prints at "actual size" (100 %). No fonts are embedded: all text is already
//   part of the raster image, which avoids the Korean font-subsetting problems of PDF libraries.
//
// The PDF is built byte by byte so that the cross-reference table holds exact byte offsets.

export const A4 = { w: 210, h: 297 };

const MM_PER_INCH = 25.4;
const PT_PER_INCH = 72;

/** Millimetres → whole device pixels at the given resolution (A4 at 300 dpi = 2480 × 3508). */
export function mmToPx(mm, dpi = 300) {
  return Math.round((mm * dpi) / MM_PER_INCH);
}

/** Millimetres → PDF points (1 pt = 1/72 inch). Not rounded. */
export function mmToPt(mm) {
  return (mm * PT_PER_INCH) / MM_PER_INCH;
}

/**
 * Encode a canvas (HTMLCanvasElement or OffscreenCanvas) as a Blob.
 * opts.dpi: the resolution the canvas was drawn at; a PNG or JPEG then says so in the file (withDpi), so
 * that 한글 / Word / Excel insert it, and a printer prints it at 'actual size', at its paper size.
 * Rejects with error.code = 'CANVAS_TO_BLOB_FAILED' when the browser cannot encode it
 * (typically because the canvas is larger than the device allows).
 */
export function canvasToBlob(canvas, type = 'image/png', quality = 0.92, opts = {}) {
  const dpi = opts && opts.dpi;
  const encoded = encodeBlob(canvas, type, quality);
  return dpi > 0 ? encoded.then((blob) => withDpi(blob, dpi)) : encoded;
}

function encodeBlob(canvas, type, quality) {
  if (typeof canvas.toBlob !== 'function' && typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type, quality }).then((blob) => {
      if (!blob) throw codedError('CANVAS_TO_BLOB_FAILED', 'convertToBlob returned no blob');
      return blob;
    });
  }
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(codedError('CANVAS_TO_BLOB_FAILED', `toBlob returned null (${canvas.width}x${canvas.height})`));
        },
        type,
        quality
      );
    } catch (err) {
      const e = codedError('CANVAS_TO_BLOB_FAILED', String(err && err.message ? err.message : err));
      e.cause = err;
      reject(e);
    }
  });
}

/**
 * The same PNG or JPEG saying it is `dpi` dots per inch (review 2026-10-25: the browser writes no
 * resolution — a PNG without a pHYs chunk, a JPEG with JFIF density 1:1 and no unit — so programs that
 * size a picture by it took the 300 dpi A4 page for 96 or 72 dpi, three times A4, and the 1:60 written on
 * it held only after resizing it by hand). PNG: a pHYs chunk (pixels per metre) right after IHDR, an
 * earlier one dropped. JPEG: the JFIF APP0 segment's unit (1 = dots per inch) and density, or such a
 * segment added after SOI. Anything else, or data that cannot be read so, comes back unchanged.
 * blob: Blob | ArrayBuffer | Uint8Array. → Promise<Blob> (the input's type; image/png | image/jpeg)
 */
export async function withDpi(blob, dpi) {
  const bytes = await toBytes(blob);
  const type = (blob && blob.type) || (isPng(bytes) ? 'image/png' : isJpeg(bytes) ? 'image/jpeg' : '');
  const d = Math.round(Number(dpi));
  let out = null;
  if (d > 0 && isPng(bytes)) out = pngWithDpi(bytes, d);
  else if (d > 0 && isJpeg(bytes)) out = jpegWithDpi(bytes, d);
  if (!out) return blob instanceof Blob ? blob : new Blob([bytes], { type });
  return new Blob([out], { type });
}

/**
 * The resolution a PNG or JPEG says it has. → { dpiX, dpiY } | null (none, or no unit)
 */
export function readDpi(bytes) {
  if (isPng(bytes)) {
    for (const c of pngChunks(bytes)) {
      if (c.type !== 'pHYs' || c.length !== 9) continue;
      const x = u32(bytes, c.data), y = u32(bytes, c.data + 4);
      return bytes[c.data + 8] === 1 ? { dpiX: x * 0.0254, dpiY: y * 0.0254 } : null;
    }
    return null;
  }
  if (isJpeg(bytes)) {
    const j = jfifAt(bytes);
    if (j == null) return null;
    const unit = bytes[j + 11], x = (bytes[j + 12] << 8) | bytes[j + 13], y = (bytes[j + 14] << 8) | bytes[j + 15];
    if (unit === 1) return { dpiX: x, dpiY: y };
    if (unit === 2) return { dpiX: x * 2.54, dpiY: y * 2.54 };
    return null;
  }
  return null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (b) => b instanceof Uint8Array && b.length >= 33 && PNG_SIGNATURE.every((v, i) => b[i] === v);
const isJpeg = (b) => b instanceof Uint8Array && b.length >= 4 && b[0] === 0xff && b[1] === 0xd8;
const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

// PNG chunks: [{ type, length, at (chunk start), data (data start), end (after the CRC) }]
function pngChunks(bytes) {
  const out = [];
  let i = 8;
  while (i + 12 <= bytes.length) {
    const length = u32(bytes, i);
    const end = i + 12 + length;
    if (end > bytes.length) break;
    out.push({ type: ascii(bytes, i + 4, 4), length, at: i, data: i + 8, end });
    i = end;
  }
  return out;
}

function pngWithDpi(bytes, dpi) {
  const chunks = pngChunks(bytes);
  if (!chunks.length || chunks[0].type !== 'IHDR') return null;
  const ppm = Math.round(dpi / 0.0254);
  const phys = new Uint8Array(21);
  const put32 = (i, v) => { phys[i] = (v >>> 24) & 255; phys[i + 1] = (v >>> 16) & 255; phys[i + 2] = (v >>> 8) & 255; phys[i + 3] = v & 255; };
  put32(0, 9);
  phys.set([0x70, 0x48, 0x59, 0x73], 4); // 'pHYs'
  put32(8, ppm);
  put32(12, ppm);
  phys[16] = 1; // unit: metre
  put32(17, crc32(phys, 4, 17));
  const parts = [bytes.subarray(0, chunks[0].end), phys];
  let at = chunks[0].end;
  for (const c of chunks.slice(1)) {
    if (c.type === 'pHYs') { parts.push(bytes.subarray(at, c.at)); at = c.end; }
  }
  parts.push(bytes.subarray(at));
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let k = 0;
  for (const p of parts) { out.set(p, k); k += p.length; }
  return out;
}

// The offset of the JFIF APP0 segment's marker (FF E0 … 'JFIF\0') among the segments before the
// image data, or null.
function jfifAt(bytes) {
  let i = 2;
  while (i + 4 <= bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1];
    if (marker === 0xda || marker === 0xd9) return null;
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2) return null;
    if (marker === 0xe0 && len >= 16 && ascii(bytes, i + 4, 5) === 'JFIF\u0000') return i;
    i += 2 + len;
  }
  return null;
}

function jpegWithDpi(bytes, dpi) {
  const v = Math.min(65535, dpi);
  const j = jfifAt(bytes);
  if (j != null) {
    const out = bytes.slice();
    out[j + 11] = 1; // dots per inch
    out[j + 12] = v >> 8; out[j + 13] = v & 255;
    out[j + 14] = v >> 8; out[j + 15] = v & 255;
    return out;
  }
  // No JFIF segment: one after SOI (version 1.1, no thumbnail).
  const app0 = new Uint8Array([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 1, v >> 8, v & 255, v >> 8, v & 255, 0, 0]);
  const out = new Uint8Array(bytes.length + app0.length);
  out.set(bytes.subarray(0, 2), 0);
  out.set(app0, 2);
  out.set(bytes.subarray(2), 2 + app0.length);
  return out;
}

let CRC_TABLE = null;
// CRC-32 (PNG chunks) of bytes[start, end).
function crc32(bytes, start, end) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Read width, height and colour components from a JPEG's start-of-frame segment.
 * bytes: Uint8Array of the whole JPEG file.
 * → { width, height, components, bitsPerComponent, adobe }  (adobe = an Adobe APP14 marker was seen)
 * Throws error.code = 'NOT_JPEG' when the data is not a readable JPEG.
 */
export function parseJpegInfo(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw codedError('NOT_JPEG', 'data does not start with the JPEG SOI marker');
  }
  // Start-of-frame markers that carry the image size (all SOFn except DHT C4, JPG C8, DAC CC).
  const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let adobe = false;
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) throw codedError('NOT_JPEG', `expected a marker at byte ${i}`);
    // Skip fill bytes (0xFF padding).
    while (i < bytes.length && bytes[i] === 0xff) i++;
    if (i >= bytes.length) break;
    const marker = bytes[i];
    i++;
    // Markers without a length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (marker === 0xd9 || marker === 0xda) break; // EOI or start of scan before any SOF
    if (i + 2 > bytes.length) break;
    const segLen = (bytes[i] << 8) | bytes[i + 1];
    if (segLen < 2) throw codedError('NOT_JPEG', `bad segment length at byte ${i}`);
    if (marker === 0xee && segLen >= 7 && ascii(bytes, i + 2, 5) === 'Adobe') adobe = true;
    if (SOF.has(marker)) {
      if (i + 8 > bytes.length) break;
      return {
        bitsPerComponent: bytes[i + 2],
        height: (bytes[i + 3] << 8) | bytes[i + 4],
        width: (bytes[i + 5] << 8) | bytes[i + 6],
        components: bytes[i + 7],
        adobe,
      };
    }
    i += segLen;
  }
  throw codedError('NOT_JPEG', 'no start-of-frame segment found');
}

/**
 * Build a one-page PDF whose page is completely covered by the given JPEG.
 * jpeg: Blob | ArrayBuffer | Uint8Array holding a JPEG file.
 * → Promise<Blob> of type application/pdf.
 */
export async function buildRasterPdf(jpeg, { pageWidthMM = A4.w, pageHeightMM = A4.h } = {}) {
  const jpegBytes = await toBytes(jpeg);
  const info = parseJpegInfo(jpegBytes);
  if (!(info.width > 0 && info.height > 0)) throw codedError('NOT_JPEG', 'JPEG has no size');

  const pageW = pdfNumber(mmToPt(pageWidthMM));
  const pageH = pdfNumber(mmToPt(pageHeightMM));

  let colorSpace;
  let decode = '';
  if (info.components === 1) colorSpace = '/DeviceGray';
  else if (info.components === 3) colorSpace = '/DeviceRGB';
  else if (info.components === 4) {
    colorSpace = '/DeviceCMYK';
    // Adobe-written CMYK JPEGs store inverted values.
    if (info.adobe) decode = ' /Decode [1 0 1 0 1 0 1 0]';
  } else {
    throw codedError('NOT_JPEG', `unsupported number of colour components: ${info.components}`);
  }

  // Scale the unit image square to the full page.
  const content = asciiBytes(`q\n${pageW} 0 0 ${pageH} 0 0 cm\n/Im0 Do\nQ\n`);

  const w = new PdfWriter();
  w.text('%PDF-1.4\n');
  // A comment with bytes > 127 tells transfer tools that the file is binary.
  w.bytes(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  // PrintScaling /None asks viewers to default to "actual size" when printing (ignored by viewers that
  // do not know it; harmless in a 1.4 file).
  w.object(1, '<< /Type /Catalog /Pages 2 0 R /ViewerPreferences << /PrintScaling /None >> >>');
  w.object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  w.object(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
      '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'
  );
  w.streamObject(
    4,
    `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} ` +
      `/ColorSpace ${colorSpace} /BitsPerComponent ${info.bitsPerComponent || 8}${decode} ` +
      `/Filter /DCTDecode /Length ${jpegBytes.length} >>`,
    jpegBytes
  );
  w.streamObject(5, `<< /Length ${content.length} >>`, content);
  return w.finish(1);
}

// ---------------------------------------------------------------------------------------------
// Internals

/** Collects byte chunks and remembers the byte offset at which each object starts. */
class PdfWriter {
  constructor() {
    this.chunks = [];
    this.offset = 0;
    this.objectOffsets = []; // index = object number
  }

  bytes(u8) {
    this.chunks.push(u8);
    this.offset += u8.length;
  }

  text(str) {
    this.bytes(asciiBytes(str));
  }

  object(num, body) {
    this.objectOffsets[num] = this.offset;
    this.text(`${num} 0 obj\n${body}\nendobj\n`);
  }

  streamObject(num, dict, data) {
    this.objectOffsets[num] = this.offset;
    this.text(`${num} 0 obj\n${dict}\nstream\n`);
    this.bytes(data);
    // The end-of-line before 'endstream' is not part of the stream data (not counted in /Length).
    this.text('\nendstream\nendobj\n');
  }

  finish(rootNum) {
    const count = this.objectOffsets.length; // objects 0..count-1
    for (let n = 1; n < count; n++) {
      if (typeof this.objectOffsets[n] !== 'number') throw new Error(`PDF object ${n} was never written`);
    }
    const xrefOffset = this.offset;
    // Each xref entry is exactly 20 bytes: 10-digit offset, space, 5-digit generation, space, type, space, LF.
    let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let n = 1; n < count; n++) {
      xref += `${String(this.objectOffsets[n]).padStart(10, '0')} 00000 n \n`;
    }
    this.text(xref);
    this.text(`trailer\n<< /Size ${count} /Root ${rootNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
    return new Blob(this.chunks, { type: 'application/pdf' });
  }
}

/** Numbers in PDF syntax: at most 2 decimals, no trailing zeros (595.2756 → "595.28", 100 → "100"). */
function pdfNumber(x) {
  let s = x.toFixed(2);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

async function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data && typeof data.arrayBuffer === 'function') return new Uint8Array(await data.arrayBuffer());
  throw codedError('NOT_JPEG', 'expected a Blob, ArrayBuffer or Uint8Array');
}

function asciiBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c > 127) throw new Error('PDF syntax must be ASCII');
    out[i] = c;
  }
  return out;
}

function ascii(bytes, start, len) {
  let s = '';
  for (let i = start; i < start + len && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}
