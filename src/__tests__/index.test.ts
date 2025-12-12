/**
 * Basic smoke tests for repomap package
 */
import { describe, it, expect } from 'vitest';

describe('repomap', () => {
  it('should export main modules', async () => {
    const main = await import('../index');
    expect(main).toBeDefined();
    expect(main.DocGeneratorEngine).toBeDefined();
    expect(main.DocServer).toBeDefined();
  });

  it('should export types', async () => {
    const types = await import('../types');
    expect(types).toBeDefined();
  });

  it('should export analyzers', async () => {
    const analyzers = await import('../analyzers');
    expect(analyzers).toBeDefined();
  });
});
