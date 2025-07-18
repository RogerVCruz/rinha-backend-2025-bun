/**
 * debug-test.js
 * * Este é um script de teste do k6 modificado para ser muito menos agressivo,
 * ideal para depurar o fluxo de pagamentos e o comportamento do worker.
 * * Como funciona:
 * - Executa com apenas 1 usuário virtual (VU).
 * - Envia um total de 10 requisições de pagamento.
 * - Espera 2 segundos entre cada requisição.
 */

import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';
import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";
import { sleep } from "k6";
import {
  resetPPDatabase,
  resetBackendDatabase,
  requestBackendPayment
} from "./rinha-test/requests.js";

// --- Configuração do Teste de Depuração ---
export const options = {
  // Cenário único e lento
  scenarios: {
    debug_payments: {
      exec: "payments", // Função a ser executada
      executor: "per-vu-iterations", // Executa um número fixo de iterações por VU
      vus: 1, // Apenas 1 usuário
      iterations: 10, // Envia um total de 10 requisições
      maxDuration: "1m", // Duração máxima de 1 minuto
    },
  },
};

// --- Funções do Teste ---

// A função setup é executada uma vez no início do teste para limpar o ambiente.
export async function setup() {
  console.log('--- Iniciando Teste de Depuração ---');
  console.log('Limpando bases de dados dos processadores e do backend...');
  await resetPPDatabase("default");
  await resetPPDatabase("fallback");
  await resetBackendDatabase();
  console.log('Ambiente limpo. Começando os pagamentos...');
}

// A função teardown é executada no final do teste.
export function teardown() {
  console.log('--- Teste de Depuração Finalizado ---');
}

// Função principal que envia os pagamentos
export async function payments() {
  const payload = {
    correlationId: uuidv4(),
    amount: 15.50 // Um valor qualquer
  };

  console.log(`Enviando pagamento com correlationId: ${payload.correlationId}`);
  
  const response = await requestBackendPayment(payload);

  console.log(`Resposta para ${payload.correlationId}: HTTP ${response.status}`);

  // Espera 2 segundos antes da próxima iteração.
  // Isso dá tempo para o worker processar e para você ler os logs.
  sleep(2);
}

// A função handleSummary pode ser simplificada ou removida para o debug,
// mas vamos mantê-la para consistência.
export function handleSummary(data) {
  console.log('--- Resumo do Teste de Depuração ---');
  return {
    stdout: textSummary(data),
  };
}