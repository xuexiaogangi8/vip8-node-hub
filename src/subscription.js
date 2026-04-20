export function buildSubscription(nodes) {
  const raw = nodes.map((n) => n.raw).join('\n');
  const base64 = Buffer.from(raw, 'utf8').toString('base64');
  return { raw, base64 };
}
