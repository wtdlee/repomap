import * as net from 'net';

/**
 * Check if a port is available
 */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        resolve(false);
      }
    });

    server.once('listening', () => {
      server.close();
      resolve(true);
    });

    server.listen(port);
  });
}

/**
 * Find an available port starting from the given port
 *
 * @param startPort - Port to start searching from
 * @param maxAttempts - Maximum number of ports to try (default: 10)
 * @returns Available port number
 * @throws Error if no available port found within maxAttempts
 */
export async function findAvailablePort(
  startPort: number,
  maxAttempts: number = 10
): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(
    `No available port found between ${startPort} and ${startPort + maxAttempts - 1}`
  );
}
