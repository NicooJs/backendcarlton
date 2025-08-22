import express from 'express';
import cors from 'cors';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago'; // Adicionado 'Payment'
import dotenv from 'dotenv';
import fetch from 'node-fetch';

// Carrega as variáveis de ambiente do arquivo .env
dotenv.config();

// Configuração inicial do Express
const app = express();
const port = process.env.PORT || 4000;
app.use(cors());
// Usamos express.json() para o corpo das requisições, e express.raw() para o webhook
app.use(express.json());


// --- Variáveis de Ambiente ---
const mpAccessToken = process.env.MP_ACCESS_TOKEN;
const meApiToken = process.env.MELHOR_ENVIO_TOKEN;
const senderCep = process.env.SENDER_CEP;
const backendUrl = process.env.BACKEND_URL || `http://localhost:${port}`; // URL base do seu backend

// Validação das variáveis de ambiente
if (!mpAccessToken) {
  console.error("ERRO CRÍTICO: Access Token do Mercado Pago (MP_ACCESS_TOKEN) não encontrado no .env.");
  process.exit(1);
}
if (!meApiToken) {
  console.error("ERRO CRÍTICO: Token da Melhor Envio (MELHOR_ENVIO_TOKEN) não encontrado no .env.");
  process.exit(1);
}
if (!senderCep) {
    console.error("ERRO CRÍTICO: CEP de Origem (SENDER_CEP) não encontrado no .env.");
    process.exit(1);
}

// Configuração do Cliente Mercado Pago
const client = new MercadoPagoConfig({ accessToken: mpAccessToken });

// ------------------- ROTAS DA APLICAÇÃO -------------------

// ROTA /criar-preferencia
app.post('/criar-preferencia', async (req, res) => {
    console.log("Criando preferência de pagamento...");

    try {
        const { items, payerInfo, shipmentCost } = req.body;

        const preferenceBody = {
            items: items,
            payer: {
                first_name: payerInfo.first_name,
                email: payerInfo.email,
                identification: {
                    type: payerInfo.identification.type,
                    number: payerInfo.identification.number
                }
            },
            shipments: {
                cost: Number(shipmentCost),
                mode: "not_specified",
            },
            // ▼▼▼ GARANTIA DOS MEIOS DE PAGAMENTO ▼▼▼
            // Este bloco garante que não estamos excluindo o PIX.
            // Por padrão, ele permite TUDO que sua conta aceita.
            payment_methods: {
                // Para não aceitar boleto, por exemplo, descomente a linha abaixo
                // excluded_payment_types: [{ id: "ticket" }],
            },
            // URL para onde o Mercado Pago enviará a notificação de pagamento
            notification_url: `${backendUrl}/notificacao-pagamento`,
            back_urls: {
                success: `https://seu-site.com/sucesso`, // Altere para sua URL de sucesso
                failure: `https://seu-site.com/falha`,   // Altere para sua URL de falha
                pending: `https://seu-site.com/pendente` // Altere para sua URL de pendente
            }
        };

        const preference = new Preference(client);
        const result = await preference.create({ body: preferenceBody });

        console.log("SUCESSO! Preferência criada:", result.id);
        res.status(201).json({
            id: result.id,
            init_point: result.init_point
        });

    } catch (error) {
        console.error("ERRO AO CRIAR PREFERÊNCIA:", JSON.stringify(error, null, 2));
        res.status(500).json({
            error: 'Erro ao criar a preferência de pagamento.',
            cause: error.cause
        });
    }
});

// ROTA /calcular-frete (Sem alterações)
app.post('/calcular-frete', async (req, res) => {
    // ... seu código de calcular frete com Melhor Envio continua aqui, sem alterações ...
    const { cepDestino, items } = req.body;
    const cleanCepDestino = cepDestino.replace(/\D/g, '');

    if (!items || items.length === 0) {
        return res.status(400).json({ error: 'A lista de itens não pode estar vazia.' });
    }

    try {
        const viaCepUrl = `https://viacep.com.br/ws/${cleanCepDestino}/json/`;
        const viaCepResponse = await fetch(viaCepUrl);
        const addressInfo = await viaCepResponse.json();
        if (addressInfo.erro) throw new Error("CEP não encontrado.");

        const shipmentPayload = {
            from: { postal_code: senderCep.replace(/\D/g, '') },
            to: { postal_code: cleanCepDestino },
            products: items.map(item => ({
                id: item.id, width: 15, height: 10, length: 20, weight: 0.3,
                insurance_value: item.unit_price, quantity: item.quantity,
            })),
            options: { receipt: false, own_hand: false },
        };

        const meResponse = await fetch('https://www.melhorenvio.com.br/api/v2/me/shipment/calculate', {
            method: 'POST',
            headers: {
                'Accept': 'application/json', 'Content-Type': 'application/json',
                'Authorization': `Bearer ${meApiToken}`, 'User-Agent': 'Sua Loja'
            },
            body: JSON.stringify(shipmentPayload)
        });

        if (!meResponse.ok) {
            const errorData = await meResponse.json();
            throw new Error(errorData.message || 'Erro na API da Melhor Envio.');
        }

        const shippingOptions = await meResponse.json();
        const formattedServices = shippingOptions
            .filter(option => !option.error)
            .map(option => ({
                code: option.id, name: `${option.company.name} - ${option.name}`,
                price: parseFloat(option.price), deliveryTime: option.delivery_time,
            }));

        res.status(200).json({
            services: formattedServices,
            addressInfo: {
                logradouro: addressInfo.logradouro, bairro: addressInfo.bairro,
                localidade: addressInfo.localidade, uf: addressInfo.uf
            }
        });

    } catch (error) {
        console.error("ERRO AO CALCULAR FRETE:", error.message);
        res.status(500).json({ error: error.message || 'Não foi possível calcular o frete.' });
    }
});


// ROTA DE WEBHOOK PARA NOTIFICAÇÕES DO MERCADO PAGO
app.post('/notificacao-pagamento', async (req, res) => {
    const { query } = req;
    const topic = query.topic || query.type;

    console.log('Recebi uma notificação:', { topic, id: query.id });

    try {
        if (topic === 'payment') {
            const paymentId = query.id;
            const payment = await new Payment(client).get({ id: paymentId });

            console.log('Detalhes do Pagamento:', {
                id: payment.id,
                status: payment.status,
                payment_method_id: payment.payment_method_id,
            });

            if (payment.status === 'approved') {
                console.log(`✅ Pagamento ${paymentId} APROVADO!`);
                // AQUI VOCÊ DEVE ATUALIZAR SEU BANCO DE DADOS
                // Ex: marcar o pedido como "PAGO"
                // Ex: enviar email de confirmação para o cliente
                // Ex: iniciar o processo de separação do produto
            } else {
                console.log(`❕ Pagamento ${paymentId} com status: ${payment.status}`);
            }
        }
        // É importante responder com status 200 para o Mercado Pago saber que você recebeu.
        res.status(200).send('Notificação recebida');
    } catch (error) {
        console.error('Erro ao processar notificação:', error);
        res.status(500).send('Erro no servidor');
    }
});


// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(port, () => {
    console.log(`Servidor backend rodando na porta ${port}`);
});
