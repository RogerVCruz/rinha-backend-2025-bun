CREATE TABLE IF NOT EXISTS processor_health (
    processor_name VARCHAR(20) PRIMARY KEY,
    is_failing BOOLEAN NOT NULL,
    min_response_time INTEGER NOT NULL,
    last_checked_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    correlation_id UUID NOT NULL,
    amount NUMERIC(10, 2) NOT NULL,
    processor VARCHAR(20) NOT NULL,
    processed_at TIMESTAMP NOT NULL
);

INSERT INTO processor_health (processor_name, is_failing, min_response_time, last_checked_at) VALUES ('default', false, 0, NOW());
INSERT INTO processor_health (processor_name, is_failing, min_response_time, last_checked_at) VALUES ('fallback', false, 0, NOW());
