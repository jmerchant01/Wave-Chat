const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 15e6  // 15MB for images/files
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

function getRoomPublicState(room) {
  const participants = [];
  room.participants.forEach((p, id) => {
    participants.push({ id, name: p.name, muted: p.muted, isHost: p.isHost });
  });
  return {
    name: room.name,
    hostId: room.hostId,
    locked: room.locked,
    chatLocked: room.chatLocked,
    allMuted: room.allMuted,
    participants
  };
}

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  socket.on('create_room', ({ roomId, roomName, userName }) => {
    if (rooms.has(roomId)) { socket.emit('error_msg', 'Room ID already exists.'); return; }
    const room = {
      name: roomName, hostId: socket.id,
      locked: false, chatLocked: false, allMuted: false,
      participants: new Map()
    };
    room.participants.set(socket.id, { name: userName, muted: false, isHost: true });
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = userName;
    socket.data.isHost = true;
    socket.emit('room_joined', { roomId, isHost: true, state: getRoomPublicState(room) });
    console.log(`[R] Room "${roomName}" (${roomId}) created by ${userName}`);
  });

  socket.on('join_room', ({ roomId, userName }) => {
    const room = rooms.get(roomId);
    if (!room) { socket.emit('error_msg', 'Room not found. Check the code.'); return; }
    if (room.locked) { socket.emit('error_msg', 'This room is locked by the host.'); return; }
    const joinMuted = room.allMuted;
    room.participants.set(socket.id, { name: userName, muted: joinMuted, isHost: false });
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = userName;
    socket.data.isHost = false;
    socket.emit('room_joined', { roomId, isHost: false, state: getRoomPublicState(room), joinMuted });
    socket.to(roomId).emit('participant_joined', { id: socket.id, name: userName, muted: joinMuted, isHost: false });
    io.to(roomId).emit('chat_message', { type: 'system', text: `${userName} joined the room.` });
    if (joinMuted) socket.emit('force_mute', { locked: true });
    console.log(`[J] ${userName} joined ${roomId}`);
  });

  socket.on('webrtc_offer', ({ target, sdp }) => { io.to(target).emit('webrtc_offer', { from: socket.id, sdp }); });
  socket.on('webrtc_answer', ({ target, sdp }) => { io.to(target).emit('webrtc_answer', { from: socket.id, sdp }); });
  socket.on('webrtc_ice', ({ target, candidate }) => { io.to(target).emit('webrtc_ice', { from: socket.id, candidate }); });

  socket.on('chat_message', ({ text, image, msgId }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    const p = room.participants.get(socket.id);
    if (!p) return;
    if (room.chatLocked && !p.isHost) { socket.emit('error_msg', 'Chat is locked by the host.'); return; }
    if (image && image.length > 13500000) { socket.emit('error_msg', 'File too large. Max 10MB.'); return; }
    io.to(roomId).emit('chat_message', { type: p.isHost ? 'host' : 'user', from: socket.id, name: p.name, text, image, msgId, isHost: p.isHost });
  });

  socket.on('delete_message', ({ msgId }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    io.to(roomId).emit('message_deleted', { msgId });
  });

  socket.on('speaking', ({ active }) => {
    if (socket.data.roomId) socket.to(socket.data.roomId).emit('participant_speaking', { id: socket.id, active });
  });

  socket.on('mute_status', ({ muted }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    const p = room.participants.get(socket.id);
    if (!p) return;
    // Block unmute if allMuted is on
    if (room.allMuted && !p.isHost) {
      socket.emit('force_mute', { locked: true });
      return;
    }
    p.muted = muted;
    socket.to(roomId).emit('participant_mute_changed', { id: socket.id, muted });
  });

  socket.on('host_mute', ({ target }) => {
    if (!socket.data.isHost) return;
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    if (target === 'all') {
      room.allMuted = true;
      room.participants.forEach((p, id) => {
        if (id !== socket.id) { p.muted = true; io.to(id).emit('force_mute', { locked: true }); }
      });
      io.to(roomId).emit('room_state_update', getRoomPublicState(room));
      io.to(roomId).emit('chat_message', { type: 'system', text: '🔇 Host muted everyone. Participants cannot unmute.' });
    } else {
      const p = room.participants.get(target);
      if (p) { p.muted = true; io.to(target).emit('force_mute', { locked: false }); io.to(roomId).emit('participant_mute_changed', { id: target, muted: true }); }
    }
  });

  socket.on('host_unmute', ({ target }) => {
    if (!socket.data.isHost) return;
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    if (target === 'all') {
      room.allMuted = false;
      room.participants.forEach((p, id) => {
        if (id !== socket.id) { p.muted = false; io.to(id).emit('force_unmute'); }
      });
      io.to(roomId).emit('room_state_update', getRoomPublicState(room));
      io.to(roomId).emit('chat_message', { type: 'system', text: '🔊 Host unmuted everyone.' });
    } else {
      const p = room.participants.get(target);
      if (p) { p.muted = false; io.to(target).emit('force_unmute'); io.to(roomId).emit('participant_mute_changed', { id: target, muted: false }); }
    }
  });

  socket.on('host_chat_lock', ({ locked }) => {
    if (!socket.data.isHost) return;
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    room.chatLocked = locked;
    io.to(roomId).emit('chat_locked', { locked });
    io.to(roomId).emit('chat_message', { type: 'system', text: locked ? '💬 Chat locked — only host can send messages.' : '💬 Chat unlocked by host.' });
  });

  socket.on('host_kick', ({ target }) => {
    if (!socket.data.isHost) return;
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    const p = room.participants.get(target);
    if (!p) return;
    const name = p.name;
    io.to(target).emit('kicked', { reason: 'Removed by host' });
    room.participants.delete(target);
    socket.to(roomId).emit('participant_left', { id: target });
    io.to(roomId).emit('chat_message', { type: 'system', text: `${name} was removed by the host.` });
  });

  socket.on('host_lock', ({ locked }) => {
    if (!socket.data.isHost) return;
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    room.locked = locked;
    io.to(roomId).emit('room_locked', { locked });
    io.to(roomId).emit('chat_message', { type: 'system', text: locked ? '🔒 Room locked — no new joins.' : '🔓 Room unlocked.' });
  });

  socket.on('end_room', () => {
    if (!socket.data.isHost) return;
    const roomId = socket.data.roomId;
    io.to(roomId).emit('room_ended');
    rooms.delete(roomId);
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    const p = room.participants.get(socket.id);
    const name = p ? p.name : 'Someone';
    room.participants.delete(socket.id);
    socket.to(roomId).emit('participant_left', { id: socket.id });
    io.to(roomId).emit('chat_message', { type: 'system', text: `${name} left the room.` });
    if (room.hostId === socket.id) {
      if (room.participants.size > 0) {
        const [newHostId, newHostP] = room.participants.entries().next().value;
        newHostP.isHost = true;
        room.hostId = newHostId;
        io.to(newHostId).emit('promoted_to_host');
        io.to(roomId).emit('chat_message', { type: 'system', text: `${newHostP.name} is now the host.` });
        io.to(roomId).emit('room_state_update', getRoomPublicState(room));
      } else {
        rooms.delete(roomId);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`\n🎙️  WAVE server running on http://localhost:${PORT}\n`); });
