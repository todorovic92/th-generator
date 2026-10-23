import { describe, it, expect } from 'vitest';
import { isVideoFile } from './video-extensions.js';

describe('isVideoFile', () => {
  it('recognizes known extensions case-insensitively', () => {
    expect(isVideoFile('/a/Movie.MP4')).toBe(true);
    expect(isVideoFile('/a/clip.webm')).toBe(true);
    expect(isVideoFile('/a/notes.txt')).toBe(false);
  });
});
