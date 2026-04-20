const token = process.env.TG_BOT_TOKEN;
const secret = process.env.TG_WEBHOOK_SECRET || '';
const baseUrl = process.env.PUBLIC_BASE_URL || 'https://sub.vip8.tech';

if (!token) {
  console.error('Missing TG_BOT_TOKEN');
  process.exit(1);
}

const url = `https://api.telegram.org/bot${token}/setWebhook`;
const body = {
  url: `${baseUrl}/telegram/webhook`,
};
if (secret) body.secret_token = secret;

const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const json = await res.json();
console.log(JSON.stringify(json, null, 2));
