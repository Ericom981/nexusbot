# 🤖 NexusBot — WhatsApp Bot + Admin Panel

A full-featured WhatsApp bot with pairing code system, admin spy panel, downloaders, AI chat, status automation and more.

---

## 🚀 Quick Setup (Free Hosting on Railway / Render)

### 1. Install Dependencies
```bash
cd nexusbot
npm install
```

### 2. Start the Bot
```bash
npm start
```

### 3. Access the Pages
| Page | URL |
|------|-----|
| User Connect Page | `http://localhost:3000` |
| Admin Login | `http://localhost:3000/admin.html` |
| Admin Dashboard | `http://localhost:3000/dashboard.html` |

### 4. First Login
- On first run, the console shows your **auto-generated admin password**
- Example: `🔑 Admin Password: a3f9b2c1`
- Go to `/admin.html` and log in with this password
- **Change it immediately** in Admin → Account Settings

---

## 🌐 Free Hosting (Railway)

1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. It auto-detects Node.js and starts `npm start`
4. You get a free public URL like `https://nexusbot-xxx.railway.app`
5. Share `https://nexusbot-xxx.railway.app` with users to connect
6. Your admin panel: `https://nexusbot-xxx.railway.app/admin.html`

**Other free options:**
- [Render.com](https://render.com) — Free Web Service
- [Glitch.com](https://glitch.com) — Instant deploy

---

## 📋 Features

### Bot Commands
| Command | Description |
|---------|-------------|
| `.menu` | Show all commands |
| `.ig <url>` | Download Instagram reel/video |
| `.tt <url>` | Download TikTok video (no watermark) |
| `.fb <url>` | Download Facebook video |
| `.tw <url>` | Download Twitter/X video |
| `.yt <url>` | Download YouTube audio/video |
| `.weather <city>` | Live weather update |
| `.news` | Latest headlines |
| `.ai <question>` | Ask AI anything (GPT-powered) |
| `.ping` | Check bot latency & uptime |
| `.sticker` | Convert image to sticker |
| `.about` | Bot info |

### Admin Panel Features
- 📊 **Dashboard** — Stats overview, recent users, live log
- 📡 **Live Log** — Real-time activity monitor (messages, downloads, status views)
- 🔌 **Connection** — QR code scanner, restart/disconnect controls
- 🔑 **Pairing Codes** — Generate & share codes with users (24h expiry)
- 👥 **User Spy Panel** — See who connected, their message count, recent chats
- 💬 **Send Message** — Send messages as the bot to any number
- ⚙️ **Bot Settings** — Configure name, prefix, welcome message, features
- 🛡️ **Admin Account** — Change your password

### Auto Features
- 👁️ **Auto-view Status** — Automatically views all WhatsApp statuses
- ❤️ **Auto-react Status** — Reacts to statuses with random emojis
- 🔔 **Admin Notifications** — Notified via WhatsApp when new users connect or send messages

---

## 🔒 Security
- Admin panel protected by password (session-based)
- Pairing codes expire in 24 hours
- Users can be banned from the admin panel
- Admin number receives real-time alerts

---

## 📁 File Structure
```
nexusbot/
├── index.js          ← Main bot + API server
├── package.json      ← Dependencies
├── config.json       ← Auto-generated config (after first run)
├── auth_info/        ← Auto-generated WhatsApp session
└── public/
    ├── index.html    ← User connect page (share this link)
    ├── admin.html    ← Admin login page
    └── dashboard.html ← Admin dashboard
```

---

## ⚠️ Notes
- First run generates `config.json` with a random admin password — check the console
- WhatsApp session is saved in `auth_info/` — don't delete it unless you want to re-scan QR
- The bot uses Baileys (unofficial WhatsApp Web API) — use responsibly
- Video downloaders use free public APIs — replace with premium ones for reliability
