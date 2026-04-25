import nodemailer from 'nodemailer';

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'true') !== 'false';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const SITE_NAME = String(process.env.SITE_NAME || '').trim() || (() => {
  try { return PUBLIC_BASE_URL ? (new URL(PUBLIC_BASE_URL).host || '会员站') : '会员站'; } catch { return '会员站'; }
})();
const MAIL_FROM_RAW = process.env.MAIL_FROM || SMTP_USER || '';
const MAIL_FROM = (() => {
  const value = String(MAIL_FROM_RAW || '').trim();
  if (!value) return '';
  if (value.includes('<')) return value;
  if (value.includes('@')) return `${SITE_NAME} <${value}>`;
  return value;
})();

let transporter = null;

function getTransporter() {
  if (!SMTP_USER || !SMTP_PASS) throw new Error('SMTP 未配置');
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return transporter;
}

export async function sendVerificationEmail({ to, code }) {
  const tx = getTransporter();
  await tx.sendMail({
    from: MAIL_FROM,
    to,
    subject: `${SITE_NAME} 邮箱验证码`,
    text: `你的验证码是：${code}\n\n5 分钟内有效。若不是你本人操作，请忽略这封邮件。`,
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#25324a"><h2>${SITE_NAME} 邮箱验证码</h2><p>你的验证码是：</p><div style="font-size:32px;font-weight:700;letter-spacing:6px">${code}</div><p>5 分钟内有效。若不是你本人操作，请忽略这封邮件。</p></div>`,
  });
}

export async function verifyMailConfig() {
  const tx = getTransporter();
  await tx.verify();
}
