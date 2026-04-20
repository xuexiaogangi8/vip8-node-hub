export function parseNode(raw) {
  const value = raw.trim();
  if (!value) throw new Error('Empty node');

  const protocol = value.split('://')[0]?.toLowerCase();
  if (!['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hy2', 'hysteria2'].includes(protocol)) {
    throw new Error(`Unsupported protocol: ${protocol || 'unknown'}`);
  }

  let host = null;
  let port = null;
  let name = null;

  try {
    if (protocol === 'trojan' || protocol === 'vless' || protocol === 'hy2' || protocol === 'hysteria2') {
      const url = new URL(value);
      host = url.hostname;
      port = Number(url.port || (protocol === 'hy2' || protocol === 'hysteria2' ? 443 : 443));
      name = decodeURIComponent((url.hash || '').replace(/^#/, '')) || url.hostname;
    } else if (protocol === 'ss') {
      const [, rest = ''] = value.split('://');
      const fragParts = rest.split('#');
      name = fragParts[1] ? decodeURIComponent(fragParts[1]) : 'ss-node';
      const main = fragParts[0].split('?')[0];
      const atIndex = main.lastIndexOf('@');
      const serverPart = atIndex >= 0 ? main.slice(atIndex + 1) : main;
      const [h, p] = serverPart.split(':');
      host = h || null;
      port = Number(p || 0) || null;
    } else if (protocol === 'vmess') {
      const encoded = value.slice('vmess://'.length);
      const json = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      host = json.add || json.host || null;
      port = Number(json.port || 0) || null;
      name = json.ps || 'vmess-node';
    } else if (protocol === 'ssr') {
      const encoded = value.slice('ssr://'.length);
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const main = decoded.split('/?')[0];
      const parts = main.split(':');
      host = parts[0] || null;
      port = Number(parts[1] || 0) || null;
      name = host ? `ssr-${host}:${port}` : 'ssr-node';
    }
  } catch (error) {
    throw new Error(`Parse failed: ${error.message}`);
  }

  if (!host || !port) throw new Error('Host or port missing');

  const dedupe_key = `${protocol}:${String(host).toLowerCase()}:${port}`;
  return { protocol, host, port, name: name || `${protocol}-${host}:${port}`, raw: value, dedupe_key };
}
