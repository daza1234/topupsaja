import { config } from '../config.js'

export async function sendTelegramAlert(text) {
  const { botToken, chatId } = config.telegram
  if (!botToken || !chatId) {
    console.warn(`[alert] ${text}`)
    return
  }
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `TopUpSaja\n${text}`,
        parse_mode: 'HTML',
      }),
    })
  } catch (err) {
    console.error('[telegram] alert gagal:', err.message)
  }
}
