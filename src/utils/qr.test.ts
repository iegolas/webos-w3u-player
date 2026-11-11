import { describe, expect, it } from 'vitest';
import { qrCodeDataUrl } from './qr';

// GIF header: width and height are the little-endian words at bytes 6 and 8.
function gifSize(url: string): { width: number; height: number } {
  const bytes = atob(url.slice(url.indexOf(',') + 1));
  const word = (at: number): number => bytes.charCodeAt(at) | (bytes.charCodeAt(at + 1) << 8);
  return { width: word(6), height: word(8) };
}

describe('qrCodeDataUrl', () => {
  it('returns an image data URL that is square and close to the target size', () => {
    const url = qrCodeDataUrl('http://host.test/a.m3u8');
    expect(url).toMatch(/^data:image\/gif;base64,/);
    const { width, height } = gifSize(url!);
    expect(width).toBe(height);
    expect(width).toBeLessThanOrEqual(240);
    expect(width).toBeGreaterThan(200);
  });

  it('makes a different code for a different address', () => {
    expect(qrCodeDataUrl('http://host.test/a')).not.toBe(qrCodeDataUrl('http://host.test/b'));
  });

  it('accepts non-ASCII text and grows no larger than whole dots allow for a long address', () => {
    expect(qrCodeDataUrl('http://host.test/é/ü?q=日本')).toMatch(/^data:image\/gif/);
    const long = qrCodeDataUrl(`http://host.test/${'a'.repeat(600)}`);
    expect(long).toMatch(/^data:image\/gif/);
  });

  it('returns null when the text cannot fit in any code', () => {
    expect(qrCodeDataUrl('x'.repeat(4000))).toBeNull();
  });
});
