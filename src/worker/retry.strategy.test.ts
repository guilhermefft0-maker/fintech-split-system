import { calcBackoffDelay, withRetry, DEFAULT_RETRY_OPTIONS, RetryOptions } from './retry.strategy';

// ── calcBackoffDelay ─────────────────────────────────────────────────────────

describe('calcBackoffDelay', () => {
  const opts: RetryOptions = { ...DEFAULT_RETRY_OPTIONS, jitter: false };

  it('tentativa 1 retorna baseDelayMs', () => {
    expect(calcBackoffDelay(1, opts)).toBe(5_000);
  });

  it('tentativa 2 retorna 5^1 * baseDelay = 25s', () => {
    expect(calcBackoffDelay(2, opts)).toBe(25_000);
  });

  it('tentativa 3 retorna 5^2 * baseDelay = 125s', () => {
    expect(calcBackoffDelay(3, opts)).toBe(125_000);
  });

  it('respeita o teto maxDelayMs', () => {
    expect(calcBackoffDelay(10, opts)).toBe(opts.maxDelayMs);
  });

  it('com jitter retorna valor entre 0 e o teto', () => {
    const optsJitter = { ...opts, jitter: true };
    for (let i = 0; i < 50; i++) {
      const delay = calcBackoffDelay(1, optsJitter);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(5_000);
    }
  });
});

// ── withRetry ────────────────────────────────────────────────────────────────

describe('withRetry', () => {
  const fastOpts: Partial<RetryOptions> = {
    maxAttempts: 3,
    baseDelayMs: 0,
    maxDelayMs:  0,
    jitter:      false,
  };

  it('retorna o resultado imediatamente quando não falha', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, fastOpts)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('tenta novamente após falha e sucede', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('falha 1'))
      .mockRejectedValueOnce(new Error('falha 2'))
      .mockResolvedValueOnce('sucesso');

    await expect(withRetry(fn, fastOpts)).resolves.toBe('sucesso');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('lança o último erro após esgotar todas as tentativas', async () => {
    const erro = new Error('erro persistente');
    const fn = jest.fn().mockRejectedValue(erro);

    await expect(withRetry(fn, fastOpts)).rejects.toThrow('erro persistente');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('respeita maxAttempts = 1 (sem retry)', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('falha'));
    await expect(withRetry(fn, { ...fastOpts, maxAttempts: 1 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('para imediatamente em caso de sucesso na segunda tentativa', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('falha'))
      .mockResolvedValueOnce(42);

    const result = await withRetry(fn, fastOpts);
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
