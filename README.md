# 🎙️ WAVE — Real-Time Voice Chat

Multi-user voice rooms with full host controls. Works across any device on any network.

## Stack
- **Server:** Node.js + Express + Socket.io (signaling)
- **Audio:** WebRTC peer-to-peer mesh (direct device-to-device audio)
- **Frontend:** Vanilla HTML/CSS/JS (single file, zero build step)

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Start the server
```bash
npm start
# Server runs at http://localhost:3000
```

### 3. Open in browser
Go to `http://localhost:3000`

---

## How to Invite People

### Same network (home/office WiFi):
Share your local IP:
```
http://192.168.x.x:3000?room=ROOMCODE
```
Find your IP:
- **Mac/Linux:** `ifconfig | grep "inet "`  
- **Windows:** `ipconfig` → look for IPv4 Address

### Over the internet (anyone, anywhere):
Use [ngrok](https://ngrok.com) (free):
```bash
# Install ngrok, then:
ngrok http 3000
# Share the https://xxxx.ngrok.io URL
```

Or deploy to Railway / Render / Fly.io (all have free tiers).

---

## Features

### For everyone:
- 🎙️ Real-time voice with echo cancellation & noise suppression
- 💬 Text chat alongside voice
- 🔊 Visual speaking indicators (green pulse when someone talks)
- 📋 One-click invite link copying

### Host only 👑:
- 🔇 Mute/unmute any individual participant
- 🔇 Mute All / Unmute All buttons
- ✕ Remove (kick) any participant
- 🔒 Lock room — prevent new people joining
- ⛔ End room for everyone
- 👑 If host leaves, next participant is automatically promoted

---

## Architecture

```
Browser A ──────────────────── Browser B
    │    WebRTC (audio P2P)        │
    │                              │
    └──── Socket.io server ────────┘
         (signaling only:
          offer/answer/ICE)
```

The server only handles signaling (connecting peers). Audio flows **directly** between browsers via WebRTC — the server doesn't touch audio data.

## Deploy to the Cloud

### Railway (easiest):
1. Push to GitHub
2. Connect repo to [railway.app](https://railway.app)
3. It auto-detects Node.js and deploys

### Render:
1. Push to GitHub  
2. New Web Service on [render.com](https://render.com)
3. Build: `npm install`, Start: `npm start`

### Environment Variables:
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
