import { describe, it, expect, vi } from 'vitest';
import {
  formatDuration, formatTotalDuration, escapeHtml, hueFromString,
  initials, slugify, sanitizeSearchTerm, debounce, pluralize,
} from '@/lib/utils/format';
import { midpoint } from '@/lib/library/service';

describe('formatDuration', () => {
  it('formats minutes and seconds with a padded seconds field', () => {
    expect(formatDuration(214)).toBe('3:34');
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(60)).toBe('1:00');
  });

  it('adds an hours field past 60 minutes', () => {
    expect(formatDuration(3725)).toBe('1:02:05');
  });

  it('shows a placeholder for unknown durations rather than NaN', () => {
    for (const v of [null, undefined, NaN, -5, Infinity]) {
      expect(formatDuration(v as number)).toBe('--:--');
    }
  });
});

describe('formatTotalDuration', () => {
  it('summarises album and playlist lengths', () => {
    expect(formatTotalDuration(45)).toBe('45 sec');
    expect(formatTotalDuration(2040)).toBe('34 min');
    expect(formatTotalDuration(3600)).toBe('1 hr');
    expect(formatTotalDuration(3840)).toBe('1 hr 4 min');
  });

  it('returns nothing for a zero-length collection', () => {
    expect(formatTotalDuration(0)).toBe('');
  });
});

describe('escapeHtml', () => {
  it('neutralises a script tag in a track title', () => {
    const escaped = escapeHtml('<script>alert("x")</script>');
    expect(escaped).not.toContain('<script>');
    expect(escaped).toContain('&lt;script&gt;');
  });

  it('escapes quotes so attribute injection is impossible', () => {
    expect(escapeHtml('" onerror="alert(1)')).toContain('&quot;');
  });

  it('handles null and undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('placeholder helpers', () => {
  it('gives the same hue for the same name every time', () => {
    expect(hueFromString('Kind of Blue')).toBe(hueFromString('Kind of Blue'));
    expect(hueFromString('Kind of Blue')).toBeLessThan(360);
  });

  it('takes an initial, falling back for empty input', () => {
    expect(initials('daft punk')).toBe('D');
    expect(initials('  ')).toBe('?');
  });
});

describe('slugify', () => {
  it('produces a safe storage path segment', () => {
    expect(slugify('Björk — Jóga (Live!)')).toBe('bjork-joga-live');
  });

  it('never returns an empty string', () => {
    expect(slugify('!!!')).toBe('untitled');
  });

  it('caps length so object keys stay sane', () => {
    expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
});

describe('sanitizeSearchTerm', () => {
  it('strips PostgREST filter syntax that would break the query', () => {
    expect(sanitizeSearchTerm('rock,pop(x)')).toBe('rock pop x');
    expect(sanitizeSearchTerm('100%')).toBe('100');
  });

  it('collapses whitespace', () => {
    expect(sanitizeSearchTerm('  the    beatles ')).toBe('the beatles');
  });
});

describe('midpoint (playlist reordering)', () => {
  it('lands exactly between two neighbours', () => {
    expect(midpoint(1, 2)).toBe(1.5);
  });

  it('handles the ends of the list', () => {
    expect(midpoint(null, 5)).toBe(4);
    expect(midpoint(5, null)).toBe(6);
    expect(midpoint(null, null)).toBe(1);
  });

  it('keeps ordering stable across repeated inserts in the same gap', () => {
    let low = 1, high = 2;
    for (let i = 0; i < 10; i++) {
      const mid = midpoint(low, high);
      expect(mid).toBeGreaterThan(low);
      expect(mid).toBeLessThan(high);
      high = mid;
    }
  });
});

describe('debounce', () => {
  it('fires once after the quiet period', async () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    const debounced = debounce(spy, 100);
    debounced('a'); debounced('b'); debounced('c');
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('c');
    vi.useRealTimers();
  });

  it('can be cancelled', () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    const debounced = debounce(spy, 100);
    debounced(); debounced.cancel();
    vi.advanceTimersByTime(200);
    expect(spy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('pluralize', () => {
  it('agrees with the count', () => {
    expect(pluralize(1, 'song')).toBe('1 song');
    expect(pluralize(3, 'song')).toBe('3 songs');
  });
});
