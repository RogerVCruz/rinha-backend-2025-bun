docker compose down
cd ./payment-processor && docker compose down && docker compose build --no-cache && docker compose up -d
cd .. && docker compose down && docker compose build --no-cache && docker compose up -d
cd ./rinha-test && k6 run rinha.js