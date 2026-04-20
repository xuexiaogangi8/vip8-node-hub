import net from 'net';
import dgram from 'dgram';

export function tcpPing(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ host, port });
    let finished = false;

    const done = (result) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve({ probe: 'tcp', ...result });
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done({ ok: true, latency: Date.now() - started }));
    socket.on('timeout', () => done({ ok: false, error: 'timeout' }));
    socket.on('error', (err) => done({ ok: false, error: err.message }));
  });
}

export function udpProbe(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = dgram.createSocket('udp4');
    let finished = false;

    const done = (result) => {
      if (finished) return;
      finished = true;
      try { socket.close(); } catch {}
      resolve({ probe: 'udp', ...result });
    };

    const timer = setTimeout(() => done({ ok: true, latency: Date.now() - started, warning: 'no-response-assumed-open' }), timeoutMs);

    socket.once('error', (err) => {
      clearTimeout(timer);
      done({ ok: false, error: err.message });
    });

    socket.once('message', () => {
      clearTimeout(timer);
      done({ ok: true, latency: Date.now() - started });
    });

    socket.connect(port, host, (err) => {
      if (err) {
        clearTimeout(timer);
        return done({ ok: false, error: err.message });
      }
      socket.send(Buffer.alloc(16), (sendErr) => {
        if (sendErr) {
          clearTimeout(timer);
          return done({ ok: false, error: sendErr.message });
        }
      });
    });
  });
}

export function probeNode(node, timeoutMs = 3000) {
  if (!node?.host || !node?.port) return Promise.resolve({ ok: false, error: 'host or port missing' });
  const protocol = String(node.protocol || '').toLowerCase();
  if (protocol === 'hy2' || protocol === 'hysteria2') {
    return udpProbe(node.host, node.port, timeoutMs);
  }
  return tcpPing(node.host, node.port, timeoutMs);
}
