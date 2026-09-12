import { syncRates } from './syncRates.js'
import { closeDb } from '../db.js'

// Jalankan syncRates sekali (untuk cron eksternal / testing)
syncRates()
  .then((n) => console.log(`Done: ${n} model`))
  .catch((err) => {
    console.error('syncRates gagal:', err.message)
    process.exitCode = 1
  })
  .finally(closeDb)
