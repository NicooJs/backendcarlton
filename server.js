/* ================================================================================ 
|   ARQUIVO DO SERVIDOR BACKEND - VERSÃO FINAL E CORRIGIDA                     | 
================================================================================ */

import express from 'express';
import cors from 'cors';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import nodemailer from 'nodemailer';
import db from './db.js';

// --- CONFIGURAÇÃO INICIAL ---
dotenv.config();
const app = express();
const port = process.env.PORT || 4000;
app.use(cors());
app.use(express.json());

// --- VARIÁVEIS DE AMBIENTE ---
const {
    MP_ACCESS_TOKEN, MELHOR_ENVIO_TOKEN, SENDER_CEP, BACKEND_URL,
    FRONTEND_URL, EMAIL_HOST, EMAIL_PORT, EMAIL_SECURE, EMAIL_USER,
    EMAIL_PASS, EMAIL_TO, SENDER_NAME, SENDER_PHONE, SENDER_EMAIL,
    SENDER_DOCUMENT, SENDER_STREET, SENDER_NUMBER, SENDER_COMPLEMENT,
    SENDER_DISTRICT, SENDER_CITY, SENDER_STATE_ABBR
} = process.env;

// Validação das variáveis de ambiente
if (!MP_ACCESS_TOKEN || !MELHOR_ENVIO_TOKEN || !BACKEND_URL || !FRONTEND_URL || !EMAIL_USER || !db) {
    console.error("ERRO CRÍTICO: Verifique todas as variáveis de ambiente e a conexão com o banco de dados.");
    process.exit(1);
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
                itens_pedido, info_frete, valor_total, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AGUARDANDO_PAGAMENTO');`;

        const [result] = await db.query(sql, [
            `${customerInfo.firstName} ${customerInfo.lastName}`, customerInfo.email,
            customerInfo.cpf.replace(/\D/g, ''), customerInfo.phone.replace(/\D/g, ''),
            fullAddress, customerInfo.cep.replace(/\D/g, ''), customerInfo.address,
            customerInfo.number, customerInfo.complement, customerInfo.neighborhood,
            customerInfo.city, customerInfo.state, JSON.stringify(items),
            JSON.stringify(selectedShipping), total
        ]);
        const novoPedidoId = result.insertId;

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
            }
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
        const viaCepResponse = await fetch(viaCepUrl);
        const addressInfo = await viaCepResponse.json();
        if (addressInfo.erro) throw new Error("CEP de destino não encontrado.");
        const shipmentPayload = {
            from: { postal_code: SENDER_CEP.replace(/\D/g, '') },
            to: { postal_code: cleanCepDestino },
            products: items.map(item => ({ id: item.id, width: 15, height: 10, length: 20, weight: 0.3, insurance_value: item.unit_price, quantity: item.quantity })),
            options: { receipt: false, own_hand: false },
        };
        const meResponse = await fetch('https://www.melhorenvio.com.br/api/v2/me/shipment/calculate', {
            method: 'POST',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${MELHOR_ENVIO_TOKEN}`, 'User-Agent': 'Sua Loja (contato@seusite.com)'},
            body: JSON.stringify(shipmentPayload)
        });
        if (!meResponse.ok) {
            const errorData = await meResponse.json();
            throw new Error(errorData.message || 'Erro ao comunicar com a Melhor Envio.');
        }
        const shippingOptions = await meResponse.json();

        // ===== INÍCIO DA MODIFICAÇÃO =====
        const formattedServices = shippingOptions
            .filter(option => {
                if (option.error) return false; // Remove opções com erro
                const isSedex = option.company.name === 'Correios' && option.name === 'SEDEX';
                const isLoggi = option.company.name === 'Loggi';
                return isSedex || isLoggi; // Mantém apenas se for Sedex OU Loggi
            })
            .map(option => ({ 
                code: option.id, 
                name: `${option.company.name} - ${option.name}`, 
                price: parseFloat(option.price), 
                deliveryTime: option.delivery_time 
            }));
        // ===== FIM DA MODIFICAÇÃO =====

        res.status(200).json({ services: formattedServices, addressInfo: { logradouro: addressInfo.logradouro, bairro: addressInfo.bairro, localidade: addressInfo.localidade, uf: addressInfo.uf }});
    } catch (error) {
        console.error("ERRO AO CALCULAR FRETE:", error.message);
        res.status(500).json({ error: error.message || 'Não foi possível calcular o frete.' });
    }
});

// ROTA DE WEBHOOK PARA NOTIFICAÇÕES DO MERCADO PAGO
app.post('/notificacao-pagamento', async (req, res) => {
    console.log('LOG: Notificação recebida:', req.query);
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

                    if (pedidoDoBanco.status === 'PAGO') {
                        console.log(`Pedido ${pedidoId} já está PAGO. Nenhuma ação necessária.`);
                    } else {
                        const novoStatus = payment.status === 'approved' ? 'PAGO' : 'PAGAMENTO_PENDENTE';
                        
                        if (pedidoDoBanco.status !== novoStatus) {
                            await db.query("UPDATE pedidos SET status = ?, mercado_pago_id = ? WHERE id = ?", [novoStatus, payment.id, pedidoId]);
                            console.log(`Status do Pedido #${pedidoId} atualizado para: ${novoStatus}`);
                        }

                        if (novoStatus === 'PAGO') {
                            await enviarEmailDeConfirmacao({ ...pedidoDoBanco, mercado_pago_id: payment.id });
                        }
                        
                        if (!pedidoDoBanco.melhor_envio_id) {
                            await inserirPedidoNoCarrinhoME(pedidoDoBanco);
                        } else {
                            console.log(`Etiqueta Melhor Envio para o pedido #${pedidoId} já foi gerada.`);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('ERRO AO PROCESSAR NOTIFICAÇÃO DE PAGAMENTO:', error);
        }
    } else {
        console.log(`LOG: Notificação do tipo '${topic}' recebida e ignorada.`);
    }
    
    res.status(200).send('Notificação recebida');
});


// --- FUNÇÃO AUXILIAR DE ENVIO DE E-MAIL ---
async function enviarEmailDeConfirmacao(pedido) {
    const itens = typeof pedido.itens_pedido === 'string' ? JSON.parse(pedido.itens_pedido) : pedido.itens_pedido;
    const frete = typeof pedido.info_frete === 'string' ? JSON.parse(pedido.info_frete) : pedido.info_frete;
    
    const emailBody = `
      <h1>🎉 Pedido Confirmado! (Nº ${pedido.id})</h1>
      <p>Olá, ${pedido.nome_cliente}. Seu pagamento foi aprovado!</p>
      <p><strong>ID do Pagamento (Mercado Pago):</strong> ${pedido.mercado_pago_id}</p>
      <hr>
      <h2>Dados do Cliente</h2>
      <p><strong>Nome:</strong> ${pedido.nome_cliente}</p>
      <p><strong>E-mail:</strong> ${pedido.email_cliente}</p>
      <p><strong>CPF:</strong> ${pedido.cpf_cliente}</p>
      <p><strong>Telefone:</strong> ${pedido.telefone_cliente}</p>
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
            from: `"Sua Loja" <${EMAIL_USER}>`,
            to: EMAIL_TO,
            bcc: pedido.email_cliente,
            subject: `Confirmação do Pedido #${pedido.id}`,
            html: emailBody,
        });
        console.log(`E-mail de confirmação para o pedido #${pedido.id} enviado com sucesso.`);
    } catch (error) {
        console.error(`ERRO ao enviar e-mail para o pedido #${pedido.id}:`, error);
    }
}


// --- FUNÇÃO: INSERIR PEDIDO NO CARRINHO DO MELHOR ENVIO ---
async function inserirPedidoNoCarrinhoME(pedido) {
    console.log(`Iniciando inserção no carrinho Melhor Envio para o pedido #${pedido.id}`);
    
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
            name: item.title,
            quantity: item.quantity,
            unitary_value: item.unit_price,
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
            'User-Agent': 'Sua Loja (contato@seusite.com)'
        },
        body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) {
        console.error("Payload enviado para o Melhor Envio:", JSON.stringify(payload, null, 2));
        console.error("Resposta de erro do Melhor Envio:", data);
        throw new Error(JSON.stringify(data.error || 'Erro ao adicionar etiqueta ao carrinho do Melhor Envio.'));
    }

    const melhorEnvioId = data.id;
    console.log(`SUCESSO! Pedido #${pedido.id} inserido no carrinho Melhor Envio com ID: ${melhorEnvioId}`);

    await db.query("UPDATE pedidos SET melhor_envio_id = ? WHERE id = ?", [melhorEnvioId, pedido.id]);
    console.log(`ID do Melhor Envio salvo no banco para o pedido #${pedido.id}.`);
}

// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(port, () => {
    console.log(`Servidor backend rodando na porta ${port}`);
});
