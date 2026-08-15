import { createApp } from './server/app.js'
import { loadConfig } from './config.js'

const config = loadConfig(process.env)
const app = createApp(config)

app.listen(config.port, '0.0.0.0', () => {
  console.log(JSON.stringify({ level: 'info', msg: 'listening', port: config.port }))
})
