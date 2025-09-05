/* ================================================================================
|                                  Feito 100% por Nicolas Arantes                                  |
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
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

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
    console.error("ERRO CRÍTICO: Verifique as variáveis de ambiente essenciais.");
    process.exit(1);
}
if (!MP_WEBHOOK_SECRET) {
    console.warn("AVISO: Variável de ambiente MP_WEBHOOK_SECRET não encontrada. A validação de segurança dos webhooks do Mercado Pago está desativada.");
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
    console.log("LOG: Corpo da requisição recebido em /criar-preferencia:", JSON.stringify(req.body, null, 2));
    try {
        const { items, customerInfo, selectedShipping, shipmentCost } = req.body;
        if (!items || !customerInfo || !selectedShipping || shipmentCost === undefined) {
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
        console.log(`SUCESSO! Pedido #${novoPedidoId} salvo no banco. Preferência ${preferenceResult.id} criada.`);
        res.status(201).json({ id: preferenceResult.id, init_point: preferenceResult.init_point });
    } catch (error) {
        console.error("ERRO AO CRIAR PREFERÊNCIA E SALVAR PEDIDO:", error);
        res.status(500).json({ error: 'Erro interno ao processar o pedido.' });
    }
});

// ROTA /calcular-frete
app.post('/calcular-frete', async (req, res) => {
    console.log("LOG: Corpo da requisição recebido em /calcular-frete:", req.body);
    const { cepDestino, items } = req.body;
    if (!cepDestino || !items || items.length === 0) {
        return res.status(400).json({ error: 'CEP de destino e lista de itens são obrigatórios.' });
    }
    try {
        const cleanCepDestino = cepDestino.replace(/\D/g, '');
        const viaCepUrl = `https://viacep.com.br/ws/${cleanCepDestino}/json/`;
        let addressInfo;
        for (let attempts = 0; attempts < 3; attempts++) {
            try {
                const viaCepResponse = await fetch(viaCepUrl);
                addressInfo = await viaCepResponse.json();
                if (addressInfo.erro) throw new Error("CEP de destino não encontrado.");
                break;
            } catch (error) {
                if (attempts === 2) throw new Error('Não foi possível conectar com o serviço de CEP.');
                await new Promise(resolve => setTimeout(resolve, 1000 * (attempts + 1)));
            }
        }
        const subtotal = items.reduce((sum, item) => sum + (item.unit_price * item.quantity), 0);
        const shipmentPayload = {
            from: { postal_code: SENDER_CEP.replace(/\D/g, '') },
            to: { postal_code: cleanCepDestino },
            products: items.map(item => ({
                name: item.title || item.id, quantity: item.quantity, unitary_value: item.unit_price,
                height: 10, width: 15, length: 20, weight: 0.3
            })),
            options: { receipt: false, own_hand: false, insurance_value: subtotal }
        };
        const meResponse = await fetch('https://www.melhorenvio.com.br/api/v2/me/shipment/calculate', {
            method: 'POST',
            headers: {
                'Accept': 'application/json', 'Content-Type': 'application/json',
                'Authorization': `Bearer ${MELHOR_ENVIO_TOKEN}`, 'User-Agent': 'Carlton (carltoncoletivo@audionoiseskatevisual.com)'
            },
            body: JSON.stringify(shipmentPayload)
        });
        const responseData = await meResponse.json();
        if (!meResponse.ok) throw new Error(responseData.message || 'Erro ao comunicar com a Melhor Envio.');
        const formattedServices = responseData
            .filter(option => !option.error && ((option.company.name === 'Correios' && option.name === 'SEDEX') || option.company.name === 'Loggi'))
            .map(option => ({ code: option.id, name: `${option.company.name} - ${option.name}`, price: parseFloat(option.price), deliveryTime: option.delivery_time }));
        res.status(200).json({ services: formattedServices, addressInfo });
    } catch (error) {
        console.error("ERRO AO CALCULAR FRETE:", error.message);
        res.status(500).json({ error: error.message || 'Não foi possível calcular o frete.' });
    }
});

// ROTA DE WEBHOOK PARA NOTIFICAÇÕES DO MERCADO PAGO
app.post('/notificacao-pagamento', async (req, res) => {
    if (MP_WEBHOOK_SECRET) {
        const signature = req.headers['x-signature'];
        const parts = signature ? signature.split(',') : [];
        const timestampPart = parts.find(p => p.startsWith('ts='));
        const signatureHashPart = parts.find(p => p.startsWith('v1='));
        if (!timestampPart || !signatureHashPart) return res.status(401).send('Invalid signature format');
        const timestamp = timestampPart.replace('ts=', '');
        const signatureHash = signatureHashPart.replace('v1=', '');
        const message = `id:${req.query.id};ts:${timestamp};`;
        const hmac = crypto.createHmac('sha256', MP_WEBHOOK_SECRET);
        hmac.update(message);
        const expectedSignature = hmac.digest('hex');
        if (expectedSignature !== signatureHash) return res.status(401).send('Invalid signature');
    }
    const topic = req.query.topic || req.query.type;
    if (topic === 'payment') {
        try {
            const paymentId = req.query.id || req.query['data.id'];
            const payment = await new Payment(client).get({ id: paymentId });
            if (payment && payment.external_reference) {
                const pedidoId = payment.external_reference;
                const [rows] = await db.query('SELECT * FROM pedidos WHERE id = ?', [pedidoId]);
                if (rows.length > 0) {
                    const pedidoDoBanco = rows[0];
                    const novoStatus = payment.status === 'approved' ? 'PAGO' : 'PAGAMENTO_PENDENTE';
                    if (pedidoDoBanco.status !== 'PAGO' && pedidoDoBanco.status !== novoStatus) {
                        await db.query("UPDATE pedidos SET status = ?, mercado_pago_id = ? WHERE id = ?", [novoStatus, payment.id, pedidoId]);
                        console.log(`Status do Pedido #${pedidoId} atualizado para: ${novoStatus}`);
                        if (novoStatus === 'PAGO') {
                            await enviarEmailDeConfirmacao({ ...pedidoDoBanco, mercado_pago_id: payment.id });
                            await inserirPedidoNoCarrinhoME(pedidoDoBanco);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('ERRO AO PROCESSAR NOTIFICAÇÃO DE PAGAMENTO:', error);
        }
    }
    res.status(200).send('Notificação recebida');
});

// ROTA DE WEBHOOK DO MELHOR ENVIO PARA RASTREIO
app.post('/webhook-melhorenvio', async (req, res) => {
    console.log("LOG: Notificação do Melhor Envio recebida:", req.body);
    try {
        const { resource, event } = req.body;
        if (event === "tracking" && resource && resource.tracking) {
            const { id, tracking } = resource;
            const [rows] = await db.query("SELECT * FROM pedidos WHERE melhor_envio_id = ?", [id]);
            if (rows.length > 0) {
                const pedido = rows[0];
                await db.query("UPDATE pedidos SET codigo_rastreio = ? WHERE id = ?", [tracking, pedido.id]);
                await enviarEmailComRastreio(pedido, tracking);
            }
        }
        res.status(200).send("Webhook do Melhor Envio processado com sucesso");
    } catch (error) {
        console.error("ERRO AO PROCESSAR WEBHOOK DO MELHOR ENVIO:", error);
        res.status(500).send("Erro no processamento do webhook");
    }
});

// ROTA PARA CHECAR PEDIDOS EXPIRADOS
app.get('/checar-pedidos-expirados', async (req, res) => {
    console.log("LOG: Iniciando checagem de pedidos expirados.");
    try {
        const [pedidosExpirados] = await db.query("SELECT * FROM pedidos WHERE status = 'AGUARDANDO_PAGAMENTO' AND expiracao_pix < NOW();");
        for (const pedido of pedidosExpirados) {
            await db.query("UPDATE pedidos SET status = 'CANCELADO_POR_EXPIRACAO' WHERE id = ?", [pedido.id]);
            await enviarEmailDeExpiracao(pedido);
            console.log(`Pedido #${pedido.id} cancelado por expiração e e-mail enviado.`);
        }
        res.status(200).json({ message: `Checagem concluída. ${pedidosExpirados.length} pedidos atualizados.` });
    } catch (error) {
        console.error("ERRO ao checar pedidos expirados:", error.message, error.stack);
        res.status(500).json({ error: "Erro interno na checagem de pedidos." });
    }
});

// --- FUNÇÕES AUXILIARES ---
async function enviarEmailDeConfirmacao(pedido) {
    const itens = JSON.parse(pedido.itens_pedido);
    const frete = JSON.parse(pedido.info_frete);
    const emailBody = `<h1>🎉 Pedido Confirmado! (Nº ${pedido.id})</h1><p>Olá, ${pedido.nome_cliente}. Seu pagamento foi aprovado!</p><p><strong>ID do Pagamento (Mercado Pago):</strong> ${pedido.mercado_pago_id}</p><hr><h2>Endereço de Entrega</h2><p>${pedido.endereco_entrega}</p><hr><h2>Detalhes do Pedido</h2><ul>${itens.map(item => `<li>${item.quantity}x ${item.title} - R$ ${Number(item.unit_price).toFixed(2)} cada</li>`).join('')}</ul><hr><h2>Valores</h2><p><strong>Frete (${frete.name}):</strong> R$ ${Number(frete.price).toFixed(2)}</p><h3><strong>Total:</strong> R$ ${Number(pedido.valor_total).toFixed(2)}</h3>`;
    try {
        await transporter.sendMail({ from: `"Carlton" <${EMAIL_USER}>`, to: EMAIL_TO, bcc: pedido.email_cliente, subject: `Confirmação do Pedido #${pedido.id}`, html: emailBody });
        console.log(`E-mail de confirmação para o pedido #${pedido.id} enviado com sucesso.`);
    } catch (error) {
        console.error(`ERRO ao enviar e-mail para o pedido #${pedido.id}:`, error.message);
    }
}

async function enviarEmailComRastreio(pedido, trackingCode) {
    const emailBody = `<h1>📦 Seu pedido foi postado!</h1><p>Olá, ${pedido.nome_cliente}.</p><p>Seu pedido <strong>#${pedido.id}</strong> já foi enviado.</p><p><strong>Código de rastreio:</strong> ${trackingCode}</p><p>Acompanhe pelo site dos Correios ou Melhor Envio.</p>`;
    try {
        await transporter.sendMail({ from: `"Carlton" <${EMAIL_USER}>`, to: pedido.email_cliente, subject: `Código de Rastreio - Pedido #${pedido.id}`, html: emailBody });
        console.log(`E-mail de rastreio enviado para o pedido #${pedido.id}.`);
    } catch (error) {
        console.error(`Erro ao enviar e-mail de rastreio para o pedido #${pedido.id}:`, error.message);
    }
}

async function enviarEmailDeExpiracao(pedido) {
    const emailBody = `<h1>⚠️ Pagamento não confirmado para o Pedido #${pedido.id}</h1><p>Olá, ${pedido.nome_cliente}.</p><p>Notamos que o pagamento referente ao seu pedido <strong>#${pedido.id}</strong> ainda não foi confirmado.</p><p>O link para pagamento via PIX expirou. Se ainda deseja os produtos, por favor, realize um novo pedido.</p><hr><p>Atenciosamente,</p><p>Equipe Carlton</p>`;
    try {
        await transporter.sendMail({ from: `"Carlton" <${EMAIL_USER}>`, to: pedido.email_cliente, subject: `Aviso: Pagamento Pendente para o Pedido #${pedido.id}`, html: emailBody });
        console.log(`E-mail de expiração enviado para o pedido #${pedido.id}.`);
    } catch (error) {
        console.error(`Erro ao enviar e-mail de expiração para o pedido #${pedido.id}:`, error.message);
    }
}

async function inserirPedidoNoCarrinhoME(pedido) {
    console.log(`Iniciando inserção no carrinho Melhor Envio para o pedido #${pedido.id}`);
    const itens = JSON.parse(pedido.itens_pedido);
    const frete = JSON.parse(pedido.info_frete);
    const subtotal = itens.reduce((sum, item) => sum + item.unit_price * item.quantity, 0);
    const pesoTotal = itens.reduce((sum, item) => sum + (0.3 * item.quantity), 0);
    const payload = {
        service: frete.code,
        from: { name: SENDER_NAME, phone: SENDER_PHONE.replace(/\D/g, ''), email: SENDER_EMAIL, document: SENDER_DOCUMENT.replace(/\D/g, ''), address: SENDER_STREET, complement: SENDER_COMPLEMENT, number: SENDER_NUMBER, district: SENDER_DISTRICT, city: SENDER_CITY, state_abbr: SENDER_STATE_ABBR, country_id: "BR", postal_code: SENDER_CEP.replace(/\D/g, '') },
        to: { name: pedido.nome_cliente, phone: pedido.telefone_cliente.replace(/\D/g, ''), email: pedido.email_cliente, document: pedido.cpf_cliente.replace(/\D/g, ''), address: pedido.logradouro, complement: pedido.complemento, number: pedido.numero, district: pedido.bairro, city: pedido.cidade, state_abbr: pedido.estado, country_id: "BR", postal_code: pedido.cep.replace(/\D/g, '') },
        products: itens.map(item => ({ name: item.title || item.id, quantity: item.quantity, unitary_value: item.unit_price, height: 10, width: 15, length: 20, weight: 0.3 })),
        volumes: [{ height: 10, width: 15, length: 20, weight: Math.max(0.01, pesoTotal) }],
        options: { insurance_value: Math.max(1, subtotal), receipt: false, own_hand: false, reverse: false, non_commercial: true, tags: [{ tag: `Pedido #${pedido.id}`, url: null }] },
    };
    const response = await fetch('https://www.melhorenvio.com.br/api/v2/me/cart', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${MELHOR_ENVIO_TOKEN}`, 'User-Agent': 'Carlton (carltoncoletivo@audionoiseskatevisual.com)' },
        body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) {
        console.error("Payload enviado para o Melhor Envio:", JSON.stringify(payload, null, 2));
        throw new Error(JSON.stringify(data.error || 'Erro ao inserir no carrinho Melhor Envio.'));
    }
    const melhorEnvioId = data.id;
    if (melhorEnvioId) {
        await db.query("UPDATE pedidos SET melhor_envio_id = ? WHERE id = ?", [melhorEnvioId, pedido.id]);
        console.log(`ID do Melhor Envio (${melhorEnvioId}) salvo para o pedido #${pedido.id}.`);
    }
    console.log(`Pedido #${pedido.id} inserido no carrinho do Melhor Envio com sucesso.`);
}

// ROTA PARA O CLIENTE RASTREAR O PEDIDO
app.post('/rastrear-pedido', async (req, res) => {
    console.log("LOG: Recebida solicitação para rastrear pedido:", req.body);
    const { pedidoId: codigoRastreio, email } = req.body;
    if (!codigoRastreio || !email) {
        return res.status(400).json({ error: 'Código de rastreio e e-mail são obrigatórios.' });
    }
    try {
        const sql = `SELECT id, status, codigo_rastreio, data_criacao FROM pedidos WHERE codigo_rastreio = ? AND email_cliente = ?`;
        const [rows] = await db.query(sql, [codigoRastreio, email]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Código de rastreio não encontrado ou e-mail incorreto.' });
        }
        res.status(200).json(rows[0]);
    } catch (error) {
        console.error("ERRO AO BUSCAR PEDIDO PELO CÓDIGO DE RASTREIO:", error);
        res.status(500).json({ error: 'Ocorreu um erro interno. Por favor, tente mais tarde.' });
    }
});

// --- INICIAR SERVIDOR ---
app.listen(port, () => {
    console.log(`🚀 Servidor rodando na porta ${port}`);
});
