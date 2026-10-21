// Raster export helpers (DEVTEST package; used by the device test page now and by the editor in stage C).
//
// - canvasToBlob: canvas → PNG / JPEG blob.
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
 * Rejects with error.code = 'CANVAS_TO_BLOB_FAILED' when the browser cannot encode it
 * (typically because the canvas is larger than the device allows).
 */
export function canvasToBlob(canvas, type = 'image/png', quality = 0.92) {
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
