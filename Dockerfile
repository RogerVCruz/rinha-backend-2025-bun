FROM oven/bun:1.0.25-alpine

# Install netcat for health checks
RUN apk add --no-cache netcat-openbsd

WORKDIR /app

COPY package.json tsconfig.json ./

RUN bun install

COPY . .

# Make wait script executable
RUN chmod +x wait-for-deps.sh

CMD ["./wait-for-deps.sh", "bun", "run", "src/index.ts"]
