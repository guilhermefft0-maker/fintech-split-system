import { logger } from '../utils/logger';

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number; // delay inicial
  maxDelayMs:  number; // teto do crescimento exponencial
  jitter:      boolean; // aleatoriza o delay pra evitar thundering herd
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 5,
  baseDelayMs: 5_000,   //  5s
  maxDelayMs:  600_000, // 10min
  jitter:      true,
};

// Calcula o delay da próxima tentativa com backoff exponencial.
//
// Exemplo sem jitter:
//   tentativa 1 →   5s
//   tentativa 2 →  25s
//   tentativa 3 → 125s (~2min)
//   tentativa 4 → 600s (10min, no teto)
export function calcBackoffDelay(
  attempt: number,
  opts: RetryOptions = DEFAULT_RETRY_OPTIONS
): number {
  const exp    = Math.pow(5, attempt - 1) * opts.baseDelayMs;
  const capped = Math.min(exp, opts.maxDelayMs);

  // Jitter completo: sorteia entre 0 e o valor com teto
  // Isso evita que vários workers tentem ao mesmo tempo depois de uma falha em massa
  if (!opts.jitter) return capped;
  return Math.floor(Math.random() * capped);
}

// Executa uma função assíncrona com retry automático em caso de falha.
// Lança o último erro se todas as tentativas se esgotarem.
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
  context?: Record<string, unknown>
): Promise<T> {
  const options = { ...DEFAULT_RETRY_OPTIONS, ...opts };
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt === options.maxAttempts) {
        logger.error({ err, attempt, ...context }, 'Todas as tentativas esgotadas');
        break;
      }

      const delay = calcBackoffDelay(attempt, options);
      logger.warn(
        { err, attempt, proximaTentativaMs: delay, ...context },
        `Tentativa ${attempt} falhou, aguardando ${delay}ms`
      );

      await sleep(delay);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
