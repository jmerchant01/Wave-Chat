const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Report = require('../models/Report');
const Block  = require('../models/Block');
const MonetizationApplication = require('../models/MonetizationApplication');
const Community = require('../models/Community');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET || 'wave-secret-key-change-in-prod';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'JayMerch';

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if(!token) return res.status(401).json({ error: 'Not authenticated' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function isAdmin(req) {
  return req.user?.username?.toLowerCase() === ADMIN_USERNAME.toLowerCase();
}

// ─────────────────────────────────────────────
// REPORTS
// ─────────────────────────────────────────────

// ── Submit a report (any type) ──
router.post('/reports', auth, async (req, res) => {
  try {
    const {
      targetType, reason, description,
      reportedUserId, reportedCommunityId,
      reportedMessageId, reportedCommunityMessageId,
      roomId, roomName, contentSnapshot
    } = req.body;

    if(!targetType || !reason || !description)
      return res.status(400).json({ error: 'targetType, reason, and description are required' });

    // Rate limit: max 10 reports per hour per user
    const oneHourAgo = new Date(Date.now() - 3600000);
    const recentCount = await Report.countDocuments({ reportedBy: req.user.id, createdAt: { $gte: oneHourAgo } });
    if(recentCount >= 10)
      return res.status(429).json({ error: 'You have submitted too many reports recently. Please wait before submitting more.' });

    const report = await Report.create({
      reportedBy: req.user.id,
      targetType,
      reason,
      description,
      reportedUser:             reportedUserId || null,
      reportedCommunity:        reportedCommunityId || null,
      reportedMessage:          reportedMessageId || null,
      reportedCommunityMessage: reportedCommunityMessageId || null,
      roomId:   roomId || null,
      roomName: roomName || null,
      contentSnapshot: contentSnapshot || null
    });

    // CSAM or threats → flag as critical immediately
    if(['csam','illegal_content','threats'].includes(reason)){
      console.error(`🚨 CRITICAL REPORT [${reason.toUpperCase()}] filed by ${req.user.username} - Report ID: ${report._id}`);
    }

    res.json({ success: true, reportId: report._id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: get all reports ──
router.get('/admin/reports', auth, async (req, res) => {
  try {
    if(!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
    const { status, priority, targetType, page = 1 } = req.query;
    const filter = {};
    if(status) filter.status = status;
    if(priority) filter.priority = priority;
    if(targetType) filter.targetType = targetType;

    const reports = await Report.find(filter)
      .populate('reportedBy', 'username email avatar')
      .populate('reportedUser', 'username email avatar')
      .populate('reportedCommunity', 'name avatar')
      .populate('reportedMessage', 'text from to')
      .populate('reportedCommunityMessage', 'text userId communityId channelId')
      .sort({ priority: -1, createdAt: -1 })
      .skip((page - 1) * 50).limit(50).lean();

    const counts = await Report.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);
    const critical = await Report.countDocuments({ priority: 'critical', status: 'pending' });

    res.json({ reports, counts, critical });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: update report status ──
router.patch('/admin/reports/:id', auth, async (req, res) => {
  try {
    if(!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
    const { status, adminNote } = req.body;
    const report = await Report.findByIdAndUpdate(
      req.params.id,
      { status, adminNote: adminNote || '', reviewedBy: req.user.username, reviewedAt: new Date() },
      { new: true }
    );
    if(!report) return res.status(404).json({ error: 'Report not found' });
    res.json({ success: true, report });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// BLOCKS
// ─────────────────────────────────────────────

// ── Block something ──
router.post('/blocks', auth, async (req, res) => {
  try {
    const { targetType, blockedUserId, blockedCommunityId, blockedRoomId, blockedRoomName } = req.body;
    if(!targetType) return res.status(400).json({ error: 'targetType required' });

    // Cannot block yourself
    if(targetType === 'user' && blockedUserId === req.user.id)
      return res.status(400).json({ error: 'You cannot block yourself' });

    const blockData = {
      blockedBy: req.user.id,
      targetType,
      blockedUser:      blockedUserId || null,
      blockedCommunity: blockedCommunityId || null,
      blockedRoomId:    blockedRoomId || null,
      blockedRoomName:  blockedRoomName || null
    };

    // Upsert — idempotent
    let block;
    if(targetType === 'user'){
      block = await Block.findOneAndUpdate(
        { blockedBy: req.user.id, blockedUser: blockedUserId },
        blockData, { upsert: true, new: true }
      );
      // Also remove from friends if they were friends
      await User.updateOne({ _id: req.user.id }, { $pull: { friends: blockedUserId } });
      await User.updateOne({ _id: blockedUserId }, { $pull: { friends: req.user.id } });
    } else if(targetType === 'community'){
      block = await Block.findOneAndUpdate(
        { blockedBy: req.user.id, blockedCommunity: blockedCommunityId },
        blockData, { upsert: true, new: true }
      );
    } else {
      block = await Block.create(blockData);
    }

    res.json({ success: true, block });
  } catch(e) {
    if(e.code === 11000) return res.json({ success: true, alreadyBlocked: true });
    res.status(500).json({ error: e.message });
  }
});

// ── Unblock ──
router.delete('/blocks/:id', auth, async (req, res) => {
  try {
    const block = await Block.findOneAndDelete({ _id: req.params.id, blockedBy: req.user.id });
    if(!block) return res.status(404).json({ error: 'Block not found' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Get my blocks ──
router.get('/blocks/mine', auth, async (req, res) => {
  try {
    const blocks = await Block.find({ blockedBy: req.user.id })
      .populate('blockedUser', 'username avatar')
      .populate('blockedCommunity', 'name avatar')
      .lean();
    res.json({ blocks });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Check if something is blocked ──
router.get('/blocks/check', auth, async (req, res) => {
  try {
    const { targetType, targetId } = req.query;
    let query = { blockedBy: req.user.id, targetType };
    if(targetType === 'user') query.blockedUser = targetId;
    else if(targetType === 'community') query.blockedCommunity = targetId;
    else if(targetType === 'room') query.blockedRoomId = targetId;
    const block = await Block.findOne(query).lean();
    res.json({ blocked: !!block, blockId: block?._id || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// MONETIZATION APPLICATIONS
// ─────────────────────────────────────────────

// ── Creator: apply for paid subscriptions ──
router.post('/communities/:id/monetization/apply', auth, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id);
    if(!community) return res.status(404).json({ error: 'Community not found' });
    if(community.ownerId.toString() !== req.user.id)
      return res.status(403).json({ error: 'Only the community owner can apply' });

    const { proposedPricing, valueProposition, stripeAccountId } = req.body;
    if(!valueProposition || valueProposition.trim().length < 20)
      return res.status(400).json({ error: 'Please describe what subscribers will receive (min 20 characters)' });

    // Must have at least one price set
    const prices = proposedPricing || {};
    const hasPrice = Object.values(prices).some(p => parseFloat(p) > 0);
    if(!hasPrice)
      return res.status(400).json({ error: 'Please set at least one subscription price' });

    // Upsert application — creators can update a pending application
    const existing = await MonetizationApplication.findOne({ communityId: req.params.id });
    if(existing && existing.status === 'approved')
      return res.status(400).json({ error: 'This community is already approved for paid subscriptions' });
    if(existing && existing.status === 'pending')
      return res.status(400).json({ error: 'Your application is already pending review' });

    const application = await MonetizationApplication.findOneAndUpdate(
      { communityId: req.params.id },
      {
        communityId: req.params.id,
        ownerId: req.user.id,
        proposedPricing: {
          weekly:   parseFloat(prices.weekly)   || 0,
          monthly:  parseFloat(prices.monthly)  || 0,
          yearly:   parseFloat(prices.yearly)   || 0,
          lifetime: parseFloat(prices.lifetime) || 0
        },
        valueProposition: valueProposition.trim(),
        stripeAccountId: stripeAccountId || community.stripeAccountId || null,
        status: 'pending',
        updatedAt: new Date()
      },
      { upsert: true, new: true }
    );

    res.json({ success: true, application });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Creator: get their application status ──
router.get('/communities/:id/monetization/status', auth, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id).select('ownerId stripeAccountId isPaid').lean();
    if(!community) return res.status(404).json({ error: 'Not found' });
    if(community.ownerId.toString() !== req.user.id)
      return res.status(403).json({ error: 'Owner only' });

    const application = await MonetizationApplication.findOne({ communityId: req.params.id }).lean();
    res.json({
      application: application || null,
      isPaid: community.isPaid,
      stripeAccountId: community.stripeAccountId
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: get all monetization applications ──
router.get('/admin/monetization/applications', auth, async (req, res) => {
  try {
    if(!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
    const { status } = req.query;
    const filter = status ? { status } : {};
    const applications = await MonetizationApplication.find(filter)
      .populate('communityId', 'name avatar description members stripeAccountId')
      .populate('ownerId', 'username email avatar')
      .sort({ createdAt: -1 }).lean();
    res.json({ applications });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: approve or reject a monetization application ──
router.patch('/admin/monetization/applications/:id', auth, async (req, res) => {
  try {
    if(!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
    const { status, adminNote } = req.body;
    if(!['approved','rejected','revoked'].includes(status))
      return res.status(400).json({ error: 'Invalid status' });

    const application = await MonetizationApplication.findByIdAndUpdate(
      req.params.id,
      { status, adminNote: adminNote || '', reviewedBy: req.user.username, reviewedAt: new Date(), updatedAt: new Date() },
      { new: true }
    ).populate('communityId').populate('ownerId', 'username');

    if(!application) return res.status(404).json({ error: 'Application not found' });

    // If approved → enable paid subscriptions and apply pricing on the community
    if(status === 'approved'){
      const community = await Community.findById(application.communityId._id);
      if(community){
        community.isPaid = true;
        // Save the proposed pricing
        const p = application.proposedPricing;
        if(p.weekly  > 0) community.subscription.weekly.price  = Math.round(p.weekly  * 100);
        if(p.monthly > 0) community.subscription.monthly.price = Math.round(p.monthly * 100);
        if(p.yearly  > 0) community.subscription.yearly.price  = Math.round(p.yearly  * 100);
        if(p.lifetime> 0) community.subscription.lifetime.price= Math.round(p.lifetime* 100);
        await community.save();
      }
    }

    // If rejected or revoked → disable paid subscriptions
    if(status === 'rejected' || status === 'revoked'){
      await Community.findByIdAndUpdate(application.communityId._id, { isPaid: false });
    }

    res.json({ success: true, application });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ─────────────────────────────────────────────
// ACCOUNT DELETION
// ─────────────────────────────────────────────

// ── Request account deletion — requires password confirmation ──
router.post('/account/delete', auth, async (req, res) => {
  try {
    const { password, reason } = req.body;
    if(!password) return res.status(400).json({ error: 'Password confirmation required' });

    const user = await User.findById(req.user.id);
    if(!user) return res.status(404).json({ error: 'User not found' });

    // Verify password before deleting
    const valid = await user.comparePassword(password);
    if(!valid) return res.status(401).json({ error: 'Incorrect password' });

    const userId = user._id;
    const username = user.username;

    // 1. Cancel any active Stripe subscriptions
    try {
      const Subscription = require('../models/Subscription');
      const activeSubs = await Subscription.find({ userId, status: 'active', stripeSubscriptionId: { $ne: null } });
      const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
      if(STRIPE_SECRET && activeSubs.length > 0){
        const stripe = require('stripe')(STRIPE_SECRET);
        for(const sub of activeSubs){
          try { await stripe.subscriptions.cancel(sub.stripeSubscriptionId); } catch(e) { /* best effort */ }
        }
      }
      await Subscription.deleteMany({ userId });
    } catch(e) { console.error('Subscription cleanup error:', e.message); }

    // 2. Remove user from all communities they're a member of
    try {
      await Community.updateMany(
        { 'members.userId': userId },
        { $pull: { members: { userId } } }
      );
    } catch(e) { console.error('Community member cleanup error:', e.message); }

    // 3. Delete communities they own (or optionally mark as orphaned)
    try {
      const CommunityMessage = require('../models/CommunityMessage');
      const ownedCommunities = await Community.find({ ownerId: userId }).select('_id');
      const ownedIds = ownedCommunities.map(c => c._id);
      if(ownedIds.length > 0){
        await CommunityMessage.deleteMany({ communityId: { $in: ownedIds } });
        await Community.deleteMany({ ownerId: userId });
      }
    } catch(e) { console.error('Owned community cleanup error:', e.message); }

    // 4. Soft-delete direct messages (mark deleted, don't expose to other user)
    try {
      const Message = require('../models/Message');
      await Message.updateMany({ $or: [{ from: userId }, { to: userId }] }, { deleted: true });
    } catch(e) { console.error('Message cleanup error:', e.message); }

    // 5. Delete their community messages
    try {
      const CommunityMessage = require('../models/CommunityMessage');
      await CommunityMessage.updateMany({ userId }, { deleted: true, text: '[deleted]' });
    } catch(e) { console.error('Community message cleanup error:', e.message); }

    // 6. Remove from friends lists of all other users
    try {
      await User.updateMany({ friends: userId }, { $pull: { friends: userId } });
      await User.updateMany({}, { $pull: { friendRequests: { from: userId } } });
    } catch(e) { console.error('Friends cleanup error:', e.message); }

    // 7. Delete their blocks and reports
    try {
      await Block.deleteMany({ $or: [{ blockedBy: userId }, { blockedUser: userId }] });
      await Report.updateMany({ reportedUser: userId }, { $set: { adminNote: `[Account deleted: ${username}]` } });
    } catch(e) { console.error('Block/report cleanup error:', e.message); }

    // 8. Delete monetization applications
    try {
      const MonetizationApplication = require('../models/MonetizationApplication');
      await MonetizationApplication.deleteMany({ ownerId: userId });
    } catch(e) { console.error('Monetization cleanup error:', e.message); }

    // 9. Finally delete the user account
    await User.findByIdAndDelete(userId);

    console.log(`🗑️ Account deleted: ${username} (${userId}) — Reason: ${reason || 'not specified'}`);
    res.json({ success: true, message: 'Your account and all associated data has been permanently deleted.' });
  } catch(e) {
    console.error('Account deletion error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: delete any user account ──
router.delete('/admin/users/:id', auth, async (req, res) => {
  try {
    if(!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
    const user = await User.findById(req.params.id);
    if(!user) return res.status(404).json({ error: 'User not found' });
    if(user.username.toLowerCase() === ADMIN_USERNAME.toLowerCase())
      return res.status(400).json({ error: 'Cannot delete admin account' });

    // Reuse same cleanup — fire and forget non-critical steps
    const userId = user._id;
    const Subscription = require('../models/Subscription');
    const Message = require('../models/Message');
    const CommunityMessage = require('../models/CommunityMessage');
    const MonetizationApplication = require('../models/MonetizationApplication');

    await Promise.allSettled([
      Subscription.deleteMany({ userId }),
      Community.updateMany({ 'members.userId': userId }, { $pull: { members: { userId } } }),
      Message.updateMany({ $or: [{ from: userId }, { to: userId }] }, { deleted: true }),
      CommunityMessage.updateMany({ userId }, { deleted: true, text: '[deleted]' }),
      User.updateMany({ friends: userId }, { $pull: { friends: userId } }),
      Block.deleteMany({ $or: [{ blockedBy: userId }, { blockedUser: userId }] }),
      MonetizationApplication.deleteMany({ ownerId: userId })
    ]);

    // Delete owned communities
    const ownedCommunities = await Community.find({ ownerId: userId }).select('_id');
    if(ownedCommunities.length > 0){
      const ids = ownedCommunities.map(c => c._id);
      await CommunityMessage.deleteMany({ communityId: { $in: ids } });
      await Community.deleteMany({ ownerId: userId });
    }

    await User.findByIdAndDelete(userId);
    console.log(`🗑️ Admin deleted account: ${user.username} (${userId}) by ${req.user.username}`);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ─────────────────────────────────────────────
// USER VERIFICATION (Blue Checkmark)
// ─────────────────────────────────────────────

// ── Admin: verify a user ──
router.post('/admin/users/:id/verify', auth, async (req, res) => {
  try {
    if(!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
    const { verified, note } = req.body;
    const user = await User.findByIdAndUpdate(
      req.params.id,
      {
        isVerified: verified !== false,
        verifiedAt: verified !== false ? new Date() : null,
        verifiedBy: verified !== false ? req.user.username : null,
        verificationNote: note || ''
      },
      { new: true }
    ).select('username email isVerified verifiedAt verifiedBy verificationNote');
    if(!user) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, user });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: get all verified users ──
router.get('/admin/verified-users', auth, async (req, res) => {
  try {
    if(!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
    const users = await User.find({ isVerified: true })
      .select('username avatar isVerified verifiedAt verifiedBy verificationNote')
      .lean();
    res.json({ users });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: search users for verification ──
router.get('/admin/users/search', auth, async (req, res) => {
  try {
    if(!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
    const { q } = req.query;
    if(!q) return res.json({ users: [] });
    const users = await User.find({
      $or: [
        { username: new RegExp(q, 'i') },
        { email: new RegExp(q, 'i') }
      ]
    }).select('username email avatar isVerified createdAt').limit(20).lean();
    res.json({ users });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Get notification preferences ──
router.get('/me/notification-prefs', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('notificationPrefs').lean();
    res.json({ prefs: user?.notificationPrefs || {} });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Update notification preferences ──
router.patch('/me/notification-prefs', auth, async (req, res) => {
  try {
    const allowed = ['friendOnline','friendRequest','directMessage','communityInvite','roomInvite','communityMessage'];
    const update = {};
    allowed.forEach(k => { if(req.body[k] !== undefined) update[`notificationPrefs.${k}`] = !!req.body[k]; });
    await User.findByIdAndUpdate(req.user.id, { $set: update });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
