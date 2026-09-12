import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import jwt from '@fastify/jwt'
import { config } from './config.js'
import { closeDb } from './db.js'
import authPlugin from './plugins/auth.js'
import proxyPlugin from './plugins/proxy.js'
import authRoutes from './routes/authRoutes.js'
import userRoutes from './routes/userRoutes.js'
import topupRoutes from './routes/topupRoutes.js'
import adminRoutes from './routes/adminRoutes.js'
import publicRoutes from './routes/publicRoutes.js'
import { startScheduler } from './jobs/scheduler.js'

const app = Fastify({
  trustProxy: true,
  logger: config.isProd
    ? { level: 'warn' }
    : { level: 'info', transport: undefined },
})

await app.register(cors, {
  origin: (origin, cb) => {
    // Request tanpa Origin (curl, CLI, same-origin) tetap diizinkan.
    if (!origin) return cb(null, true)
    cb(null, config.corsOrigins.includes(origin))
  },
  credentials: true,
})
await app.register(rateLimit, {
  global: true,
  max: 300,
  timeWindow: '1 minute',
  // Rate limit API key custom diterapkan via config.rateLimit di route
})
await app.register(jwt, { secret: config.jwtSecret })
await app.register(authPlugin)
await app.register(proxyPlugin)

await app.register(authRoutes)
await app.register(userRoutes)
await app.register(topupRoutes)
await app.register(adminRoutes)
await app.register(publicRoutes)

app.setErrorHandler((err, request, reply) => {
  request.log.error({ err }, 'unhandled error')
  const code = err.statusCode ?? 500
  reply.code(code).send({
    error: {
      message: code === 500 ? 'Internal error' : err.message,
      type: 'server_error',
    },
  })
})

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    app.log.info(`${sig} diterima — shutdown...`)
    await app.close()
    await closeDb()
    process.exit(0)
  })
}

try {
  await app.listen({ port: config.port, host: '0.0.0.0' })
  startScheduler(app)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
