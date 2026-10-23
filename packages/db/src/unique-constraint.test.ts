import { describe, it, expect } from 'vitest';
import { isStatusCheckConstraint, isUniqueOnVideoPathOnly } from './postgres-database.js';

describe('isUniqueOnVideoPathOnly', () => {
  it('accepts single-column UNIQUE(video_path)', () => {
    expect(isUniqueOnVideoPathOnly('UNIQUE (video_path)')).toBe(true);
    expect(isUniqueOnVideoPathOnly('UNIQUE ("video_path")')).toBe(true);
  });

  it('rejects composite uniques that merely include video_path', () => {
    expect(isUniqueOnVideoPathOnly('UNIQUE (video_path, status)')).toBe(false);
    expect(isUniqueOnVideoPathOnly('UNIQUE (status, video_path)')).toBe(false);
  });
});

describe('isStatusCheckConstraint', () => {
  it('accepts Postgres ANY(ARRAY[...]) and IN (...) forms for exactly completed|failed', () => {
    expect(
      isStatusCheckConstraint("CHECK ((status = ANY (ARRAY['completed'::text, 'failed'::text])))"),
    ).toBe(true);
    expect(isStatusCheckConstraint("CHECK (status IN ('completed', 'failed'))")).toBe(true);
  });

  it('rejects loose checks that merely mention completed/failed', () => {
    expect(
      isStatusCheckConstraint(
        "CHECK ((status IS NOT NULL) OR status = 'completed' OR status = 'failed')",
      ),
    ).toBe(false);
    expect(
      isStatusCheckConstraint(
        "CHECK ((status = ANY (ARRAY['completed'::text, 'failed'::text, 'pending'::text])))",
      ),
    ).toBe(false);
    expect(isStatusCheckConstraint('CHECK (length(status) > 0)')).toBe(false);
  });

  it('rejects IN/ANY constraints widened with OR true', () => {
    expect(isStatusCheckConstraint("CHECK (status IN ('completed', 'failed') OR true)")).toBe(
      false,
    );
    expect(
      isStatusCheckConstraint(
        "CHECK ((status = ANY (ARRAY['completed'::text, 'failed'::text])) OR true)",
      ),
    ).toBe(false);
  });
});
