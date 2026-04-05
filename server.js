const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');
const { router: authRouter, JWT_SECRET } = require('./routes/auth');
const adminRouter = require('./routes/admin');
const messagesRouter = require('./routes/messages');
const communityRouter = require('./routes/communities');
const stripeRouter = require('./routes/stripe');
const moderationRouter = require('./routes/moderation');
const jwt = require('jsonwebtoken');
// Pre-load all models so Mongoose registers them before routes use them
require('./models/User');
require('./models/Community');
require('./models/Message');
require('./models/CommunityMessage');
require('./models/Report');
require('./models/Subscription');
require('./models/WaveSettings');
require('./models/Block');
require('./models/MonetizationApplication');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 15e6
});

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://jaymerch:CarCoop1823!@wave-chat.qoqscw3.mongodb.net/wave?appName=Wave-Chat';
mongoose.connect(MONGO_URI).then(() => console.log('✅ MongoDB connected')).catch(e => console.error('❌ MongoDB error:', e));

// ── Push notifications via socket (no external lib needed) ──
// sendPushNotification is a no-op stub — real-time handled via socket events
async function sendPushNotification(userId, payload) {
  // Real-time push handled via socket.io emit to connected clients
  // Browser Notification API handles display when app is open
}

// Stripe webhook needs raw body — mount BEFORE express.json()
app.use('/api/stripe/webhook', require('express').raw({ type: 'application/json' }), stripeRouter);
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', authRouter);
app.use('/api', adminRouter);
app.use('/api', messagesRouter);
app.use('/api', communityRouter);
app.use('/api', stripeRouter);
app.use('/api', moderationRouter);

// ── Public rooms registry ──
const publicRooms = new Map(); // roomId -> { name, tags, hostName, participants, createdAt }

app.get('/api/rooms/search', (req, res) => {
  const { q = '' } = req.query;
  const query = q.toLowerCase().replace('#','');
  const results = [];
  publicRooms.forEach((room, id) => {
    if(!query || room.name.toLowerCase().includes(query) || room.tags.some(t=>t.includes(query)) || room.hostName.toLowerCase().includes(query)) {
      results.push({ roomId: id, name: room.name, tags: room.tags, hostName: room.hostName, participants: room.participants, createdAt: room.createdAt, avatar: room.avatar||null });
    }
  });
  results.sort((a,b) => b.participants - a.participants);
  res.json({ rooms: results.slice(0,30) });
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
    </div>
  </div></body></html>`;
}

const rooms = new Map();
const onlineUsers = new Map(); // userId -> { socketId, username, avatar, roomId }


function broadcastCommunityRoomUpdate(io, room, roomId, ended=false){
  if(!room.communityId) return;
  const members = [...room.participants.values()].map(p=>p.name);
  io.to(`community:${room.communityId}`).emit('community_room_update',{
    communityId: room.communityId, channelId: room.channelId,
    roomId, members, ended
  });
  // Also notify via home sockets (for users not currently in community view)
  if(!ended){
    io.to(`community:${room.communityId}`).emit('community_room_live',{
      communityId: room.communityId, channelId: room.channelId,
      roomId, hostName: room.participants.values().next().value?.name || 'Someone',
      roomName: room.name
    });
  }
}
function getRoomPublicState(room) {
  const participants = [];
  room.participants.forEach((p, id) => participants.push({ id, name: p.name, muted: p.muted, isHost: p.isHost, userId: p.userId||null, avatar: p.avatar||null }));
  return { name: room.name, hostId: room.hostId, locked: room.locked, chatLocked: room.chatLocked, allMuted: room.allMuted, participants };
}

io.on('connection', (socket) => {

  socket.on('user_online', async ({ token }) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.data.userId = decoded.id;
      socket.data.username = decoded.username;
      const wasOnline = onlineUsers.has(decoded.id);
      onlineUsers.set(decoded.id, { socketId: socket.id, username: decoded.username, roomId: null });
      // Broadcast online status to this user so they get fresh friend statuses
      socket.emit('friends_status_refresh');
      // Notify friends with bell enabled that this user came online
      if(!wasOnline){
        try {
          const User = require('./models/User');
          const user = await User.findById(decoded.id).select('friends username avatar isVerified').lean();
          if(user && user.friends){
            for(const fid of user.friends){
              const friendSocket = onlineUsers.get(fid.toString());
              if(friendSocket){
                io.to(friendSocket.socketId).emit('friend_came_online', {
                  userId: decoded.id,
                  username: decoded.username,
                  avatar: user.avatar || null,
                  isVerified: user.isVerified || false
                });
              }
            }
          }
        } catch(e){ console.error('friend_came_online error:', e.message); }
      }
    } catch {}
  });

  // ── Get friend statuses (which friends are online/in-room) ──
  socket.on('get_friend_statuses', ({ friendIds }) => {
    const statuses = {};
    (friendIds || []).forEach(fid => {
      const o = onlineUsers.get(fid);
      if(o) statuses[fid] = { online: true, roomId: o.roomId || null };
      else statuses[fid] = { online: false, roomId: null };
    });
    socket.emit('friend_statuses', statuses);
  });

  // ── Cancel join request ──
  socket.on('cancel_join_request', ({ roomId, fromUserId }) => {
    const room = rooms.get(roomId);
    if(!room) return;
    io.to(room.hostId).emit('join_request_cancelled', { fromUserId });
  });

  // ── Request to join a friend's room ──
  socket.on('request_to_join_room', ({ roomId, fromName, fromUserId }) => {
    const room = rooms.get(roomId);
    if(!room) return socket.emit('join_request_failed', { reason: 'Room not found' });
    io.to(room.hostId).emit('join_request', { fromName, fromUserId, roomId });
  });

  // ── Host approves/denies join request ──
  socket.on('join_request_approved', ({ toUserId, roomId }) => {
    const target = onlineUsers.get(toUserId);
    if(target) io.to(target.socketId).emit('join_request_result', { approved: true, roomId });
  });
  socket.on('join_request_denied', ({ toUserId }) => {
    const target = onlineUsers.get(toUserId);
    if(target) io.to(target.socketId).emit('join_request_result', { approved: false });
  });

  // ── Real-time friend request notification ──
  socket.on('notify_friend_request', async ({ toUserId, fromUsername }) => {
    const target = onlineUsers.get(toUserId);
    if(target) io.to(target.socketId).emit('friend_request_received', { from: fromUsername });
    await sendPushNotification(toUserId, {
      title: '👥 New Friend Request',
      body: `${fromUsername} sent you a friend request on WAVE`,
      tag: 'wave-friend-request'
    });
  });

  // ── Real-time friend accepted notification ──
  socket.on('notify_friend_accepted', ({ toUserId, fromUsername }) => {
    const target = onlineUsers.get(toUserId);
    if(target) io.to(target.socketId).emit('friend_accepted', { username: fromUsername });
  });

  // ── Community invite via socket ──
  socket.on('send_community_invite', ({ toUserId, fromName, communityId, communityName, inviteCode, autoJoined }) => {
    const target = onlineUsers.get(toUserId);
    if(target) io.to(target.socketId).emit('community_invite_received', { fromName, communityId, communityName, inviteCode, autoJoined: !!autoJoined });
  });

  // ── Invite friend to room (public/private) ──
  socket.on('invite_friend_to_room', ({ toUserId, roomId: rid, fromName }) => {
    const room = rooms.get(rid);
    if (!room) return socket.emit('invite_result', { error: 'Room not found' });
    const target = onlineUsers.get(toUserId);
    if (room.locked) {
      // Private/locked room — send request to host
      if (room.hostId === socket.id) {
        // You ARE the host, just send invite directly
        if (target) io.to(target.socketId).emit('friend_invite', { fromName, roomId: rid, roomName: room.name });
      } else {
        // Ask host to approve
        io.to(room.hostId).emit('join_request', { fromName: `${fromName} (invited by friend)`, fromUserId: toUserId, roomId: rid });
        socket.emit('invite_result', { pending: true });
      }
    } else {
      // Public/unlocked room — send invite directly
      if (target) io.to(target.socketId).emit('friend_invite', { fromName, roomId: rid, roomName: room.name });
      socket.emit('invite_result', { sent: true });
    }
  });
  socket.on('community_join', ({ communityId }) => {
    socket.join(`community:${communityId}`);
  });
  socket.on('community_leave', ({ communityId }) => {
    socket.leave(`community:${communityId}`);
  });
  socket.on('community_message', ({ communityId, channelId, message }) => {
    socket.to(`community:${communityId}`).emit('community_message', { communityId, channelId, message });
  });
  socket.on('community_typing', ({ communityId, channelId, username }) => {
    socket.to(`community:${communityId}`).emit('community_typing', { channelId, username });
  });
  socket.on('community_room_update', ({ communityId, channelId, roomId, members, ended }) => {
    // Broadcast to all community members including sender
    io.to(`community:${communityId}`).emit('community_room_update', { communityId, channelId, roomId, members, ended });
  });
  socket.on('dm_send', ({ toUserId, messageId }) => {
    const target = onlineUsers.get(toUserId);
    if(target) io.to(target.socketId).emit('dm_received', { fromUserId: socket.data.userId, messageId });
  });

  socket.on('dm_typing', ({ toUserId }) => {
    const target = onlineUsers.get(toUserId);
    if(target) io.to(target.socketId).emit('dm_typing', { fromUserId: socket.data.userId });
  });

  socket.on('dm_read', ({ toUserId }) => {
    const target = onlineUsers.get(toUserId);
    if(target) io.to(target.socketId).emit('dm_read', { fromUserId: socket.data.userId });
  });

  socket.on('send_friend_invite', async ({ toUserId, roomId, roomName, fromName }) => {
    const target = onlineUsers.get(toUserId);
    if (target) {
      io.to(target.socketId).emit('friend_invite', { fromName, roomId, roomName });
      io.to(target.socketId).emit('browser_notification', {
        title: `📨 Room Invite from ${fromName}`,
        body: `${fromName} invited you to join "${roomName}"`,
        roomId
      });
    }
    // Web push — works even if app is closed
    await sendPushNotification(toUserId, {
      title: `📨 Room Invite from ${fromName}`,
      body: `${fromName} wants you to join "${roomName}" on WAVE!`,
      roomId, tag: 'wave-invite'
    });
    // Email fallback
    try {
      const User = require('./models/User');
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY || 're_cpjQ5pCW_BqS7EyPe8qqXtezbXZBopQd9');
      const appUrl = process.env.APP_URL || 'https://wave-chat-fnpr.onrender.com';
      const friend = await User.findById(toUserId).select('email username');
      if(friend && friend.email){
        const joinUrl = `${appUrl}?room=${roomId}`;
        const result = await resend.emails.send({
          from: 'WAVE <onboarding@resend.dev>',
          to: friend.email,
          subject: `${fromName} invited you to join "${roomName}" on WAVE`,
          html: emailTemplate(`🎙️ You're invited to "${roomName}"`,
            `<b>${fromName}</b> wants you to join their room on WAVE!`,
            `Click the button below to jump in now.`, joinUrl, '🎙️ Join Room Now')
        });
        console.log('✅ Invite email sent to', friend.email, result?.id || '');
      }
    } catch(e) { console.log('❌ Invite email error:', e.message); }
    if(!target) socket.emit('friend_invite_offline', { toUserId });
  });

  socket.on('create_room', async ({ name, roomName, userId, inviteFriendIds, isPublic, tags, communityId, channelId, avatar }) => {
    const roomId = Math.random().toString(36).substr(2, 8).toUpperCase();
    const displayName = name || 'Host';
    const rName = roomName || 'Voice Room';
    let hostAvatar = null;
    if(userId){ try{ const User=require('./models/User'); const u=await User.findById(userId).select('avatar').lean(); hostAvatar=u?.avatar||null; }catch(e){} }
    rooms.set(roomId, {
      name: rName, hostId: socket.id,
      avatar: avatar||null,
      locked: false, chatLocked: false, allMuted: false,
      activeScreenShareId: null, screenRequestsEnabled: true,
      pendingInvites: new Map(),
      participants: new Map([[socket.id, { name: displayName, muted: false, isHost: true, userId: userId||null, avatar: hostAvatar }]])
    });
    socket.join(roomId); socket.data.roomId = roomId; socket.data.name = displayName;
    if (userId) { const o = onlineUsers.get(userId); if(o) o.roomId = roomId; }
    const roomTags = (tags||[]).map(t=>t.toLowerCase().replace('#','')).filter(Boolean).slice(0,5);
    rooms.get(roomId).tags = roomTags;
    rooms.get(roomId).isPublic = !!isPublic;
    rooms.get(roomId).communityId = communityId||null;
    rooms.get(roomId).channelId = channelId||null;
    socket.emit('room_joined', { roomId, isHost: true, joinMuted: false, state: getRoomPublicState(rooms.get(roomId)) });
    if(isPublic){ publicRooms.set(roomId, { name: rName, tags: roomTags, hostName: displayName, participants: 1, createdAt: Date.now(), avatar: avatar||null }); }

    // Auto-invite selected friends — socket + email + browser notification
    if(inviteFriendIds && inviteFriendIds.length){
      const User = require('./models/User');
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY || 're_cpjQ5pCW_BqS7EyPe8qqXtezbXZBopQd9');
      const appUrl = process.env.APP_URL || 'https://wave-chat-fnpr.onrender.com';

      for(const fid of inviteFriendIds){
        try{
          const friend = await User.findById(fid).select('username email');
          if(!friend) continue;
          const room = rooms.get(roomId);
          if(room) room.pendingInvites.set(fid, { username: friend.username, sentAt: Date.now() });

          const target = onlineUsers.get(fid);
          if(target){
            io.to(target.socketId).emit('friend_invite', { fromName: displayName, roomId, roomName: rName });
            io.to(target.socketId).emit('browser_notification', {
              title: `📨 Room Invite from ${displayName}`,
              body: `${displayName} invited you to join "${rName}"`,
              roomId
            });
          }
          // Always send web push (works even if app is closed)
          await sendPushNotification(fid, {
            title: `📨 Room Invite from ${displayName}`,
            body: `${displayName} invited you to join "${rName}" on WAVE — tap to join!`,
            roomId,
            tag: 'wave-invite'
          });
          // Always send email regardless of online status
          const joinUrl = `${appUrl}?room=${roomId}`;
          try {
            const result = await resend.emails.send({
              from: 'WAVE <onboarding@resend.dev>',
              to: friend.email,
              subject: `${displayName} invited you to join "${rName}" on WAVE`,
              html: emailTemplate(
                `🎙️ You're invited to "${rName}"`,
                `<b>${displayName}</b> created a room and wants you to join!`,
                `Click the button below to jump in — the room is live right now.`,
                joinUrl, '🎙️ Join Room Now'
              )
            });
            console.log('✅ Invite email sent to', friend.email, result?.id || '');
          } catch(emailErr) {
            console.log('❌ Email send failed for', friend.email, ':', emailErr.message);
          }
          // Notify host that invite was sent
          socket.emit('invite_sent', { userId: fid, username: friend.username });
        }catch(e){ console.log('❌ Invite error for', fid, ':', e.message); }
      }
    }
  });

  socket.on('join_room', async ({ roomId, name, userId }) => {
    const room = rooms.get(roomId); const displayName = name || 'Guest';
    if (!room) return socket.emit('room_error', { message: 'Room not found' });
    if (room.locked) return socket.emit('room_error', { message: 'Room is locked' });
    const nameTaken = Array.from(room.participants.values()).some(p => p.name.toLowerCase() === displayName.toLowerCase());
    if (nameTaken) return socket.emit('room_error', { message: 'Name already taken in this room' });
    const joinMuted = room.allMuted;
    let joinAvatar = null;
    if(userId){ try{ const User=require('./models/User'); const u=await User.findById(userId).select('avatar').lean(); joinAvatar=u?.avatar||null; }catch(e){} }
    room.participants.set(socket.id, { name: displayName, muted: joinMuted, isHost: false, userId: userId||null, avatar: joinAvatar });
    socket.join(roomId); socket.data.roomId = roomId; socket.data.name = displayName;
    if (userId) { const o = onlineUsers.get(userId); if(o) o.roomId = roomId; }
    socket.emit('room_joined', { roomId, isHost: false, joinMuted, state: getRoomPublicState(room) });
    socket.to(roomId).emit('participant_joined', { id: socket.id, name: displayName, muted: joinMuted, isHost: false, userId: userId||null, avatar: joinAvatar });
    io.to(roomId).emit('room_state_update', getRoomPublicState(room));
    if (userId) { const o = onlineUsers.get(userId); if(o) o.roomId = roomId; }
    if(room.pendingInvites && room.pendingInvites.has(userId)){ room.pendingInvites.delete(userId); io.to(room.hostId).emit('invite_joined', { userId, name: displayName }); }
    // Update public room participant count
    if(room.isPublic && publicRooms.has(roomId)){ publicRooms.get(roomId).participants = room.participants.size; }
    broadcastCommunityRoomUpdate(io, room, roomId);
  });

  socket.on('webrtc_offer',  ({target,sdp})       => io.to(target).emit('webrtc_offer',  {from:socket.id,sdp}));
  socket.on('webrtc_answer', ({target,sdp})       => io.to(target).emit('webrtc_answer', {from:socket.id,sdp}));
  socket.on('webrtc_ice',    ({target,candidate}) => io.to(target).emit('webrtc_ice',    {from:socket.id,candidate}));

  socket.on('speaking',    ({speaking}) => { const r=socket.data.roomId; if(r) socket.to(r).emit('speaking',{id:socket.id,speaking}); });
  socket.on('mute_status', ({muted})    => {
    const r=socket.data.roomId; const room=rooms.get(r); if(!room) return;
    const p=room.participants.get(socket.id); if(p) p.muted=muted;
    socket.to(r).emit('mute_status',{id:socket.id,muted});
  });

  socket.on('cam_active',       ({active,streamId})  => { const r=socket.data.roomId; if(r) socket.to(r).emit('cam_active',{from:socket.id,active,streamId}); });
  socket.on('screenshare_start',({streamId}={})      => {
    const r=socket.data.roomId; const room=rooms.get(r); if(!room) return;
    room.activeScreenShareId=socket.id;
    socket.to(r).emit('screenshare_started',{sharerId:socket.id,streamId});
  });
  socket.on('screenshare_stop', () => {
    const r=socket.data.roomId; const room=rooms.get(r); if(!room) return;
    if(room.activeScreenShareId===socket.id){room.activeScreenShareId=null; socket.to(r).emit('screenshare_stopped',{sharerId:socket.id});}
  });
  socket.on('screenshare_request', () => {
    const r=socket.data.roomId; const room=rooms.get(r); if(!room) return;
    if(!room.screenRequestsEnabled) return socket.emit('screenshare_denied');
    const p=room.participants.get(socket.id);
    io.to(room.hostId).emit('screenshare_request',{fromId:socket.id,fromName:p?.name||'Someone'});
  });
  socket.on('screenshare_approved',   ({targetId}) => io.to(targetId).emit('screenshare_approved'));
  socket.on('screenshare_denied',     ({targetId}) => io.to(targetId).emit('screenshare_denied'));
  socket.on('request_screenshare',    ({targetId}) => {
    const r=socket.data.roomId; const room=rooms.get(r); if(!room) return;
    const p=room.participants.get(socket.id);
    io.to(targetId).emit('screenshare_request',{fromId:socket.id,fromName:p?.name||'Host',isHostRequest:true});
  });
  socket.on('host_screen_requests_toggle',({enabled}) => {
    const r=socket.data.roomId; const room=rooms.get(r); if(!room) return;
    room.screenRequestsEnabled=enabled; socket.to(r).emit('screen_requests_toggle',{enabled});
  });

  socket.on('chat_message', ({text,image,msgId}) => {
    const r=socket.data.roomId; const room=rooms.get(r); if(!room) return;
    if(room.chatLocked && room.hostId!==socket.id) return;
    if(image && image.length>13500000) return;
    const p=room.participants.get(socket.id);
    socket.to(r).emit('chat_message',{id:socket.id,name:p?.name||'?',text,image,msgId,isHost:room.hostId===socket.id});
  });
  socket.on('delete_message', ({msgId}) => {
    const r=socket.data.roomId; if(r) io.to(r).emit('message_deleted',{msgId});
  });

  socket.on('host_mute',      ({targetId, target}) => {
    if(target==='all'){
      const r2=socket.data.roomId; const rm=rooms.get(r2); if(!rm||rm.hostId!==socket.id) return;
      rm.allMuted=true;
      rm.participants.forEach((p,id)=>{ if(id!==socket.id) io.to(id).emit('force_mute',{locked:true}); });
      io.to(r2).emit('room_state_update',getRoomPublicState(rm));
      return;
    }
    const r=socket.data.roomId; const room=rooms.get(r); if(!room||room.hostId!==socket.id) return;
    const p=room.participants.get(targetId); if(p) p.muted=true;
    io.to(targetId).emit('force_mute',{locked:false}); io.to(r).emit('room_state_update',getRoomPublicState(room));
  });
  socket.on('host_unmute',    ({targetId, target}) => {
    if(target==='all'){
      const r3=socket.data.roomId; const rm2=rooms.get(r3); if(!rm2||rm2.hostId!==socket.id) return;
      rm2.allMuted=false;
      rm2.participants.forEach((p,id)=>{ if(id!==socket.id) io.to(id).emit('force_unmute'); });
      io.to(r3).emit('room_state_update',getRoomPublicState(rm2));
      return;
    }
    const r=socket.data.roomId; const room=rooms.get(r); if(!room||room.hostId!==socket.id) return;
    const p=room.participants.get(targetId); if(p) p.muted=false;
    io.to(targetId).emit('force_unmute'); io.to(r).emit('room_state_update',getRoomPublicState(room));
  });
  socket.on('host_mute_all', () => {
    const r=socket.data.roomId; const room=rooms.get(r); if(!room||room.hostId!==socket.id) return;
    room.allMuted=true;
    room.participants.forEach((p,id)=>{ if(id!==socket.id){p.muted=true; io.to(id).emit('force_mute',{locked:true});} });
    io.to(r).emit('room_state_update',getRoomPublicState(room));
  });
  socket.on('host_unmute_all', () => {
    const r=socket.data.roomId; const room=rooms.get(r); if(!room||room.hostId!==socket.id) return;
    room.allMuted=false;
    room.participants.forEach((p,id)=>{ p.muted=false; if(id!==socket.id) io.to(id).emit('force_unmute'); });
    io.to(r).emit('room_state_update',getRoomPublicState(room));
  });
  socket.on('host_chat_lock', ({locked}) => {
    const r=socket.data.roomId; const room=rooms.get(r); if(!room||room.hostId!==socket.id) return;
    room.chatLocked=locked; io.to(r).emit('chat_locked',{locked});
  });
  socket.on('host_lock', ({locked}) => {
    const r=socket.data.roomId; const room=rooms.get(r); if(!room||room.hostId!==socket.id) return;
    room.locked=locked; io.to(r).emit('room_locked',{locked});
  });
  socket.on('host_kick', ({targetId}) => {
    const r=socket.data.roomId; const room=rooms.get(r); if(!room||room.hostId!==socket.id) return;
    io.to(targetId).emit('kicked');
  });
  socket.on('end_room', () => {
    const r=socket.data.roomId; const room=rooms.get(r); if(!room||room.hostId!==socket.id) return;
    io.to(r).emit('room_ended'); rooms.delete(r);
  });

  // ── Screen recording permission ──
  socket.on('request_record_permission', ({ roomId }) => {
    const room = rooms.get(roomId);
    if(!room) return socket.emit('record_permission_denied', { reason: 'Room not found' });
    if(room.hostId === socket.id){
      // Host can always record
      socket.emit('record_permission_granted');
      return;
    }
    // Ask host for permission
    io.to(room.hostId).emit('record_permission_request', {
      fromId: socket.id,
      fromName: room.participants.get(socket.id)?.name || 'Someone'
    });
  });

  socket.on('record_permission_approve', ({ targetId }) => {
    const r = socket.data.roomId;
    const room = rooms.get(r);
    if(!room || room.hostId !== socket.id) return;
    io.to(targetId).emit('record_permission_granted');
  });

  socket.on('record_permission_deny', ({ targetId }) => {
    const r = socket.data.roomId;
    const room = rooms.get(r);
    if(!room || room.hostId !== socket.id) return;
    io.to(targetId).emit('record_permission_denied', { reason: 'The host denied your recording request' });
  });

  socket.on('disconnect', () => {
    if (socket.data.userId) {
      const o=onlineUsers.get(socket.data.userId);
      if(o && o.socketId===socket.id) onlineUsers.delete(socket.data.userId);
    }
    const r=socket.data.roomId; if(!r) return;
    const room=rooms.get(r); if(!room) return;
    room.participants.delete(socket.id);
    if(room.participants.size===0){
      // Always broadcast community room ended BEFORE deleting so members clear their ghost room
      if(room.communityId) broadcastCommunityRoomUpdate(io, room, r, true);
      if(room.isPublic) publicRooms.delete(r);
      rooms.delete(r);
      return;
    }
    if(room.hostId===socket.id){
      if(room.communityId){
        // Community rooms always shut down when the host leaves — no promotion
        io.to(r).emit('room_ended');
        if(room.isPublic) publicRooms.delete(r);
        broadcastCommunityRoomUpdate(io, room, r, true);
        rooms.delete(r);
        return;
      }
      // Regular rooms: promote the next participant to host
      const newHostId=room.participants.keys().next().value;
      room.hostId=newHostId;
      const p=room.participants.get(newHostId); if(p) p.isHost=true;
      io.to(newHostId).emit('promoted_to_host');
    }
    io.to(r).emit('participant_left',{id:socket.id});
    io.to(r).emit('room_state_update',getRoomPublicState(room));
    if(room.isPublic){ if(room.participants.size===0) publicRooms.delete(r); else if(publicRooms.has(r)) publicRooms.get(r).participants=room.participants.size; }
    if(room.communityId){ if(room.participants.size===0){ broadcastCommunityRoomUpdate(io,room,r,true); } else { broadcastCommunityRoomUpdate(io,room,r,false); } }
  });
});

// ── Check if a room exists (for ghost-room detection) ──
app.get('/api/rooms/:roomId/check', (req, res) => {
  const exists = rooms.has((req.params.roomId||'').toUpperCase());
  res.json({ exists });
});

// ── Admin: force-end a community room channel ──
app.post('/api/rooms/admin-end', async (req, res) => {
  try {
    const authHeader = req.headers.authorization||'';
    const token = authHeader.replace('Bearer ','');
    if(!token) return res.status(401).json({error:'Unauthorized'});
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, JWT_SECRET || process.env.JWT_SECRET);
    const Community = require('./models/Community');
    const { communityId, channelId } = req.body;
    const community = await Community.findById(communityId);
    if(!community) return res.status(404).json({error:'Community not found'});
    const isOwner = community.ownerId.toString() === decoded.id;
    const member = community.members?.find(m=>(m.userId?._id||m.userId)?.toString()===decoded.id);
    const isAdmin = isOwner || member?.roles?.some(rid=>{
      const role = community.roles?.find(r=>r._id?.toString()===rid?.toString());
      return role?.permissions?.isAdmin;
    });
    if(!isAdmin) return res.status(403).json({error:'No permission'});
    // Find and end the room matching this community+channel
    let ended = false;
    for(const [roomId, room] of rooms.entries()){
      if((room.communityId||'')===communityId && (room.channelId||'')===channelId){
        io.to(roomId).emit('room_ended');
        broadcastCommunityRoomUpdate(io, room, roomId, true);
        if(room.isPublic) publicRooms.delete(roomId);
        rooms.delete(roomId);
        ended = true;
        break;
      }
    }
    // Even if no live room, clear the ghost by broadcasting ended=true
    if(!ended){
      io.to(`community:${communityId}`).emit('community_room_update',{
        communityId, channelId, roomId:'ghost', members:[], ended:true
      });
    }
    res.json({ success: true, ended });
  } catch(e) { res.status(500).json({error:e.message}); }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🌊 WAVE running on port ${PORT}`));
