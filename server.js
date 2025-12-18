/* ================================================================================
|                                   Feito 100% por Nicolas Arantes                                   |
================================================================================ */

import express from 'express';
import cors from 'cors';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import nodemailer from 'nodemailer';
import db from './db.js';
import crypto from 'crypto';

// --- CONFIGURAÇÃO INICIAL ---
dotenv.config();
const app = express();
const port = process.env.PORT || 4000;
app.use(cors());

// A body-parser precisa ser configurada com `verify` para ler o buffer da requisição,
// que é necessário para validar a assinatura do webhook.
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

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
  MP_ACCESS_TOKEN, MELHOR_ENVIO_TOKEN, SENDER_CEP, BACKEND_URL,
  FRONTEND_URL, EMAIL_HOST, EMAIL_PORT, EMAIL_SECURE, EMAIL_USER,
  EMAIL_PASS, EMAIL_TO, SENDER_NAME, SENDER_PHONE, SENDER_EMAIL,
  SENDER_DOCUMENT, SENDER_STREET, SENDER_NUMBER, SENDER_COMPLEMENT,
  SENDER_DISTRICT, SENDER_CITY, SENDER_STATE_ABBR, MP_WEBHOOK_SECRET
} = process.env;

// Validação das variáveis de ambiente
if (!MP_ACCESS_TOKEN || !MELHOR_ENVIO_TOKEN || !BACKEND_URL || !FRONTEND_URL || !EMAIL_USER || !db) {
  log('error', 'BOOT/FATAL', 'Variáveis essenciais ausentes. Verifique .env / Railway Variables.');
  process.exit(1);
}

if (!MP_WEBHOOK_SECRET) {
  log('warn', 'BOOT/WARN', 'MP_WEBHOOK_SECRET não encontrada. Validação do webhook Mercado Pago DESATIVADA.');
}

// --- CONFIGURAÇÃO DOS SERVIÇOS ---
const client = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
const transporter = nodemailer.createTransport({
  host: EMAIL_HOST,
  port: parseInt(EMAIL_PORT, 10),
  secure: EMAIL_SECURE === 'true',
  auth: { user: EMAIL_USER, pass: EMAIL_PASS },
});

// ------------------- ROTAS DA APLICAÇÃO -------------------

// ROTA /criar-preferencia
app.post('/criar-preferencia', async (req, res) => {
  // Antes você logava o body inteiro. Isso pode vazar dados pessoais.
  // Agora logamos um resumo (sem mudar lógica).
  try {
    const { items, customerInfo, selectedShipping, shipmentCost } = req.body;

    log('info', 'API/PREF/IN', 'Requisição recebida', {
      itemsCount: Array.isArray(items) ? items.length : 0,
      hasCustomerInfo: !!customerInfo,
      hasSelectedShipping: !!selectedShipping,
      shipmentCostDefined: shipmentCost !== undefined
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

    const expiracaoPix = new Date(Date.now() + 30 * 60 * 1000);

    const [result] = await db.query(sql, [
      `${customerInfo.firstName} ${customerInfo.lastName}`, customerInfo.email,
      customerInfo.cpf.replace(/\D/g, ''), customerInfo.phone.replace(/\D/g, ''),
      fullAddress, customerInfo.cep.replace(/\D/g, ''), customerInfo.address,
      customerInfo.number, customerInfo.complement, customerInfo.neighborhood,
      customerInfo.city, customerInfo.state, JSON.stringify(items),
      JSON.stringify(selectedShipping), total, expiracaoPix
    ]);
    const novoPedidoId = result.insertId;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();

    const preferenceBody = {
      items,
      payer: { first_name: customerInfo.firstName, email: customerInfo.email },
      shipments: { cost: Number(shipmentCost) },
      external_reference: novoPedidoId.toString(),
      notification_url: `${BACKEND_URL}/notificacao-pagamento`,
      back_urls: {
        success: `${FRONTEND_URL}/sucesso`,
        failure: `${FRONTEND_URL}/falha`,
        pending: `${FRONTEND_URL}/pendente`
      },
      expires: true,
      expiration_date_from: now.toISOString(),
      expiration_date_to: expiresAt
    };

    const preference = new Preference(client);
    const preferenceResult = await preference.create({ body: preferenceBody });

    log('info', 'API/PREF/OK', 'Pedido salvo e preferência criada', {
      pedidoId: novoPedidoId,
      preferenceId: preferenceResult.id,
      total: Number(total)
    });

    res.status(201).json({ id: preferenceResult.id, init_point: preferenceResult.init_point });
  } catch (error) {
    log('error', 'API/PREF/ERROR', 'Erro ao criar preferência e salvar pedido', {
      message: error?.message,
      stack: error?.stack
    });
    res.status(500).json({ error: 'Erro interno ao processar o pedido.' });
  }
});

// ROTA /calcular-frete
app.post('/calcular-frete', async (req, res) => {
  const { cepDestino, items } = req.body;

  log('info', 'API/FRETE/IN', 'Requisição recebida', {
    hasCepDestino: !!cepDestino,
    itemsCount: Array.isArray(items) ? items.length : 0
  });

  if (!cepDestino || !items || items.length === 0) {
    log('warn', 'API/FRETE/INVALID', 'CEP destino e itens são obrigatórios');
    return res.status(400).json({ error: 'CEP de destino e lista de itens são obrigatórios.' });
  }

  try {
    const cleanCepDestino = cepDestino.replace(/\D/g, '');
    const viaCepUrl = `https://viacep.com.br/ws/${cleanCepDestino}/json/`;
    let addressInfo;
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        const viaCepResponse = await fetch(viaCepUrl);
        addressInfo = await viaCepResponse.json();
        if (addressInfo.erro) throw new Error("CEP de destino não encontrado.");
        break;
      } catch (error) {
        attempts++;
        if (attempts === maxAttempts) {
          log('error', 'API/FRETE/VIACEP_FATAL', 'Falha ao consultar ViaCEP após tentativas', {
            attempts,
            message: error?.message
          });
          throw new Error('Não foi possível conectar com o serviço de CEP no momento. Por favor, tente novamente mais tarde.');
        }
        log('warn', 'API/FRETE/VIACEP_RETRY', 'Tentativa ViaCEP falhou. Tentando novamente...', { attempts });
        await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
      }
    }

    const subtotal = items.reduce((sum, item) => sum + (item.unit_price * item.quantity), 0);

    const shipmentPayload = {
      from: { postal_code: SENDER_CEP.replace(/\D/g, '') },
      to: { postal_code: cleanCepDestino },
      products: items.map(item => ({
        name: item.title || item.id,
        quantity: item.quantity,
        unitary_value: item.unit_price,
        height: 10,
        width: 15,
        length: 20,
        weight: 0.3
      })),
      options: {
        receipt: false,
        own_hand: false,
        insurance_value: subtotal
      }
    };

    const meResponse = await fetch('https://www.melhorenvio.com.br/api/v2/me/shipment/calculate', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MELHOR_ENVIO_TOKEN}`,
        'User-Agent': 'Carlton (carltoncoletivo@audionoiseskatevisual.com)'
      },
      body: JSON.stringify(shipmentPayload)
    });

    const responseData = await meResponse.json();
    if (!meResponse.ok) {
      log('error', 'API/FRETE/ME_ERROR', 'Erro retornado pelo Melhor Envio', responseData);
      throw new Error(responseData.message || 'Erro ao comunicar com a Melhor Envio.');
    }

    const formattedServices = responseData
      .filter(option => {
        if (option.error) return false;
        const isSedex = option.company.name === 'Correios' && option.name === 'SEDEX';
        const isLoggi = option.company.name === 'Loggi';
        return isSedex || isLoggi;
      })
      .map(option => ({
        code: option.id,
        name: `${option.company.name} - ${option.name}`,
        price: parseFloat(option.price),
        deliveryTime: option.delivery_time
      }));

    log('info', 'API/FRETE/OK', 'Fretes calculados', {
      cepDestino: cleanCepDestino,
      servicesCount: formattedServices.length
    });

    res.status(200).json({
      services: formattedServices,
      addressInfo: {
        logradouro: addressInfo.logradouro,
        bairro: addressInfo.bairro,
        localidade: addressInfo.localidade,
        uf: addressInfo.uf
      }
    });
  } catch (error) {
    log('error', 'API/FRETE/ERROR', 'Erro ao calcular frete', { message: error?.message });
    res.status(500).json({ error: error.message || 'Não foi possível calcular o frete.' });
  }
});

// ROTA DE WEBHOOK PARA NOTIFICAÇÕES DO MERCADO PAGO
app.post('/notificacao-pagamento', async (req, res) => {
  // validação de assinatura (mesma lógica)
  if (MP_WEBHOOK_SECRET) {
    const signature = req.headers['x-signature'];
    if (!signature) {
      log('error', 'MP/WEBHOOK/SIG_MISSING', 'Assinatura ausente');
      return res.status(401).send('Invalid signature');
    }

    const parts = signature.split(',');
    const timestampPart = parts.find(p => p.startsWith('ts='));
    const signatureHashPart = parts.find(p => p.startsWith('v1='));

    if (!timestampPart || !signatureHashPart) {
      log('error', 'MP/WEBHOOK/SIG_FORMAT', 'Formato de assinatura inválido', { signature });
      return res.status(401).send('Invalid signature format');
    }

    const timestamp = timestampPart.replace('ts=', '');
    const signatureHash = signatureHashPart.replace('v1=', '');

    const message = `id:${req.query.id};ts:${timestamp};`;
    const hmac = crypto.createHmac('sha256', MP_WEBHOOK_SECRET);
    hmac.update(message);
    const expectedSignature = hmac.digest('hex');

    if (expectedSignature !== signatureHash) {
      log('error', 'MP/WEBHOOK/SIG_INVALID', 'Assinatura inválida (bloqueado)', {
        id: req.query?.id,
        topic: req.query?.topic || req.query?.type
      });
      return res.status(401).send('Invalid signature');
    }
  } else {
    log('warn', 'MP/WEBHOOK/WARN', 'Validação de assinatura desativada (MP_WEBHOOK_SECRET ausente)');
  }

  const topic = req.query.topic || req.query.type;
  const paymentIdCandidate = req.query.id || req.query['data.id'];

  log('info', 'MP/WEBHOOK/IN', 'Notificação recebida', {
    topic,
    id: paymentIdCandidate
  });

  if (topic === 'payment') {
    try {
      const paymentId = paymentIdCandidate;
      const payment = await new Payment(client).get({ id: paymentId });

      if (payment && payment.external_reference) {
        const pedidoId = payment.external_reference;
        const [rows] = await db.query('SELECT * FROM pedidos WHERE id = ?', [pedidoId]);

        if (rows.length > 0) {
          const pedidoDoBanco = rows[0];

          // Evita processar novamente um pedido já pago ou em produção
          if (pedidoDoBanco.status !== 'AGUARDANDO_PAGAMENTO' && pedidoDoBanco.status !== 'PAGAMENTO_PENDENTE') {
            log('info', 'MP/IDEMPOTENT', 'Pedido já processado, ignorando', {
              pedidoId,
              status: pedidoDoBanco.status
            });
          } else {
            const isApproved = payment.status === 'approved';
            const novoStatus = isApproved ? 'EM_PRODUCAO' : 'PAGAMENTO_PENDENTE';

            if (isApproved) {
              const metodoPagamento = payment.payment_type_id === 'credit_card' ? 'Cartão de Crédito' :
                payment.payment_type_id === 'ticket' ? 'Boleto' :
                  payment.payment_method_id === 'pix' ? 'PIX' :
                    (payment.payment_method_id || 'Não especificado');

              const finalCartao = payment.card ? payment.card.last_four_digits : null;

              const sql = `
                                UPDATE pedidos 
                                SET status = ?, mercado_pago_id = ?, metodo_pagamento = ?, final_cartao = ? 
                                WHERE id = ?
                            `;

              await db.query(sql, [novoStatus, payment.id, metodoPagamento, finalCartao, pedidoId]);

              log('info', 'MP/PAGAMENTO/APROVADO', 'Pedido atualizado para EM_PRODUCAO', {
                pedidoId,
                paymentId: payment.id,
                metodo: metodoPagamento
              });

              await enviarEmailDeConfirmacao({ ...pedidoDoBanco, mercado_pago_id: payment.id });
              await inserirPedidoNoCarrinhoME(pedidoDoBanco);

            } else if (pedidoDoBanco.status !== novoStatus) {
              await db.query(
                "UPDATE pedidos SET status = ?, mercado_pago_id = ? WHERE id = ?",
                [novoStatus, payment.id, pedidoId]
              );

              log('info', 'MP/PAGAMENTO/PENDENTE', 'Pedido atualizado para PAGAMENTO_PENDENTE', {
                pedidoId,
                paymentId: payment.id
              });
            }
          }
        } else {
          log('warn', 'MP/WEBHOOK/NO_ORDER', 'external_reference não encontrado no banco', { pedidoId });
        }
      } else {
        log('warn', 'MP/WEBHOOK/NO_REF', 'Payment sem external_reference', { paymentId: paymentIdCandidate });
      }
    } catch (error) {
      log('error', 'MP/WEBHOOK/ERROR', 'Erro ao processar notificação', {
        message: error?.message,
        stack: error?.stack
      });
    }
  } else {
    log('info', 'MP/WEBHOOK/IGNORED', 'Notificação ignorada (topic não suportado)', { topic });
  }

  res.status(200).send('Notificação recebida');
});

// ROTA DE WEBHOOK DO MELHOR ENVIO PARA RASTREIO
app.post('/webhook-melhorenvio', async (req, res) => {
  log('info', 'ME/WEBHOOK/IN', 'Notificação do Melhor Envio recebida');

  try {
    const { resource, event } = req.body;

    if (event === "tracking") {
      const { id, tracking } = resource;
      const [rows] = await db.query("SELECT * FROM pedidos WHERE melhor_envio_id = ?", [id]);

      if (rows.length > 0 && tracking) {
        const pedido = rows[0];

        const sql = "UPDATE pedidos SET codigo_rastreio = ?, status = 'ENVIADO' WHERE id = ?";
        await db.query(sql, [tracking, pedido.id]);

        log('info', 'ME/TRACKING/OK', 'Pedido atualizado para ENVIADO', {
          pedidoId: pedido.id,
          melhorEnvioId: id,
          tracking
        });

        await enviarEmailComRastreio(pedido, tracking);
      } else {
        log('warn', 'ME/TRACKING/NO_MATCH', 'Sem pedido para melhor_envio_id ou tracking ausente', {
          melhorEnvioId: id,
          hasTracking: !!tracking
        });
      }
    } else {
      log('info', 'ME/WEBHOOK/IGNORED', 'Evento ignorado', { event });
    }

    res.status(200).send("Webhook do Melhor Envio processado com sucesso");
  } catch (error) {
    log('error', 'ME/WEBHOOK/ERROR', 'Erro ao processar webhook Melhor Envio', {
      message: error?.message,
      stack: error?.stack
    });
    res.status(500).send("Erro no processamento do webhook");
  }
});

// ROTA PARA CHECAR PEDIDOS EXPIRADOS
app.get('/checar-pedidos-expirados', async (req, res) => {
  log('info', 'CRON/EXPIRACAO/IN', 'Iniciando checagem de pedidos expirados.');

  try {
    const [pedidosExpirados] = await db.query(
      "SELECT * FROM pedidos WHERE status = 'AGUARDANDO_PAGAMENTO' AND expiracao_pix < NOW();"
    );

    for (const pedido of pedidosExpirados) {
      await db.query("UPDATE pedidos SET status = 'CANCELADO_POR_EXPIRACAO' WHERE id = ?", [pedido.id]);
      await enviarEmailDeExpiracao(pedido);
      log('info', 'CRON/EXPIRACAO/CANCEL', 'Pedido cancelado por expiração e e-mail enviado', { pedidoId: pedido.id });
    }

    log('info', 'CRON/EXPIRACAO/OK', 'Checagem concluída', { cancelados: pedidosExpirados.length });
    res.status(200).json({ message: `Checagem concluída. ${pedidosExpirados.length} pedidos atualizados.` });
  } catch (error) {
    log('error', 'CRON/EXPIRACAO/ERROR', 'Erro ao checar pedidos expirados', {
      message: error?.message,
      stack: error?.stack
    });
    res.status(500).json({ error: "Erro interno na checagem de pedidos." });
  }
});

// FUNÇÃO AUXILIAR DE ENVIO DE E-MAIL
async function enviarEmailDeConfirmacao(pedido) {
  const itens = typeof pedido.itens_pedido === 'string' ? JSON.parse(pedido.itens_pedido) : pedido.itens_pedido;
  const frete = typeof pedido.info_frete === 'string' ? JSON.parse(pedido.info_frete) : pedido.info_frete;

  const emailBody = `
        <h1>🎉 Pedido Confirmado! (Nº ${pedido.id})</h1>
        <p>Olá, ${pedido.nome_cliente}. Seu pagamento foi aprovado!</p>
        <p><strong>ID do Pagamento (Mercado Pago):</strong> ${pedido.mercado_pago_id}</p>
        <hr>
        <h2>Endereço de Entrega</h2>
        <p>${pedido.endereco_entrega}</p>
        <hr>
        <h2>Detalhes do Pedido</h2>
        <ul>
        ${itens.map(item => `<li>${item.quantity}x ${item.title} - R$ ${Number(item.unit_price).toFixed(2)} cada</li>`).join('')}
        </ul>
        <hr>
        <h2>Valores</h2>
        <p><strong>Frete (${frete.name}):</strong> R$ ${Number(frete.price).toFixed(2)}</p>
        <h3><strong>Total:</strong> R$ ${Number(pedido.valor_total).toFixed(2)}</h3>
    `;

  try {
    await transporter.sendMail({
      from: `"Carlton" <${EMAIL_USER}>`,
      to: EMAIL_TO,
      bcc: pedido.email_cliente,
      subject: `Confirmação do Pedido #${pedido.id}`,
      html: emailBody,
    });

    log('info', 'MAIL/CONFIRM/OK', 'E-mail de confirmação enviado', { pedidoId: pedido.id });
  } catch (error) {
    log('error', 'MAIL/CONFIRM/ERROR', 'Erro ao enviar e-mail de confirmação', {
      pedidoId: pedido.id,
      message: error?.message,
      stack: error?.stack
    });
  }
}

// FUNÇÃO: ENVIAR E-MAIL COM RASTREIO
async function enviarEmailComRastreio(pedido, trackingCode) {
  const emailBody = `
        <h1>📦 Seu pedido foi postado!</h1>
        <p>Olá, ${pedido.nome_cliente}.</p>
        <p>Seu pedido <strong>#${pedido.id}</strong> já foi enviado.</p>
        <p><strong>Código de rastreio:</strong> ${trackingCode}</p>
        <p>Acompanhe pelo site dos Correios ou Melhor Envio.</p>
    `;

  try {
    await transporter.sendMail({
      from: `"Carlton" <${EMAIL_USER}>`,
      to: pedido.email_cliente,
      subject: `Código de Rastreio - Pedido #${pedido.id}`,
      html: emailBody,
    });

    log('info', 'MAIL/TRACK/OK', 'E-mail de rastreio enviado', { pedidoId: pedido.id });
  } catch (error) {
    log('error', 'MAIL/TRACK/ERROR', 'Erro ao enviar e-mail de rastreio', {
      pedidoId: pedido.id,
      message: error?.message,
      stack: error?.stack
    });
  }
}

// FUNÇÃO: ENVIAR E-MAIL DE EXPIRAÇÃO DE PIX
async function enviarEmailDeExpiracao(pedido) {
  const emailBody = `
        <h1>⚠️ Pagamento não confirmado para o Pedido #${pedido.id}</h1>
        <p>Olá, ${pedido.nome_cliente}.</p>
        <p>Notamos que o pagamento referente ao seu pedido <strong>#${pedido.id}</strong> ainda não foi confirmado.</p>
        <p>O link para pagamento via PIX expirou para evitar pagamentos duplicados ou fraudes. Se ainda deseja adquirir os produtos, por favor, realize um novo pedido em nosso site.</p>
        <p>Se você já pagou e acha que isso foi um engano, por favor, entre em contato conosco com o comprovante de pagamento.</p>
        <hr>
        <p>Agradecemos a sua compreensão.</p>
        <p>Atenciosamente,</p>
        <p>Equipe Carlton</p>
    `;

  try {
    await transporter.sendMail({
      from: `"Carlton" <${EMAIL_USER}>`,
      to: pedido.email_cliente,
      subject: `Aviso: Pagamento Pendente para o Pedido #${pedido.id}`,
      html: emailBody,
    });

    log('info', 'MAIL/EXPIRY/OK', 'E-mail de expiração enviado', { pedidoId: pedido.id });
  } catch (error) {
    log('error', 'MAIL/EXPIRY/ERROR', 'Erro ao enviar e-mail de expiração', {
      pedidoId: pedido.id,
      message: error?.message,
      stack: error?.stack
    });
  }
}

// FUNÇÃO: INSERIR PEDIDO NO CARRINHO DO MELHOR ENVIO
async function inserirPedidoNoCarrinhoME(pedido) {
  log('info', 'ME/CART/IN', 'Iniciando inserção no carrinho Melhor Envio', { pedidoId: pedido.id });

  const itens = typeof pedido.itens_pedido === 'string' ? JSON.parse(pedido.itens_pedido) : pedido.itens_pedido;
  const frete = typeof pedido.info_frete === 'string' ? JSON.parse(pedido.info_frete) : pedido.info_frete;
  const subtotal = itens.reduce((sum, item) => sum + item.unit_price * item.quantity, 0);
  const pesoTotal = itens.reduce((sum, item) => sum + (0.3 * item.quantity), 0);

  const payload = {
    service: frete.code,
    from: {
      name: SENDER_NAME, phone: SENDER_PHONE.replace(/\D/g, ''), email: SENDER_EMAIL,
      document: SENDER_DOCUMENT.replace(/\D/g, ''), address: SENDER_STREET,
      complement: SENDER_COMPLEMENT, number: SENDER_NUMBER, district: SENDER_DISTRICT,
      city: SENDER_CITY, state_abbr: SENDER_STATE_ABBR, country_id: "BR",
      postal_code: SENDER_CEP.replace(/\D/g, ''),
    },
    to: {
      name: pedido.nome_cliente, phone: pedido.telefone_cliente.replace(/\D/g, ''),
      email: pedido.email_cliente, document: pedido.cpf_cliente.replace(/\D/g, ''),
      address: pedido.logradouro, complement: pedido.complemento, number: pedido.numero,
      district: pedido.bairro, city: pedido.cidade, state_abbr: pedido.estado,
      country_id: "BR", postal_code: pedido.cep.replace(/\D/g, ''),
    },
    products: itens.map(item => ({
      name: item.title || item.id,
      quantity: item.quantity,
      unitary_value: item.unit_price,
      height: 10,
      width: 15,
      length: 20,
      weight: 0.3
    })),
    volumes: [{
      height: 10,
      width: 15,
      length: 20,
      weight: pesoTotal < 0.01 ? 0.01 : pesoTotal
    }],
    options: {
      insurance_value: Math.max(1, subtotal),
      receipt: false,
      own_hand: false,
      reverse: false,
      non_commercial: true,
      tags: [{ tag: `Pedido #${pedido.id}`, url: null }],
    },
  };

  const response = await fetch('https://www.melhorenvio.com.br/api/v2/me/cart', {
    method: 'POST',
    headers: {
      'Accept': 'application/json', 'Content-Type': 'application/json',
      'Authorization': `Bearer ${MELHOR_ENVIO_TOKEN}`,
      'User-Agent': 'Carlton (carltoncoletivo@audionoiseskatevisual.com)'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok) {
    log('error', 'ME/CART/ERROR', 'Erro ao inserir no carrinho do Melhor Envio', {
      status: response.status,
      response: data
    });
    // mantém exatamente seu comportamento: log payload detalhado + throw
    console.error("Payload enviado para o Melhor Envio:", JSON.stringify(payload, null, 2));
    console.error("Resposta de erro do Melhor Envio:", data);
    throw new Error(JSON.stringify(data.error || 'Erro ao inserir no carrinho Melhor Envio.'));
  }

  const melhorEnvioId = data.id;
  if (melhorEnvioId) {
    await db.query(
      "UPDATE pedidos SET melhor_envio_id = ? WHERE id = ?",
      [melhorEnvioId, pedido.id]
    );

    log('info', 'ME/CART/OK', 'ID do Melhor Envio salvo no pedido', {
      pedidoId: pedido.id,
      melhorEnvioId
    });
  }

  log('info', 'ME/CART/OK', 'Pedido inserido no carrinho do Melhor Envio', { pedidoId: pedido.id });
}

// ROTA PARA O CLIENTE RASTREAR O PEDIDO
app.post('/rastrear-pedido', async (req, res) => {
  // Aqui existe PII (cpf/email). Vamos logar só o essencial.
  const { cpf, email } = req.body;

  log('info', 'API/RASTREIO/IN', 'Solicitação recebida', {
    hasCpf: !!cpf,
    hasEmail: !!email
  });

  if (!cpf || !email) {
    log('warn', 'API/RASTREIO/INVALID', 'CPF e e-mail são obrigatórios');
    return res.status(400).json({ error: 'CPF e e-mail são obrigatórios.' });
  }

  try {
    const cpfLimpo = cpf.replace(/\D/g, '');

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

    const itens = typeof pedidoDoBanco.itens_pedido === 'string'
      ? JSON.parse(pedidoDoBanco.itens_pedido)
      : pedidoDoBanco.itens_pedido || [];

    const freteInfo = typeof pedidoDoBanco.info_frete === 'string'
      ? JSON.parse(pedidoDoBanco.info_frete)
      : pedidoDoBanco.info_frete || {};

    const itensFormatados = itens.map(item => ({
      id: item.id,
      nome: item.title,
      quantidade: item.quantity,
      preco: parseFloat(item.unit_price),
      imagem: item.picture_url
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

      frete: parseFloat(freteInfo.price || 0)
    };

    log('info', 'API/RASTREIO/OK', 'Pedido encontrado e enviado ao frontend', {
      pedidoId: pedidoDoBanco.id,
      status: pedidoDoBanco.status
    });

    res.status(200).json(dadosFormatadosParaFrontend);

  } catch (error) {
    log('error', 'API/RASTREIO/ERROR', 'Erro ao buscar pedido pelo CPF', {
      message: error?.message,
      stack: error?.stack
    });
    res.status(500).json({ error: 'Ocorreu um erro interno. Por favor, tente mais tarde.' });
  }
});

// --- INICIAR SERVIDOR ---
app.listen(port, () => {
  log('info', 'BOOT/OK', `Servidor rodando em http://localhost:${port}`);
});
