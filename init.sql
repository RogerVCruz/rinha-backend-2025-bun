CREATE TABLE transactions (
    id SERIAL PRIMARY KEY,
    correlation_id UUID NOT NULL,
    amount DECIMAL NOT NULL,
    processor VARCHAR(10) NOT NULL,
    processed_at TIMESTAMP NOT NULL
);

CREATE INDEX idx_transactions_processed_at ON transactions(processed_at);

CREATE TABLE processor_health (
    processor_name VARCHAR(10) PRIMARY KEY,
    is_failing BOOLEAN NOT NULL,
    min_response_time INTEGER NOT NULL,
    last_checked_at TIMESTAMP NOT NULL
);