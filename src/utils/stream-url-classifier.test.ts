import { describe, expect, it } from 'vitest';
import { classifyStreamUrl } from './stream-url-classifier';

describe('classifyStreamUrl', () => {
  it('treats a media extension as media even with a query or fragment', () => {
    expect(classifyStreamUrl('http://host/download/a.mp4?token=x')).toBe('media');
    expect(classifyStreamUrl('http://host/live/a.m3u8#t=10')).toBe('media');
    expect(classifyStreamUrl('http://host/a.ts')).toBe('media');
  });

  it('matches media extensions case-insensitively', () => {
    expect(classifyStreamUrl('http://host/a.M3U8')).toBe('media');
    expect(classifyStreamUrl('HTTP://HOST/A.MP4')).toBe('media');
    expect(classifyStreamUrl('http://host/a.FLV')).toBe('media');
  });

  it('treats a media format in the output query as media', () => {
    expect(classifyStreamUrl('http://host/live?output=m3u8')).toBe('media');
    expect(classifyStreamUrl('http://host/live?username=u&output=ts')).toBe('media');
    expect(classifyStreamUrl('http://host/live?output=MP4')).toBe('media');
  });

  it('keeps a media extension ahead of an embed-shaped path', () => {
    expect(classifyStreamUrl('http://host/player/a.mp4')).toBe('media');
    expect(classifyStreamUrl('http://host/watch/a.m3u8')).toBe('media');
  });

  it('recognizes the known embed path shapes', () => {
    expect(classifyStreamUrl('http://host/videoembed/123')).toBe('embed');
    expect(classifyStreamUrl('http://host/embed/123')).toBe('embed');
    expect(classifyStreamUrl('http://host/embed-abc.html')).toBe('embed');
    expect(classifyStreamUrl('http://host/iframe/123')).toBe('embed');
    expect(classifyStreamUrl('http://host/player/123')).toBe('embed');
    expect(classifyStreamUrl('http://host/watch/123')).toBe('embed');
    expect(classifyStreamUrl('http://host/e/abc')).toBe('embed');
    expect(classifyStreamUrl('http://host/v/123')).toBe('embed');
  });

  it('treats a bare page route as embed', () => {
    expect(classifyStreamUrl('http://host/page.html')).toBe('embed');
    expect(classifyStreamUrl('http://host/page.htm')).toBe('embed');
    expect(classifyStreamUrl('http://host/page.php?x=1')).toBe('embed');
  });

  it('returns unknown when no rule applies or the URL is not http(s)', () => {
    expect(classifyStreamUrl('http://host/live/stream')).toBe('unknown');
    expect(classifyStreamUrl('http://host/live?output=mkv')).toBe('unknown');
    expect(classifyStreamUrl('ftp://host/a.mp4')).toBe('unknown');
    expect(classifyStreamUrl('javascript:alert(1)')).toBe('unknown');
    expect(classifyStreamUrl('/a.mp4')).toBe('unknown');
    expect(classifyStreamUrl('not a url')).toBe('unknown');
    expect(classifyStreamUrl('')).toBe('unknown');
  });
});
