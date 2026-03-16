import { calcBackoffDelay, withRetry, DEFAULT_RETRY_OPTIONS } from '../worker/retry.strategy';

describe('calcBackoffDelay — backoff exponencial', () => {
  const opts = { ...DEFAULT_RETRY_OPTIONS, jitter: false };

  test('tentativa 1 → delay base de 5s', () => {
    expect(calcBackoffDelay(1, opts)).toBe(5_000);
  });

  test('tentativa 2 → 25s (5^1 × 5000)', () => {
    expect(calcBackoffDelay(2, opts)).toBe(25_000);
  });

  test('tentativa 3 → 125s', () => {
    expect(calcBackoffDelay(3, opts)).toBe(125_000);
  });

  test('delay nunca passa do teto de 10min', () => {
    expect(calcBackoffDelay(10, opts)).toBe(opts.maxDelayMs);
  });

  test('com jitter: delay fica entre 0 e o valor com teto', () => {
    const optsComJitter = { ...opts, jitter: true };
    for (let i = 0; i < 20; i++) {
      const delay = calcBackoffDelay(2, optsComJitter);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(25_000);
    }
  });
});

const OPTS_RAPIDO = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitter: false };

describe('withRetry — comportamento de retry', () => {
  test('resolve na primeira tentativa sem retry', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, OPTS_RAPIDO);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('faz retry e resolve na segunda tentativa', async () => {
    let chamadas = 0;
    const fn = jest.fn().mockImplementation(() => {
      chamadas++;
      if (chamadas === 1) return Promise.reject(new Error('falha de rede'));
      return Promise.resolve('ok no retry');
    });

    const result = await withRetry(fn, OPTS_RAPIDO);
    expect(result).toBe('ok no retry');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('lança o último erro quando todas as tentativas falham', async () => {
    const fn = jest.fn().mockImplementation(() =>
      Promise.reject(new Error('sempre falha'))
    );

    await expect(withRetry(fn, OPTS_RAPIDO)).rejects.toThrow('sempre falha');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('maxAttempts = 1 não faz nenhum retry', async () => {
    const fn = jest.fn().mockImplementation(() =>
      Promise.reject(new Error('falha'))
    );

    await expect(
      withRetry(fn, { ...OPTS_RAPIDO, maxAttempts: 1 })
    ).rejects.toThrow('falha');

    expect(fn).toHaveBeenCalledTimes(1);
  });
});