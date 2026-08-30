const express = require('express');
const cors = require('cors');
const { Paymos } = require('@paymos/sdk');
const { createClient } = require('@supabase/supabase-js');

// Carregar variáveis de ambiente do .env.local
const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '.env.local') });

const app = express();
const PORT = process.env.PORT || 3001;

// Configuração CORS
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'https://diamond-store-aasajzmdz-marconi4.vercel.app',
    process.env.FRONTEND_URL
  ].filter(Boolean),
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

// Endpoint de health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Configuração Supabase
const supabaseUrl = process.env.VITE_SUPABASE_URL || 'https://your-project.supabase.co';
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || 'your-anon-key';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Configuração Paymos
const PAYMOS_PROJECT_ID = process.env.PAYMOS_PROJECT_ID || '';

// Cliente Paymos (será inicializado dinamicamente)
let paymosClient = null;

async function getPaymosClient() {
  if (paymosClient) return paymosClient;

  try {
    console.log('Buscando credenciais Paymos no banco de dados...');
    const { data, error } = await supabase
      .from('Apis')
      .select('api_paymos, api_secret_paymos, Project_ID_Paymos')
      .limit(1)
      .single();

    if (error) {
      console.error('Erro ao buscar credenciais Paymos:', error);
      throw new Error(`Erro ao buscar credenciais: ${error.message}`);
    }

    if (!data) {
      console.error('Nenhuma credencial Paymos encontrada na tabela Apis');
      throw new Error('Credenciais Paymos não encontradas no banco de dados');
    }

    if (!data.api_paymos) {
      console.error('API Paymos não configurada (api_paymos está vazio)');
      throw new Error('API Paymos não configurada (api_paymos está vazio)');
    }

    // Buscar Project ID do banco de dados
    const projectId = data.Project_ID_Paymos || process.env.PAYMOS_PROJECT_ID;

    if (!projectId) {
      console.error('Project ID Paymos não configurado');
      throw new Error('Project ID Paymos não configurado no banco de dados');
    }

    console.log('✓ Credenciais Paymos encontradas');
    console.log('  - API Key:', data.api_paymos ? '***' + data.api_paymos.slice(-4) : 'N/A');
    console.log('  - API Secret:', data.api_secret_paymos ? '***' + data.api_secret_paymos.slice(-4) : 'N/A');
    console.log('  - Project ID:', projectId);

    paymosClient = new Paymos({
      apiKey: data.api_paymos,
      apiSecret: data.api_secret_paymos || null,
      projectId: projectId,
    });

    console.log('✓ Cliente Paymos inicializado com sucesso');
    return paymosClient;
  } catch (error) {
    console.error('Erro ao inicializar cliente Paymos:', error);
    throw error;
  }
}

// Rota para criar invoice
app.post('/api/paymos/invoice', async (req, res) => {
  try {
    const { amount, currency, diamondAmount, userId, packageAmount } = req.body;

    console.log('Requisição para criar invoice:', { amount, currency, diamondAmount });

    const paymos = await getPaymosClient();

    // Buscar Project ID do banco de dados
    const { data: apisData } = await supabase
      .from('Apis')
      .select('Project_ID_Paymos')
      .limit(1)
      .single();

    const projectId = apisData?.Project_ID_Paymos || process.env.PAYMOS_PROJECT_ID;

    if (!projectId) {
      throw new Error('Project ID Paymos não configurado no banco de dados');
    }

    console.log('Project ID usado:', projectId);

    // Criar invoice com campos corretos
    const invoice = await paymos.invoices.create({
      projectId: projectId,
      amount: amount.toString(),
      currency: currency,
      network: 'BEP20',
      externalOrderId: `${userId}_${packageAmount}_${Date.now()}`,
      clientId: userId,
    });

    console.log('Invoice criada:', {
      invoiceId: invoice.invoiceId,
      id: invoice.id,
      status: invoice.status,
      payment: invoice.payment,
      paymentUrl: invoice.paymentUrl,
      fullInvoice: JSON.stringify(invoice, null, 2),
    });

    // Se não tiver endereço de pagamento, confirmar
    if (!invoice.payment && invoice.status === 'awaiting_client') {
      console.log('Confirmando pagamento para obter endereço...');
      const confirmedInvoice = await paymos.invoices.confirmPayment(invoice.invoiceId, {
        currency: currency,
        network: 'BEP20',
      });
      
      console.log('Invoice confirmada:', {
        invoiceId: confirmedInvoice.invoiceId,
        status: confirmedInvoice.status,
        payment: confirmedInvoice.payment,
        paymentUrl: confirmedInvoice.paymentUrl,
        fullInvoice: JSON.stringify(confirmedInvoice, null, 2),
      });
      
      return res.json({
        success: true,
        invoice: confirmedInvoice,
      });
    }

    res.json({
      success: true,
      invoice: invoice,
    });
  } catch (error) {
    console.error('Erro ao criar invoice:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Rota para verificar status
app.get('/api/paymos/status/:invoiceId', async (req, res) => {
  try {
    const { invoiceId } = req.params;

    console.log('Verificando status invoice:', invoiceId);

    const paymos = await getPaymosClient();
    const invoice = await paymos.invoices.get(invoiceId);

    console.log('Status invoice:', invoice.status);

    res.json({
      success: true,
      invoice: invoice,
    });
  } catch (error) {
    console.error('Erro ao verificar status:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Rota para simular pagamento (para testes)
app.post('/api/paymos/simulate/:invoiceId', async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const { stage = 'paid' } = req.body;

    console.log('Simulando pagamento para invoice:', invoiceId, 'stage:', stage);

    const paymos = await getPaymosClient();
    
    // Usar endpoint de simulação da Paymos (sandbox)
    const response = await fetch(`https://api.paymos.io/v1/sandbox/invoices/${invoiceId}/simulate-payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${paymos.apiKey}`,
      },
      body: JSON.stringify({ stage }),
    });

    const result = await response.json();
    console.log('Resultado da simulação:', result);

    if (!response.ok) {
      throw new Error(result.error?.message || result.message || 'Failed to simulate payment');
    }

    res.json({
      success: true,
      invoice: result,
    });
  } catch (error) {
    console.error('Erro ao simular pagamento:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Proxy server is running' });
});

app.listen(PORT, () => {
  console.log(`Proxy server rodando em http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});