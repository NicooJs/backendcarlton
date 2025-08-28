import express from 'express';
import cors from 'cors';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import nodemailer from 'nodemailer';
import db from './db.js'; // Importa a conexão do banco de dados

// --- CONFIGURAÇÃO INICIAL ---
dotenv.config();
const app = express();
const port = process.env.PORT || 4000;
app.use(cors());
app.use(express.json());

// --- VARIÁVEIS DE AMBIENTE ---
const {
    MP_ACCESS_TOKEN,
    MELHOR_ENVIO_TOKEN,
    SENDER_CEP,
    BACKEND_URL,
    FRONTEND_URL,
    EMAIL_HOST,
    EMAIL_PORT,
    EMAIL_SECURE,
    EMAIL_USER,
    EMAIL_PASS,
    EMAIL_TO
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

        // 1. SALVA O PEDIDO NO BANCO DE DADOS
        // ATENÇÃO: Adapte os nomes das colunas (nome_cliente, email_cliente, etc.) para os nomes da SUA tabela.
        const sql = `
            INSERT INTO pedidos (nome_cliente, email_cliente, cpf_cliente, telefone_cliente, endereco_entrega, itens_pedido, info_frete, valor_total, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'AGUARDANDO_PAGAMENTO');
        `;
        const [result] = await db.query(sql, [
            `${customerInfo.firstName} ${customerInfo.lastName}`,
            customerInfo.email,
            customerInfo.cpf,
            customerInfo.phone,
            fullAddress,
            JSON.stringify(items),
            JSON.stringify(selectedShipping),
            total
        ]);
        const novoPedidoId = result.insertId;

        // 2. CRIA A PREFERÊNCIA DE PAGAMENTO USANDO O ID DO NOSSO PEDIDO
        const preferenceBody = {
            items: items,
            payer: {
                first_name: customerInfo.firstName,
                email: customerInfo.email,
            },
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


// ROTA /calcular-frete (Sem alterações)
app.post('/calcular-frete', async (req, res) => {
    // ... Seu código de cálculo de frete original e funcional continua aqui ...
    // Nenhuma alteração foi necessária nesta rota.
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
        const formattedServices = shippingOptions.filter(option => !option.error).map(option => ({ code: option.id, name: `${option.company.name} - ${option.name}`, price: parseFloat(option.price), deliveryTime: option.delivery_time }));
        res.status(200).json({ services: formattedServices, addressInfo: { logradouro: addressInfo.logradouro, bairro: addressInfo.bairro, localidade: addressInfo.localidade, uf: addressInfo.uf }});
    } catch (error) {
        console.error("ERRO AO CALCULAR FRETE:", error.message);
        res.status(500).json({ error: error.message || 'Não foi possível calcular o frete.' });
    }
});


// ROTA DE WEBHOOK PARA NOTIFICAÇÕES DO MERCADO PAGO
app.post('/notificacao-pagamento', async (req, res) => {
    console.log('LOG: Notificação recebida:', req.query);
    try {
        const { query } = req;
        const topic = query.topic || query.type;

        if (topic === 'payment') {
            const paymentId = query.id;
            const payment = await new Payment(client).get({ id: paymentId });

            if (payment.status === 'approved' && payment.external_reference) {
                const pedidoId = payment.external_reference;

                // 1. BUSCA O PEDIDO NO BANCO DE DADOS
                // ATENÇÃO: Adapte o nome da tabela 'pedidos' e das colunas se forem diferentes.
                const [rows] = await db.query('SELECT * FROM pedidos WHERE id = ?', [pedidoId]);
                if (rows.length === 0) throw new Error(`Pedido ${pedidoId} não encontrado no banco de dados.`);
                
                const pedidoDoBanco = rows[0];

                if (pedidoDoBanco.status !== 'AGUARDANDO_PAGAMENTO') {
                    console.log(`Pedido ${pedidoId} já foi processado. Status atual: ${pedidoDoBanco.status}`);
                    return res.status(200).send('Notificação já processada.');
                }

                // 2. ATUALIZA O STATUS DO PEDIDO PARA 'PAGO'
                // ATENÇÃO: Adapte os nomes das colunas 'status' e 'mercado_pago_id' se forem diferentes.
                await db.query("UPDATE pedidos SET status = 'PAGO', mercado_pago_id = ? WHERE id = ?", [payment.id, pedidoId]);

                // 3. ENVIA O E-MAIL DE CONFIRMAÇÃO
                await enviarEmailDeConfirmacao({ ...pedidoDoBanco, mercado_pago_id: payment.id });

                console.log(`✅ Pedido ${pedidoId} APROVADO e processado com sucesso!`);
            }
        }
        res.status(200).send('Notificação recebida');
    } catch (error) {
        console.error('ERRO AO PROCESSAR NOTIFICAÇÃO:', error);
        res.status(500).send('Erro no servidor ao processar notificação.');
    }
});


// --- FUNÇÃO AUXILIAR DE ENVIO DE E-MAIL ---
async function enviarEmailDeConfirmacao(pedido) {
    // ATENÇÃO: Adapte os nomes das propriedades (pedido.itens_pedido, pedido.info_frete, etc.)
    // para corresponderem aos nomes das colunas retornadas do seu banco de dados.
    const itens = JSON.parse(pedido.itens_pedido);
    const frete = JSON.parse(pedido.info_frete);
    
    const emailBody = `
      <h1>🎉 Novo Pedido Recebido! (Nº ${pedido.id})</h1>
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
            bcc: pedido.email_cliente, // Envia cópia oculta para o cliente
            subject: `Confirmação do Pedido #${pedido.id}`,
            html: emailBody,
        });
        console.log(`E-mail de confirmação para o pedido #${pedido.id} enviado com sucesso.`);
    } catch (error) {
        console.error(`ERRO ao enviar e-mail para o pedido #${pedido.id}:`, error);
    }
}


// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(port, () => {
    console.log(`Servidor backend rodando na porta ${port}`);
});
