import nodemailer from 'nodemailer'
import { config } from '../config.js'

let transport = null

function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: config.smtpUser, pass: config.smtpAppPassword },
    })
  }
  return transport
}

/**
 * Kirim email verifikasi. Return true bila terkirim, false bila SMTP
 * belum dikonfigurasi atau gagal (fitur degrade aman — gate bisa
 * dilewati manual oleh admin via SQL).
 */
export async function sendVerificationEmail(email, token) {
  if (!config.smtpUser || !config.smtpAppPassword) {
    console.warn('[mailer] SMTP belum dikonfigurasi — email verifikasi tidak terkirim')
    return false
  }
  const link = `${config.webOrigin}/verify?token=${encodeURIComponent(token)}`
  try {
    await getTransport().sendMail({
      from: `TopUpSaja <${config.smtpUser}>`,
      to: email,
      subject: 'Verifikasi email TopUpSaja Anda',
      text: `Klik link berikut untuk memverifikasi email Anda (berlaku 24 jam):\n\n${link}\n\nJika Anda tidak mendaftar di TopUpSaja, abaikan email ini.`,
      html: `<p>Klik link berikut untuk memverifikasi email Anda (berlaku 24 jam):</p><p><a href="${link}">Verifikasi email saya</a></p><p style="color:#888">Jika Anda tidak mendaftar di TopUpSaja, abaikan email ini.</p>`,
    })
    return true
  } catch (err) {
    console.error('[mailer] kirim email gagal:', err.message)
    return false
  }
}
