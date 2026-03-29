const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { Resend } = require('resend');

const JWT_SECRET = process.env.JWT_SECRET || 'wave-secret-key-change-in-prod';
const RESEND_KEY = process.env.RESEND_API_KEY || 're_cpjQ5pCW_BqS7EyPe8qqXtezbXZBopQd9';
const resend = new Resend(RESEND_KEY);
const FROM_EMAIL = 'WAVE <onboarding@resend.dev>';

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ── Check if username is taken (public — for guest join) ──
router.get('/check-username', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json({ taken: false });
    const user = await User.findOne({ username: new RegExp(`^${q}$`, 'i') });
    res.json({ taken: !!user });
  } catch (e) { res.status(500).json({ taken: false }); }
});

// ── Register ──
router.post('/register', async (req, res) => {
  try {
    const { username, email, password, avatar } = req.body;
    if (!username || !email || !password)
      return res.status(400).json({ error: 'Username, email, and password are required' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Invalid email address' });

    const existingUser = await User.findOne({ username: new RegExp(`^${username}$`, 'i') });
    if (existingUser) return res.status(400).json({ error: 'Username already taken' });

    const existingEmail = await User.findOne({ email: email.toLowerCase() });
    if (existingEmail) return res.status(400).json({ error: 'Email already registered' });

    const user = await User.create({ username, email: email.toLowerCase(), password, avatar: avatar || null });
    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user._id, username: user.username, email: user.email, avatar: user.avatar } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Login ──
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username: new RegExp(`^${username}$`, 'i') });
    if (!user || !(await user.comparePassword(password)))
      return res.status(400).json({ error: 'Invalid username or password' });
    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user._id, username: user.username, email: user.email, avatar: user.avatar } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Get current user ──
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .populate('friends', 'username avatar email')
      .populate('friendRequests.from', 'username avatar');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: user._id, username: user.username, email: user.email, avatar: user.avatar, pushSubscription: user.pushSubscription, friends: user.friends, friendRequests: user.friendRequests });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Update avatar ──
router.post('/avatar', auth, async (req, res) => {
  try {
    const { avatar } = req.body;
    await User.findByIdAndUpdate(req.user.id, { avatar });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Save push subscription ──
router.post('/push-subscribe', auth, async (req, res) => {
  try {
    const { subscription } = req.body;
    await User.findByIdAndUpdate(req.user.id, { pushSubscription: subscription });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Search user by exact username ──
router.get('/search', auth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json([]);
    const user = await User.findOne({ username: new RegExp(`^${q}$`, 'i') }).select('username avatar');
    if (!user || user._id.toString() === req.user.id) return res.json([]);
    res.json([{ id: user._id, username: user.username, avatar: user.avatar }]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Send friend request ──
router.post('/friend-request/:targetId', auth, async (req, res) => {
  try {
    const target = await User.findById(req.params.targetId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.friends.map(f=>f.toString()).includes(req.user.id))
      return res.status(400).json({ error: 'Already friends' });
    if (target.friendRequests.some(r => r.from.toString() === req.user.id))
      return res.status(400).json({ error: 'Request already sent' });
    target.friendRequests.push({ from: req.user.id });
    await target.save();

    // Email notification for friend request
    const me = await User.findById(req.user.id);
    try {
      await resend.emails.send({
        from: FROM_EMAIL, to: target.email,
        subject: `${me.username} wants to be your friend on WAVE`,
        html: emailTemplate(`👋 Friend Request from ${me.username}`,
          `<b>${me.username}</b> sent you a friend request on WAVE.`,
          'Log in to WAVE to accept or decline.',
          process.env.APP_URL || 'https://wave-chat-fnpr.onrender.com', 'Open WAVE')
      });
    } catch(e) { console.log('Email failed:', e.message); }

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Accept friend request ──
router.post('/friend-accept/:fromId', auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id);
    const them = await User.findById(req.params.fromId);
    if (!them) return res.status(404).json({ error: 'User not found' });
    me.friendRequests = me.friendRequests.filter(r => r.from.toString() !== req.params.fromId);
    if (!me.friends.map(f=>f.toString()).includes(req.params.fromId)) me.friends.push(req.params.fromId);
    if (!them.friends.map(f=>f.toString()).includes(req.user.id)) them.friends.push(req.user.id);
    await me.save(); await them.save();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Decline friend request ──
router.post('/friend-decline/:fromId', auth, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user.id, { $pull: { friendRequests: { from: req.params.fromId } } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Remove friend ──
router.post('/friend-remove/:friendId', auth, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user.id, { $pull: { friends: req.params.friendId } });
    await User.findByIdAndUpdate(req.params.friendId, { $pull: { friends: req.user.id } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Send room invite email to offline friend ──
router.post('/invite-email', auth, async (req, res) => {
  try {
    const { toUserId, roomId, roomName } = req.body;
    const me = await User.findById(req.user.id);
    const friend = await User.findById(toUserId).select('email username friends');
    if (!friend) return res.status(404).json({ error: 'User not found' });
    // Must be friends
    if (!friend.friends.map(f=>f.toString()).includes(req.user.id))
      return res.status(403).json({ error: 'Not friends' });

    const joinUrl = `${process.env.APP_URL || 'https://wave-chat-fnpr.onrender.com'}?room=${roomId}`;
    await resend.emails.send({
      from: FROM_EMAIL, to: friend.email,
      subject: `${me.username} invited you to join a room on WAVE`,
      html: emailTemplate(
        `🎙️ You're invited to "${roomName}"`,
        `<b>${me.username}</b> is in a room and wants you to join!`,
        `Click the button below to jump in — the room is live right now.`,
        joinUrl, '🎙️ Join Room Now'
      )
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function emailTemplate(title, body, sub, url, btnText) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#050508;font-family:'Segoe UI',sans-serif;">
  <div style="max-width:480px;margin:40px auto;background:#0d0d14;border-radius:16px;overflow:hidden;border:1px solid #1e1e2e;">
    <div style="background:linear-gradient(135deg,#6c63ff,#ff6584,#43e97b);padding:3px 0 0;"></div>
    <div style="padding:2rem;">
      <div style="font-size:2rem;font-weight:900;background:linear-gradient(135deg,#6c63ff,#ff6584);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:1rem;">WAVE</div>
      <h2 style="color:#e8e8f0;font-size:1.1rem;margin:0 0 .75rem;">${title}</h2>
      <p style="color:#e8e8f0;font-size:.9rem;margin:0 0 .5rem;">${body}</p>
      <p style="color:#6b6b80;font-size:.82rem;margin:0 0 1.5rem;">${sub}</p>
      <a href="${url}" style="display:inline-block;background:#6c63ff;color:#fff;text-decoration:none;padding:.75rem 1.5rem;border-radius:10px;font-weight:700;font-size:.9rem;">${btnText}</a>
      <p style="color:#6b6b80;font-size:.7rem;margin-top:1.5rem;">You received this because you have an account on WAVE. If you didn't expect this, you can ignore it.</p>
    </div>
  </div></body></html>`;
}

module.exports = { router, auth, JWT_SECRET };
