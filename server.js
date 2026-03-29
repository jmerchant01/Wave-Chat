const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');
const { router: authRouter, JWT_SECRET } = require('./routes/auth');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 15e6
});

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://jaymerch:CarCoop1823!@wave-chat.qoqscw3.mongodb.net/wave?appName=Wave-Chat';
mongoose.connect(MONGO_URI).then(() => console.log('✅ MongoDB connected')).catch(e => console.error('❌ MongoDB error:', e));

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', authRouter);

const rooms = new Map();
const onlineUsers = new Map(); // userId -> { socketId, username, avatar, roomId }

function getRoomPublicState(room) {
  const participants = [];
  room.participants.forEach((p, id) => participants.push({ id, name: p.name, muted: p.muted, isHost: p.isHost }));
  return { name: room.name, hostId: room.hostId, locked: room.locked, chatLocked: room.chatLocked, allMuted: room.allMuted, participants };
}

io.on('connection', (socket) => {

  socket.on('user_online', ({ token }) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.data.userId = decoded.id;
      socket.data.username = decoded.username;
      onlineUsers.set(decoded.id, { socketId: socket.id, username: decoded.username, roomId: null });
      // Broadcast online status to this user so they get fresh friend statuses
      socket.emit('friends_status_refresh');
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
  socket.on('notify_friend_request', ({ toUserId, fromUsername }) => {
    const target = onlineUsers.get(toUserId);
    if(target) io.to(target.socketId).emit('friend_request_received', { from: fromUsername });
  });

  // ── Real-time friend accepted notification ──
  socket.on('notify_friend_accepted', ({ toUserId, fromUsername }) => {
    const target = onlineUsers.get(toUserId);
    if(target) io.to(target.socketId).emit('friend_accepted', { username: fromUsername });
  });

  socket.on('send_friend_invite', ({ toUserId, roomId, roomName, fromName }) => {
    const target = onlineUsers.get(toUserId);
    if (target) io.to(target.socketId).emit('friend_invite', { fromName, roomId, roomName });
    else socket.emit('friend_invite_offline', { toUserId });
  });

  socket.on('create_room', ({ name, roomName, userId, inviteFriendIds }) => {
    const roomId = Math.random().toString(36).substr(2, 8).toUpperCase();
    const displayName = name || 'Host';
    rooms.set(roomId, {
      name: roomName || 'Voice Room', hostId: socket.id,
      locked: false, chatLocked: false, allMuted: false,
      activeScreenShareId: null, screenRequestsEnabled: true,
      participants: new Map([[socket.id, { name: displayName, muted: false, isHost: true, userId: userId||null }]])
    });
    socket.join(roomId); socket.data.roomId = roomId; socket.data.name = displayName;
    if (userId) { const o = onlineUsers.get(userId); if(o) o.roomId = roomId; }
    socket.emit('room_joined', { roomId, isHost: true, joinMuted: false, state: getRoomPublicState(rooms.get(roomId)) });
    // Auto-invite selected friends
    if(inviteFriendIds && inviteFriendIds.length){
      inviteFriendIds.forEach(fid => {
        const target = onlineUsers.get(fid);
        if(target) io.to(target.socketId).emit('friend_invite', { fromName: displayName, roomId, roomName: roomName||'Voice Room' });
      });
    }
  });

  socket.on('join_room', ({ roomId, name, userId }) => {
    const room = rooms.get(roomId); const displayName = name || 'Guest';
    if (!room) return socket.emit('room_error', { message: 'Room not found' });
    if (room.locked) return socket.emit('room_error', { message: 'Room is locked' });
    const nameTaken = Array.from(room.participants.values()).some(p => p.name.toLowerCase() === displayName.toLowerCase());
    if (nameTaken) return socket.emit('room_error', { message: 'Name already taken in this room' });
    const joinMuted = room.allMuted;
    room.participants.set(socket.id, { name: displayName, muted: joinMuted, isHost: false, userId: userId||null });
    socket.join(roomId); socket.data.roomId = roomId; socket.data.name = displayName;
    if (userId) { const o = onlineUsers.get(userId); if(o) o.roomId = roomId; }
    socket.emit('room_joined', { roomId, isHost: false, joinMuted, state: getRoomPublicState(room) });
    socket.to(roomId).emit('participant_joined', { id: socket.id, name: displayName, muted: joinMuted, isHost: false });
    io.to(roomId).emit('room_state_update', getRoomPublicState(room));
    // Update online status to show in-room
    if (userId) { const o = onlineUsers.get(userId); if(o) o.roomId = roomId; }
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

  socket.on('host_mute',      ({targetId}) => {
    const r=socket.data.roomId; const room=rooms.get(r); if(!room||room.hostId!==socket.id) return;
    const p=room.participants.get(targetId); if(p) p.muted=true;
    io.to(targetId).emit('force_mute',{locked:false}); io.to(r).emit('room_state_update',getRoomPublicState(room));
  });
  socket.on('host_unmute',    ({targetId}) => {
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

  socket.on('disconnect', () => {
    if (socket.data.userId) {
      const o=onlineUsers.get(socket.data.userId);
      if(o && o.socketId===socket.id) onlineUsers.delete(socket.data.userId);
    }
    const r=socket.data.roomId; if(!r) return;
    const room=rooms.get(r); if(!room) return;
    room.participants.delete(socket.id);
    if(room.participants.size===0){rooms.delete(r);return;}
    if(room.hostId===socket.id){
      const newHostId=room.participants.keys().next().value;
      room.hostId=newHostId;
      const p=room.participants.get(newHostId); if(p) p.isHost=true;
      io.to(newHostId).emit('promoted_to_host');
    }
    io.to(r).emit('participant_left',{id:socket.id});
    io.to(r).emit('room_state_update',getRoomPublicState(room));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🌊 WAVE running on port ${PORT}`));
