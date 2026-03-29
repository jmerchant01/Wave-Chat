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
    const { status, page = 1 } = req.query;
    const limit = 20;
    const { status, userId, page = 1 } = req.query;
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
