import express from 'express';
import cors from 'cors';
import { MercadoPagoConfig, Preference } from 'mercadopago';
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
const meApiToken = process.env.MELHOR_ENVIO_TOKEN; // NOVO: Token da Melhor Envio
const senderCep = process.env.SENDER_CEP; // NOVO: CEP da sua loja/origem

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


// ------------------- ROTAS DA APLICAÇÃO -------------------

// ROTA /criar-preferencia (Nenhuma alteração necessária aqui)
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
        };

        const client = new MercadoPagoConfig({ accessToken: mpAccessToken });
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

// ROTA /calcular-frete (Totalmente refeita para Melhor Envio)
app.post('/calcular-frete', async (req, res) => {
    const { cepDestino, items } = req.body;
    const cleanCepDestino = cepDestino.replace(/\D/g, '');

    if (!items || items.length === 0) {
        return res.status(400).json({ error: 'A lista de itens não pode estar vazia.' });
    }

    try {
        // --- 1. Buscar dados do endereço pelo ViaCEP (para UX no frontend) ---
        const viaCepUrl = `https://viacep.com.br/ws/${cleanCepDestino}/json/`;
        const viaCepResponse = await fetch(viaCepUrl);
        const addressInfo = await viaCepResponse.json();

        if (addressInfo.erro) {
            throw new Error("CEP não encontrado. Verifique o número.");
        }

        // --- 2. Preparar os dados para a API da Melhor Envio ---
        // IMPORTANTE: Você PRECISA ter peso e dimensões para seus produtos.
        // Aqui estamos usando valores fixos como EXEMPLO. O ideal é que esses
        // dados venham do seu banco de dados junto com cada produto.
        const totalValue = items.reduce((sum, item) => sum + (item.unit_price * item.quantity), 0);
        const totalWeight = items.reduce((sum, item) => {
            // Exemplo: cada item pesa 0.3kg. Adapte para a sua realidade!
            return sum + (0.3 * item.quantity);
        }, 0);
        
        const shipmentPayload = {
            from: { postal_code: senderCep.replace(/\D/g, '') },
            to: { postal_code: cleanCepDestino },
            products: items.map(item => ({
                id: item.id,
                width: 15, // Exemplo em cm
                height: 10, // Exemplo em cm
                length: 20, // Exemplo em cm
                weight: 0.3, // Exemplo em kg
                insurance_value: item.unit_price,
                quantity: item.quantity,
            })),
            // Outra opção é usar 'package' se todos os itens forem em uma caixa só
            // "package": {
            //     "weight": totalWeight,
            //     "width": 20,
            //     "height": 20,
            //     "length": 20,
            //     "insurance_value": totalValue
            // },
            options: {
                receipt: false,
                own_hand: false,
            },
        };

        // --- 3. Chamar a API da Melhor Envio ---
        const meResponse = await fetch('https://www.melhorenvio.com.br/api/v2/me/shipment/calculate', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${meApiToken}`,
                'User-Agent': 'Sua Loja (seuemail@seudominio.com)' // Boa prática
            },
            body: JSON.stringify(shipmentPayload)
        });

        if (!meResponse.ok) {
            const errorData = await meResponse.json();
            console.error("ERRO DA API MELHOR ENVIO:", errorData);
            throw new Error(errorData.message || 'Não foi possível calcular o frete com a Melhor Envio.');
        }

        const shippingOptions = await meResponse.json();

        // --- 4. Formatar a resposta para o frontend ---
        const formattedServices = shippingOptions
            .filter(option => !option.error) // Filtra serviços que deram erro
            .map(option => ({
                // O frontend espera 'code', mas o 'id' da Melhor Envio serve.
                code: option.id, 
                name: `${option.company.name} - ${option.name}`,
                price: parseFloat(option.price),
                deliveryTime: option.delivery_time,
            }));

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
        console.error("ERRO GERAL AO CALCULAR FRETE:", error.message);
        res.status(500).json({ error: error.message || 'Não foi possível calcular o frete.' });
    }
});


// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(port, () => {
    console.log(`Servidor backend rodando na porta ${port}`);
});
