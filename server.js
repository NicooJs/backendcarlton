import express from 'express';
import cors from 'cors';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

// Carrega as variáveis de ambiente do arquivo .env
dotenv.config();

// Configuração inicial do Express
const app = express();
const port = process.env.PORT || 4000;
app.use(cors());
app.use(express.json());

// --- Variáveis de Ambiente ---
const mpAccessToken = process.env.MP_ACCESS_TOKEN;
const meApiToken = process.env.MELHOR_ENVIO_TOKEN;
const senderCep = process.env.SENDER_CEP;
const backendUrl = process.env.BACKEND_URL; // ALTERAÇÃO 1: Removido o valor padrão para forçar a configuração
const frontendUrl = process.env.FRONTEND_URL; // ALTERAÇÃO 2: Adicionada a URL do frontend para os redirects

// Validação das variáveis de ambiente
if (!mpAccessToken) {
  console.error("ERRO CRÍTICO: Access Token do Mercado Pago (MP_ACCESS_TOKEN) não encontrado no .env.");
  process.exit(1);
}
if (!meApiToken) {
  console.error("ERRO CRÍTICO: Token da Melhor Envio (MELHOR_ENVIO_TOKEN) não encontrado no .env.");
  process.exit(1);
}
if (!senderCep || senderCep === "SEU_CEP_DE_ORIGEM_EX:12345678") { // ALTERAÇÃO 3: Verificação aprimorada do CEP
    console.error("ERRO CRÍTICO: CEP de Origem (SENDER_CEP) não configurado corretamente no .env.");
    process.exit(1);
}
// ALTERAÇÃO 4: Adicionada validação para as URLs
if (!backendUrl) {
    console.error("ERRO CRÍTICO: URL do Backend (BACKEND_URL) não encontrada no .env. Para dev, use a URL do ngrok.");
    process.exit(1);
}
if (!frontendUrl) {
    console.error("ERRO CRÍTICO: URL do Frontend (FRONTEND_URL) não encontrada no .env.");
    process.exit(1);
}


// Configuração do Cliente Mercado Pago
const client = new MercadoPagoConfig({ accessToken: mpAccessToken });

// ------------------- ROTAS DA APLICAÇÃO -------------------

// ROTA /criar-preferencia
app.post('/criar-preferencia', async (req, res) => {
    // ALTERAÇÃO 5: Log detalhado para depuração do que o frontend está enviando
    console.log("LOG: Corpo da requisição recebido em /criar-preferencia:");
    console.log(JSON.stringify(req.body, null, 2));

    try {
        const { items, payerInfo, shipmentCost } = req.body;

        // Validação básica de entrada
        if (!items || !payerInfo || shipmentCost === undefined) {
            return res.status(400).json({ error: 'Dados incompletos para criar a preferência.' });
        }

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
            payment_methods: {
                // Para não aceitar boleto, por exemplo, descomente a linha abaixo
                // excluded_payment_types: [{ id: "ticket" }],
            },
            // URL para onde o Mercado Pago enviará a notificação de pagamento (Webhook)
            notification_url: `${backendUrl}/notificacao-pagamento`,
            // ALTERAÇÃO 6: Uso da variável de ambiente para as URLs de retorno
            back_urls: {
                success: `${frontendUrl}/sucesso`,
                failure: `${frontendUrl}/falha`,
                pending: `${frontendUrl}/pendente`
            }
        };

        const preference = new Preference(client);
        const result = await preference.create({ body: preferenceBody });

        console.log("SUCESSO! Preferência criada com ID:", result.id);
        res.status(201).json({
            id: result.id,
            init_point: result.init_point
        });

    } catch (error) {
        console.error("ERRO AO CRIAR PREFERÊNCIA:", JSON.stringify(error, null, 2));
        res.status(500).json({
            error: 'Erro ao criar a preferência de pagamento.',
            // O `cause` do SDK v3 já contém informações detalhadas do erro da API
            details: error.cause
        });
    }
});

// ROTA /calcular-frete (Sem alterações funcionais, apenas log adicionado)
app.post('/calcular-frete', async (req, res) => {
    console.log("LOG: Corpo da requisição recebido em /calcular-frete:");
    console.log(JSON.stringify(req.body, null, 2));

    const { cepDestino, items } = req.body;

    if (!cepDestino || !items || items.length === 0) {
        return res.status(400).json({ error: 'CEP de destino e lista de itens são obrigatórios.' });
    }
    const cleanCepDestino = cepDestino.replace(/\D/g, '');

    try {
        const viaCepUrl = `https://viacep.com.br/ws/${cleanCepDestino}/json/`;
        const viaCepResponse = await fetch(viaCepUrl);
        const addressInfo = await viaCepResponse.json();
        if (addressInfo.erro) throw new Error("CEP de destino não encontrado.");

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
                'Authorization': `Bearer ${meApiToken}`, 'User-Agent': 'Sua Loja (contato@seusite.com)'
            },
            body: JSON.stringify(shipmentPayload)
        });

        if (!meResponse.ok) {
            const errorData = await meResponse.json();
            console.error("ERRO API MELHOR ENVIO:", errorData);
            throw new Error(errorData.message || 'Erro ao comunicar com a Melhor Envio.');
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

    console.log('LOG: Notificação recebida:', { topic, id: query.id });

    try {
        if (topic === 'payment') {
            const paymentId = query.id;
            const payment = await new Payment(client).get({ id: paymentId });

            console.log('LOG: Detalhes do Pagamento obtidos via Webhook:', {
                id: payment.id,
                status: payment.status,
                status_detail: payment.status_detail,
                payment_method_id: payment.payment_method_id,
            });

            if (payment.status === 'approved') {
                console.log(`✅ Pagamento ${paymentId} APROVADO!`);
                // AQUI VOCÊ DEVE ATUALIZAR SEU BANCO DE DADOS
            } else {
                console.log(`❕ Pagamento ${paymentId} com status: ${payment.status}`);
            }
        }
        res.status(200).send('Notificação recebida');
    } catch (error) {
        console.error('ERRO AO PROCESSAR NOTIFICAÇÃO:', error);
        res.status(500).send('Erro no servidor ao processar notificação.');
    }
});


// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(port, () => {
    console.log(`Servidor backend rodando na porta ${port}`);
});
