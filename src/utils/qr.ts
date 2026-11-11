import qrcode from 'qrcode-generator';

// Aim for a code about this wide on the 1920x1080 canvas: roughly 4px a dot
// for a typical address, which a phone reads from a sofa.
export const QR_TARGET_PX = 240;
const QUIET_ZONE_MODULES = 4;
const MIN_CELL_PX = 2;

// The QR text is bytes, so anything outside ASCII goes out percent-encoded,
// the way a browser would send it.
function asciiOnly(text: string): string {
  return text.replace(/[^\x00-\x7f]+/g, (run) => encodeURIComponent(run));
}

// A GIF data URL of `text` at a whole number of pixels per dot, with the
// standard four-dot white margin. Low error correction keeps the code coarse
// and so large on screen. Null when the text is too long for any code.
export function qrCodeDataUrl(text: string, targetPx = QR_TARGET_PX): string | null {
  try {
    const qr = qrcode(0, 'L');
    qr.addData(asciiOnly(text));
    qr.make();
    const modules = qr.getModuleCount() + QUIET_ZONE_MODULES * 2;
    const cell = Math.max(MIN_CELL_PX, Math.floor(targetPx / modules));
    return qr.createDataURL(cell, cell * QUIET_ZONE_MODULES);
  } catch {
    return null;
  }
}
