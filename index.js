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

const CONFIG_FILE = './config.json'

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) } catch(e) {}
  }
  const cfg = {
    adminNumber: '',
    adminPassword: process.env.ADMIN_PASSWORD || crypto.randomBytes(4).toString('hex'),
    botName: 'NexusBot',
    botPrefix: '.',
    welcomeMessage: 'Welcome! Type .menu to see all commands.',
    autoReactStatus: true,
    autoViewStatus: true,
    autoReply: true,
    statusEmojis: ['❤️','🔥','😍','👏','🎉','💯','😂','🥰'],
    bannedUsers: [],
    features: { downloader: true, aiChat: true, weather: true, news: true }
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
  return cfg
}

function saveConfig(cfg) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)) }

let CONFIG = loadConfig()

const app = express()
const server = http.createServer(app)
const io = socketIo(server, { cors: { origin: '*' } })

app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(session({ secret: 'nexusbot-secret-2024', resave: false, saveUninitialized: false, cookie: { maxAge: 86400000 } }))
app.use(express.static(path.join(__dirname, 'public')))

const activityLog = []
const connectedUsers = new Map()
const pairingCodes = new Map()
let sock = null, qrCodeData = null, botStatus = 'disconnected', botStartTime = null, totalMsgs = 0

function addLog(type, number, message, extra = {}) {
  const entry = { id: Date.now() + Math.random(), timestamp: new Date().toISOString(), type, number: number || 'system', message, ...extra }
  activityLog.unshift(entry)
  if (activityLog.length > 2000) activityLog.pop()
  io.emit('activity', entry)
  return entry
}

function genCode() { return crypto.randomBytes(4).toString('hex').toUpperCase() }
function isAdmin(n) { return CONFIG.adminNumber && (n === CONFIG.adminNumber || n === CONFIG.adminNumber.replace(/\D/g,'')) }
function getUptime() {
  if (!botStartTime) return 'Offline'
  const s = Math.floor((Date.now()-botStartTime)/1000)
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m ${s%60}s`
}

function trackUser(number, msgText, cmdUsed) {
  const now = new Date().toISOString()
  const u = connectedUsers.get(number) || { number, firstSeen: now, lastSeen: now, msgCount: 0, commandsUsed: [], recentMessages: [], isOnline: true, status: 'active' }
  u.lastSeen = now; u.msgCount++; u.isOnline = true
  if (cmdUsed) { u.commandsUsed.unshift({ cmd: cmdUsed, time: now }); if (u.commandsUsed.length > 20) u.commandsUsed.pop() }
  if (msgText) { u.recentMessages.unshift({ text: msgText.substring(0,100), time: now }); if (u.recentMessages.length > 30) u.recentMessages.pop() }
  connectedUsers.set(number, u)
  io.emit('user_update', u)
  io.emit('users_list', Array.from(connectedUsers.values()))
}

async function downloadMedia(platform, url) {
  try {
    const apis = {
      instagram: `https://api.instagramsave.cc/api?url=${encodeURIComponent(url)}`,
      tiktok: `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`,
      facebook: `https://snapsave.app/action.php?url=${encodeURIComponent(url)}`,
      twitter: `https://twitsave.com/info?url=${encodeURIComponent(url)}`,
      youtube: `https://yt-api.p.rapidapi.com/dl?id=${url}`
    }
    const res = await axios.get(apis[platform] || apis.tiktok, { timeout: 15000 })
    return res.data
  } catch { return null }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info')
  const { version } = await fetchLatestBaileysVersion()
  sock = makeWASocket({ version, logger: pino({ level: 'silent' }), printQRInTerminal: true, auth: state, browser: ['NexusBot','Chrome','3.0'], syncFullHistory: false })

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrCodeData = await qrcode.toDataURL(qr)
      botStatus = 'qr_ready'
      io.emit('qr', qrCodeData); io.emit('status', { status: botStatus, uptime: getUptime() })
      addLog('system', null, 'QR Code ready')
    }
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      const reconnect = code !== DisconnectReason.loggedOut
      botStatus = 'disconnected'; botStartTime = null
      io.emit('status', { status: botStatus, uptime: getUptime() }); addLog('system', null, `Disconnected (${code})`)
      if (reconnect) setTimeout(startBot, 5000)
    } else if (connection === 'open') {
      qrCodeData = null; botStatus = 'connected'; botStartTime = Date.now()
      io.emit('status', { status: botStatus, uptime: getUptime() }); io.emit('qr', null)
      addLog('system', null, `✅ ${CONFIG.botName} connected!`)
      if (CONFIG.adminNumber) await sock.sendMessage(`${CONFIG.adminNumber}@s.whatsapp.net`, { text: `✅ *${CONFIG.botName}* is online!\n🕐 ${new Date().toLocaleString()}` }).catch(()=>{})
    }
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try {
        if (msg.key.remoteJid === 'status@broadcast') {
          if (CONFIG.autoViewStatus) { await sock.readMessages([msg.key]).catch(()=>{}); addLog('status_view', msg.key.participant?.split('@')[0], 'Viewed status') }
          if (CONFIG.autoReactStatus && msg.key.participant) {
            const emoji = CONFIG.statusEmojis[Math.floor(Math.random()*CONFIG.statusEmojis.length)]
            await sock.sendMessage('status@broadcast', { react: { text: emoji, key: msg.key } }).catch(()=>{})
            addLog('status_react', msg.key.participant?.split('@')[0], `Reacted ${emoji}`)
          }
          continue
        }
        await handleMsg(msg)
      } catch(e) { console.error('Msg error:', e.message) }
    }
  })
}

async function handleMsg(msg) {
  if (!msg.message || msg.key.fromMe) return
  const jid = msg.key.remoteJid; if (!jid) return
  const isGroup = jid.endsWith('@g.us')
  const senderJid = isGroup ? (msg.key.participant || jid) : jid
  const number = senderJid.split('@')[0]
  const body = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || '').trim()

  totalMsgs++
  if (!isGroup) {
    addLog('message', number, body.substring(0,80))
    if (!isAdmin(number) && CONFIG.adminNumber && sock) {
      await sock.sendMessage(`${CONFIG.adminNumber}@s.whatsapp.net`, { text: `👁️ *Message*\n📱 +${number}\n💬 ${body.substring(0,50)||'[media]'}\n🕐 ${new Date().toLocaleTimeString()}` }).catch(()=>{})
    }
  }

  if (CONFIG.bannedUsers.includes(number)) return

  // Pairing code check
  if (!isGroup && body.length === 8 && /^[A-F0-9]{8}$/.test(body)) {
    const info = pairingCodes.get(body)
    if (info && info.expires > Date.now()) {
      pairingCodes.delete(body)
      const now = new Date().toISOString()
      const user = { number, firstSeen: now, lastSeen: now, msgCount: 1, commandsUsed: [], recentMessages: [], isOnline: true, status: 'active' }
      connectedUsers.set(number, user)
      io.emit('new_user', user); io.emit('users_list', Array.from(connectedUsers.values()))
      addLog('pair', number, 'New user connected')
      await sock.sendMessage(jid, { text: `✅ *Connected Successfully!*\n\n👋 Welcome to *${CONFIG.botName}*!\n\n${CONFIG.welcomeMessage}\n\nType *${CONFIG.botPrefix}menu* to get started 🚀` })
      if (CONFIG.adminNumber) await sock.sendMessage(`${CONFIG.adminNumber}@s.whatsapp.net`, { text: `🔗 *New User Connected!*\n📱 +${number}\n🕐 ${new Date().toLocaleString()}` }).catch(()=>{})
      return
    }
  }

  if (connectedUsers.has(number)) trackUser(number, body, null)

  const prefix = CONFIG.botPrefix
  if (!body.startsWith(prefix)) {
    if (CONFIG.autoReply && !isGroup && !isAdmin(number)) await sock.sendMessage(jid, { text: `👋 Hello! I'm *${CONFIG.botName}*\nType *${prefix}menu* to get started!` })
    return
  }

  const parts = body.slice(prefix.length).trim().split(' ')
  const cmd = parts[0].toLowerCase()
  const args = parts.slice(1)
  const argStr = args.join(' ')
  const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg })

  if (connectedUsers.has(number)) trackUser(number, body, cmd)
  addLog('command', number, `${prefix}${cmd}`)

  switch(cmd) {
    case 'menu': case 'help':
      await reply(`╔═══════════════════════╗\n║  *${CONFIG.botName}* 🤖\n╚═══════════════════════╝\n\n📥 *DOWNLOADERS*\n${prefix}ig <url> — Instagram\n${prefix}tt <url> — TikTok\n${prefix}fb <url> — Facebook\n${prefix}tw <url> — Twitter/X\n${prefix}yt <url> — YouTube\n\n🛠️ *TOOLS*\n${prefix}weather <city>\n${prefix}news\n${prefix}ai <question>\n${prefix}translate <lang> <text>\n${prefix}shorturl <url>\n\n👥 *GROUP*\n${prefix}tagall — Tag everyone\n${prefix}groupinfo\n\n🎮 *FUN*\n${prefix}joke\n${prefix}quote\n${prefix}fact\n${prefix}flip\n${prefix}roll\n\nℹ️ *INFO*\n${prefix}ping | ${prefix}uptime | ${prefix}about\n\n_Powered by ${CONFIG.botName}_`)
      break
    case 'ping': { const t=Date.now(); await reply(`🏓 *Pong!*\n⚡ ${Date.now()-t}ms\n⏱️ ${getUptime()}`); break }
    case 'uptime': await reply(`⏱️ *Uptime:* ${getUptime()}`); break
    case 'about': await reply(`*${CONFIG.botName}*\n✅ Online\n⏱️ ${getUptime()}\n👥 Users: ${connectedUsers.size}\n📨 Messages: ${totalMsgs}`); break
    case 'ig': case 'tt': case 'fb': case 'tw': case 'yt': {
      if (!argStr) { await reply(`❌ Provide a URL: ${prefix}${cmd} https://...`); break }
      const map={ig:'instagram',tt:'tiktok',fb:'facebook',tw:'twitter',yt:'youtube'}
      await reply(`⏳ Downloading from ${map[cmd]}...`)
      const data = await downloadMedia(map[cmd], argStr)
      const videoUrl = data?.url||data?.data?.play||data?.data?.hdplay||data?.video_url||data?.medias?.[0]?.url
      if (videoUrl) { await sock.sendMessage(jid,{video:{url:videoUrl},caption:`✅ Downloaded from ${map[cmd]}`},{quoted:msg}); addLog('download',number,map[cmd]) }
      else await reply(`❌ Download failed. The content may be private.`)
      break
    }
    case 'weather': {
      if (!argStr) { await reply(`❌ Usage: ${prefix}weather Nairobi`); break }
      const r = await axios.get(`https://wttr.in/${encodeURIComponent(argStr)}?format=4`).catch(()=>null)
      await reply(r?.data ? `🌤️ *${argStr}*\n\n${r.data}` : `❌ City not found`)
      break
    }
    case 'news': {
      const r = await axios.get('https://gnews.io/api/v4/top-headlines?lang=en&max=5&token=demo').catch(()=>null)
      if (!r?.data?.articles?.length) { await reply(`❌ No news available`); break }
      await reply(`📰 *News*\n\n${r.data.articles.map((a,i)=>`${i+1}. *${a.title}*`).join('\n\n')}`)
      break
    }
    case 'ai': {
      if (!argStr) { await reply(`❌ Usage: ${prefix}ai <question>`); break }
      await reply(`🤖 Thinking...`)
      const r = await axios.get(`https://api.paxsenix.biz.id/ai/gpt4?text=${encodeURIComponent(argStr)}`).catch(()=>null)
      const ans = r?.data?.message||r?.data?.result||r?.data?.response
      await reply(ans ? `🤖 *AI:*\n\n${ans}` : `❌ AI unavailable right now`)
      break
    }
    case 'translate': {
      if (args.length<2) { await reply(`❌ Usage: ${prefix}translate es Hello`); break }
      const r = await axios.get(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(args.slice(1).join(' '))}&langpair=en|${args[0]}`).catch(()=>null)
      await reply(r?.data?.responseData?.translatedText ? `🌐 *Translation:*\n${r.data.responseData.translatedText}` : `❌ Translation failed`)
      break
    }
    case 'shorturl': {
      if (!argStr) { await reply(`❌ Usage: ${prefix}shorturl https://...`); break }
      const r = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(argStr)}`).catch(()=>null)
      await reply(r?.data ? `🔗 ${r.data}` : `❌ Failed to shorten URL`)
      break
    }
    case 'joke': { const r=await axios.get('https://v2.jokeapi.dev/joke/Any?blacklistFlags=nsfw,racist&type=single').catch(()=>null); await reply(r?.data?.joke?`😂 ${r.data.joke}`:`😂 Why don't scientists trust atoms? They make up everything!`); break }
    case 'quote': { const r=await axios.get('https://api.quotable.io/random').catch(()=>null); await reply(r?.data?`💭 *"${r.data.content}"*\n— _${r.data.author}_`:`💭 "The only way to do great work is to love what you do." — Steve Jobs`); break }
    case 'fact': { const r=await axios.get('https://uselessfacts.jsph.pl/api/v2/facts/random').catch(()=>null); await reply(r?.data?.text?`🧠 ${r.data.text}`:`🧠 Honey never spoils!`); break }
    case 'flip': await reply(`🪙 *Coin Flip:* ${Math.random()>0.5?'HEADS ✨':'TAILS 🌀'}`); break
    case 'roll': await reply(`🎲 *Dice Roll:* ${Math.floor(Math.random()*(parseInt(args[0])||6))+1}`); break
    case 'tagall': case 'everyone': {
      if (!isGroup) { await reply(`❌ Groups only`); break }
      try { const meta=await sock.groupMetadata(jid); const mentions=meta.participants.map(m=>m.id); await sock.sendMessage(jid,{text:`📢 ${argStr||'Attention!'}\n\n${mentions.map(m=>`@${m.split('@')[0]}`).join(' ')}`,mentions},{quoted:msg}) } catch { await reply(`❌ Failed`) }
      break
    }
    case 'groupinfo': {
      if (!isGroup) { await reply(`❌ Groups only`); break }
      try { const m=await sock.groupMetadata(jid); await reply(`👥 *${m.subject}*\n👤 Members: ${m.participants.length}\n📅 ${new Date(m.creation*1000).toLocaleDateString()}\n📝 ${m.desc||'No description'}`) } catch { await reply(`❌ Failed`) }
      break
    }
    default: await reply(`❓ Unknown: *${prefix}${cmd}*\nType *${prefix}menu* for commands.`)
  }
}

function adminOnly(req, res, next) { if (req.session?.isAdmin) return next(); res.status(401).json({ error: 'Unauthorized' }) }

app.post('/api/admin/login', (req,res) => { if (req.body.password===CONFIG.adminPassword) { req.session.isAdmin=true; res.json({success:true}) } else res.status(401).json({error:'Wrong password'}) })
app.post('/api/admin/logout', (req,res) => { req.session.destroy(); res.json({success:true}) })
app.get('/api/admin/stats', adminOnly, (req,res) => res.json({ status:botStatus, uptime:getUptime(), userCount:connectedUsers.size, totalMessages:totalMsgs, activeCodes:[...pairingCodes.entries()].filter(([,v])=>v.expires>Date.now()).length, botName:CONFIG.botName, adminNumber:CONFIG.adminNumber }))
app.get('/api/admin/users', adminOnly, (req,res) => res.json(Array.from(connectedUsers.values())))
app.get('/api/admin/users/:number', adminOnly, (req,res) => { const u=connectedUsers.get(req.params.number); u?res.json(u):res.status(404).json({error:'Not found'}) })
app.get('/api/admin/activity', adminOnly, (req,res) => res.json(activityLog.slice(0,200)))
app.post('/api/admin/generate-code', adminOnly, (req,res) => { const code=genCode(); pairingCodes.set(code,{expires:Date.now()+86400000,createdAt:new Date().toISOString()}); addLog('system',null,`Code generated: ${code}`); res.json({code,shareUrl:`https://wa.me/${CONFIG.adminNumber}?text=${code}`}) })
app.get('/api/admin/codes', adminOnly, (req,res) => { const list=[]; for(const [code,info] of pairingCodes) list.push({code,...info,valid:info.expires>Date.now()}); res.json(list) })
app.get('/api/admin/config', adminOnly, (req,res) => { const s={...CONFIG}; delete s.adminPassword; res.json(s) })
app.post('/api/admin/config', adminOnly, (req,res) => { ['adminNumber','botName','botPrefix','welcomeMessage','autoReactStatus','autoViewStatus','autoReply','statusEmojis','features'].forEach(k=>{ if(req.body[k]!==undefined) CONFIG[k]=req.body[k] }); saveConfig(CONFIG); res.json({success:true}) })
app.post('/api/admin/change-password', adminOnly, (req,res) => { if (!req.body.newPassword||req.body.newPassword.length<4) return res.status(400).json({error:'Too short'}); CONFIG.adminPassword=req.body.newPassword; saveConfig(CONFIG); res.json({success:true}) })
app.post('/api/admin/ban', adminOnly, (req,res) => { const {number,action}=req.body; if(action==='ban'){if(!CONFIG.bannedUsers.includes(number))CONFIG.bannedUsers.push(number);const u=connectedUsers.get(number);if(u){u.status='banned';connectedUsers.set(number,u)}}else{CONFIG.bannedUsers=CONFIG.bannedUsers.filter(n=>n!==number);const u=connectedUsers.get(number);if(u){u.status='active';connectedUsers.set(number,u)}}; saveConfig(CONFIG); io.emit('users_list',Array.from(connectedUsers.values())); res.json({success:true}) })
app.post('/api/admin/send', adminOnly, async (req,res) => { if (!sock) return res.status(503).json({error:'Bot not connected'}); try { await sock.sendMessage(`${req.body.number}@s.whatsapp.net`,{text:req.body.text}); addLog('admin_send',req.body.number,req.body.text?.substring(0,60)); res.json({success:true}) } catch(e) { res.status(500).json({error:e.message}) } })
app.post('/api/admin/restart', adminOnly, (req,res) => { res.json({success:true}); if(sock){try{sock.end()}catch(e){}}; setTimeout(startBot,2000) })
app.get('/api/bot-info', (req,res) => res.json({botName:CONFIG.botName,status:botStatus==='connected'?'online':'offline',adminNumber:CONFIG.adminNumber}))

app.post('/api/request-code', async (req,res) => {
  const clean = (req.body.number||'').toString().replace(/\D/g,'')
  if (clean.length < 7) return res.status(400).json({error:'Invalid number'})
  const code = genCode()
  pairingCodes.set(code, {expires:Date.now()+86400000, number:clean, createdAt:new Date().toISOString()})
  addLog('code_request', clean, `Code requested`)
  if (sock && botStatus==='connected') {
    try {
      await sock.sendMessage(`${clean}@s.whatsapp.net`, { text: `👋 *Welcome to ${CONFIG.botName}!*\n\nYour pairing code is:\n\n┌─────────────────┐\n│   *${code}*   │\n└─────────────────┘\n\nSend this code back to me to connect!\n\n⏰ _Expires in 24 hours_` })
      res.json({success:true, message:'Code sent to your WhatsApp!'})
    } catch(e) { res.status(500).json({error:'Failed to send. Check your number.'}) }
  } else {
    res.status(503).json({error:'Bot is offline. Try again later.'})
  }
})

io.on('connection', (socket) => {
  socket.emit('status', {status:botStatus,uptime:getUptime()})
  if (qrCodeData) socket.emit('qr', qrCodeData)
  socket.emit('users_list', Array.from(connectedUsers.values()))
  socket.emit('activity_bulk', activityLog.slice(0,50))
  const ticker = setInterval(()=>socket.emit('uptime',getUptime()), 5000)
  socket.on('disconnect', ()=>clearInterval(ticker))
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`\n🤖 ${CONFIG.botName} running on port ${PORT}`)
  console.log(`🌐 User Page:   http://localhost:${PORT}`)
  console.log(`🔐 Admin Panel: http://localhost:${PORT}/admin.html`)
  console.log(`\n🔑 Admin Password: ${CONFIG.adminPassword}\n`)
  startBot()
})
