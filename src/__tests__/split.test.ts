// Testa o cálculo do split 98/2 — lógica pura, sem banco, sem Stark Bank, sem SQS.
// Se essa conta errar, todo o sistema financeiro fica inconsistente.

function calcSplit(amount: number): { licensedAmount: number; holdingAmount: number } {
  const holdingAmount  = Math.round(amount * 0.02); // 2% holding
  const licensedAmount = amount - holdingAmount;     // 98% licenciado
  return { licensedAmount, holdingAmount };
}

describe('Cálculo do split 98/2', () => {
  test('R$ 100,00 → licenciado R$ 98,00 / holding R$ 2,00', () => {
    const { licensedAmount, holdingAmount } = calcSplit(10_000);
    expect(licensedAmount).toBe(9_800);
    expect(holdingAmount).toBe(200);
  });

  test('as duas partes sempre somam o valor original', () => {
    const valores = [1, 99, 100, 1_000, 9_999, 10_000, 100_000, 999_999];
    for (const amount of valores) {
      const { licensedAmount, holdingAmount } = calcSplit(amount);
      expect(licensedAmount + holdingAmount).toBe(amount);
    }
  });

  test('holding nunca é negativo e licenciado nunca é zero', () => {
    const valores = [1, 50, 100, 10_000, 1_000_000];
    for (const amount of valores) {
      const { licensedAmount, holdingAmount } = calcSplit(amount);
      expect(holdingAmount).toBeGreaterThanOrEqual(0);
      expect(licensedAmount).toBeGreaterThan(0);
    }
  });

  test('R$ 0,01 — arredondamento não perde centavo', () => {
    const { licensedAmount, holdingAmount } = calcSplit(1);
    expect(licensedAmount + holdingAmount).toBe(1);
  });

  test('R$ 0,99 — arredondamento não perde centavo', () => {
    const { licensedAmount, holdingAmount } = calcSplit(99);
    expect(licensedAmount + holdingAmount).toBe(99);
  });

  test('R$ 1.000.000,00 — valor alto sem perda', () => {
    const { licensedAmount, holdingAmount } = calcSplit(100_000_000);
    expect(holdingAmount).toBe(2_000_000);
    expect(licensedAmount).toBe(98_000_000);
    expect(licensedAmount + holdingAmount).toBe(100_000_000);
  });

  test('holding fica dentro de 1 centavo do 2% exato (tolerância de arredondamento)', () => {
    const valores = [100, 1_000, 10_000, 100_000];
    for (const amount of valores) {
      const { holdingAmount } = calcSplit(amount);
      expect(Math.abs(holdingAmount - amount * 0.02)).toBeLessThanOrEqual(1);
    }
  });
});
