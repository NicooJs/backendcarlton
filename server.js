// ------------------- IMPORTS -------------------
import express from 'express';
import cors from 'cors';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import nodemailer from 'nodemailer';
import db from './db.js'; // conexão mysql2/promise

// ------------------- CONFIGURAÇÃO INICIAL -------------------
dotenv.config();
const app = express();
const port = process.env.PORT || 4000;
app.use(cors());
app.use(express.json());

// ------------------- VARIÁVEIS DE AMBIENTE -------------------
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
  EMAIL_TO,
} = process.env;

if (!MP_ACCESS_TOKEN || !MELHOR_ENVIO_TOKEN || !BACKEND_URL || !FRONTEND_URL || !EMAIL_USER || !db) {
  console.error('ERRO CRÍTICO: Verifique variáveis de ambiente e conexão com o banco.');
  process.exit(1);
}

// ------------------- CONFIGURAÇÃO DOS SERVIÇOS -------------------
const client = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });

const transporter = nodemailer.createTransport({
  host: EMAIL_HOST,
  port: parseInt(EMAIL_PORT, 10),
  secure: EMAIL_SECURE === 'true',
  auth: { user: EMAIL_USER, pass: EMAIL_PASS },
});

// ------------------- ROTA /criar-preferencia -------------------
app.post('/criar-preferencia', async (req, res) => {
  console.log('LOG: Corpo recebido em /criar-preferencia:', JSON.stringify(req.body, null, 2));
  try {
    const { items, customerInfo, selectedShipping, shipmentCost } = req.body;

    if (!items || !customerInfo || !selectedShipping || shipmentCost === undefined) {
      return res.status(400).json({ error: 'Dados incompletos para criar a preferência.' });
    }

    const total = items.reduce((sum, item) => sum + item.unit_price * item.quantity, 0) + shipmentCost;

    // 1. SALVA O PEDIDO NO BANCO DE DADOS
    const sql = `
      INSERT INTO pedidos (
        nome_cliente, sobrenome_cliente, cpf_cliente, email_cliente, telefone_cliente,
        cep_cliente, endereco_cliente, numero_cliente, complemento_cliente,
        bairro_cliente, cidade_cliente, estado_cliente,
        itens_pedido, valor_total, info_frete, shipment_cost, status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AGUARDANDO_PAGAMENTO');
    `;

    const [result] = await db.query(sql, [
      customerInfo.firstName,
      customerInfo.lastName,
      customerInfo.cpf,
      customerInfo.email,
      customerInfo.phone,
      customerInfo.cep,
      customerInfo.address,
      customerInfo.number,
      customerInfo.complement,
      customerInfo.neighborhood,
      customerInfo.city,
      customerInfo.state,
      JSON.stringify(items),
      total,
      JSON.stringify(selectedShipping),
      shipmentCost,
    ]);

    const novoPedidoId = result.insertId;

    // 2. CRIA A PREFERÊNCIA NO MERCADO PAGO
    const preferenceBody = {
      items,
      payer: {
        first_name: customerInfo.firstName,
        last_name: customerInfo.lastName,
        email: customerInfo.email,
        identification: { type: 'CPF', number: customerInfo.cpf },
      },
      shipments: { cost: Number(shipmentCost) },
      external_reference: novoPedidoId.toString(),
      notification_url: `${BACKEND_URL}/notificacao-pagamento`,
      back_urls: {
        success: `${FRONTEND_URL}/sucesso`,
        failure: `${FRONTEND_URL}/falha`,
        pending: `${FRONTEND_URL}/pendente`,
      },
    };

    const preference = new Preference(client);
    const preferenceResult = await preference.create({ body: preferenceBody });

    console.log(`✅ Pedido #${novoPedidoId} salvo. Preferência ${preferenceResult.id} criada.`);
    res.status(201).json({ id: preferenceResult.id, init_point: preferenceResult.init_point });
  } catch (error) {
    console.error('ERRO AO CRIAR PREFERÊNCIA:', error);
    res.status(500).json({ error: 'Erro interno ao processar o pedido.' });
  }
});

// ------------------- ROTA WEBHOOK NOTIFICAÇÕES MERCADO PAGO -------------------
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

        // Busca no banco
        const [rows] = await db.query('SELECT * FROM pedidos WHERE id = ?', [pedidoId]);
        if (rows.length === 0) throw new Error(`Pedido ${pedidoId} não encontrado.`);
        const pedido = rows[0];

        if (pedido.status !== 'AGUARDANDO_PAGAMENTO') {
          console.log(`Pedido ${pedidoId} já processado. Status: ${pedido.status}`);
          return res.status(200).send('Notificação já processada.');
        }

        // Atualiza status
        await db.query("UPDATE pedidos SET status = 'PAGO', mercado_pago_id = ? WHERE id = ?", [
          payment.id,
          pedidoId,
        ]);

        // =========================================================================
        // ======================= INÍCIO DA ÁREA MODIFICADA =======================
        // =========================================================================

        // Criar pedido no Melhor Envio com todos os dados
        const itensDoPedido = JSON.parse(pedido.itens_pedido);
        const infoDoFrete = JSON.parse(pedido.info_frete);

        const mePayload = {
          service: infoDoFrete.id, // Usar o ID do serviço de frete
          from: {
            name: "Nome da Sua Loja", // <-- IMPORTANTE: Coloque o nome da sua loja
            postal_code: SENDER_CEP.replace(/\D/g, ''),
          },
          to: {
            name: `${pedido.nome_cliente} ${pedido.sobrenome_cliente}`,
            phone: pedido.telefone_cliente.replace(/\D/g, ''),
            email: pedido.email_cliente,
            document: pedido.cpf_cliente.replace(/\D/g, ''),
            address: pedido.endereco_cliente,
            number: pedido.numero_cliente,
            complement: pedido.complemento_cliente,
            district: pedido.bairro_cliente,
            city: pedido.cidade_cliente,
            state_abbr: pedido.estado_cliente,
            postal_code: pedido.cep_cliente.replace(/\D/g, ''),
            note: `Pedido #${pedido.id}`,
          },
          products: itensDoPedido.map(item => ({
            name: item.title,
            quantity: item.quantity,
            unitary_value: item.unit_price,
          })),
          volumes: [{
            weight: 0.3, // ATENÇÃO: Considere tornar isso dinâmico
            width: 20,
            height: 10,
            length: 20,
          }],
          options: {
            insurance_value: Number(pedido.valor_total),
            receipt: false,
            own_hand: false,
            non_commercial: true, // <-- MUITO IMPORTANTE: para gerar declaração de conteúdo
            platform: "Sua Loja",
            tags: [{ tag: `Pedido #${pedido.id}` }],
          },
        };

        const meResponse = await fetch('https://www.melhorenvio.com.br/api/v2/me/cart', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${MELHOR_ENVIO_TOKEN}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': 'Sua Loja (carltoncoletivo@audionoiseskatevisual.com)', // <-- IMPORTANTE: Use seu email
          },
          body: JSON.stringify(mePayload),
        });

        const meResult = await meResponse.json();

        // =======================================================================
        // ======================== FIM DA ÁREA MODIFICADA =======================
        // =======================================================================

        if (meResponse.ok && meResult.id) {
            console.log(`🚚 Pedido ${pedidoId} adicionado ao carrinho do Melhor Envio! ID: ${meResult.id}`);
            await db.query('UPDATE pedidos SET melhor_envio_id = ? WHERE id = ?', [meResult.id, pedidoId]);
        } else {
            // Log detalhado do erro para facilitar a depuração
            console.error(`❌ Erro ao adicionar pedido #${pedidoId} no Melhor Envio:`, JSON.stringify(meResult, null, 2));
        }

        // Email de confirmação
        await enviarEmailDeConfirmacao({ ...pedido, mercado_pago_id: payment.id });

        console.log(`✅ Pedido ${pedidoId} aprovado e processado!`);
      }
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('ERRO NA ROTA DE NOTIFICAÇÃO:', error);
    res.status(500).send('Erro ao processar notificação.');
  }
});

// ------------------- FUNÇÃO EMAIL -------------------
async function enviarEmailDeConfirmacao(pedido) {
  const itens = JSON.parse(pedido.itens_pedido);
  const frete = JSON.parse(pedido.info_frete);

  const emailBody = `
    <h1>🎉 Novo Pedido Recebido! (Nº ${pedido.id})</h1>
    <p><strong>ID Pagamento:</strong> ${pedido.mercado_pago_id}</p>
    <hr>
    <h2>Dados do Cliente</h2>
    <p><strong>Nome:</strong> ${pedido.nome_cliente} ${pedido.sobrenome_cliente}</p>
    <p><strong>CPF:</strong> ${pedido.cpf_cliente}</p>
    <p><strong>Email:</strong> ${pedido.email_cliente}</p>
    <p><strong>Telefone:</strong> ${pedido.telefone_cliente}</p>
    <hr>
    <h2>Endereço</h2>
    <p>${pedido.endereco_cliente}, ${pedido.numero_cliente} ${pedido.complemento_cliente || ''}</p>
    <p>${pedido.bairro_cliente} - ${pedido.cidade_cliente}/${pedido.estado_cliente}</p>
    <p>CEP: ${pedido.cep_cliente}</p>
    <hr>
    <h2>Itens</h2>
    <ul>
      ${itens.map(i => `<li>${i.quantity}x ${i.title} - R$ ${Number(i.unit_price).toFixed(2)}</li>`).join('')}
    </ul>
    <hr>
    <h2>Valores</h2>
    <p><strong>Frete:</strong> ${frete.name} - R$ ${Number(frete.price).toFixed(2)}</p>
    <h3>Total: R$ ${Number(pedido.valor_total).toFixed(2)}</h3>
  `;

  try {
    await transporter.sendMail({
      from: `"Sua Loja" <${EMAIL_USER}>`,
      to: EMAIL_TO,
      bcc: pedido.email_cliente,
      subject: `Confirmação Pedido #${pedido.id}`,
      html: emailBody,
    });
    console.log(`📧 Email do pedido #${pedido.id} enviado.`);
  } catch (err) {
    console.error(`Erro ao enviar email pedido #${pedido.id}:`, err);
  }
}

// ------------------- INICIALIZAÇÃO -------------------
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
