// =================================================================
// ARQUIVO COMPLETO E FINAL: backend/server.js
// SINTAXE CORRETA PARA MERCADO PAGO SDK v3.x
// =================================================================

import express from 'express';
import cors from 'cors';
import { MercadoPagoConfig, Preference } from 'mercadopago';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

// Carrega as variáveis de ambiente do arquivo .env
dotenv.config();

// Configuração inicial do Express
const app = express();
const port = process.env.PORT || 4000; // ✅ Importante para Railway
app.use(cors());
app.use(express.json());

// Pega o Access Token do .env
const accessToken = process.env.MP_ACCESS_TOKEN;

if (!accessToken) {
  console.error("ERRO CRÍTICO: Access Token do Mercado Pago não encontrado no arquivo .env.");
  process.exit(1);
}

// ------------------- ROTAS DA APLICAÇÃO -------------------

// ROTA /criar-preferencia
app.post('/criar-preferencia', async (req, res) => {
    console.log("EXECUTANDO TESTE SEM AUTO_RETURN...");

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

        const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
        const preference = new Preference(client);
        const result = await preference.create({ body: preferenceBody });

        console.log("SUCESSO! Preferência criada SEM auto_return:", result.id);
        res.status(201).json({
            id: result.id,
            init_point: result.init_point
        });

    } catch (error) {
        console.error("ERRO NO TESTE SEM AUTO_RETURN:", JSON.stringify(error, null, 2));
        res.status(500).json({
            error: 'Erro ao criar a preferência de pagamento.',
            cause: error.cause
        });
    }
});

// ROTA /calcular-frete
app.post('/calcular-frete', async (req, res) => {
    const { cepDestino } = req.body;
    const cleanCep = cepDestino.replace(/\D/g, '');

    try {
        const viaCepUrl = `https://viacep.com.br/ws/${cleanCep}/json/`;
        const viaCepResponse = await fetch(viaCepUrl);
        const viaCepData = await viaCepResponse.json();

        if (viaCepData.erro) {
            throw new Error("CEP não encontrado. Verifique o número.");
        }

        const estado = viaCepData.uf;
        const precosPorEstado = {
            'SP': 0.50, 'RJ': 25.70, 'MG': 26.00, 'ES': 28.00,
            'PR': 24.50, 'SC': 26.80, 'RS': 28.90
        };
        const precoPadrao = 35.00;
        const precoBase = precosPorEstado[estado] || precoPadrao;
        
        const respostaDeFrete = {
            services: [
                { name: 'PAC', code: '04510', price: precoBase, deliveryTime: 8 },
                { name: 'SEDEX', code: '04014', price: precoBase + 15.00, deliveryTime: 3 }
            ],
            addressInfo: {
                logradouro: viaCepData.logradouro,
                bairro: viaCepData.bairro,
                localidade: viaCepData.localidade,
                uf: viaCepData.uf
            }
        };

        res.status(200).json(respostaDeFrete);
    } catch (error) {
        console.error("ERRO AO CALCULAR FRETE:", error.message);
        res.status(500).json({ error: error.message || 'Não foi possível calcular o frete.' });
    }
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(port, () => {
    console.log(`Servidor backend rodando na porta ${port}`);
    console.log('Usando Mercado Pago SDK v3.x');
});
