import cron from 'node-cron'
import { syncRates } from './syncRates.js'
import { watchUpstream } from './watchUpstream.js'
import { expireTopups } from './expireTopups.js'
import { probeDisabled } from './probeDisabled.js'
import { purgeSessions } from './purgeSessions.js'

function safe(name, fn) {
  return async () => {
    try {
      await fn()
    } catch (err) {
      console.error(`[${name}] error:`, err.message)
    }
  }
}

export function startScheduler(app) {
  // syncRates: tiap 15 menit
  cron.schedule('*/15 * * * *', safe('syncRates', syncRates))
  // watchUpstream: tiap 5 menit
  cron.schedule('*/5 * * * *', safe('watchUpstream', watchUpstream))
  // expireTopups: tiap jam
  cron.schedule('5 * * * *', safe('expireTopups', expireTopups))
  // probeDisabled: recovery model auto-disable, tiap 15 menit
  cron.schedule('*/15 * * * *', safe('probeDisabled', probeDisabled))
  // purgeSessions: hapus sesi kedaluwarsa/direvoke >7 hari, harian
  cron.schedule('17 4 * * *', safe('purgeSessions', purgeSessions))

  // Jalankan sekali saat boot (delay 3 detik agar DB siap)
  setTimeout(async () => {
    await safe('boot-syncRates', syncRates)()
    await safe('boot-watchUpstream', watchUpstream)()
    await safe('boot-probeDisabled', probeDisabled)()
    await safe('boot-purgeSessions', purgeSessions)()
  }, 3000)

  app.log.info('Scheduler aktif: syncRates 15m, watchUpstream 5m, expireTopups 1h, probeDisabled 15m, purgeSessions 24h')
}
