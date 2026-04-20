import db from './db.js';
import { parseNode } from './parser.js';

const NODE_REGEX = /(ss:\/\/[^\s]+|ssr:\/\/[^\s]+|vmess:\/\/[^\s]+|vless:\/\/[^\s]+|trojan:\/\/[^\s]+|hy2:\/\/[^\s]+|hysteria2:\/\/[^\s]+)/gi;
const URL_REGEX = /https?:\/\/[^\s]+/gi;

function extractNodes(text = '') {
  return [...String(text || '').matchAll(NODE_REGEX)].map((m) => m[0]);
}

function extractUrls(text = '') {
  return [...String(text || '').matchAll(URL_REGEX)].map((m) => m[0].replace(/[),.;!?]+$/g, ''));
}

function decodeSubscriptionText(input = '') {
  const text = String(input || '').trim();
  if (!text) return '';
  if (/(ss|ssr|vmess|vless|trojan|hy2|hysteria2):\/\//i.test(text)) return text;
  const compact = text.replace(/\s+/g, '');
  if (!compact || /[^A-Za-z0-9+/=_-]/.test(compact)) return text;
  try {
    return Buffer.from(compact, 'base64').toString('utf8');
  } catch {
    return text;
  }
}

function extractYamlNodes(text = '') {
  const raw = String(text || '');
  const out = [...extractNodes(raw)];

  const buildFromFields = (fields) => {
    const get = (key) => String(fields[key] || '').trim();
    const type = get('type').toLowerCase();
    const host = get('server');
    const port = get('port');
    const name = get('name') || `${type}-${host}:${port}`;
    if (!type || !host || !port) return null;

    if (type === 'trojan') {
      const password = get('password');
      return password ? `trojan://${password}@${host}:${port}#${encodeURIComponent(name)}` : null;
    }
    if (type === 'vless') {
      const uuid = get('uuid');
      return uuid ? `vless://${uuid}@${host}:${port}#${encodeURIComponent(name)}` : null;
    }
    if (type === 'ss') {
      const cipher = get('cipher');
      const password = get('password');
      if (!cipher || !password) return null;
      const userinfo = Buffer.from(`${cipher}:${password}`).toString('base64');
      return `ss://${userinfo}@${host}:${port}#${encodeURIComponent(name)}`;
    }
    if (type === 'vmess') {
      const payload = {
        v: '2',
        ps: name,
        add: host,
        port: String(port),
        id: get('uuid') || get('id'),
        aid: String(get('alterId') || get('alter-id') || 0),
        scy: get('cipher') || 'auto',
        net: get('network') || 'tcp',
        type: 'none',
        host: get('servername') || '',
        path: get('ws-path') || '',
        tls: ['true', '1'].includes(get('tls').toLowerCase()) ? 'tls' : '',
        sni: get('servername') || '',
      };
      return payload.id ? `vmess://${Buffer.from(JSON.stringify(payload)).toString('base64')}` : null;
    }
    if (type === 'ssr') {
      const cipher = get('cipher');
      const password = get('password');
      const protocol = get('protocol') || 'origin';
      const obfs = get('obfs') || 'plain';
      if (!cipher || !password) return null;
      const passwordB64 = Buffer.from(password).toString('base64').replace(/=+$/g, '');
      const base = `${host}:${port}:${protocol}:${cipher}:${obfs}:${passwordB64}`;
      return `ssr://${Buffer.from(base).toString('base64')}`;
    }
    if (type === 'hy2' || type === 'hysteria2') {
      return `${type}://${get('password') || ''}@${host}:${port}#${encodeURIComponent(name)}`;
    }
    return null;
  };

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^(?:url|subscribe|subscription|link)\s*:\s*["']?([^"'\s]+)["']?/i);
    if (m?.[1] && /^(ss|ssr|vmess|vless|trojan|hy2|hysteria2):\/\//i.test(m[1])) out.push(m[1]);
  }

  const inlineObjects = raw.match(/\{[^\n{}]*type\s*:\s*(?:ss|ssr|vmess|vless|trojan|hy2|hysteria2)[^\n{}]*\}/gi) || [];
  for (const item of inlineObjects) {
    const fields = {};
    for (const m of item.matchAll(/([A-Za-z0-9_.-]+)\s*:\s*("[^"]*"|'[^']*'|[^,}]+)/g)) {
      fields[m[1]] = String(m[2]).trim().replace(/^['"]|['"]$/g, '');
    }
    const built = buildFromFields(fields);
    if (built) out.push(built);
  }

  const lines = raw.split(/\r?\n/);
  let current = null;
  let inProxies = false;
  for (const line of lines) {
    if (/^\s*proxies\s*:/i.test(line)) {
      inProxies = true;
      continue;
    }
    if (inProxies && /^\S/.test(line) && !/^\s*proxies\s*:/i.test(line)) {
      if (current) {
        const built = buildFromFields(current);
        if (built) out.push(built);
        current = null;
      }
      inProxies = false;
    }
    const dashOnly = line.match(/^\s*-[\s]*$/);
    if (inProxies && dashOnly) {
      if (current) {
        const built = buildFromFields(current);
        if (built) out.push(built);
      }
      current = {};
      continue;
    }
    const typeStart = line.match(/^\s*-\s*type\s*:\s*([A-Za-z0-9_-]+)/i);
    if (typeStart) {
      if (current) {
        const built = buildFromFields(current);
        if (built) out.push(built);
      }
      current = { type: typeStart[1] };
      inProxies = true;
      continue;
    }
    const nameStart = line.match(/^\s*-\s*name\s*:\s*(.+)$/i);
    if (nameStart) {
      if (current) {
        const built = buildFromFields(current);
        if (built) out.push(built);
      }
      current = { name: nameStart[1].trim().replace(/^['"]|['"]$/g, '') };
      inProxies = true;
      continue;
    }
    if (!current) continue;
    const field = line.match(/^\s+([A-Za-z0-9_.-]+)\s*:\s*(.+)$/);
    if (field) {
      current[field[1]] = field[2].trim().replace(/^['"]|['"]$/g, '');
      continue;
    }
    if (/^\S/.test(line)) {
      const built = buildFromFields(current);
      if (built) out.push(built);
      current = null;
    }
  }
  if (current) {
    const built = buildFromFields(current);
    if (built) out.push(built);
  }

  return [...new Set(out)];
}

function parseTextToNodes(body = '', hint = '') {
  const text = decodeSubscriptionText(body);
  const looksYaml = /(^|\n)\s*proxies\s*:/i.test(text)
    || /(^|\n)\s*proxy-providers\s*:/i.test(text)
    || text.includes('#!MANAGED-CONFIG')
    || /\.(yaml|yml|txt|conf|cfg)$/i.test(String(hint || ''));
  const nodes = looksYaml ? extractYamlNodes(text) : extractNodes(text);
  return { nodes, format: looksYaml ? 'yaml' : 'subscription' };
}

async function fetchSubscriptionNodes(url) {
  const timeoutMs = Number(process.env.SUB_FETCH_TIMEOUT_MS || 15000);
  const attempts = [
    {
      label: 'default',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'text/plain,text/html,application/json,application/yaml,text/yaml,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    },
    {
      label: 'browserish',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Referer': 'https://www.google.com/',
      },
    },
  ];

  let lastError = null;

  for (const attempt of attempts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: attempt.headers,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        lastError = `fetch-${res.status}`;
        continue;
      }
      const body = await res.text();
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      const looksYaml = /yaml|yml|text\/plain|octet-stream/.test(contentType)
        || /\.(yaml|yml)(\?|$)/i.test(url)
        || /(^|\n)\s*proxies\s*:/i.test(body)
        || /(^|\n)\s*proxy-providers\s*:/i.test(body)
        || body.includes('#!MANAGED-CONFIG');
      const decoded = decodeSubscriptionText(body);
      const nodes = looksYaml ? extractYamlNodes(decoded) : extractNodes(decoded);
      return {
        url,
        nodes,
        error: nodes.length ? null : 'no-supported-nodes-found',
        format: looksYaml ? 'yaml' : 'subscription',
        fetch_mode: attempt.label,
      };
    } catch (error) {
      clearTimeout(timer);
      const msg = String(error?.cause?.message || error?.message || error || 'unknown').toLowerCase();
      if (msg.includes('timeout') || error?.name === 'AbortError') lastError = 'fetch-timeout';
      else if (msg.includes('certificate') || msg.includes('tls') || msg.includes('ssl')) lastError = `fetch-tls:${error.message}`;
      else if (msg.includes('enotfound') || msg.includes('dns')) lastError = `fetch-dns:${error.message}`;
      else if (msg.includes('econnrefused') || msg.includes('ehostunreach') || msg.includes('socket') || msg.includes('connect')) lastError = `fetch-connect:${error.message}`;
      else lastError = `fetch-failed:${error.message}`;
    }
  }

  return { url, nodes: [], error: lastError || 'fetch-failed:unknown' };
}

async function fetchTelegramFileText(fileId, fileName = '') {
  const token = process.env.TG_BOT_TOKEN || '';
  if (!token || !fileId) return { text: '', error: 'telegram-file-missing-token-or-id' };
  try {
    const metaRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
    const meta = await metaRes.json();
    if (!metaRes.ok || !meta?.ok || !meta?.result?.file_path) {
      return { text: '', error: `telegram-file-meta-failed:${meta?.description || metaRes.status}` };
    }
    const filePath = meta.result.file_path;
    const fileRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    if (!fileRes.ok) return { text: '', error: `telegram-file-download-failed:${fileRes.status}` };
    const text = await fileRes.text();
    return { text, error: null, filePath, fileName };
  } catch (error) {
    return { text: '', error: `telegram-file-fetch-failed:${error.message}` };
  }
}

function getTelegramDocument(msg) {
  return msg?.document || msg?.reply_to_message?.document || null;
}

export async function ingestTelegramUpdate(update) {
  const msg = update?.message || update?.channel_post || update?.edited_message;
  if (!msg) return { ok: true, added: 0, skipped: 0, reason: 'no-message' };

  const text = [msg.text, msg.caption].filter(Boolean).join('\n');
  const directNodes = extractNodes(text);
  const candidateUrls = extractUrls(text).filter((url) => !directNodes.includes(url));
  const fetchedSubs = [];
  const found = [...directNodes];

  for (const url of candidateUrls) {
    const result = await fetchSubscriptionNodes(url);
    if (result.nodes.length) found.push(...result.nodes);
    fetchedSubs.push({ url: result.url, count: result.nodes.length, error: result.error, format: result.format || null });
  }

  const doc = getTelegramDocument(msg);
  let documentInfo = null;
  if (doc?.file_id) {
    const downloaded = await fetchTelegramFileText(doc.file_id, doc.file_name || 'telegram-document');
    const parsed = downloaded.text ? parseTextToNodes(downloaded.text, doc.file_name || '') : { nodes: [], format: null };
    if (parsed.nodes.length) found.push(...parsed.nodes);
    documentInfo = {
      file_name: doc.file_name || null,
      mime_type: doc.mime_type || null,
      file_size: doc.file_size || null,
      count: parsed.nodes.length,
      format: parsed.format,
      error: downloaded.error || null,
    };
  }

  let added = 0;
  let skipped = 0;
  const errors = [];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO nodes (source_type, source_ref, name, protocol, raw, dedupe_key, host, port)
    VALUES (@source_type, @source_ref, @name, @protocol, @raw, @dedupe_key, @host, @port)
  `);

  for (const raw of [...new Set(found)]) {
    try {
      const parsed = parseNode(raw);
      const result = insert.run({
        source_type: 'telegram',
        source_ref: String(msg.chat?.id || 'unknown'),
        ...parsed,
      });
      if (result.changes > 0) added += 1;
      else skipped += 1;
    } catch (error) {
      skipped += 1;
      errors.push(String(error.message || '').includes('nodes.dedupe_key') ? 'duplicate-node' : error.message);
    }
  }

  return {
    ok: true,
    added,
    skipped,
    total: [...new Set(found)].length,
    direct_total: directNodes.length,
    fetched_subscriptions: fetchedSubs,
    telegram_document: documentInfo,
    chat: msg.chat ? { id: msg.chat.id, title: msg.chat.title || msg.chat.username || msg.chat.type } : null,
    message_id: msg.message_id,
    errors,
  };
}

export function isTelegramAllowed(update) {
  const allow = (process.env.TG_ALLOW_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allow.length) return true;
  const msg = update?.message || update?.channel_post || update?.edited_message;
  const chatId = String(msg?.chat?.id || '');
  return allow.includes(chatId);
}
