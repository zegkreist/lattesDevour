import { defineConfig } from 'vitest/config';

// Os testes de integração recriam o schema do mesmo Postgres: não podem rodar em paralelo.
export default defineConfig({ test: { fileParallelism: false } });
