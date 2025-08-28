// =================================================================
// ARQUIVO COMPLETO E FINAL: backend/server.js
// SINTAXE CORRETA PARA MERCADO PAGO SDK v3.x E CONEXÃO COM BANCO DE DADOS
// =================================================================

import express from 'express';
import cors from 'cors';
import { MercadoPagoConfig, Preference } from 'mercadopago';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

// <<< NOVO: Importar a conexão do banco de dados >>>
import db from './config/database.js';

// Carrega as variáveis de ambiente do arquivo .env
dotenv.config();

// Configuração inicial do Express
const app = express();
const port = process.env.PORT || 4000;
app.use(cors());
app.use(express.json());

// Pega o Access Token do .env
const accessToken = process.env.MP_ACCESS_TOKEN;

if (!accessToken) {
    console.error("ERRO CRÍTICO: Access Token do Mercado Pago não encontrado no arquivo .env.");
    process.exit(1);
}

// ------------------- ROTAS DA APLICAÇÃO -------------------

// Rota de teste para a raiz do servidor
app.get('/', (req, res) => {
    res.status(200).json({ status: 'API online', message: 'Bem-vindo ao backend!' });
});

// ROTA /criar-preferencia
app.post('/criar-preferencia', async (req, res) => {
    console.log("EXECUTANDO CRIAÇÃO DE PREFERÊNCIA...");

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
        
        // <<< NOVO: Salvar o pedido no banco de dados >>>
        try {
            const totalAmount = items.reduce((sum, item) => sum + (item.unit_price * item.quantity), 0);
            const sql = 'INSERT INTO pedidos (preference_id, payer_email, total_amount, shipment_cost, status) VALUES (?, ?, ?, ?, ?)';
            const values = [result.id, payerInfo.email, totalAmount, Number(shipmentCost), 'pending'];
            
            const [dbResult] = await db.query(sql, values);
            console.log(`✅ Pedido (ID: ${dbResult.insertId}) salvo no banco de dados com preference_id: ${result.id}`);

        } catch (dbError) {
            // Se der erro no banco, o pagamento não deve ser impedido, mas registramos o erro.
            console.error("ERRO AO SALVAR PEDIDO NO BANCO DE DADOS:", dbError);
        }
        
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

// <<< NOVA ROTA DE EXEMPLO: Buscar todos os pedidos no banco >>>
app.get('/pedidos', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM pedidos ORDER BY created_at DESC');
        res.status(200).json(rows);
    } catch (error) {
        console.error("ERRO AO BUSCAR PEDIDOS:", error);
        res.status(500).json({ error: 'Não foi possível buscar os pedidos.' });
    }
});


// ROTA /calcular-frete (sem alterações)
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
            'SP': 18.50, 'RJ': 25.70, 'MG': 26.00, 'ES': 28.00,
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
