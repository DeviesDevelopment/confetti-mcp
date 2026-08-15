import { createApp } from './server/app.js'
import { loadConfig } from './config.js'

const config = loadConfig(process.env)
const app = createApp(config)

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(JSON.stringify({ level: 'info', msg: 'listening', port: config.port }))
})

// Stop accepting new connections and let in-flight requests finish. Without
// this, SIGTERM terminates the process mid-response on every redeploy.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    // Don't hang forever if a connection refuses to drain.
    setTimeout(() => process.exit(0), 5000).unref()
  })
}
