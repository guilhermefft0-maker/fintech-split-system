-- Migration 001: schema inicial do sistema de split financeiro

-- Tabela principal de pagamentos processados.
-- A constraint UNIQUE em external_id é a segunda camada de idempotência
-- (a primeira é o SELECT FOR UPDATE no código).
CREATE TABLE IF NOT EXISTS processed_payments (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id     VARCHAR(255) NOT NULL,        -- ID do evento da Stark Bank
  status          VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
                               -- PENDING | PROCESSING | COMPLETED | FAILED
  amount          BIGINT       NOT NULL,         -- valor total em centavos
  holding_amount  BIGINT       NOT NULL,         -- 2% — vai pra holding
  licensed_amount BIGINT       NOT NULL,         -- 98% — vai pro licenciado
  error_message   TEXT,                          -- preenchido quando status = FAILED
  retry_count     SMALLINT     NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_external_id  UNIQUE (external_id),
  CONSTRAINT chk_status      CHECK (status IN ('PENDING','PROCESSING','COMPLETED','FAILED')),
  CONSTRAINT chk_amount_pos  CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS idx_payments_status  ON processed_payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_created ON processed_payments(created_at);

-- Ledger financeiro — uma linha por perna de transferência (LICENSED e HOLDING).
-- Permite auditoria completa e detecção de falhas parciais.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id  UUID         NOT NULL REFERENCES processed_payments(id) ON DELETE RESTRICT,
  direction   VARCHAR(10)  NOT NULL,    -- HOLDING | LICENSED
  amount      BIGINT       NOT NULL,
  transfer_id VARCHAR(255),             -- ID da transferência retornado pela Stark Bank
  status      VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
                           -- PENDING | SENT | CONFIRMED | FAILED
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_direction     CHECK (direction IN ('HOLDING','LICENSED')),
  CONSTRAINT chk_ledger_status CHECK (status IN ('PENDING','SENT','CONFIRMED','FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_ledger_payment_id ON ledger_entries(payment_id);

-- Atualiza updated_at automaticamente em qualquer UPDATE
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER set_updated_at_payments
  BEFORE UPDATE ON processed_payments
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE OR REPLACE TRIGGER set_updated_at_ledger
  BEFORE UPDATE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
