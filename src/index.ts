import 'dotenv/config';
import { config } from './config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { db } from './db/client';
import { redis } from './redis/client';
import { authRoutes } from './routes/auth';
import { sessionRoutes } from './routes/sessions';
import { askRoutes } from './routes/ask';
import { clockRoutes } from './routes/clock';
import { audioHandler } from './ws/audioHandler';

const app = Fastify({
  logger: {
    level: config.NODE_ENV === 'production' ? 'info' : 'debug',
    serializers: {
      req(req) {
        return {
          method: req.method,
          url: req.url?.split('?')[0],  // strip query params (hides JWT token in /audio)
        };
      },
      res(res) {
        return { status: res.statusCode };
      },
    },
  },
});

async function bootstrap() {
  await app.register(cors, {
    origin: (origin, cb) => {
      const allowed = [config.FRONTEND_ORIGIN, 'http://localhost:5173'];
      if (!origin || allowed.includes(origin)) {
        cb(null, true);
      } else {
        cb(new Error('Not allowed by CORS'), false);
      }
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Internal-Secret'],
    credentials: true,
  });

  await app.register(rateLimit, {
    global: false,
  });

  await app.register(websocket);

  await app.register(authRoutes);
  await app.register(sessionRoutes);
  await app.register(askRoutes);
  await app.register(clockRoutes);
  await app.register(audioHandler);

  await app.listen({ host: '0.0.0.0', port: config.PORT });
  app.log.info(`Server listening on port ${config.PORT}`);
}

async function shutdown() {
  app.log.info('Shutting down...');
  await app.close();
  await db.end();
  await redis.quit();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

bootstrap().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
