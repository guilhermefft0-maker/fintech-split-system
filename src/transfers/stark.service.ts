// require() em vez de import default — evita problema de ESM/CJS com o pacote starkbank
// eslint-disable-next-line @typescript-eslint/no-var-requires
const starkbank = require('starkbank');

import { logger } from '../utils/logger';

// Inicializa o SDK da Stark Bank com as credenciais do projeto.
// Deve ser chamado uma vez na inicialização do serviço.
// Docs do SDK v2: https://github.com/starkbank/sdk-node
export function initStarkBank(): void {
  const privateKey  = process.env.STARK_PRIVATE_KEY;
  const projectId   = process.env.STARK_PROJECT_ID;
  const environment = process.env.STARK_ENV || 'sandbox';

  if (!privateKey || !projectId) {
    throw new Error('STARK_PRIVATE_KEY e STARK_PROJECT_ID são obrigatórios');
  }

  starkbank.user = new starkbank.Project({
    environment,
    id: projectId,
    privateKey,
  });

  logger.info({ environment }, 'SDK da Stark Bank inicializado');
}

export interface TransferRequest {
  amount:        number;  // valor em centavos (BRL)
  name:          string;
  taxId:         string;  // CPF ou CNPJ do destinatário
  bankCode:      string;
  branchCode:    string;
  accountNumber: string;
  accountType?:  string;  // checking | savings | salary | payment
  externalId?:   string;  // chave de idempotência — Stark Bank deduplica por esse campo
}

export interface TransferResult {
  transferId: string;
  status:     string;
  amount:     number;
}

// Cria uma transferência via API da Stark Bank.
// Lança erro em caso de falha para que o caller possa tentar novamente.
export async function createTransfer(req: TransferRequest): Promise<TransferResult> {
  logger.info(
    { amount: req.amount, externalId: req.externalId },
    'Criando transferência na Stark Bank'
  );

  // SDK v2: transfer.create([...]) retorna Promise<Transfer[]>
  const transfers: any[] = await starkbank.transfer.create([
    {
      amount:        req.amount,
      name:          req.name,
      taxId:         req.taxId,
      bankCode:      req.bankCode,
      branchCode:    req.branchCode,
      accountNumber: req.accountNumber,
      accountType:   req.accountType || 'checking',
      externalId:    req.externalId,
    },
  ]);

  const transfer = transfers[0];

  if (!transfer || !transfer.id) {
    throw new Error('Stark Bank retornou resposta vazia para transfer.create');
  }

  logger.info(
    { transferId: transfer.id, status: transfer.status, amount: transfer.amount },
    'Transferência criada com sucesso'
  );

  return {
    transferId: transfer.id,
    status:     transfer.status,
    amount:     transfer.amount,
  };
}

// Executa o split 98/2 de um pagamento.
//
// As transferências são criadas em paralelo para reduzir a latência total.
// A idempotência é garantida pelo externalId — se o worker repetir a chamada
// após uma falha parcial, a Stark Bank não duplica a transferência já criada.
//
// Em caso de falha de qualquer uma das duas, o Promise.all rejeita e o caller
// (withRetry no worker) vai tentar novamente o par completo. Como a Stark Bank
// deduplica por externalId, a transferência que já foi criada será um no-op.
export async function executeSplit(params: {
  paymentDbId:    string;
  licensedAmount: number;
  holdingAmount:  number;
}): Promise<{ licensedTransferId: string; holdingTransferId: string }> {
  const [licensed, holding] = await Promise.all([
    createTransfer({
      name:          process.env.LICENSED_NAME           || 'Licenciado',
      taxId:         process.env.LICENSED_TAX_ID         || '',
      bankCode:      process.env.LICENSED_BANK_CODE      || '',
      branchCode:    process.env.LICENSED_BRANCH_CODE    || '',
      accountNumber: process.env.LICENSED_ACCOUNT_NUMBER || '',
      accountType:   process.env.LICENSED_ACCOUNT_TYPE   || 'checking',
      amount:        params.licensedAmount,
      externalId:    `${params.paymentDbId}-licensed`,
    }),
    createTransfer({
      name:          process.env.HOLDING_NAME           || 'Holding',
      taxId:         process.env.HOLDING_TAX_ID         || '',
      bankCode:      process.env.HOLDING_BANK_CODE      || '',
      branchCode:    process.env.HOLDING_BRANCH_CODE    || '',
      accountNumber: process.env.HOLDING_ACCOUNT_NUMBER || '',
      accountType:   process.env.HOLDING_ACCOUNT_TYPE   || 'checking',
      amount:        params.holdingAmount,
      externalId:    `${params.paymentDbId}-holding`,
    }),
  ]);

  return {
    licensedTransferId: licensed.transferId,
    holdingTransferId:  holding.transferId,
  };
}

// Valida e desserializa um evento de webhook usando o SDK oficial.
// Recomendado em produção — o SDK gerencia a rotação de chaves ECDSA automaticamente.
export async function parseStarkWebhookEvent(
  rawBody: string,
  signature: string
): Promise<any> {
  return starkbank.event.parse({
    content:   rawBody,
    signature: signature,
  });
}
