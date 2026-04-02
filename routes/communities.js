const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Community = require('../models/Community');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET || 'wave-secret-key-change-in-prod';

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function getMember(community, userId) {
  return community.members.find(m => m.userId.toString() === userId.toString());
}

// Check if a user can view a channel based on viewRoles
function canViewChannel(community, channel, userId) {
  if(!channel.viewRoles || channel.viewRoles.length === 0) return true; // open to all
  if(community.ownerId.toString() === userId.toString()) return true;
  const member = getMember(community, userId);
  if(!member) return false;
  return member.roles.some(rId => channel.viewRoles.includes(rId));
}

// Check if a user can write to a channel based on writeRoles
function canWriteChannel(community, channel, userId) {
  if(community.ownerId.toString() === userId.toString()) return true;
  if(!channel.writeRoles || channel.writeRoles.length === 0) return true;
  const member = getMember(community, userId);
  if(!member) return false;
  return member.roles.some(rId => channel.writeRoles.includes(rId));
}

function hasPermission(community, userId, perm) {
  const member = getMember(community, userId);
  if (!member) return false;
  if (community.ownerId.toString() === userId.toString()) return true;
  return member.roles.some(rId => {
    const role = community.roles.id(rId);
    return role?.permissions?.isAdmin || role?.permissions?.[perm];
  });
}


// ── Migrate voice channels to room type (run once) ──
router.post('/communities/migrate-voice-to-room', auth, async (req, res) => {
  try {
    const communities = await Community.find({ 'channels.type': { $in: ['voice'] } });
    let count = 0;
    for(const community of communities){
      let changed = false;
      community.channels.forEach(ch => {
        if(ch.type === 'voice'){ ch.type = 'room'; if(ch.name==='voice') ch.name='room'; changed = true; }
      });
      if(changed){ await community.save(); count++; }
    }
    res.json({ success: true, migrated: count });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Create community ──
router.post('/communities', auth, async (req, res) => {
  try {
    const { name, description, isPublic, tags, avatar } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    // Enforce unique community names (case-insensitive)
    const nameTaken = await Community.findOne({ name: new RegExp(`^${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
    if(nameTaken) return res.status(400).json({ error: `A community named "${name}" already exists. Please choose a different name.` });

    const inviteCode = Math.random().toString(36).substr(2, 8).toUpperCase();
    const community = await Community.create({
      name, description: description||'', isPublic: isPublic!==false,
      tags: (tags||[]).slice(0,10),
      avatar: avatar||null,
      ownerId: req.user.id,
      inviteCode,
      roles: [
        { name: 'Admin', color: '#ffd700', order: 0, permissions: { isAdmin: true, canInvite: true, canKick: true, canBan: true, canManageChannels: true, canManageRoles: true } },
        { name: 'Member', color: '#6c63ff', order: 1, permissions: { canInvite: true } }
      ],
      channels: [
        { name: 'general', type: 'text', description: 'General discussion', order: 0 },
        { name: 'announcements', type: 'announcement', description: 'Community announcements', order: 1 },
        { name: 'room', type: 'room', description: 'Create voice rooms', order: 2 }
      ],
      members: [{ userId: req.user.id, roles: [], joinedAt: new Date() }]
    });
    res.json({ success: true, community: await populateCommunity(community) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Get my communities ──
router.get('/communities/mine', auth, async (req, res) => {
  try {
    const communities = await Community.find({ 'members.userId': req.user.id, 'members.banned': { $ne: true } })
      .select('name avatar description isPublic tags members ownerId inviteCode roles channels createdAt')
      .lean();
    // Populate member user info for all communities
    const populated = await Promise.all(communities.map(c => populateCommunityLean(c)));
    res.json({ communities: populated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── Trending/popular public communities ──
router.get('/communities/trending', auth, async (req, res) => {
  try {
    // Get public communities sorted by member count descending, top 10
    const communities = await Community.find({ isPublic: true })
      .select('name avatar description tags members ownerId isPaid stripeProductId')
      .lean();

    // Sort by active member count
    const ranked = communities
      .map(c => ({
        ...c,
        memberCount: c.members?.filter(m => !m.banned).length || 0,
        isMember: c.members?.some(m => m.userId.toString() === req.user.id) || false
      }))
      .sort((a, b) => b.memberCount - a.memberCount)
      .slice(0, 10)
      .map(c => {
        // Don't send full members array to client
        const { members, ...rest } = c;
        return rest;
      });

    res.json({ communities: ranked });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Search public communities ──
router.get('/communities/search', auth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json({ communities: [] });
    const communities = await Community.find({
      isPublic: true,
      $or: [
        { name: new RegExp(q, 'i') },
        { tags: { $in: [q.toLowerCase().replace('#','')] } },
        { description: new RegExp(q, 'i') }
      ]
    }).select('name avatar description tags members ownerId').limit(20).lean();
    const result = communities.map(c => ({
      ...c,
      memberCount: c.members?.filter(m=>!m.banned).length || 0,
      isMember: c.members?.some(m => m.userId.toString() === req.user.id)
    }));
    res.json({ communities: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Get single community ──
router.get('/communities/:id', auth, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id).lean();
    if (!community) return res.status(404).json({ error: 'Community not found' });
    const member = getMember(community, req.user.id);
    if (!community.isPublic && !member) return res.status(403).json({ error: 'Private community' });
    res.json({ community: await populateCommunityLean(community) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Invite a friend to community ──
router.post('/communities/:id/invite-friend', auth, async (req, res) => {
  try {
    const { friendId } = req.body;
    const community = await Community.findById(req.params.id);
    if (!community) return res.status(404).json({ error: 'Not found' });
    // Must be a member to invite
    if (!getMember(community, req.user.id)) return res.status(403).json({ error: 'Not a member' });
    // Must be friends
    const me = await User.findById(req.user.id).select('username friends');
    if (!me.friends.map(f=>f.toString()).includes(friendId))
      return res.status(403).json({ error: 'Not friends with this user' });
    const friend = await User.findById(friendId).select('username');
    if (!friend) return res.status(404).json({ error: 'User not found' });

    if (community.isPublic) {
      // Public: auto-add them
      const existing = getMember(community, friendId);
      if (!existing) {
        const memberRole = community.roles.find(r => r.name === 'Member');
        community.members.push({ userId: friendId, roles: memberRole ? [memberRole._id.toString()] : [] });
        await community.save();
      }
      res.json({ success: true, autoJoined: true, communityId: community._id, communityName: community.name, inviteCode: community.inviteCode });
    } else {
      // Private: just return the invite code — host approval not required for friend invites
      // The friend uses the invite code to join
      res.json({ success: true, autoJoined: false, communityId: community._id, communityName: community.name, inviteCode: community.inviteCode });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Join community ──
router.post('/communities/:id/join', auth, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id);
    if (!community) return res.status(404).json({ error: 'Not found' });
    const existing = getMember(community, req.user.id);
    if (existing?.banned) return res.status(403).json({ error: 'You are banned from this community' });
    if (existing) return res.json({ success: true, already: true });
    const memberRole = community.roles.find(r => r.name === 'Member');
    community.members.push({ userId: req.user.id, roles: memberRole ? [memberRole._id.toString()] : [] });
    await community.save();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Join by invite code ──
router.post('/communities/invite/:code', auth, async (req, res) => {
  try {
    const community = await Community.findOne({ inviteCode: req.params.code.toUpperCase() });
    if (!community) return res.status(404).json({ error: 'Invalid invite code' });
    const existing = getMember(community, req.user.id);
    if (existing?.banned) return res.status(403).json({ error: 'You are banned' });
    if (!existing) {
      const memberRole = community.roles.find(r => r.name === 'Member');
      community.members.push({ userId: req.user.id, roles: memberRole ? [memberRole._id.toString()] : [] });
      await community.save();
    }
    res.json({ success: true, communityId: community._id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Leave community ──
router.post('/communities/:id/leave', auth, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id);
    if (!community) return res.status(404).json({ error: 'Not found' });
    if (community.ownerId.toString() === req.user.id) return res.status(400).json({ error: 'Owner cannot leave — transfer ownership or delete' });
    community.members = community.members.filter(m => m.userId.toString() !== req.user.id);
    await community.save();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Update community ──
router.patch('/communities/:id', auth, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id);
    if (!community) return res.status(404).json({ error: 'Not found' });
    if (!hasPermission(community, req.user.id, 'isAdmin')) return res.status(403).json({ error: 'No permission' });
    const { name, description, isPublic, tags, avatar } = req.body;
    if (name && name !== community.name) {
      const nameTaken = await Community.findOne({
        name: new RegExp(`^${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
        _id: { $ne: community._id }
      });
      if(nameTaken) return res.status(400).json({ error: `A community named "${name}" already exists.` });
      community.name = name;
    }
    if (description !== undefined) community.description = description;
    if (isPublic !== undefined) community.isPublic = isPublic;
    if (tags) community.tags = tags.slice(0, 10);
    if (avatar !== undefined) community.avatar = avatar;
    await community.save();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Delete community ──
router.delete('/communities/:id', auth, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id);
    if (!community) return res.status(404).json({ error: 'Not found' });
    if (community.ownerId.toString() !== req.user.id) return res.status(403).json({ error: 'Only owner can delete' });
    await Community.deleteOne({ _id: req.params.id });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Add channel ──
router.post('/communities/:id/channels', auth, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id);
    if (!community) return res.status(404).json({ error: 'Not found' });
    if (!hasPermission(community, req.user.id, 'canManageChannels')) return res.status(403).json({ error: 'No permission' });
    const { name, type, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Channel name required' });
    community.channels.push({ name: name.toLowerCase().replace(/\s+/g,'-'), type: type||'text', description: description||'', order: community.channels.length });
    await community.save();
    res.json({ success: true, channels: community.channels });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Delete channel ──
router.delete('/communities/:id/channels/:channelId', auth, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id);
    if (!community) return res.status(404).json({ error: 'Not found' });
    if (!hasPermission(community, req.user.id, 'canManageChannels')) return res.status(403).json({ error: 'No permission' });
    community.channels = community.channels.filter(c => c._id.toString() !== req.params.channelId);
    await community.save();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Add role ──
router.post('/communities/:id/roles', auth, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id);
    if (!community) return res.status(404).json({ error: 'Not found' });
    if (!hasPermission(community, req.user.id, 'canManageRoles')) return res.status(403).json({ error: 'No permission' });
    const { name, color, permissions } = req.body;
    community.roles.push({ name, color: color||'#6c63ff', permissions: permissions||{}, order: community.roles.length });
    await community.save();
    res.json({ success: true, roles: community.roles });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Assign role to member ──
router.post('/communities/:id/members/:userId/roles', auth, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id);
    if (!community) return res.status(404).json({ error: 'Not found' });
    if (!hasPermission(community, req.user.id, 'canManageRoles')) return res.status(403).json({ error: 'No permission' });
    const { roleId, action } = req.body; // action: 'add' | 'remove'
    const member = getMember(community, req.params.userId);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    if (action === 'add' && !member.roles.includes(roleId)) member.roles.push(roleId);
    if (action === 'remove') member.roles = member.roles.filter(r => r !== roleId);
    await community.save();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Kick member ──
router.delete('/communities/:id/members/:userId', auth, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id);
    if (!community) return res.status(404).json({ error: 'Not found' });
    if (!hasPermission(community, req.user.id, 'canKick')) return res.status(403).json({ error: 'No permission' });
    if (community.ownerId.toString() === req.params.userId) return res.status(400).json({ error: 'Cannot kick owner' });
    community.members = community.members.filter(m => m.userId.toString() !== req.params.userId);
    await community.save();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Ban/unban member ──
router.post('/communities/:id/members/:userId/ban', auth, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id);
    if (!community) return res.status(404).json({ error: 'Not found' });
    if (!hasPermission(community, req.user.id, 'canBan')) return res.status(403).json({ error: 'No permission' });
    const member = getMember(community, req.params.userId);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    member.banned = req.body.ban !== false;
    await community.save();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function populateCommunity(community) {
  await community.populate('members.userId', 'username avatar lastSeen');
  return community;
}


// ── Lock/unlock channel ──
router.patch('/communities/:id/channels/:channelId/lock', auth, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id);
    if (!community) return res.status(404).json({ error: 'Not found' });
    if (!hasPermission(community, req.user.id, 'isAdmin') && community.ownerId.toString() !== req.user.id)
      return res.status(403).json({ error: 'No permission' });
    const ch = community.channels.id(req.params.channelId);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    if (req.body.locked !== undefined) ch.locked = req.body.locked;
    if (req.body.chatLocked !== undefined) ch.chatLocked = req.body.chatLocked;
    await community.save();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Set active room on a room channel ──
router.patch('/communities/:id/channels/:channelId/active-room', auth, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id);
    if (!community) return res.status(404).json({ error: 'Not found' });
    if (!getMember(community, req.user.id)) return res.status(403).json({ error: 'Not a member' });
    const ch = community.channels.id(req.params.channelId);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    ch.activeRoomId = req.body.roomId || null;
    await community.save();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function populateCommunityLean(community) {
  const memberIds = community.members.map(m => m.userId);
  const users = await User.find({ _id: { $in: memberIds } }).select('username avatar lastSeen').lean();
  const userMap = {};
  users.forEach(u => userMap[u._id.toString()] = u);
  community.members = community.members.map(m => ({ ...m, user: userMap[m.userId.toString()] }));
  return community;
}

// ── Get channel messages ──
router.get('/communities/:id/channels/:channelId/messages', auth, async (req, res) => {
  try {
    const CommunityMessage = require('../models/CommunityMessage');
    const community = await Community.findById(req.params.id).lean();
    if (!community) return res.status(404).json({ error: 'Not found' });
    if (!getMember(community, req.user.id)) return res.status(403).json({ error: 'Not a member' });
    const channel = community.channels.find(c => c._id.toString() === req.params.channelId);
    if(!channel) return res.status(404).json({ error: 'Channel not found' });
    if(!canViewChannel(community, channel, req.user.id)) return res.status(403).json({ error: 'You do not have permission to view this channel' });
    const { page = 1 } = req.query;
    const messages = await CommunityMessage.find({
      communityId: req.params.id,
      channelId: req.params.channelId,
      deleted: false
    }).populate('userId', 'username avatar').sort({ createdAt: -1 }).skip((page-1)*50).limit(50).lean();
    res.json({ messages: messages.reverse() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Send channel message ──
router.post('/communities/:id/channels/:channelId/messages', auth, async (req, res) => {
  try {
    const CommunityMessage = require('../models/CommunityMessage');
    const community = await Community.findById(req.params.id).lean();
    if (!community) return res.status(404).json({ error: 'Not found' });
    const member = getMember(community, req.user.id);
    if (!member || member.banned) return res.status(403).json({ error: 'Not a member' });
    const channel = community.channels.find(c => c._id.toString() === req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if(!canViewChannel(community, channel, req.user.id)) return res.status(403).json({ error: 'You do not have permission to view this channel' });
    if(!canWriteChannel(community, channel, req.user.id)) return res.status(403).json({ error: 'You do not have permission to post in this channel' });
    if (channel.type === 'announcement' && !hasPermission(community, req.user.id, 'isAdmin'))
      return res.status(403).json({ error: 'Only admins can post in announcements' });
    const { text, fileUrl, fileType, fileName } = req.body;
    if (!text && !fileUrl) return res.status(400).json({ error: 'Empty message' });
    const msg = await CommunityMessage.create({
      communityId: req.params.id, channelId: req.params.channelId,
      userId: req.user.id, text: text||'', fileUrl, fileType, fileName
    });
    const populated = await CommunityMessage.findById(msg._id).populate('userId', 'username avatar').lean();
    res.json({ success: true, message: populated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Delete channel message ──
router.delete('/communities/:id/channels/:channelId/messages/:msgId', auth, async (req, res) => {
  try {
    const CommunityMessage = require('../models/CommunityMessage');
    const msg = await CommunityMessage.findById(req.params.msgId);
    if (!msg) return res.status(404).json({ error: 'Not found' });
    const community = await Community.findById(req.params.id).lean();
    const isOwn = msg.userId.toString() === req.user.id;
    const isAdmin = hasPermission(community, req.user.id, 'isAdmin');
    if (!isOwn && !isAdmin) return res.status(403).json({ error: 'No permission' });
    await CommunityMessage.findByIdAndUpdate(req.params.msgId, { deleted: true });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── Update channel view/write role permissions ──
router.patch('/communities/:id/channels/:channelId/permissions', auth, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id);
    if (!community) return res.status(404).json({ error: 'Not found' });
    if (!hasPermission(community, req.user.id, 'isAdmin') && community.ownerId.toString() !== req.user.id)
      return res.status(403).json({ error: 'Admin only' });
    const ch = community.channels.id(req.params.channelId);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    const { viewRoles, writeRoles } = req.body;
    if(viewRoles  !== undefined) ch.viewRoles  = viewRoles  || [];
    if(writeRoles !== undefined) ch.writeRoles = writeRoles || [];
    await community.save();
    res.json({ success: true, channel: ch });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── Update role (name/color) ──
router.patch('/communities/:id/roles/:roleId', auth, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id);
    if (!community) return res.status(404).json({ error: 'Not found' });
    if (!hasPermission(community, req.user.id, 'canManageRoles') && community.ownerId.toString() !== req.user.id)
      return res.status(403).json({ error: 'No permission' });
    const role = community.roles.id(req.params.roleId);
    if (!role) return res.status(404).json({ error: 'Role not found' });
    if (req.body.name) role.name = req.body.name;
    if (req.body.color) role.color = req.body.color;
    if (req.body.permissions) Object.assign(role.permissions, req.body.permissions);
    await community.save();
    res.json({ success: true, role });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Delete role ──
router.delete('/communities/:id/roles/:roleId', auth, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id);
    if (!community) return res.status(404).json({ error: 'Not found' });
    if (!hasPermission(community, req.user.id, 'canManageRoles') && community.ownerId.toString() !== req.user.id)
      return res.status(403).json({ error: 'No permission' });
    // Remove role from all members first
    community.members.forEach(m => {
      m.roles = m.roles.filter(r => r !== req.params.roleId);
    });
    community.roles = community.roles.filter(r => r._id.toString() !== req.params.roleId);
    await community.save();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
