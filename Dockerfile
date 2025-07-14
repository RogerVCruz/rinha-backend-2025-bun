FROM oven/bun:1.0.25-alpine

WORKDIR /app

COPY package.json tsconfig.json ./

RUN bun install

COPY . .

CMD ["bun", "run", "src/index.ts"]
