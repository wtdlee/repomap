/**
 * Server smoke tests
 * Verifies server can start without runtime errors
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'http';

describe('DocServer', () => {
  let serverInstance: { server: Server } | null = null;

  afterEach(async () => {
    if (serverInstance?.server) {
      await new Promise<void>((resolve) => {
        serverInstance!.server.close(() => resolve());
      });
      serverInstance = null;
    }
  });

  it('should initialize without errors', async () => {
    const { DocServer } = await import('../server/doc-server');

    const config = {
      outputDir: './.repomap-test',
      site: { title: 'Test', baseUrl: '/' },
      repositories: [{ name: 'test', path: process.cwd(), displayName: 'Test' }],
      analyzers: {
        pages: { enabled: false },
        graphql: { enabled: false },
        dataflow: { enabled: false },
        restApi: { enabled: false },
      },
      generators: { markdown: { enabled: false }, mermaid: { enabled: false } },
      watch: { enabled: false, debounceMs: 1000 },
    };

    // Should not throw during construction
    const server = new DocServer(config, 0); // port 0 = random available port
    expect(server).toBeDefined();
  });

  it('should have valid route patterns for Express 5', async () => {
    // This test verifies that Express 5 route patterns are valid
    // by checking that the server can be constructed without path-to-regexp errors
    const { DocServer } = await import('../server/doc-server');

    const config = {
      outputDir: './.repomap-test',
      site: { title: 'Test', baseUrl: '/' },
      repositories: [{ name: 'test', path: process.cwd(), displayName: 'Test' }],
      analyzers: {
        pages: { enabled: false },
        graphql: { enabled: false },
        dataflow: { enabled: false },
        restApi: { enabled: false },
      },
      generators: { markdown: { enabled: false }, mermaid: { enabled: false } },
      watch: { enabled: false, debounceMs: 1000 },
    };

    // Express 5 validates route patterns during route registration
    // If patterns are invalid, this will throw
    expect(() => new DocServer(config, 0)).not.toThrow();
  });
});
