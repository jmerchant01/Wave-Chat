const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Report = require('../models/Report');

const JWT_SECRET = process.env.JWT_SECRET || 'wave-secret-key-change-in-prod';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'JayMerch';

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function adminOnly(req, res, next) {
  if(req.user.username.toLowerCase() !== ADMIN_USERNAME.toLowerCase())
    return res.status(403).json({ error: 'Admin only' });
  next();
}

// ── Submit a report ──
router.post('/report', auth, async (req, res) => {
  try {
    const { reportedUserId, reason, description } = req.body;
    if(!reportedUserId || !reason || !description)
      return res.status(400).json({ error: 'Missing fields' });
    if(description.length < 10)
      return res.status(400).json({ error: 'Description must be at least 10 characters' });
    if(reportedUserId === req.user.id)
      return res.status(400).json({ error: 'Cannot report yourself' });

    // Check if already reported this user recently (prevent spam)
    const existing = await Report.findOne({
      reportedUser: reportedUserId,
      reportedBy: req.user.id,
      createdAt: { $gte: new Date(Date.now() - 24*60*60*1000) }
    });
    if(existing) return res.status(400).json({ error: 'You already reported this user in the last 24 hours' });

    const report = await Report.create({
      reportedUser: reportedUserId,
      reportedBy: req.user.id,
      reason,
      description
    });
    res.json({ success: true, reportId: report._id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: Get all users ──
router.get('/admin/users', auth, adminOnly, async (req, res) => {
  try {
    const { search, page = 1 } = req.query;
    const limit = 20;
    const query = search ? { username: new RegExp(search, 'i') } : {};
    const total = await User.countDocuments(query);
    const users = await User.find(query)
      .select('username email avatar createdAt')
      .sort({ createdAt: -1 })
      .skip((page-1)*limit).limit(limit);

    // Get report counts for each user
    const ids = users.map(u => u._id);
    const reportCounts = await Report.aggregate([
      { $match: { reportedUser: { $in: ids } } },
      { $group: { _id: '$reportedUser', count: { $sum: 1 } } }
    ]);
    const countMap = {};
    reportCounts.forEach(r => countMap[r._id.toString()] = r.count);

    const result = users.map(u => ({
      id: u._id, username: u.username, email: u.email,
      avatar: u.avatar, createdAt: u.createdAt,
      reportCount: countMap[u._id.toString()] || 0
    }));
    res.json({ users: result, total, page: parseInt(page), pages: Math.ceil(total/limit) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: Delete a user ──
router.delete('/admin/users/:id', auth, adminOnly, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if(!user) return res.status(404).json({ error: 'User not found' });
    if(user.username.toLowerCase() === ADMIN_USERNAME.toLowerCase())
      return res.status(400).json({ error: 'Cannot delete admin account' });
    // Remove from all friends lists
    await User.updateMany({ friends: req.params.id }, { $pull: { friends: req.params.id } });
    await User.deleteOne({ _id: req.params.id });
    await Report.deleteMany({ $or: [{ reportedUser: req.params.id }, { reportedBy: req.params.id }] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: Get all reports ──
router.get('/admin/reports', auth, adminOnly, async (req, res) => {
  try {
    const { status, userId, page = 1 } = req.query;
    const limit = 20;
    const query = {};
    if(status) query.status = status;
    if(userId) query.reportedUser = userId;
    const total = await Report.countDocuments(query);
    const reports = await Report.find(query)
      .populate('reportedUser', 'username avatar')
      .populate('reportedBy', 'username')
      .sort({ createdAt: -1 })
      .skip((page-1)*limit).limit(limit);
    res.json({ reports, total, page: parseInt(page), pages: Math.ceil(total/limit) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: Update report status ──
router.patch('/admin/reports/:id', auth, adminOnly, async (req, res) => {
  try {
    const { status, adminNote } = req.body;
    await Report.findByIdAndUpdate(req.params.id, { status, adminNote });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: Get stats ──
router.get('/admin/stats', auth, adminOnly, async (req, res) => {
  try {
    const [totalUsers, totalReports, pendingReports, topReported] = await Promise.all([
      User.countDocuments(),
      Report.countDocuments(),
      Report.countDocuments({ status: 'pending' }),
      Report.aggregate([
        { $group: { _id: '$reportedUser', count: { $sum: 1 } } },
        { $sort: { count: -1 } }, { $limit: 5 },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
        { $unwind: '$user' },
        { $project: { username: '$user.username', count: 1 } }
      ])
    ]);
    res.json({ totalUsers, totalReports, pendingReports, topReported });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

// ── ADMIN: Get all communities ──
router.get('/admin/communities', auth, adminOnly, async (req, res) => {
  try {
    const Community = require('../models/Community');
    const { search, page = 1 } = req.query;
    const limit = 20;
    const query = search ? { name: new RegExp(search, 'i') } : {};
    const total = await Community.countDocuments(query);
    const communities = await Community.find(query)
      .select('name description isPublic members channels createdAt ownerId tags')
      .populate('ownerId', 'username')
      .sort({ createdAt: -1 })
      .skip((page-1)*limit).limit(limit).lean();
    const result = communities.map(c => ({
      ...c,
      memberCount: c.members?.length || 0,
      channelCount: c.channels?.length || 0,
    }));
    res.json({ communities: result, total, page: parseInt(page), pages: Math.ceil(total/limit) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: Get community messages (all channels) ──
router.get('/admin/communities/:id/messages', auth, adminOnly, async (req, res) => {
  try {
    const Community = require('../models/Community');
    const CommunityMessage = require('../models/CommunityMessage');
    const { channelId, page = 1 } = req.query;
    const limit = 50;
    const query = { communityId: req.params.id, deleted: false };
    if(channelId) query.channelId = channelId;
    const messages = await CommunityMessage.find(query)
      .populate('userId', 'username avatar')
      .sort({ createdAt: -1 })
      .skip((page-1)*limit).limit(limit).lean();
    const community = await Community.findById(req.params.id).select('name channels').lean();
    res.json({ messages: messages.reverse(), community, total: await CommunityMessage.countDocuments(query) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: Delete a community message ──
router.delete('/admin/communities/:id/messages/:msgId', auth, adminOnly, async (req, res) => {
  try {
    const CommunityMessage = require('../models/CommunityMessage');
    await CommunityMessage.findByIdAndUpdate(req.params.msgId, { deleted: true });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: Delete a community ──
router.delete('/admin/communities/:id', auth, adminOnly, async (req, res) => {
  try {
    const Community = require('../models/Community');
    const CommunityMessage = require('../models/CommunityMessage');
    await Community.deleteOne({ _id: req.params.id });
    await CommunityMessage.deleteMany({ communityId: req.params.id });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: Get all DMs between users ──
router.get('/admin/messages', auth, adminOnly, async (req, res) => {
  try {
    const Message = require('../models/Message');
    const { userId, page = 1 } = req.query;
    const limit = 50;
    const query = { deleted: false };
    if(userId) query.$or = [{ from: userId }, { to: userId }];
    const total = await Message.countDocuments(query);
    const messages = await Message.find(query)
      .populate('from', 'username avatar')
      .populate('to', 'username avatar')
      .sort({ createdAt: -1 })
      .skip((page-1)*limit).limit(limit).lean();
    res.json({ messages: messages.reverse(), total, pages: Math.ceil(total/limit) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: Delete a DM ──
router.delete('/admin/messages/:id', auth, adminOnly, async (req, res) => {
  try {
    const Message = require('../models/Message');
    await Message.findByIdAndUpdate(req.params.id, { deleted: true });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: Ban/unban user from community ──
router.post('/admin/communities/:id/members/:userId/ban', auth, adminOnly, async (req, res) => {
  try {
    const Community = require('../models/Community');
    const community = await Community.findById(req.params.id);
    if(!community) return res.status(404).json({ error: 'Not found' });
    const member = community.members.find(m => m.userId.toString() === req.params.userId);
    if(!member) return res.status(404).json({ error: 'Member not found' });
    member.banned = req.body.ban !== false;
    await community.save();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
