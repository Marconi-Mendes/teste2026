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

// Configuração CORS - será atualizado dinamicamente
let allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'https://diamond-store-2efqo9lhx-marconi4.vercel.app',
  process.env.FRONTEND_URL
].filter(Boolean);

// Middleware CORS dinâmico
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV === 'development') {
      callback(null, true);
    } else {
      callback(null, true);
    }
  },
  methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'access_token'],
  credentials: true,
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

// Proxy para API Asaas - middleware
app.use('/api/asaas', async (req, res) => {
  try {
    // Remover /api/asaas do caminho
    const endpoint = req.path.replace('/api/asaas', '');

    // Buscar API key e modo do banco de dados
    const { data: apisData } = await supabase
      .from('Apis')
      .select('api_asaas, api_asaas_production, production_mode')
      .limit(1)
      .single();

    const useProduction = apisData?.production_mode === true;
    const asaasApiKey = useProduction ? apisData?.api_asaas_production : apisData?.api_asaas;
    const baseUrl = useProduction ? 'https://api.asaas.com/api/v3' : 'https://sandbox.asaas.com/api/v3';

    if (!asaasApiKey) {
      throw new Error('API Asaas não configurada');
    }

    console.log('Proxy Asaas:', { method: req.method, endpoint, useProduction });

    // Fazer requisição para API Asaas
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'access_token': asaasApiKey,
      },
      ...(req.method !== 'GET' && { body: JSON.stringify(req.body) }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `Asaas API error: ${response.status}`);
    }

    res.json(data);
  } catch (error) {
    console.error('Erro no proxy Asaas:', error);
    res.status(500).json({
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

// Rota para criar QR Code PIX via Abacate Pay
app.post('/api/abacatepay/create', async (req, res) => {
  try {
    const { amount, description, customer, metadata, expiresIn } = req.body;

    console.log('Requisição para criar QR Code PIX Abacate Pay:', { amount, description });

    // Buscar API key do Abacate Pay no banco de dados
    const { data: apisData, error } = await supabase
      .from('Apis')
      .select('api_abacatepay')
      .limit(1)
      .single();

    if (error || !apisData?.api_abacatepay) {
      console.error('API Abacate Pay não configurada:', error);
      return res.status(500).json({
        success: false,
        error: 'API Abacate Pay não configurada no banco de dados',
        details: error
      });
    }

    const apiKey = apisData.api_abacatepay;
    console.log('API Key Abacate Pay (mascarada):', apiKey ? apiKey.substring(0, 4) + '***' + apiKey.substring(apiKey.length - 4) : 'N/A');

    // Converter valor de reais para centavos
    const amountInCents = Math.round(amount * 100);

    // Preparar payload para Abacate Pay
    const payload = {
      method: 'PIX',
      data: {
        amount: amountInCents,
        ...(description && { description }),
        ...(expiresIn && { expiresIn }),
        ...(customer && { customer }),
        ...(metadata && { metadata })
      }
    };

    console.log('Payload Abacate Pay:', JSON.stringify(payload, null, 2));

    // Fazer requisição para API Abacate Pay
    const response = await fetch('https://api.abacatepay.com/v2/transparents/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    console.log('Resposta Abacate Pay:', JSON.stringify(result, null, 2));

    if (!response.ok) {
      console.error('Erro na API Abacate Pay:', result);
      throw new Error(result.error || result.message || `Abacate Pay API error: ${response.status}`);
    }

    res.json({
      success: true,
      data: result.data,
      devMode: result.devMode || false,
    });
  } catch (error) {
    console.error('Erro ao criar QR Code PIX Abacate Pay:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Rota para verificar status de pagamento Abacate Pay
app.get('/api/abacatepay/status/:id', async (req, res) => {
  try {
    const { id } = req.params;

    console.log('Verificando status pagamento Abacate Pay:', id);

    // Buscar API key do Abacate Pay no banco de dados
    const { data: apisData, error } = await supabase
      .from('Apis')
      .select('api_abacatepay')
      .limit(1)
      .single();

    if (error || !apisData?.api_abacatepay) {
      console.error('API Abacate Pay não configurada:', error);
      return res.status(500).json({
        success: false,
        error: 'API Abacate Pay não configurada no banco de dados',
      });
    }

    const apiKey = apisData.api_abacatepay;

    // Fazer requisição para verificar status
    const response = await fetch(`https://api.abacatepay.com/v2/transparents/${id}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    const result = await response.json();
    console.log('Status Abacate Pay:', result);

    if (!response.ok) {
      throw new Error(result.error || result.message || `Abacate Pay API error: ${response.status}`);
    }

    res.json({
      success: true,
      data: result.data,
    });
  } catch (error) {
    console.error('Erro ao verificar status Abacate Pay:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Rota para simular pagamento Abacate Pay (sandbox)
app.post('/api/abacatepay/simulate/:id', async (req, res) => {
  try {
    const { id } = req.params;

    console.log('Simulando pagamento Abacate Pay:', id);

    // Buscar API key do Abacate Pay no banco de dados
    const { data: apisData, error } = await supabase
      .from('Apis')
      .select('api_abacatepay')
      .limit(1)
      .single();

    if (error || !apisData?.api_abacatepay) {
      console.error('API Abacate Pay não configurada:', error);
      return res.status(500).json({
        success: false,
        error: 'API Abacate Pay não configurada no banco de dados',
      });
    }

    const apiKey = apisData.api_abacatepay;

    // Fazer requisição para simular pagamento
    const response = await fetch(`https://api.abacatepay.com/v2/transparents/simulate-payment?id=${id}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({}),
    });

    const result = await response.json();
    console.log('Resultado simulação Abacate Pay:', result);

    if (!response.ok) {
      throw new Error(result.error || result.message || `Abacate Pay API error: ${response.status}`);
    }

    res.json({
      success: true,
      data: result.data,
    });
  } catch (error) {
    console.error('Erro ao simular pagamento Abacate Pay:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ============ MERCADO PAGO INTEGRAÇÃO ============

// Rota para criar pagamento PIX via Mercado Pago
app.post('/api/mercadopago/create', async (req, res) => {
  try {
    const { amount, description, metadata } = req.body;

    console.log('Requisição para criar pagamento PIX Mercado Pago:', { amount, description, metadata });

    // Buscar credenciais Mercado Pago no banco de dados
    const { data: apisData, error } = await supabase
      .from('Apis')
      .select('access_token, environment')
      .limit(1)
      .single();

    if (error || !apisData?.access_token) {
      console.error('Erro ao buscar credenciais Mercado Pago:', error);
      return res.status(500).json({
        success: false,
        error: 'Credenciais Mercado Pago não configuradas no banco de dados',
        details: error
      });
    }

    const accessToken = apisData.access_token;
    console.log('Access Token Mercado Pago (mascarado):', accessToken ? accessToken.substring(0, 8) + '...' + accessToken.substring(accessToken.length - 8) : 'N/A');

    // Converter valor de reais para centavos
    const amountInCents = Math.round(amount * 100);

    // Criar pagamento PIX via API do Mercado Pago
    const response = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        transaction_amount: amountInCents,
        description: description,
        payment_method_id: 'pix',
        date_of_expiration: new Date(Date.now() + 3600000).toISOString(), // 1 hora
        metadata: metadata
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Erro na resposta Mercado Pago:', response.status, errorText);
      throw new Error(`Mercado Pago error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log('Pagamento PIX Mercado Pago criado:', data);

    // Obter QR Code do pagamento
    const qrCodeResponse = await fetch(`https://api.mercadopago.com/v1/payments/${data.id}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!qrCodeResponse.ok) {
      throw new Error('Erro ao obter QR Code do pagamento');
    }

    const qrCodeData = await qrCodeResponse.json();
    console.log('QR Code Mercado Pago obtido:', qrCodeData);

    res.json({
      success: true,
      data: {
        id: data.id,
        qrCode: qrCodeData.point_of_interaction.transaction_data.qr_code_base64,
        copyPasteCode: qrCodeData.point_of_interaction.transaction_data.qr_code,
        ticketUrl: qrCodeData.point_of_interaction.transaction_data.ticket_url,
        status: data.status
      }
    });
  } catch (error) {
    console.error('Erro ao criar pagamento PIX Mercado Pago:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Rota para verificar status do pagamento Mercado Pago
app.get('/api/mercadopago/status/:paymentId', async (req, res) => {
  try {
    const { paymentId } = req.params;

    console.log('Verificando status pagamento Mercado Pago:', paymentId);

    // Buscar credenciais Mercado Pago no banco de dados
    const { data: apisData, error } = await supabase
      .from('Apis')
      .select('access_token')
      .limit(1)
      .single();

    if (error || !apisData?.access_token) {
      console.error('Erro ao buscar credenciais Mercado Pago:', error);
      return res.status(500).json({
        success: false,
        error: 'Credenciais Mercado Pago não configuradas no banco de dados'
      });
    }

    const accessToken = apisData.access_token;

    const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Erro ao verificar status Mercado Pago:', response.status, errorText);
      throw new Error(`Mercado Pago error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log('Status pagamento Mercado Pago:', data);

    res.json({
      success: true,
      data: {
        status: data.status,
        statusDetail: data.status_detail
      }
    });
  } catch (error) {
    console.error('Erro ao verificar status pagamento Mercado Pago:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Proxy server is running' });
});

// Proxy para API Asaas
app.use('/api/asaas', async (req, res) => {
  try {
    console.log('Proxy Asaas - Method:', req.method, 'URL:', req.url);

    // Buscar API Asaas do banco de dados
    console.log('Buscando API Asaas no banco de dados...');
    const { data, error } = await supabase
      .from('Apis')
      .select('api_asaas, api_asaas_production, production_mode')
      .limit(1)
      .single();

    console.log('Resultado do banco - Error:', error, 'Data:', data);

    if (error || !data) {
      console.error('API Asaas não configurada:', error);
      return res.status(500).json({ error: 'API Asaas não configurada', details: error });
    }

    // Decidir qual API key usar baseado no production_mode
    const useProduction = data.production_mode === true;
    const asaasApiKey = useProduction ? data.api_asaas_production : data.api_asaas;

    console.log('Modo de produção:', useProduction);
    console.log('Usando API key:', useProduction ? 'PRODUÇÃO' : 'SANDBOX');

    if (!asaasApiKey) {
      console.error('API Asaas não configurada para o modo atual');
      return res.status(500).json({
        error: 'API Asaas não configurada',
        mode: useProduction ? 'PRODUÇÃO' : 'SANDBOX',
        message: `Configure a coluna ${useProduction ? 'api_asaas_production' : 'api_asaas'} na tabela Apis`
      });
    }
    console.log('API Key Asaas (mascarada):', asaasApiKey ? asaasApiKey.substring(0, 4) + '***' + asaasApiKey.substring(asaasApiKey.length - 4) : 'N/A');
    console.log('Tamanho da API key:', asaasApiKey ? asaasApiKey.length : 0);

    // Usar URL diferente para sandbox e produção
    const asaasBaseUrl = useProduction
      ? 'https://api.asaas.com/api/v3'
      : 'https://sandbox.asaas.com/api/v3';

    const asaasUrl = `${asaasBaseUrl}${req.url.replace('/api/asaas', '')}`;
    console.log('URL base da API Asaas:', asaasBaseUrl);

    console.log('Proxy Asaas - URL completa:', asaasUrl);
    console.log('Proxy Asaas - Body:', req.body);

    const headers = {
      'Content-Type': 'application/json',
      'access_token': asaasApiKey,
    };
    console.log('Headers sendo enviados:', { ...headers, access_token: '***' });

    const response = await fetch(asaasUrl, {
      method: req.method,
      headers: headers,
      body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
    });

    console.log('Proxy Asaas - Status resposta:', response.status);
    console.log('Proxy Asaas - Headers resposta:', Object.fromEntries(response.headers.entries()));

    const responseText = await response.text();
    console.log('Proxy Asaas - Resposta bruta:', responseText);
    console.log('Proxy Asaas - Tamanho da resposta:', responseText.length);

    // Se a resposta for vazia
    if (!responseText || responseText.trim() === '') {
      console.error('Resposta vazia da API Asaas - Status:', response.status);
      return res.status(response.status).json({
        error: 'Resposta vazia da API Asaas',
        status: response.status,
        message: 'API key pode estar incorreta ou sem permissão'
      });
    }

    let dataResponse;
    try {
      dataResponse = JSON.parse(responseText);
    } catch (parseError) {
      console.error('Erro ao fazer parse da resposta Asaas:', parseError);
      return res.status(500).json({
        error: 'Resposta inválida da API Asaas',
        raw: responseText,
        parseError: parseError.message
      });
    }

    if (!response.ok) {
      console.error('Erro na API Asaas:', dataResponse);
      return res.status(response.status).json(dataResponse);
    }

    console.log('Proxy Asaas - Sucesso');
    res.json(dataResponse);
  } catch (error) {
    console.error('Erro no proxy Asaas:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxy server rodando em http://0.0.0.0:${PORT}`);
  console.log(`Health check: http://0.0.0.0:${PORT}/api/health`);
  console.log(`Acessível via IP da VPS: http://IP-DA-VPS:${PORT}`);
});