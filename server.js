/* ================================================================================
|                                   Feito 100% por Nicolas Arantes                                   |
================================================================================ */

import express from 'express';
import cors from 'cors';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import db from './db.js';
import crypto from 'crypto';
import { Resend } from 'resend';
import nodemailer from 'nodemailer';

// --- CONFIGURAÇÃO INICIAL ---
dotenv.config();
const app = express();
const port = process.env.PORT || 4000;
app.use(cors());

// JSON com rawBody (útil para validações futuras)
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ------------------------
// LOGGING (somente logs)
// ------------------------
const safeJson = (obj) => {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return '[unserializable]';
  }
};

const log = (level, scope, message, meta) => {
  const prefix = `[${scope}]`;
  const line = meta !== undefined ? `${prefix} ${message} ${safeJson(meta)}` : `${prefix} ${message}`;

  if (level === 'error') return console.error(line);
  if (level === 'warn') return console.warn(line);
  return console.log(line);
};

// --- VARIÁVEIS DE AMBIENTE ---
const {
  MP_ACCESS_TOKEN,
  MELHOR_ENVIO_TOKEN,
  SENDER_CEP,
  BACKEND_URL,
  FRONTEND_URL,

  // Email (Resend)
  RESEND_API_KEY,
  EMAIL_FROM, // compat (se existir)
  EMAIL_FROM_PRIMARY,
  EMAIL_FROM_FALLBACK,
  EMAIL_TO,

  // Email (Gmail SMTP - opcional local)
  GMAIL_USER,
  GMAIL_APP_PASSWORD,
  MAIL_FROM_NAME,
  MAIL_REPLY_TO,

  // Opcional: força usar gmail/resend/auto
  MAIL_PROVIDER, // "gmail" | "resend" | "auto"

  // Segurança (cron)
  CRON_SECRET,

  // Dados remetente Melhor Envio
  SENDER_NAME,
  SENDER_PHONE,
  SENDER_EMAIL,
  SENDER_DOCUMENT,
  SENDER_STREET,
  SENDER_NUMBER,
  SENDER_COMPLEMENT,
  SENDER_DISTRICT,
  SENDER_CITY,
  SENDER_STATE_ABBR,

  // Webhook MP
  MP_WEBHOOK_SECRET,
} = process.env;

// Validação das variáveis essenciais
if (!MP_ACCESS_TOKEN || !MELHOR_ENVIO_TOKEN || !BACKEND_URL || !FRONTEND_URL || !db) {
  log('error', 'BOOT/FATAL', 'Variáveis essenciais ausentes. Verifique Railway Variables.');
  process.exit(1);
}

if (!MP_WEBHOOK_SECRET) {
  log('warn', 'BOOT/WARN', 'MP_WEBHOOK_SECRET não encontrada. Validação do webhook Mercado Pago DESATIVADA.');
}
if (!CRON_SECRET) {
  log('warn', 'BOOT/WARN', 'CRON_SECRET não definido. A rota /checar-pedidos-expirados ficará pública.');
}
if (!RESEND_API_KEY) {
  log('warn', 'MAIL/BOOT/WARN', 'RESEND_API_KEY ausente. Resend desativado.');
}
if (!EMAIL_FROM_PRIMARY && !EMAIL_FROM_FALLBACK && !EMAIL_FROM) {
  log(
    'warn',
    'MAIL/BOOT/WARN',
    'EMAIL_FROM_PRIMARY/EMAIL_FROM_FALLBACK (ou EMAIL_FROM compat) ausentes. Ex: "Carlton <onboarding@resend.dev>".'
  );
}
if (!EMAIL_TO) {
  log('warn', 'MAIL/BOOT/WARN', 'EMAIL_TO ausente. Recomendo um email admin pra cópia/teste.');
}
if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
  log('warn', 'MAIL/BOOT/WARN', 'GMAIL_USER/GMAIL_APP_PASSWORD ausentes. Gmail SMTP desativado (ok no Railway).');
}

// --- CONFIGURAÇÃO DOS SERVIÇOS ---
const client = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// Gmail SMTP (opcional)
const gmailTransporter =
  GMAIL_USER && GMAIL_APP_PASSWORD
    ? nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
      })
    : null;

// ✅ EVITA timeout no Railway: só verifica SMTP se provider for gmail
const effectiveProvider = String(MAIL_PROVIDER || 'resend').toLowerCase();
if (gmailTransporter && effectiveProvider === 'gmail') {
  gmailTransporter
    .verify()
    .then(() => log('info', 'MAIL/GMAIL/OK', 'Gmail SMTP pronto'))
    .catch((err) =>
      log('warn', 'MAIL/GMAIL/WARN', 'Gmail SMTP não validou no boot (pode funcionar mesmo assim)', { message: err?.message })
    );
}

// ------------------------
// HELPERS
// ------------------------
const parseXSignature = (raw) => {
  if (!raw || typeof raw !== 'string') return { ts: null, v1: null };
  const parts = raw.split(',');
  const out = { ts: null, v1: null };
  for (const p of parts) {
    const [k, v] = p.split('=');
    if (!k || !v) continue;
    const key = k.trim();
    const val = v.trim();
    if (key === 'ts') out.ts = val;
    if (key === 'v1') out.v1 = val;
  }
  return out;
};

const getHeader = (req, name) => {
  const v = req.headers?.[name.toLowerCase()];
  return v === undefined ? null : String(v);
};

// ✅ Validação webhook MP (manifest: id + request-id + ts)
const validateMpWebhook = (req) => {
  if (!MP_WEBHOOK_SECRET) return { ok: true, reason: 'disabled' };

  const signature = getHeader(req, 'x-signature');
  const requestId = getHeader(req, 'x-request-id');

  if (!signature) return { ok: false, reason: 'missing_signature' };
  if (!requestId) return { ok: false, reason: 'missing_request_id' };

  const { ts, v1 } = parseXSignature(signature);
  if (!ts || !v1) return { ok: false, reason: 'bad_signature_format' };

  const id = req.query?.id || req.query?.['data.id'];
  if (!id) return { ok: false, reason: 'missing_id' };

  const manifest = `id:${String(id).trim()};request-id:${String(requestId).trim()};ts:${String(ts).trim()};`;
  const expectedHex = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex');

  try {
    const expected = Buffer.from(expectedHex, 'hex');
    const received = Buffer.from(String(v1).trim(), 'hex');
    if (expected.length !== received.length) return { ok: false, reason: 'invalid_signature' };
    const ok = crypto.timingSafeEqual(expected, received);
    return { ok, reason: ok ? 'ok' : 'invalid_signature' };
  } catch {
    return { ok: false, reason: 'invalid_signature' };
  }
};

// ------------------------
// HTTP HELPERS (robusto p/ JSON)
// ------------------------
async function fetchJsonSafe(url, options = {}, { timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    const contentType = String(resp.headers.get('content-type') || '');
    const bodyText = await resp.text();

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} (${contentType}) :: ${bodyText.slice(0, 160)}`);
    }

    const trimmed = bodyText.trim();
    const looksLikeJson =
      contentType.includes('application/json') || trimmed.startsWith('{') || trimmed.startsWith('[');

    if (!looksLikeJson) {
      throw new Error(`Resposta não-JSON (${contentType}) :: ${trimmed.slice(0, 160)}`);
    }

    return JSON.parse(bodyText);
  } catch (err) {
    if (String(err?.name) === 'AbortError') throw new Error(`Timeout após ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(t);
  }
}

// ------------------------
// EMAIL TEMPLATES (EDITÁVEL)
// ------------------------
const escapeHtml = (str = '') =>
  String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const moneyBRL = (value) => {
  const n = Number(value || 0);
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
};

const EMAIL_COPY = {
  brand: 'CARLTON',
  footerNote: 'Enviado automaticamente — não compartilhe dados sensíveis por e-mail.',
  supportLine: 'Se você não reconhece este pedido, responda este e-mail ou contate nosso suporte.',

  confirm: {
    subject: (pedidoId) => `✅ Confirmação do Pedido #${pedidoId} — CARLTON`,
    title: (pedidoId) => `Pedido confirmado #${pedidoId}`,
    intro: (nome) => `Olá, ${nome}. Seu pagamento foi aprovado ✅`,
    payLabel: 'ID do Pagamento (Mercado Pago)',
    itemsTitle: 'Itens do pedido',
    addressTitle: 'Endereço de entrega',
    totalsTitle: 'Valores',
    ctaLabel: 'Acompanhar pedido',
    ctaUrl: () => `${FRONTEND_URL}/pedidos`,
  },

  tracking: {
    subject: (pedidoId) => `📦 Rastreio do Pedido #${pedidoId} — CARLTON`,
    title: (pedidoId) => `Seu pedido foi enviado #${pedidoId}`,
    intro: (nome, pedidoId) => `Olá, ${nome}! Seu pedido #${pedidoId} foi postado 📦`,
    trackingLabel: 'Código de rastreio',
    hint: 'Acompanhe pelo site dos Correios ou Melhor Envio.',
    ctaLabel: 'Acompanhar pedido',
    ctaUrl: () => `${FRONTEND_URL}/pedidos`,
  },

  expiry: {
    subject: (pedidoId) => `⚠️ Pedido #${pedidoId} — pagamento não confirmado`,
    title: (pedidoId) => `Pagamento não confirmado — Pedido #${pedidoId}`,
    intro: (nome, pedidoId) => `Olá, ${nome}. Não identificamos a confirmação do pagamento do pedido #${pedidoId}.`,
    message:
      'O link do PIX expirou para evitar pagamentos duplicados. Se você ainda deseja adquirir os produtos, por favor realize um novo pedido em nosso site.',
    ctaLabel: 'Voltar para a loja',
    ctaUrl: () => `${FRONTEND_URL}`,
  },
};

function emailLayout({ title, preheader, contentHtml }) {
  const safeTitle = escapeHtml(title || EMAIL_COPY.brand);
  const safePreheader = escapeHtml(preheader || '');

  return `
  <!doctype html>
  <html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
  </head>
  <body style="margin:0;padding:0;background:#f6f6f6;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      ${safePreheader}
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f6;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:92vw;background:#ffffff;border-radius:14px;overflow:hidden;">
            <tr>
              <td style="padding:20px 22px;background:#111;color:#fff;font-family:Arial,sans-serif;">
                <div style="font-size:14px;letter-spacing:.08em;">${escapeHtml(EMAIL_COPY.brand)}</div>
                <div style="font-size:20px;font-weight:700;margin-top:6px;">${safeTitle}</div>
              </td>
            </tr>

            <tr>
              <td style="padding:22px;font-family:Arial,sans-serif;color:#111;font-size:14px;line-height:1.5;">
                ${contentHtml}
              </td>
            </tr>

            <tr>
              <td style="padding:18px 22px;background:#fafafa;font-family:Arial,sans-serif;color:#555;font-size:12px;line-height:1.5;">
                <div>${escapeHtml(EMAIL_COPY.supportLine)}</div>
                <div style="margin-top:10px;">© ${new Date().getFullYear()} ${escapeHtml(EMAIL_COPY.brand)}</div>
              </td>
            </tr>
          </table>

          <div style="font-family:Arial,sans-serif;color:#888;font-size:12px;margin-top:12px;">
            ${escapeHtml(EMAIL_COPY.footerNote)}
          </div>
        </td>
      </tr>
    </table>
  </body>
  </html>`;
}

function renderOrderItems(itens = []) {
  if (!Array.isArray(itens) || itens.length === 0) return '<p><em>Sem itens.</em></p>';

  const rows = itens
    .map((item) => {
      const qtd = Number(item.quantity || 0);
      const title = escapeHtml(item.title || item.id || 'Item');
      const unit = moneyBRL(item.unit_price);
      const line = moneyBRL(Number(item.unit_price || 0) * qtd);

      return `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eee;">
            <div style="font-weight:600;">${title}</div>
            <div style="color:#666;">${qtd}× ${unit}</div>
          </td>
          <td align="right" style="padding:10px 0;border-bottom:1px solid #eee;font-weight:600;">
            ${line}
          </td>
        </tr>
      `;
    })
    .join('');

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      ${rows}
    </table>
  `;
}

function renderBlock(title, bodyHtml) {
  return `
    <div style="margin-top:14px;padding:14px;border:1px solid #eee;border-radius:12px;background:#fff;">
      <div style="font-weight:700;margin-bottom:6px;">${escapeHtml(title)}</div>
      <div style="color:#333;">${bodyHtml}</div>
    </div>
  `;
}

function renderTotals({ freteName, fretePrice, total }) {
  const name = freteName ? ` (${escapeHtml(freteName)})` : '';
  return `
    <div style="margin-top:14px;padding:14px;border:1px solid #eee;border-radius:12px;background:#fff;">
      <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
        <span style="color:#666;">Frete${name}</span>
        <strong>${moneyBRL(fretePrice)}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:16px;">
        <span>Total</span>
        <strong>${moneyBRL(total)}</strong>
      </div>
    </div>
  `;
}

function renderButton({ label, url }) {
  if (!url) return '';
  return `
    <div style="margin-top:16px;">
      <a href="${escapeHtml(url)}"
        style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 16px;border-radius:10px;font-weight:700;">
        ${escapeHtml(label || 'Ver')}
      </a>
    </div>
  `;
}

function buildEmail(type, pedido, extra = {}) {
  const nome = pedido?.nome_cliente || 'cliente';
  const pedidoId = pedido?.id;

  if (type === 'confirm') {
    const itens = typeof pedido.itens_pedido === 'string' ? JSON.parse(pedido.itens_pedido) : pedido.itens_pedido || [];
    const frete = typeof pedido.info_frete === 'string' ? JSON.parse(pedido.info_frete) : pedido.info_frete || {};

    const title = EMAIL_COPY.confirm.title(pedidoId);
    const preheader = `Pagamento aprovado — pedido #${pedidoId}.`;

    const contentHtml = `
      <p>${escapeHtml(EMAIL_COPY.confirm.intro(nome))}</p>
      ${renderBlock(
        'Resumo',
        `
          <div><strong>Pedido:</strong> #${escapeHtml(pedidoId)}</div>
          <div><strong>${escapeHtml(EMAIL_COPY.confirm.payLabel)}:</strong> ${escapeHtml(pedido.mercado_pago_id || '')}</div>
        `
      )}
      ${renderBlock(EMAIL_COPY.confirm.addressTitle, escapeHtml(pedido.endereco_entrega || ''))}
      <div style="margin-top:16px;font-weight:700;">${escapeHtml(EMAIL_COPY.confirm.itemsTitle)}</div>
      ${renderOrderItems(itens)}
      ${renderTotals({ freteName: frete.name, fretePrice: frete.price, total: pedido.valor_total })}
      ${renderButton({ label: EMAIL_COPY.confirm.ctaLabel, url: EMAIL_COPY.confirm.ctaUrl() })}
    `;

    return {
      subject: EMAIL_COPY.confirm.subject(pedidoId),
      html: emailLayout({ title, preheader, contentHtml }),
    };
  }

  if (type === 'tracking') {
    const trackingCode = extra.trackingCode || '';
    const title = EMAIL_COPY.tracking.title(pedidoId);
    const preheader = trackingCode ? `Rastreio: ${trackingCode}` : `Pedido #${pedidoId} enviado`;

    const contentHtml = `
      <p>${escapeHtml(EMAIL_COPY.tracking.intro(nome, pedidoId))}</p>
      ${renderBlock(
        EMAIL_COPY.tracking.trackingLabel,
        `
          <div style="font-size:16px;"><strong>${escapeHtml(trackingCode)}</strong></div>
          <div style="color:#666;margin-top:6px;">${escapeHtml(EMAIL_COPY.tracking.hint)}</div>
        `
      )}
      ${renderButton({ label: EMAIL_COPY.tracking.ctaLabel, url: EMAIL_COPY.tracking.ctaUrl() })}
    `;

    return {
      subject: EMAIL_COPY.tracking.subject(pedidoId),
      html: emailLayout({ title, preheader, contentHtml }),
    };
  }

  if (type === 'expiry') {
    const title = EMAIL_COPY.expiry.title(pedidoId);
    const preheader = `PIX expirou — pedido #${pedidoId}.`;

    const contentHtml = `
      <p>${escapeHtml(EMAIL_COPY.expiry.intro(nome, pedidoId))}</p>
      ${renderBlock('Aviso', `<div>${escapeHtml(EMAIL_COPY.expiry.message)}</div>`)}
      ${renderButton({ label: EMAIL_COPY.expiry.ctaLabel, url: EMAIL_COPY.expiry.ctaUrl() })}
    `;

    return {
      subject: EMAIL_COPY.expiry.subject(pedidoId),
      html: emailLayout({ title, preheader, contentHtml }),
    };
  }

  return {
    subject: `Mensagem — ${EMAIL_COPY.brand}`,
    html: emailLayout({ title: `Mensagem`, preheader: '', contentHtml: `<p>Olá!</p>` }),
  };
}

// ------------------------
// EMAIL SENDER (Resend + Gmail opcional)
// ------------------------
const normalizeList = (v) => (Array.isArray(v) ? v : v ? [v] : []);

const getFromDomain = (fromStr = '') => {
  const m = fromStr.match(/<([^>]+)>/);
  const email = (m ? m[1] : fromStr).trim();
  return email.split('@')[1] || null;
};

const isDomainNotVerified403 = (error) => {
  const status = Number(error?.statusCode || error?.status || 0);
  const msg = String(error?.message || '').toLowerCase();
  return status === 403 && (msg.includes('domain is not verified') || msg.includes('not verified'));
};

async function sendEmailViaResend({ to, subject, html, bcc }) {
  if (!resend) return { ok: false, reason: 'missing_resend_key' };

  const primaryFrom = EMAIL_FROM_PRIMARY || '';
  const fallbackFrom = EMAIL_FROM_FALLBACK || 'Carlton <onboarding@resend.dev>';
  const compatFrom = EMAIL_FROM || '';

  const toList = normalizeList(to);
  const bccList = normalizeList(bcc);

  const basePayload = { to: toList, subject, html };
  if (bccList.length) basePayload.bcc = bccList;

  const trySend = async (from) => {
    const payload = { ...basePayload, from };
    if (MAIL_REPLY_TO) payload.reply_to = MAIL_REPLY_TO;

    log('info', 'MAIL/RESEND/TRY', 'Tentando Resend', { from, domain: getFromDomain(from) });

    const { data, error } = await resend.emails.send(payload);
    if (error) return { ok: false, error };
    return { ok: true, id: data?.id };
  };

  try {
    if (primaryFrom) {
      const r1 = await trySend(primaryFrom);
      if (r1.ok) {
        log('info', 'MAIL/RESEND/OK', 'Email enviado via Resend (primary)', { id: r1.id, to: toList, subject });
        return { ok: true, id: r1.id, provider: 'resend', fromUsed: primaryFrom };
      }

      if (isDomainNotVerified403(r1.error)) {
        log('warn', 'MAIL/RESEND/FROM_FALLBACK', 'Domínio não verificado — usando fallback', { error: r1.error });

        const r2 = await trySend(fallbackFrom);
        if (!r2.ok) {
          log('error', 'MAIL/RESEND/ERROR', 'Erro ao enviar via Resend (fallback)', { error: r2.error });
          return { ok: false, reason: 'resend_error', error: r2.error };
        }

        log('info', 'MAIL/RESEND/OK', 'Email enviado via Resend (fallback)', { id: r2.id, to: toList, subject });
        return { ok: true, id: r2.id, provider: 'resend', fromUsed: fallbackFrom };
      }

      log('error', 'MAIL/RESEND/ERROR', 'Erro ao enviar via Resend (primary)', { error: r1.error });
      return { ok: false, reason: 'resend_error', error: r1.error };
    }

    if (compatFrom) {
      const r = await trySend(compatFrom);
      if (!r.ok) {
        log('error', 'MAIL/RESEND/ERROR', 'Erro ao enviar via Resend (EMAIL_FROM)', { error: r.error });
        return { ok: false, reason: 'resend_error', error: r.error };
      }
      log('info', 'MAIL/RESEND/OK', 'Email enviado via Resend (EMAIL_FROM)', { id: r.id, to: toList, subject });
      return { ok: true, id: r.id, provider: 'resend', fromUsed: compatFrom };
    }

    const rf = await trySend(fallbackFrom);
    if (!rf.ok) {
      log('error', 'MAIL/RESEND/ERROR', 'Erro ao enviar via Resend (fallback)', { error: rf.error });
      return { ok: false, reason: 'resend_error', error: rf.error };
    }

    log('info', 'MAIL/RESEND/OK', 'Email enviado via Resend (fallback)', { id: rf.id, to: toList, subject });
    return { ok: true, id: rf.id, provider: 'resend', fromUsed: fallbackFrom };
  } catch (err) {
    log('error', 'MAIL/RESEND/FATAL', 'Falha inesperada Resend', { message: err?.message, stack: err?.stack });
    return { ok: false, reason: 'exception', error: err?.message, provider: 'resend' };
  }
}

async function sendEmailViaGmail({ to, subject, html, bcc }) {
  if (!gmailTransporter) return { ok: false, reason: 'missing_gmail_config' };
  if (!GMAIL_USER) return { ok: false, reason: 'missing_gmail_user' };

  try {
    const fromName = MAIL_FROM_NAME || 'CARLTON';
    const fromEmail = GMAIL_USER;

    const toList = normalizeList(to);
    const bccList = normalizeList(bcc);

    const info = await gmailTransporter.sendMail({
      from: `${fromName} <${fromEmail}>`,
      to: toList.join(', '),
      bcc: bccList.length ? bccList.join(', ') : undefined,
      replyTo: MAIL_REPLY_TO || fromEmail,
      subject,
      html,
    });

    log('info', 'MAIL/GMAIL/OK', 'Email enviado via Gmail SMTP', {
      messageId: info?.messageId,
      to: toList,
      subject,
    });

    return { ok: true, id: info?.messageId, provider: 'gmail' };
  } catch (err) {
    log('error', 'MAIL/GMAIL/ERROR', 'Erro ao enviar via Gmail SMTP', { message: err?.message, stack: err?.stack });
    return { ok: false, reason: 'gmail_error', error: err?.message, provider: 'gmail' };
  }
}

async function sendEmail({ to, subject, html, bcc }) {
  const provider = String(MAIL_PROVIDER || 'resend').toLowerCase();

  if (provider === 'resend' || provider === 'auto' || !provider) {
    const r = await sendEmailViaResend({ to, subject, html, bcc });
    if (!r.ok) log('warn', 'MAIL/RESEND/SKIP', 'Resend falhou', r);
    return r;
  }

  if (provider === 'gmail') {
    const r = await sendEmailViaGmail({ to, subject, html, bcc });
    if (!r.ok) log('warn', 'MAIL/GMAIL/SKIP', 'Gmail falhou', r);
    return r;
  }

  return { ok: false, reason: 'unknown_provider', provider };
}

// ------------------- ROTAS DA APLICAÇÃO -------------------

app.get('/ping', (req, res) => {
  return res.status(200).json({ ok: true, now: new Date().toISOString() });
});

// ✅ Status público do pedido (para a tela /pendente fazer polling)
app.get('/pedido-status/:id', async (req, res) => {
  try {
    const pedidoId = String(req.params.id || '').trim();

    if (!pedidoId || !/^\d+$/.test(pedidoId)) {
      return res.status(400).json({ error: 'pedidoId inválido' });
    }

    const [rows] = await db.query(
      'SELECT id, status, mercado_pago_id, metodo_pagamento FROM pedidos WHERE id = ? LIMIT 1;',
      [pedidoId]
    );

    if (!rows.length) return res.status(404).json({ error: 'Pedido não encontrado' });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      pedidoId: rows[0].id,
      status: rows[0].status,
      mercadoPagoId: rows[0].mercado_pago_id || null,
      metodoPagamento: rows[0].metodo_pagamento || null,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno' });
  }
});

// ✅ Teste email simples
app.get('/test-email', async (req, res) => {
  const to = req.query.to ? String(req.query.to).trim() : EMAIL_TO;
  if (!to) return res.status(400).json({ error: 'Defina EMAIL_TO no Railway ou passe ?to=seuemail@...' });

  const html = emailLayout({
    title: 'Teste de Email',
    preheader: 'Se você recebeu isso, o envio do backend está OK.',
    contentHtml: `
      <p><strong>🔥 Email funcionando!</strong></p>
      <p>Se você recebeu isso, o envio do backend está OK (Resend).</p>
      <p><strong>Data:</strong> ${escapeHtml(new Date().toISOString())}</p>
    `,
  });

  const result = await sendEmail({
    to,
    bcc: EMAIL_TO && EMAIL_TO !== to ? EMAIL_TO : undefined,
    subject: '✅ Teste de Email — CARLTON',
    html,
  });

  if (!result.ok) return res.status(500).json({ ok: false, result });
  return res.status(200).json({ ok: true, provider: result.provider, id: result.id, to, fromUsed: result.fromUsed });
});

// ✅ Teste do template de rastreio (sem Melhor Envio)
app.get('/test-tracking-email', async (req, res) => {
  const to = req.query.to ? String(req.query.to).trim() : EMAIL_TO;
  const pedidoId = req.query.pedidoId ? String(req.query.pedidoId).trim() : null;
  const tracking = req.query.tracking ? String(req.query.tracking).trim() : 'BR123456789BR';

  if (!to) return res.status(400).json({ error: 'Passe ?to=seuemail@...' });
  if (!pedidoId) return res.status(400).json({ error: 'Passe ?pedidoId=123' });

  const [rows] = await db.query('SELECT * FROM pedidos WHERE id = ?', [pedidoId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Pedido não encontrado' });

  const pedido = rows[0];
  const { subject, html } = buildEmail('tracking', pedido, { trackingCode: tracking });

  const result = await sendEmail({
    to,
    bcc: EMAIL_TO && EMAIL_TO !== to ? EMAIL_TO : undefined,
    subject,
    html,
  });

  if (!result.ok) return res.status(500).json({ ok: false, result });
  return res.status(200).json({ ok: true, provider: result.provider, id: result.id, to, pedidoId, tracking, fromUsed: result.fromUsed });
});

// ROTA /criar-preferencia
app.post('/criar-preferencia', async (req, res) => {
  try {
    const { items, customerInfo, selectedShipping, shipmentCost } = req.body;

    log('info', 'API/PREF/IN', 'Requisição recebida', {
      itemsCount: Array.isArray(items) ? items.length : 0,
      hasCustomerInfo: !!customerInfo,
      hasSelectedShipping: !!selectedShipping,
      shipmentCostDefined: shipmentCost !== undefined,
    });

    if (!items || !customerInfo || !selectedShipping || shipmentCost === undefined) {
      log('warn', 'API/PREF/INVALID', 'Dados incompletos para criar preferência');
      return res.status(400).json({ error: 'Dados incompletos para criar a preferência.' });
    }

    const total = items.reduce((sum, item) => sum + item.unit_price * item.quantity, 0) + shipmentCost;
    const fullAddress = `${customerInfo.address}, ${customerInfo.number} ${customerInfo.complement || ''} - ${customerInfo.neighborhood}, ${customerInfo.city}/${customerInfo.state}, CEP: ${customerInfo.cep}`;

    const sql = `INSERT INTO pedidos (
      nome_cliente, email_cliente, cpf_cliente, telefone_cliente, 
      endereco_entrega, cep, logradouro, numero, complemento, bairro, cidade, estado,
      itens_pedido, info_frete, valor_total, status, expiracao_pix
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AGUARDANDO_PAGAMENTO', ?);`;

    const EXPIRACAO_MINUTOS = 60;
    const expiracaoPix = new Date(Date.now() + EXPIRACAO_MINUTOS * 60 * 1000);

    const [result] = await db.query(sql, [
      `${customerInfo.firstName} ${customerInfo.lastName}`,
      customerInfo.email,
      customerInfo.cpf.replace(/\D/g, ''),
      customerInfo.phone.replace(/\D/g, ''),
      fullAddress,
      customerInfo.cep.replace(/\D/g, ''),
      customerInfo.address,
      customerInfo.number,
      customerInfo.complement,
      customerInfo.neighborhood,
      customerInfo.city,
      customerInfo.state,
      JSON.stringify(items),
      JSON.stringify(selectedShipping),
      total,
      expiracaoPix,
    ]);

    const novoPedidoId = result.insertId;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + EXPIRACAO_MINUTOS * 60 * 1000).toISOString();

    const preferenceBody = {
      items,
      payer: { first_name: customerInfo.firstName, email: customerInfo.email },
      shipments: { cost: Number(shipmentCost) },
      external_reference: novoPedidoId.toString(),
      notification_url: `${BACKEND_URL}/notificacao-pagamento`,
      back_urls: {
        success: `${FRONTEND_URL}/sucesso`,
        failure: `${FRONTEND_URL}/falha`,
        pending: `${FRONTEND_URL}/pendente`,
      },
      expires: true,
      expiration_date_from: now.toISOString(),
      expiration_date_to: expiresAt,
    };

    const preference = new Preference(client);
    const preferenceResult = await preference.create({ body: preferenceBody });

    log('info', 'API/PREF/OK', 'Pedido salvo e preferência criada', {
      pedidoId: novoPedidoId,
      preferenceId: preferenceResult.id,
      total: Number(total),
    });

    res.status(201).json({ id: preferenceResult.id, init_point: preferenceResult.init_point, pedidoId: novoPedidoId });
  } catch (error) {
    log('error', 'API/PREF/ERROR', 'Erro ao criar preferência e salvar pedido', { message: error?.message, stack: error?.stack });
    res.status(500).json({ error: 'Erro interno ao processar o pedido.' });
  }
});

// ✅ ROTA /calcular-frete (corrigida: ViaCEP robusto + fallback BrasilAPI)
app.post('/calcular-frete', async (req, res) => {
  const { cepDestino, items } = req.body;

  log('info', 'API/FRETE/IN', 'Requisição recebida', {
    hasCepDestino: !!cepDestino,
    itemsCount: Array.isArray(items) ? items.length : 0,
  });

  if (!cepDestino || !items || items.length === 0) {
    log('warn', 'API/FRETE/INVALID', 'CEP destino e itens são obrigatórios');
    return res.status(400).json({ error: 'CEP de destino e lista de itens são obrigatórios.' });
  }

  try {
    const cleanCepDestino = String(cepDestino).replace(/\D/g, '');
    if (!/^\d{8}$/.test(cleanCepDestino)) {
      return res.status(400).json({ error: 'CEP inválido. Informe 8 dígitos.' });
    }

    const viaCepUrl = `https://viacep.com.br/ws/${cleanCepDestino}/json/`;

    let addressInfo;
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        const data = await fetchJsonSafe(
          viaCepUrl,
          { method: 'GET', headers: { Accept: 'application/json' } },
          { timeoutMs: 8000 }
        );

        if (data?.erro) throw new Error('CEP de destino não encontrado.');

        addressInfo = data;
        break;
      } catch (error) {
        // última tentativa => fallback BrasilAPI
        if (attempts === maxAttempts - 1) {
          try {
            const brUrl = `https://brasilapi.com.br/api/cep/v1/${cleanCepDestino}`;
            const br = await fetchJsonSafe(
              brUrl,
              { method: 'GET', headers: { Accept: 'application/json' } },
              { timeoutMs: 8000 }
            );

            addressInfo = {
              logradouro: br.street || '',
              bairro: br.neighborhood || '',
              localidade: br.city || '',
              uf: br.state || '',
            };

            log('warn', 'API/FRETE/VIACEP_FALLBACK', 'ViaCEP falhou — usando BrasilAPI', {
              message: error?.message,
            });

            break;
          } catch (fallbackErr) {
            log('error', 'API/FRETE/VIACEP_FATAL', 'ViaCEP e BrasilAPI falharam', {
              attempts: attempts + 1,
              viaCep: error?.message,
              brasilApi: fallbackErr?.message,
            });
            throw new Error('Não foi possível conectar com o serviço de CEP no momento. Tente novamente mais tarde.');
          }
        }

        attempts++;
        log('warn', 'API/FRETE/VIACEP_RETRY', 'Tentativa ViaCEP falhou. Tentando novamente...', {
          attempts,
          message: error?.message,
        });
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempts));
      }
    }

    const subtotal = items.reduce((sum, item) => sum + item.unit_price * item.quantity, 0);

    const shipmentPayload = {
      from: { postal_code: String(SENDER_CEP || '').replace(/\D/g, '') },
      to: { postal_code: cleanCepDestino },
      products: items.map((item) => ({
        name: item.title || item.id,
        quantity: item.quantity,
        unitary_value: item.unit_price,
        height: 10,
        width: 15,
        length: 20,
        weight: 0.3,
      })),
      options: {
        receipt: false,
        own_hand: false,
        insurance_value: subtotal,
      },
    };

    const responseData = await fetchJsonSafe(
      'https://www.melhorenvio.com.br/api/v2/me/shipment/calculate',
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${MELHOR_ENVIO_TOKEN}`,
          'User-Agent': 'Carlton (carltoncoletivo@audionoiseskatevisual.com)',
        },
        body: JSON.stringify(shipmentPayload),
      },
      { timeoutMs: 15000 }
    );

    const formattedServices = (Array.isArray(responseData) ? responseData : [])
      .filter((option) => {
        if (option?.error) return false;
        const isSedex = option?.company?.name === 'Correios' && option?.name === 'SEDEX';
        const isLoggi = option?.company?.name === 'Loggi';
        return isSedex || isLoggi;
      })
      .map((option) => ({
        code: option.id,
        name: `${option.company.name} - ${option.name}`,
        price: parseFloat(option.price),
        deliveryTime: option.delivery_time,
      }));

    log('info', 'API/FRETE/OK', 'Fretes calculados', { cepDestino: cleanCepDestino, servicesCount: formattedServices.length });

    return res.status(200).json({
      services: formattedServices,
      addressInfo: {
        logradouro: addressInfo?.logradouro || '',
        bairro: addressInfo?.bairro || '',
        localidade: addressInfo?.localidade || '',
        uf: addressInfo?.uf || '',
      },
    });
  } catch (error) {
    log('error', 'API/FRETE/ERROR', 'Erro ao calcular frete', { message: error?.message });
    return res.status(500).json({ error: error.message || 'Não foi possível calcular o frete.' });
  }
});

// ------------------- MERCADO PAGO WEBHOOK -------------------
app.post('/notificacao-pagamento', async (req, res) => {
  const topic = req.query.topic || req.query.type;
  const paymentIdCandidate = req.query.id || req.query['data.id'];

  if (topic !== 'payment') {
    log('info', 'MP/WEBHOOK/IGNORED', 'Notificação ignorada (topic não suportado)', {
      topic,
      id: paymentIdCandidate,
      requestId: getHeader(req, 'x-request-id'),
    });
    return res.status(200).send('Ignored');
  }

  const sig = validateMpWebhook(req);
  if (!sig.ok) {
    log('error', 'MP/WEBHOOK/SIG_INVALID', 'Assinatura inválida (bloqueado)', {
      reason: sig.reason,
      id: paymentIdCandidate,
      topic,
      requestId: getHeader(req, 'x-request-id'),
    });
    return res.status(401).send('Invalid signature');
  }

  log('info', 'MP/WEBHOOK/IN', 'Notificação recebida', {
    topic,
    id: paymentIdCandidate,
    requestId: getHeader(req, 'x-request-id'),
  });

  try {
    const paymentId = paymentIdCandidate;
    if (!paymentId) return res.status(200).send('Ok');

    const payment = await new Payment(client).get({ id: paymentId });
    if (!payment || !payment.external_reference) {
      log('warn', 'MP/WEBHOOK/NO_REF', 'Payment sem external_reference', { paymentId });
      return res.status(200).send('Ok');
    }

    const pedidoId = payment.external_reference;
    const [rows] = await db.query('SELECT * FROM pedidos WHERE id = ?', [pedidoId]);
    if (rows.length === 0) {
      log('warn', 'MP/WEBHOOK/NO_ORDER', 'external_reference não encontrado no banco', { pedidoId });
      return res.status(200).send('Ok');
    }

    const pedidoDoBanco = rows[0];
    const isApproved = payment.status === 'approved';
    const novoStatus = isApproved ? 'EM_PRODUCAO' : 'PAGAMENTO_PENDENTE';

    if (isApproved) {
      const metodoPagamento =
        payment.payment_type_id === 'credit_card'
          ? 'Cartão de Crédito'
          : payment.payment_type_id === 'ticket'
          ? 'Boleto'
          : payment.payment_method_id === 'pix'
          ? 'PIX'
          : payment.payment_method_id || 'Não especificado';

      const finalCartao = payment.card ? payment.card.last_four_digits : null;

      const sql = `
        UPDATE pedidos
        SET status = ?, mercado_pago_id = ?, metodo_pagamento = ?, final_cartao = ?
        WHERE id = ? AND status IN ('AGUARDANDO_PAGAMENTO', 'PAGAMENTO_PENDENTE');
      `;

      const [upd] = await db.query(sql, [novoStatus, payment.id, metodoPagamento, finalCartao, pedidoId]);

      if (upd.affectedRows === 0) {
        log('info', 'MP/IDEMPOTENT', 'Pedido já estava processado (approved), ignorando disparos', {
          pedidoId,
          status: pedidoDoBanco.status,
          paymentId: payment.id,
        });
        return res.status(200).send('Ok');
      }

      log('info', 'MP/PAGAMENTO/APROVADO', 'Pedido atualizado para EM_PRODUCAO', { pedidoId, paymentId: payment.id });

      const [rows2] = await db.query('SELECT * FROM pedidos WHERE id = ?', [pedidoId]);
      const pedidoAtualizado = rows2?.[0] || { ...pedidoDoBanco, mercado_pago_id: payment.id };

      await enviarEmailDeConfirmacao(pedidoAtualizado);
      await inserirPedidoNoCarrinhoME(pedidoAtualizado);
    } else {
      const [upd] = await db.query(
        "UPDATE pedidos SET status = ?, mercado_pago_id = ? WHERE id = ? AND status = 'AGUARDANDO_PAGAMENTO';",
        [novoStatus, payment.id, pedidoId]
      );

      if (upd.affectedRows === 0) {
        log('info', 'MP/IDEMPOTENT', 'Pedido já não estava aguardando pagamento (pendente), ignorando', {
          pedidoId,
          status: pedidoDoBanco.status,
          paymentId: payment.id,
        });
        return res.status(200).send('Ok');
      }

      log('info', 'MP/PAGAMENTO/PENDENTE', 'Pedido atualizado para PAGAMENTO_PENDENTE', { pedidoId, paymentId: payment.id });
    }

    return res.status(200).send('Ok');
  } catch (error) {
    log('error', 'MP/WEBHOOK/ERROR', 'Erro ao processar notificação', { message: error?.message, stack: error?.stack });
    return res.status(200).send('Ok');
  }
});

// ------------------- MELHOR ENVIO WEBHOOK -------------------
app.post('/webhook-melhorenvio', async (req, res) => {
  log('info', 'ME/WEBHOOK/IN', 'Notificação do Melhor Envio recebida');

  try {
    const { resource, event } = req.body;

    if (event === 'tracking') {
      const { id, tracking } = resource || {};
      const [rows] = await db.query('SELECT * FROM pedidos WHERE melhor_envio_id = ?', [id]);

      if (rows.length > 0 && tracking) {
        const pedido = rows[0];

        await db.query("UPDATE pedidos SET codigo_rastreio = ?, status = 'ENVIADO' WHERE id = ?", [tracking, pedido.id]);

        log('info', 'ME/TRACKING/OK', 'Pedido atualizado para ENVIADO', { pedidoId: pedido.id, melhorEnvioId: id, tracking });

        await enviarEmailComRastreio(pedido, tracking);
      } else {
        log('warn', 'ME/TRACKING/NO_MATCH', 'Sem pedido para melhor_envio_id ou tracking ausente', {
          melhorEnvioId: id,
          hasTracking: !!tracking,
        });
      }
    } else {
      log('info', 'ME/WEBHOOK/IGNORED', 'Evento ignorado', { event });
    }

    res.status(200).send('Webhook do Melhor Envio processado com sucesso');
  } catch (error) {
    log('error', 'ME/WEBHOOK/ERROR', 'Erro ao processar webhook Melhor Envio', { message: error?.message, stack: error?.stack });
    res.status(500).send('Erro no processamento do webhook');
  }
});

// ------------------- CRON -------------------
app.get('/checar-pedidos-expirados', async (req, res) => {
  if (CRON_SECRET) {
    const token = req.query.token || req.headers['x-cron-token'];
    if (String(token || '') !== String(CRON_SECRET)) {
      log('warn', 'CRON/AUTH', 'Token inválido para /checar-pedidos-expirados');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  log('info', 'CRON/EXPIRACAO/IN', 'Iniciando checagem de pedidos expirados.');

  try {
    const [pedidosExpirados] = await db.query(
      "SELECT * FROM pedidos WHERE status IN ('AGUARDANDO_PAGAMENTO','PAGAMENTO_PENDENTE') AND expiracao_pix < NOW();"
    );

    for (const pedido of pedidosExpirados) {
      await db.query("UPDATE pedidos SET status = 'CANCELADO_POR_EXPIRACAO' WHERE id = ?", [pedido.id]);
      await enviarEmailDeExpiracao(pedido);
      log('info', 'CRON/EXPIRACAO/CANCEL', 'Pedido cancelado e e-mail disparado', { pedidoId: pedido.id });
    }

    log('info', 'CRON/EXPIRACAO/OK', 'Checagem concluída', { cancelados: pedidosExpirados.length });
    res.status(200).json({ message: `Checagem concluída. ${pedidosExpirados.length} pedidos atualizados.` });
  } catch (error) {
    log('error', 'CRON/EXPIRACAO/ERROR', 'Erro ao checar pedidos expirados', { message: error?.message, stack: error?.stack });
    res.status(500).json({ error: 'Erro interno na checagem de pedidos expirados.' });
  }
});

// ------------------- PREVIEW DE EMAIL (DEV / TESTE) -------------------
app.get('/preview-email', async (req, res) => {
  try {
    const type = String(req.query.type || 'confirm'); // confirm | tracking | expiry
    const pedidoId = Number(req.query.pedidoId);
    const trackingCode = String(req.query.tracking || 'BR123456789BR');

    if (!pedidoId) return res.status(400).send('Informe ?pedidoId=NUMERO');

    const [rows] = await db.query('SELECT * FROM pedidos WHERE id = ?', [pedidoId]);
    if (!rows.length) return res.status(404).send('Pedido não encontrado');

    const pedido = rows[0];

    let payload;
    if (type === 'tracking') payload = buildEmail('tracking', pedido, { trackingCode });
    else if (type === 'expiry') payload = buildEmail('expiry', pedido);
    else payload = buildEmail('confirm', pedido);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(payload.html);
  } catch (err) {
    log('error', 'MAIL/PREVIEW/ERROR', 'Erro ao gerar preview', {
      message: err?.message,
      stack: err?.stack,
    });
    return res.status(500).send('Erro ao gerar preview do email');
  }
});

// ------------------- FUNÇÕES DE EMAIL -------------------
async function enviarEmailDeConfirmacao(pedido) {
  const { subject, html } = buildEmail('confirm', pedido);

  const result = await sendEmail({
    to: pedido.email_cliente,
    bcc: EMAIL_TO || undefined,
    subject,
    html,
  });

  if (result.ok)
    log('info', 'MAIL/CONFIRM/OK', 'E-mail de confirmação enviado', {
      pedidoId: pedido.id,
      provider: result.provider,
      id: result.id,
      fromUsed: result.fromUsed,
    });
  else log('error', 'MAIL/CONFIRM/ERROR', 'Erro ao enviar e-mail de confirmação', { pedidoId: pedido.id, result });
}

async function enviarEmailComRastreio(pedido, trackingCode) {
  const { subject, html } = buildEmail('tracking', pedido, { trackingCode });

  const result = await sendEmail({
    to: pedido.email_cliente,
    bcc: EMAIL_TO || undefined,
    subject,
    html,
  });

  if (result.ok)
    log('info', 'MAIL/TRACK/OK', 'E-mail de rastreio enviado', {
      pedidoId: pedido.id,
      provider: result.provider,
      id: result.id,
      fromUsed: result.fromUsed,
    });
  else log('error', 'MAIL/TRACK/ERROR', 'Erro ao enviar e-mail de rastreio', { pedidoId: pedido.id, result });
}

async function enviarEmailDeExpiracao(pedido) {
  const { subject, html } = buildEmail('expiry', pedido);

  const result = await sendEmail({
    to: pedido.email_cliente,
    bcc: EMAIL_TO || undefined,
    subject,
    html,
  });

  if (result.ok)
    log('info', 'MAIL/EXPIRY/OK', 'E-mail de expiração enviado', {
      pedidoId: pedido.id,
      provider: result.provider,
      id: result.id,
      fromUsed: result.fromUsed,
    });
  else log('error', 'MAIL/EXPIRY/ERROR', 'Erro ao enviar e-mail de expiração', { pedidoId: pedido.id, result });
}

// ------------------- MELHOR ENVIO -------------------
async function inserirPedidoNoCarrinhoME(pedido) {
  log('info', 'ME/CART/IN', 'Iniciando inserção no carrinho Melhor Envio', { pedidoId: pedido.id });

  const itens = typeof pedido.itens_pedido === 'string' ? JSON.parse(pedido.itens_pedido) : pedido.itens_pedido || [];
  const frete = typeof pedido.info_frete === 'string' ? JSON.parse(pedido.info_frete) : pedido.info_frete || {};

  const subtotal = itens.reduce((sum, item) => sum + Number(item.unit_price || 0) * Number(item.quantity || 0), 0);
  const pesoTotal = itens.reduce((sum, item) => sum + 0.3 * Number(item.quantity || 0), 0);

  const payload = {
    service: frete.code,
    from: {
      name: SENDER_NAME,
      phone: String(SENDER_PHONE || '').replace(/\D/g, ''),
      email: SENDER_EMAIL,
      document: String(SENDER_DOCUMENT || '').replace(/\D/g, ''),
      address: SENDER_STREET,
      complement: SENDER_COMPLEMENT,
      number: SENDER_NUMBER,
      district: SENDER_DISTRICT,
      city: SENDER_CITY,
      state_abbr: SENDER_STATE_ABBR,
      country_id: 'BR',
      postal_code: String(SENDER_CEP || '').replace(/\D/g, ''),
    },
    to: {
      name: pedido.nome_cliente,
      phone: String(pedido.telefone_cliente || '').replace(/\D/g, ''),
      email: pedido.email_cliente,
      document: String(pedido.cpf_cliente || '').replace(/\D/g, ''),
      address: pedido.logradouro,
      complement: pedido.complemento,
      number: pedido.numero,
      district: pedido.bairro,
      city: pedido.cidade,
      state_abbr: pedido.estado,
      country_id: 'BR',
      postal_code: String(pedido.cep || '').replace(/\D/g, ''),
    },
    products: itens.map((item) => ({
      name: item.title || item.id,
      quantity: Number(item.quantity || 0),
      unitary_value: Number(item.unit_price || 0),
      height: 10,
      width: 15,
      length: 20,
      weight: 0.3,
    })),
    volumes: [
      {
        height: 10,
        width: 15,
        length: 20,
        weight: pesoTotal < 0.01 ? 0.01 : pesoTotal,
      },
    ],
    options: {
      insurance_value: Math.max(1, subtotal),
      receipt: false,
      own_hand: false,
      reverse: false,
      non_commercial: true,
      tags: [{ tag: `Pedido #${pedido.id}`, url: null }],
    },
  };

  const data = await fetchJsonSafe(
    'https://www.melhorenvio.com.br/api/v2/me/cart',
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MELHOR_ENVIO_TOKEN}`,
        'User-Agent': 'Carlton (carltoncoletivo@audionoiseskatevisual.com)',
      },
      body: JSON.stringify(payload),
    },
    { timeoutMs: 20000 }
  );

  const melhorEnvioId = data.id;
  if (melhorEnvioId) {
    await db.query('UPDATE pedidos SET melhor_envio_id = ? WHERE id = ?', [melhorEnvioId, pedido.id]);
    log('info', 'ME/CART/OK', 'ID do Melhor Envio salvo no pedido', { pedidoId: pedido.id, melhorEnvioId });
  }

  log('info', 'ME/CART/OK', 'Pedido inserido no carrinho do Melhor Envio', { pedidoId: pedido.id });
}

// ROTA PARA O CLIENTE RASTREAR O PEDIDO
app.post('/rastrear-pedido', async (req, res) => {
  const { cpf, email } = req.body;

  log('info', 'API/RASTREIO/IN', 'Solicitação recebida', { hasCpf: !!cpf, hasEmail: !!email });

  if (!cpf || !email) {
    log('warn', 'API/RASTREIO/INVALID', 'CPF e e-mail são obrigatórios');
    return res.status(400).json({ error: 'CPF e e-mail são obrigatórios.' });
  }

  try {
    const cpfLimpo = String(cpf).replace(/\D/g, '');

    const sql = `
      SELECT 
        id, nome_cliente, status, codigo_rastreio, 
        logradouro, bairro, cidade, estado, cep, numero, complemento,
        itens_pedido, info_frete, valor_total,
        data_criacao, metodo_pagamento, final_cartao
      FROM pedidos 
      WHERE cpf_cliente = ? AND email_cliente = ?
      ORDER BY data_criacao DESC
      LIMIT 1;
    `;

    const [rows] = await db.query(sql, [cpfLimpo, email]);
    if (rows.length === 0) {
      log('warn', 'API/RASTREIO/NOT_FOUND', 'Nenhum pedido encontrado (cpf/email)');
      return res.status(404).json({ error: 'Nenhum pedido encontrado para o CPF e e-mail informados.' });
    }

    const pedidoDoBanco = rows[0];
    const itens = typeof pedidoDoBanco.itens_pedido === 'string' ? JSON.parse(pedidoDoBanco.itens_pedido) : pedidoDoBanco.itens_pedido || [];
    const freteInfo = typeof pedidoDoBanco.info_frete === 'string' ? JSON.parse(pedidoDoBanco.info_frete) : pedidoDoBanco.info_frete || {};

    const itensFormatados = itens.map((item) => ({
      id: item.id,
      nome: item.title,
      quantidade: item.quantity,
      preco: parseFloat(item.unit_price),
      imagem: item.picture_url,
    }));

    const dadosFormatadosParaFrontend = {
      id: pedidoDoBanco.id,
      status: pedidoDoBanco.status,
      codigo_rastreio: pedidoDoBanco.codigo_rastreio,
      data_pagamento: null,
      data_producao: null,
      data_envio: null,
      data_entrega: null,
      data_prevista_entrega: null,

      cliente: { nome: pedidoDoBanco.nome_cliente },

      endereco_entrega: {
        rua: `${pedidoDoBanco.logradouro}, ${pedidoDoBanco.numero}`,
        bairro: pedidoDoBanco.bairro,
        cidade: pedidoDoBanco.cidade,
        estado: pedidoDoBanco.estado,
        cep: pedidoDoBanco.cep,
      },

      itens: itensFormatados,

      pagamento: {
        metodo: pedidoDoBanco.metodo_pagamento || 'Não informado',
        final_cartao: pedidoDoBanco.final_cartao ? `**** **** **** ${pedidoDoBanco.final_cartao}` : null,
      },

      frete: parseFloat(freteInfo.price || 0),
    };

    log('info', 'API/RASTREIO/OK', 'Pedido encontrado e enviado ao frontend', { pedidoId: pedidoDoBanco.id, status: pedidoDoBanco.status });
    return res.status(200).json(dadosFormatadosParaFrontend);
  } catch (error) {
    log('error', 'API/RASTREIO/ERROR', 'Erro ao buscar pedido pelo CPF', { message: error?.message, stack: error?.stack });
    return res.status(500).json({ error: 'Ocorreu um erro interno. Por favor, tente mais tarde.' });
  }
});

// --- INICIAR SERVIDOR ---
app.listen(port, () => {
  log('info', 'BOOT/OK', `Servidor rodando na porta ${port}`);
});
