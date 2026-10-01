import Fastify from 'fastify';
import cors from '@fastify/cors';
import { registerRoutes } from './routes.js';

export async function buildApp() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await registerRoutes(app);
  return app;
}

// 仅在直接运行时监听端口；被测试 import 时不占用端口。
if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  const app = await buildApp();
  await app.listen({ port: 6182, host: '127.0.0.1' });
}
