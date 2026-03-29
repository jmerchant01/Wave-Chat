const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Message = require('../models/Message');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET || 'wave-secret-key-change-in-prod';
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB base64 limit (~15MB raw)

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function isFriend(user, targetId) {
  return user.friends.some(f => f.toString() === targetId.toString());
}

// ── Send a message ──
router.post('/messages/send', auth, async (req, res) => {
  try {
    const { toUserId, text, fileUrl, fileType, fileName } = req.body;
    if (!toUserId) return res.status(400).json({ error: 'Recipient required' });
    if (!text && !fileUrl) return res.status(400).json({ error: 'Message cannot be empty' });

    // Must be friends
    const me = await User.findById(req.user.id).select('friends');
    if (!isFriend(me, toUserId))
      return res.status(403).json({ error: 'You can only message friends' });

    // File size check
    if (fileUrl && fileUrl.length > MAX_FILE_SIZE)
      return res.status(400).json({ error: 'File too large (max 15MB)' });

    // File type validation
    const allowedTypes = ['image', 'video', 'file'];
    if (fileType && !allowedTypes.includes(fileType))
      return res.status(400).json({ error: 'Invalid file type' });

    const msg = await Message.create({
      from: req.user.id, to: toUserId,
      text: text || '', fileUrl, fileType, fileName
    });

    const populated = await Message.findById(msg._id)
      .populate('from', 'username avatar');

    res.json({ success: true, message: populated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Get conversation with a user ──
router.get('/messages/conversation/:userId', auth, async (req, res) => {
  try {
    const { page = 1 } = req.query;
    const limit = 40;
    const other = req.params.userId;

    const messages = await Message.find({
      deleted: false,
      $or: [
        { from: req.user.id, to: other },
        { from: other, to: req.user.id }
      ]
    })
    .populate('from', 'username avatar')
    .sort({ createdAt: -1 })
    .skip((page-1)*limit).limit(limit);

    // Mark as read
    await Message.updateMany(
      { from: other, to: req.user.id, read: false },
      { read: true }
    );

    res.json({ messages: messages.reverse() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Get all conversations (inbox) ──
router.get('/messages/inbox', auth, async (req, res) => {
  try {
    const me = req.user.id;
    // Get latest message per conversation
    const latest = await Message.aggregate([
      { $match: { deleted: false, $or: [{ from: require('mongoose').Types.ObjectId.createFromHexString(me) }, { to: require('mongoose').Types.ObjectId.createFromHexString(me) }] } },
      { $sort: { createdAt: -1 } },
      { $group: {
        _id: {
          $cond: [{ $lt: ['$from', '$to'] }, { a: '$from', b: '$to' }, { a: '$to', b: '$from' }]
        },
        lastMsg: { $first: '$$ROOT' }
      }},
      { $replaceRoot: { newRoot: '$lastMsg' } },
      { $sort: { createdAt: -1 } }
    ]);

    // Populate users
    await Message.populate(latest, { path: 'from', select: 'username avatar' });
    await Message.populate(latest, { path: 'to', select: 'username avatar' });

    // Get unread counts
    const unreadAgg = await Message.aggregate([
      { $match: { to: require('mongoose').Types.ObjectId.createFromHexString(me), read: false, deleted: false } },
      { $group: { _id: '$from', count: { $sum: 1 } } }
    ]);
    const unreadMap = {};
    unreadAgg.forEach(u => unreadMap[u._id.toString()] = u.count);

    const conversations = latest.map(m => {
      const otherId = m.from._id.toString() === me ? m.to._id.toString() : m.from._id.toString();
      const other = m.from._id.toString() === me ? m.to : m.from;
      return {
        userId: otherId,
        username: other.username,
        avatar: other.avatar,
        lastMessage: m,
        unread: unreadMap[otherId] || 0
      };
    });

    res.json({ conversations });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Delete a message ──
router.delete('/messages/:id', auth, async (req, res) => {
  try {
    const msg = await Message.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (msg.from.toString() !== req.user.id)
      return res.status(403).json({ error: 'Cannot delete others messages' });
    await Message.findByIdAndUpdate(req.params.id, { deleted: true });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Get unread count ──
router.get('/messages/unread', auth, async (req, res) => {
  try {
    const count = await Message.countDocuments({ to: req.user.id, read: false, deleted: false });
    res.json({ count });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
