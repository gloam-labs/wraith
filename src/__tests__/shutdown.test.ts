import { EventEmitter } from 'events';
import http from 'http';
import { AddressInfo } from 'net';

// Minimal, self-contained drain/timeout behaviour test for the shutdown path.
// Exercises the same close-then-wait-with-timeout logic that src/index.ts uses.

function gracefulClose(server: http.Server, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    };
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      finish();
    }, timeoutMs);
    timer.unref?.();
    server.close(() => finish());
  });
}

describe('graceful shutdown', () => {
  it('drains an in-flight request before resolving', async () => {
    let release: () => void = () => {};
    const server = http.createServer((_req, res) => {
      release = () => {
        res.end('done');
      };
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;

    const body = new Promise<string>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });

    // wait until the request has reached the handler
    while (!release.toString || release.toString() === '() => {}') {
      await new Promise((r) => setTimeout(r, 5));
    }

    let closed = false;
    const shutdown = gracefulClose(server, 2000).then(() => {
      closed = true;
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(false);

    release();
    expect(await body).toBe('done');
    await shutdown;
    expect(closed).toBe(true);
  });

  it('resolves after the timeout when a request never completes', async () => {
    const server = http.createServer(() => {
      // never respond
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;

    http.get({ host: '127.0.0.1', port }).on('error', () => {});
    await new Promise((r) => setTimeout(r, 20));

    const start = Date.now();
    await gracefulClose(server, 100);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(2000);
  });
});
