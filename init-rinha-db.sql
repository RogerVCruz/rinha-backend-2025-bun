CREATE TABLE IF NOT EXISTS processor_health (
    processor_name VARCHAR(20) PRIMARY KEY,
    is_failing BOOLEAN NOT NULL,
    min_response_time INTEGER NOT NULL,
    last_checked_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    correlation_id UUID NOT NULL UNIQUE,
    amount NUMERIC(10, 2) NOT NULL,
    processor VARCHAR(20) NOT NULL,
    processed_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pending_payments (
    id SERIAL PRIMARY KEY,
    correlation_id UUID NOT NULL UNIQUE,
    amount NUMERIC(10, 2) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    retry_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at TIMESTAMP NOT NULL DEFAULT NOW(),
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_transactions_processed_at ON transactions(processed_at);
CREATE INDEX IF NOT EXISTS idx_transactions_processor ON transactions(processor);
CREATE INDEX IF NOT EXISTS idx_transactions_processor_processed_at ON transactions(processor, processed_at);
CREATE INDEX IF NOT EXISTS idx_pending_payments_next_retry ON pending_payments(next_retry_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_pending_payments_status ON pending_payments(status);

INSERT INTO processor_health (processor_name, is_failing, min_response_time, last_checked_at) VALUES ('default', false, 0, NOW()) ON CONFLICT DO NOTHING;
INSERT INTO processor_health (processor_name, is_failing, min_response_time, last_checked_at) VALUES ('fallback', false, 0, NOW()) ON CONFLICT DO NOTHING;
