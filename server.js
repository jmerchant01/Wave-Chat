const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Room State ──
// rooms[roomId] = { name, hostId, locked, participants: Map<socketId, {name, muted, isHost}> }
const rooms = new Map();

function getRoomPublicState(room) {
  const participants = [];
  room.participants.forEach((p, id) => {
    participants.push({ id, name: p.name, muted: p.muted, isHost: p.isHost });
  });
  return { name: room.name, hostId: room.hostId, locked: room.locked, participants };
}

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── CREATE ROOM ──
  socket.on('create_room', ({ roomId, roomName, userName }) => {
    if (rooms.has(roomId)) {
      socket.emit('error_msg', 'Room ID already exists. Try again.');
      return;
    }

    const room = {
      name: roomName,
      hostId: socket.id,
      locked: false,
      participants: new Map()
    };
    room.participants.set(socket.id, { name: userName, muted: false, isHost: true });
    rooms.set(roomId, room);

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = userName;
    socket.data.isHost = true;

    socket.emit('room_joined', {
      roomId,
      isHost: true,
      state: getRoomPublicState(room)
    });

    console.log(`[R] Room "${roomName}" (${roomId}) created by ${userName}`);
  });

  // ── JOIN ROOM ──
  socket.on('join_room', ({ roomId, userName }) => {
    const room = rooms.get(roomId);
    if (!room) { socket.emit('error_msg', 'Room not found. Check the code.'); return; }
    if (room.locked) { socket.emit('error_msg', 'This room is locked by the host.'); return; }

    room.participants.set(socket.id, { name: userName, muted: false, isHost: false });
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = userName;
    socket.data.isHost = false;

    // Tell joiner the full state
    socket.emit('room_joined', {
      roomId,
      isHost: false,
      state: getRoomPublicState(room)
    });

    // Tell existing members about the new participant
    socket.to(roomId).emit('participant_joined', {
      id: socket.id,
      name: userName,
      muted: false,
      isHost: false
    });

    // Also emit system chat
    io.to(roomId).emit('chat_message', {
      type: 'system',
      text: `${userName} joined the room.`
    });

    console.log(`[J] ${userName} joined room ${roomId}`);
  });

  // ── WEBRTC SIGNALING ──
  // When a new user joins, they need to establish peer connections with everyone
  // We relay: offer, answer, ice-candidate between specific peers

  socket.on('webrtc_offer', ({ target, sdp }) => {
    io.to(target).emit('webrtc_offer', { from: socket.id, sdp });
  });

  socket.on('webrtc_answer', ({ target, sdp }) => {
    io.to(target).emit('webrtc_answer', { from: socket.id, sdp });
  });

  socket.on('webrtc_ice', ({ target, candidate }) => {
    io.to(target).emit('webrtc_ice', { from: socket.id, candidate });
  });

  // ── CHAT ──
  socket.on('chat_message', ({ text, image, msgId }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    const p = room.participants.get(socket.id);
    if (!p) return;

    if (image && image.length > 2800000) {
      socket.emit('error_msg', 'Image too large. Max ~2MB.');
      return;
    }

    io.to(roomId).emit('chat_message', {
      type: p.isHost ? 'host' : 'user',
      from: socket.id,
      name: p.name,
      text,
      image,
      msgId,
      isHost: p.isHost
    });
  });

  // ── DELETE MESSAGE ──
  socket.on('delete_message', ({ msgId }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    const p = room.participants.get(socket.id);
    if (!p) return;
    // Broadcast delete to everyone in room
    io.to(roomId).emit('message_deleted', { msgId, deletedBy: socket.id, isHost: p.isHost });
  });

  // ── SPEAKING STATUS ──
  socket.on('speaking', ({ active }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit('participant_speaking', { id: socket.id, active });
  });

  // ── MUTE STATUS (self-reported) ──
  socket.on('mute_status', ({ muted }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    const p = room.participants.get(socket.id);
    if (p) p.muted = muted;
    socket.to(roomId).emit('participant_mute_changed', { id: socket.id, muted });
  });

  // ── HOST: MUTE PARTICIPANT ──
  socket.on('host_mute', ({ target }) => {
    if (!socket.data.isHost) return;
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;

    if (target === 'all') {
      room.participants.forEach((p, id) => {
        if (id !== socket.id) {
          p.muted = true;
          io.to(id).emit('force_mute');
        }
      });
      io.to(roomId).emit('room_state_update', getRoomPublicState(room));
    } else {
      const p = room.participants.get(target);
      if (p) {
        p.muted = true;
        io.to(target).emit('force_mute');
        io.to(roomId).emit('participant_mute_changed', { id: target, muted: true });
      }
    }
  });

  // ── HOST: UNMUTE PARTICIPANT ──
  socket.on('host_unmute', ({ target }) => {
    if (!socket.data.isHost) return;
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;

    if (target === 'all') {
      room.participants.forEach((p, id) => {
        if (id !== socket.id) {
          p.muted = false;
          io.to(id).emit('force_unmute');
        }
      });
      io.to(roomId).emit('room_state_update', getRoomPublicState(room));
    } else {
      const p = room.participants.get(target);
      if (p) {
        p.muted = false;
        io.to(target).emit('force_unmute');
        io.to(roomId).emit('participant_mute_changed', { id: target, muted: false });
      }
    }
  });

  // ── HOST: KICK ──
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

    // Tell everyone else
    socket.to(roomId).emit('participant_left', { id: target });
    io.to(roomId).emit('chat_message', { type: 'system', text: `${name} was removed by the host.` });
    console.log(`[K] ${name} kicked from ${roomId}`);
  });

  // ── HOST: LOCK/UNLOCK ──
  socket.on('host_lock', ({ locked }) => {
    if (!socket.data.isHost) return;
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    room.locked = locked;
    io.to(roomId).emit('room_locked', { locked });
    io.to(roomId).emit('chat_message', {
      type: 'system',
      text: locked ? '🔒 Room locked by host — no new participants.' : '🔓 Room unlocked by host.'
    });
  });

  // ── HOST: END ROOM ──
  socket.on('end_room', () => {
    if (!socket.data.isHost) return;
    const roomId = socket.data.roomId;
    io.to(roomId).emit('room_ended');
    rooms.delete(roomId);
    console.log(`[X] Room ${roomId} ended`);
  });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;

    const p = room.participants.get(socket.id);
    const name = p ? p.name : 'Someone';
    room.participants.delete(socket.id);

    socket.to(roomId).emit('participant_left', { id: socket.id });
    io.to(roomId).emit('chat_message', { type: 'system', text: `${name} left the room.` });

    // If host left, pick a new host or close room
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

    console.log(`[-] ${name} disconnected from ${roomId}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎙️  WAVE server running on http://localhost:${PORT}\n`);
});
