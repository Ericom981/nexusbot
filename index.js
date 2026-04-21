const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, getContentType } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const pino = require('pino')
const express = require('express')
const cors = require('cors')
const qrcode = require('qrcode')
const fs = require('fs')
const path = require('path')
const axios = require('axios')
const http = require('http')
const socketIo = require('socket.io')
const crypto = require('crypto')
const session = require('express-session')

// ════════════════════════════════════════════════════════════
//  CONFIG  (loaded from config.json set by admin panel)
// ════════════════════════════════════════════════════════════
const CONFIG_FILE = './config.json'

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
  }
  return {
    adminNumber: '',
    adminPassword: crypto.randomBytes(8).toString('hex'),
    botName: 'NexusBot',
    botPrefix: '.',
    welcomeMessage: 'Hello! I am NexusBot 🤖\nType .menu to see all commands.',
    autoReactStatus: true,
    autoViewStatus: true,
    autoReply: true,
    statusEmojis: ['❤️', '🔥', '😍', '👏', '🎉'],
    allowedUsers: [],        // empty = everyone can use
    bannedUsers: [],
    features: {
      downloader: true,
      aiChat: true,
      sticker: true,
      weather: true,
      news: true,
    }
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
}

let CONFIG = loadConfig()

// ════════════════════════════════════════════════════════════
//  EXPRESS + SOCKET.IO
// ════════════════════════════════════════════════════════════
const app = express()
const server = http.createServer(app)
const io = socketIo(server, { cors: { origin: '*' } })

app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(session({
  secret: 'nexusbot-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}))
app.use(express.static(path.join(__dirname, 'public')))

// ════════════════════════════════════════════════════════════
//  IN-MEMORY STATE
// ════════════════════════════════════════════════════════════
const store = {}
const activityLog = []
const connectedUsers = new Map()   // number → { firstSeen, lastSeen, msgCount, chats:[] }
const pairingCodes = new Map()     // code → { number, expires }
let sock = null
let qrCodeData = null
let botStatus = 'disconnected'
let botStartTime = null

// ════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════
function log(type, jid, message, extra = {}) {
  const entry = { id: Date.now() + Math.random(), timestamp: new Date().toISOString(), type, jid, number: jid ? jid.split('@')[0] : 'system', message, ...extra }
  activityLog.unshift(entry)
  if (activityLog.length > 1000) activityLog.pop()
  io.emit('activity', entry)
  return entry
}

function generatePairingCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase()
}

function isAdmin(number) {
  return number === CONFIG.adminNumber || number === CONFIG.adminNumber.replace('+', '')
}

function getUptime() {
  if (!botStartTime) return '0s'
  const s = Math.floor((Date.now() - botStartTime) / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return `${h}h ${m}m ${sec}s`
}

function trackUser(number, chatWith, messageText) {
  const existing = connectedUsers.get(number) || { number, firstSeen: new Date().toISOString(), lastSeen: null, msgCount: 0, chats: [] }
  existing.lastSeen = new Date().toISOString()
  existing.msgCount++
  if (chatWith) {
    existing.chats.unshift({ with: chatWith, msg: messageText?.substring(0, 80), time: new Date().toISOString() })
    if (existing.chats.length > 50) existing.chats.pop()
  }
  connectedUsers.set(number, existing)
  io.emit('users_update', Array.from(connectedUsers.values()))
}

// ════════════════════════════════════════════════════════════
//  BOT COMMANDS
// ════════════════════════════════════════════════════════════
const MENU = `
╔══════════════════════════╗
║   *${CONFIG.botName} Menu* 🤖   ║
╚══════════════════════════╝

📥 *DOWNLOADERS*
${CONFIG.botPrefix}ig <url>    — Instagram video/reel
${CONFIG.botPrefix}tt <url>    — TikTok video
${CONFIG.botPrefix}fb <url>    — Facebook video
${CONFIG.botPrefix}tw <url>    — Twitter/X video
${CONFIG.botPrefix}yt <url>    — YouTube audio/video

🛠️ *TOOLS*
${CONFIG.botPrefix}sticker     — Make sticker from image
${CONFIG.botPrefix}weather <city> — Weather info
${CONFIG.botPrefix}news        — Latest headlines
${CONFIG.botPrefix}ai <text>   — Ask AI anything
${CONFIG.botPrefix}ping        — Check bot latency

ℹ️ *INFO*
${CONFIG.botPrefix}menu        — Show this menu
${CONFIG.botPrefix}about       — About the bot

_Powered by ${CONFIG.botName}_
`

// ─── Downloader helper (uses yt-dlp style public APIs) ───────────────────────
async function downloadVideo(platform, url) {
  try {
    // Using a free public API aggregator — replace with your preferred service
    const endpoints = {
      instagram: `https://instagram-downloader-api.vercel.app/api?url=${encodeURIComponent(url)}`,
      tiktok:    `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`,
      facebook:  `https://fb-downloader-api.vercel.app/api?url=${encodeURIComponent(url)}`,
      twitter:   `https://twitsave.com/info?url=${encodeURIComponent(url)}`,
      youtube:   `https://yt-downloader-api.vercel.app/api?url=${encodeURIComponent(url)}`
    }
    const res = await axios.get(endpoints[platform] || endpoints.youtube, { timeout: 10000 })
    return res.data
  } catch (e) {
    return null
  }
}

// ════════════════════════════════════════════════════════════
//  WHATSAPP BOT CORE
// ════════════════════════════════════════════════════════════
async function connectBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info')
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    auth: state,
    browser: ['NexusBot', 'Chrome', '1.0.0'],
    syncFullHistory: false,
  })

  //store.bind(sock.ev)

  // ── Connection ────────────────────────────────────────────
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrCodeData = await qrcode.toDataURL(qr)
      botStatus = 'qr_ready'
      io.emit('qr', qrCodeData)
      io.emit('status', botStatus)
      log('system', null, 'QR Code generated — scan to connect')
    }
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      const reconnect = code !== DisconnectReason.loggedOut
      botStatus = 'disconnected'; botStartTime = null
      io.emit('status', botStatus); io.emit('qr', null)
      log('system', null, `Disconnected (code ${code}) — ${reconnect ? 'reconnecting…' : 'logged out'}`)
      if (reconnect) setTimeout(connectBot, 4000)
    } else if (connection === 'open') {
      qrCodeData = null; botStatus = 'connected'; botStartTime = Date.now()
      io.emit('status', botStatus); io.emit('qr', null)
      log('system', null, `✅ ${CONFIG.botName} is online!`)
      // Notify admin
      if (CONFIG.adminNumber) {
        await sock.sendMessage(`${CONFIG.adminNumber}@s.whatsapp.net`, { text: `✅ *${CONFIG.botName}* is now online!\n📅 ${new Date().toLocaleString()}` }).catch(() => {})
      }
    }
  })

  sock.ev.on('creds.update', saveCreds)

  // ── Status watcher (auto-view & react) ────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      try {
        await handleMessage(msg)
      } catch (e) {
        console.error('Message handling error:', e.message)
      }
    }
  })

  // ── Status updates (stories) ──────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (msg.key.remoteJid === 'status@broadcast' && CONFIG.autoViewStatus) {
        // Mark as read (view status)
        await sock.readMessages([msg.key]).catch(() => {})
        log('status_view', msg.key.participant, `Viewed status`)

        // Auto-react
        if (CONFIG.autoReactStatus && msg.key.participant) {
          const emoji = CONFIG.statusEmojis[Math.floor(Math.random() * CONFIG.statusEmojis.length)]
          await sock.sendMessage('status@broadcast', {
            react: { text: emoji, key: msg.key }
          }).catch(() => {})
          log('status_react', msg.key.participant, `Reacted with ${emoji}`)
        }
      }
    }
  })
}

async function handleMessage(msg) {
  if (!msg.message) return
  const jid = msg.key.remoteJid
  if (!jid) return

  const isStatus = jid === 'status@broadcast'
  if (isStatus) return  // handled separately

  const isGroup = jid.endsWith('@g.us')
  const senderJid = isGroup ? (msg.key.participant || jid) : jid
  const senderNumber = senderJid.split('@')[0]
  const isFromMe = msg.key.fromMe
  if (isFromMe) return

  const msgType = getContentType(msg.message)
  const body = (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption || ''
  ).trim()

  // Track for admin spy panel
  if (!isGroup) {
    trackUser(senderNumber, null, body)
    log('message', senderJid, body.substring(0, 100), { msgType })

    // Notify admin of every DM (only if not admin messaging themselves)
    if (!isAdmin(senderNumber) && CONFIG.adminNumber && sock) {
      const preview = body.length > 60 ? body.substring(0, 60) + '…' : body
      await sock.sendMessage(`${CONFIG.adminNumber}@s.whatsapp.net`, {
        text: `👁️ *New Message*\n📱 From: +${senderNumber}\n💬 "${preview}"\n🕐 ${new Date().toLocaleTimeString()}`
      }).catch(() => {})
    }
  }

  // Banned check
  if (CONFIG.bannedUsers.includes(senderNumber)) return

  // Pairing code check — user sends their pairing code
  if (!isGroup && body.length === 8 && /^[A-F0-9]{8}$/.test(body)) {
    const info = pairingCodes.get(body)
    if (info && info.expires > Date.now()) {
      pairingCodes.delete(body)
      CONFIG.allowedUsers.push(senderNumber)
      saveConfig(CONFIG)
      connectedUsers.set(senderNumber, { number: senderNumber, firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), msgCount: 1, chats: [] })
      io.emit('users_update', Array.from(connectedUsers.values()))
      log('pair', senderJid, `User paired successfully`, { code: body })
      await sock.sendMessage(jid, { text: `✅ *Connected Successfully!*\n\nWelcome to *${CONFIG.botName}*!\n\n${CONFIG.welcomeMessage}\n\nType *${CONFIG.botPrefix}menu* to get started.` })
      if (CONFIG.adminNumber) {
        await sock.sendMessage(`${CONFIG.adminNumber}@s.whatsapp.net`, { text: `🔗 *New User Connected!*\n📱 Number: +${senderNumber}\n🕐 ${new Date().toLocaleString()}` }).catch(() => {})
      }
      return
    }
  }

  // Prefix check
  const prefix = CONFIG.botPrefix
  if (!body.startsWith(prefix)) {
    // Auto-reply if enabled
    if (CONFIG.autoReply && !isGroup) {
      await sock.sendMessage(jid, { text: `👋 Hi! Type *${prefix}menu* to see what I can do.` })
    }
    return
  }

  const [rawCmd, ...args] = body.slice(prefix.length).trim().split(' ')
  const cmd = rawCmd.toLowerCase()
  const argStr = args.join(' ')

  const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg })

  // ── Commands ─────────────────────────────────────────────
  if (cmd === 'menu') {
    const menu = `
╔══════════════════════════╗
║   *${CONFIG.botName} Menu* 🤖   ║
╚══════════════════════════╝

📥 *DOWNLOADERS*
${prefix}ig <url>    — Instagram video/reel
${prefix}tt <url>    — TikTok video
${prefix}fb <url>    — Facebook video
${prefix}tw <url>    — Twitter/X video
${prefix}yt <url>    — YouTube audio/video

🛠️ *TOOLS*
${prefix}weather <city> — Weather info
${prefix}news        — Latest headlines
${prefix}ai <text>   — Ask AI anything
${prefix}ping        — Check bot latency

ℹ️ *INFO*
${prefix}menu        — Show this menu
${prefix}about       — About the bot

_Powered by ${CONFIG.botName}_`
    await reply(menu)

  } else if (cmd === 'ping') {
    const start = Date.now()
    await reply(`🏓 Pong!\n⚡ Latency: ${Date.now() - start}ms\n⏱️ Uptime: ${getUptime()}`)

  } else if (cmd === 'about') {
    await reply(`*${CONFIG.botName}*\n\n🤖 A powerful WhatsApp bot\n✅ Status: Online\n⏱️ Uptime: ${getUptime()}\n\n_Made with ❤️_`)

  } else if (['ig', 'tt', 'fb', 'tw', 'yt'].includes(cmd)) {
    if (!argStr) return reply(`❌ Please provide a URL.\nExample: ${prefix}${cmd} https://...`)
    const platforms = { ig: 'instagram', tt: 'tiktok', fb: 'facebook', tw: 'twitter', yt: 'youtube' }
    await reply(`⏳ Downloading from ${platforms[cmd]}... please wait`)
    const data = await downloadVideo(platforms[cmd], argStr)
    if (!data) return reply(`❌ Failed to download. Make sure the URL is correct and the video is public.`)
    const videoUrl = data?.url || data?.data?.play || data?.data?.url || data?.video_url
    if (videoUrl) {
      await sock.sendMessage(jid, { video: { url: videoUrl }, caption: `✅ Downloaded from ${platforms[cmd]}` }, { quoted: msg })
      log('download', senderJid, `Downloaded from ${platforms[cmd]}`)
    } else {
      await reply(`❌ Could not extract video URL. The video may be private or unsupported.`)
    }

  } else if (cmd === 'weather') {
    if (!argStr) return reply(`❌ Provide a city: ${prefix}weather Nairobi`)
    const res = await axios.get(`https://wttr.in/${encodeURIComponent(argStr)}?format=3`).catch(() => null)
    await reply(res?.data ? `🌤️ *Weather Update*\n${res.data}` : `❌ Couldn't fetch weather for "${argStr}"`)

  } else if (cmd === 'news') {
    const res = await axios.get('https://gnews.io/api/v4/top-headlines?category=general&lang=en&token=demo&max=5').catch(() => null)
    if (!res?.data?.articles?.length) return reply(`❌ Couldn't fetch news right now.`)
    const headlines = res.data.articles.map((a, i) => `${i + 1}. *${a.title}*`).join('\n\n')
    await reply(`📰 *Latest News*\n\n${headlines}`)

  } else if (cmd === 'ai') {
    if (!argStr) return reply(`❌ Provide a question: ${prefix}ai What is the capital of France?`)
    await reply(`🤖 Thinking...`)
    const res = await axios.get(`https://api.paxsenix.biz.id/ai/gpt4?text=${encodeURIComponent(argStr)}`).catch(() => null)
    const answer = res?.data?.message || res?.data?.result || res?.data?.response
    await reply(answer ? `🤖 *AI Response:*\n\n${answer}` : `❌ AI is unavailable right now.`)

  } else if (cmd === 'sticker') {
    if (msgType !== 'imageMessage' && !msg.message?.imageMessage) {
      return reply(`❌ Reply to an image with ${prefix}sticker to make a sticker`)
    }
    await reply(`⏳ Creating sticker...`)
    // Sticker creation would use sharp/webp conversion here
    await reply(`✅ Sticker feature requires sharp package. Run: npm install sharp`)

  } else {
    await reply(`❓ Unknown command: *${prefix}${cmd}*\n\nType *${prefix}menu* for available commands.`)
  }
}

// ════════════════════════════════════════════════════════════
//  API ROUTES
// ════════════════════════════════════════════════════════════

// Auth middleware for admin routes
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next()
  return res.status(401).json({ error: 'Unauthorized' })
}

// Admin login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body
  if (password === CONFIG.adminPassword) {
    req.session.isAdmin = true
    res.json({ success: true })
  } else {
    res.status(401).json({ error: 'Invalid password' })
  }
})

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy()
  res.json({ success: true })
})

// Generate pairing code (admin only)
app.post('/api/admin/generate-code', requireAdmin, (req, res) => {
  const code = generatePairingCode()
  const expires = Date.now() + 24 * 60 * 60 * 1000 // 24h
  pairingCodes.set(code, { expires, createdAt: new Date().toISOString() })
  log('system', null, `Admin generated pairing code: ${code}`)
  res.json({ code, expires, shareUrl: `https://wa.me/${CONFIG.adminNumber}?text=${code}` })
})
// PUBLIC: User requests code by submitting their number
app.post('/api/request-code', async (req, res) => {
  const { number } = req.body
  if (!number) return res.status(400).json({ error: 'Number required' })
  const clean = number.replace(/\D/g, '')
  if (clean.length < 10) return res.status(400).json({ error: 'Invalid number' })
  const code = generatePairingCode()
  const expires = Date.now() + 24 * 60 * 60 * 1000
  pairingCodes.set(code, { expires, createdAt: new Date().toISOString(), number: clean })
  log('system', null, `Auto code generated for +${clean}`)
  if (sock && botStatus === 'connected') {
    try {
      await sock.sendMessage(`${clean}@s.whatsapp.net`, {
        text: `👋 *Welcome to ${CONFIG.botName}!*\n\nYour pairing code is:\n\n*${code}*\n\nSend this code back to me to connect.\n\n_Code expires in 24 hours_`
      })
      res.json({ success: true, message: 'Code sent!' })
    } catch (e) {
      res.status(500).json({ error: 'Failed to send. Check your number.' })
    }
  } else {
    res.status(503).json({ error: 'Bot offline. Try again later.' })
  }
})

// Get all pairing codes
app.get('/api/admin/codes', requireAdmin, (req, res) => {
  const codes = []
  for (const [code, info] of pairingCodes.entries()) {
    codes.push({ code, ...info, valid: info.expires > Date.now() })
  }
  res.json(codes)
})

// Get connected users
app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json(Array.from(connectedUsers.values()))
})

// Get activity log
app.get('/api/admin/activity', requireAdmin, (req, res) => {
  res.json(activityLog.slice(0, 100))
})

// Get bot status
app.get('/api/admin/status', requireAdmin, (req, res) => {
  res.json({
    status: botStatus,
    qr: qrCodeData,
    uptime: getUptime(),
    userCount: connectedUsers.size,
    totalMessages: activityLog.filter(a => a.type === 'message').length,
    botName: CONFIG.botName,
    adminNumber: CONFIG.adminNumber,
  })
})

// Update config
app.post('/api/admin/config', requireAdmin, (req, res) => {
  const allowed = ['adminNumber','botName','botPrefix','welcomeMessage','autoReactStatus','autoViewStatus','autoReply','statusEmojis','features']
  for (const key of allowed) {
    if (req.body[key] !== undefined) CONFIG[key] = req.body[key]
  }
  saveConfig(CONFIG)
  log('system', null, 'Admin updated bot configuration')
  res.json({ success: true, config: CONFIG })
})

// Change admin password
app.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const { newPassword } = req.body
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password too short' })
  CONFIG.adminPassword = newPassword
  saveConfig(CONFIG)
  res.json({ success: true })
})

// Ban/unban user
app.post('/api/admin/ban', requireAdmin, (req, res) => {
  const { number, action } = req.body
  if (action === 'ban') {
    if (!CONFIG.bannedUsers.includes(number)) CONFIG.bannedUsers.push(number)
  } else {
    CONFIG.bannedUsers = CONFIG.bannedUsers.filter(n => n !== number)
  }
  saveConfig(CONFIG)
  res.json({ success: true })
})

// Restart bot
app.post('/api/admin/restart', requireAdmin, async (req, res) => {
  res.json({ success: true })
  if (sock) { try { await sock.logout() } catch(e){} }
  setTimeout(connectBot, 2000)
})

// Send message as bot (admin only)
app.post('/api/admin/send', requireAdmin, async (req, res) => {
  const { number, text } = req.body
  if (!sock) return res.status(503).json({ error: 'Bot not connected' })
  await sock.sendMessage(`${number}@s.whatsapp.net`, { text }).catch(e => console.error('Send error:', e))
  res.json({ success: true })
})

// Get full config (admin only)
app.get('/api/admin/config-get', requireAdmin, (req, res) => {
  const safe = { ...CONFIG }
  delete safe.adminPassword
  res.json(safe)
})

// Public: get bot info (for user-facing connect page)
app.get('/api/bot-info', (req, res) => {
  res.json({ botName: CONFIG.botName, status: botStatus === 'connected' ? 'online' : 'offline' })
})

// ════════════════════════════════════════════════════════════
//  SOCKET.IO
// ════════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  socket.emit('status', botStatus)
  if (qrCodeData) socket.emit('qr', qrCodeData)
  socket.emit('users_update', Array.from(connectedUsers.values()))
})

// ════════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════════
server.listen(process.env.PORT || 3000, () => {
  console.log(`\n🤖 ${CONFIG.botName} Server running on http://localhost:3000`)
  console.log(`🔐 Admin Panel: http://localhost:3000/admin.html`)
  console.log(`🌐 User Connect Page: http://localhost:3000`)
  console.log(`\n🔑 Admin Password: ${CONFIG.adminPassword}`)
  console.log('   (Change this in the admin panel after first login)\n')
  connectBot()
})
