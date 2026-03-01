const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.get('/', (req, res) => res.send('JET BATTLE Server ✈️ Running'));

// rooms: code → { players, started, match: { hpById, over } }
const rooms = {};

// waiting players: socketId → { id, name, flag, status: 'waiting'|'in-game' }
const waitingPlayers = {};

function generateCode() {
  let code;
  do { code = Math.floor(1000 + Math.random() * 9000).toString(); } while (rooms[code]);
  return code;
}

function broadcastWaitingList() {
  const list = Object.values(waitingPlayers);
  io.emit('waiting_players', list);
}

io.on('connection', (socket) => {
  console.log('+ Connect:', socket.id);

  // ── Enter the waiting room ──────────────────────────────
  socket.on('enter_waiting', ({ country }) => {
    // Generate a private room code for this player
    const code = generateCode();
    rooms[code] = { players: [socket.id], started: false, private: true };
    socket.roomCode = code;
    socket.country = country;
    socket.join(code);

    // Add to waiting list
    waitingPlayers[socket.id] = {
      id: socket.id,
      name: country.name,
      flag: country.flag,
      status: 'waiting',
      roomCode: code
    };

    socket.emit('your_room_code', { code });
    broadcastWaitingList();
  });

  // ── Join via private code ───────────────────────────────
  socket.on('join_room', ({ code, country }) => {
    const room = rooms[code];
    if (!room)               return socket.emit('error', { msg: 'Room not found! Check the code.' });
    if (room.players.length >= 2) return socket.emit('error', { msg: 'Room is full!' });
    if (room.started)        return socket.emit('error', { msg: 'Game already started!' });

    const p1Id = room.players[0];
    const p1Sock = io.sockets.sockets.get(p1Id);
    if (!p1Sock) return socket.emit('error', { msg: 'Host disconnected.' });

    room.players.push(socket.id);
    room.started = true;
    room.match = {
      hpById: { [p1Id]: 100, [socket.id]: 100 },
      over: false
    };
    socket.roomCode = code;
    socket.country = country;
    socket.join(code);

    // Mark both as in-game
    if (waitingPlayers[p1Id])   waitingPlayers[p1Id].status = 'in-game';
    if (waitingPlayers[socket.id]) waitingPlayers[socket.id].status = 'in-game';

    const p1C = p1Sock.country;
    const p2C = country;

    io.to(p1Id).emit('game_start', { myCountry: p1C, enemyCountry: p2C, playerNum: 1 });
    socket.emit('game_start', { myCountry: p2C, enemyCountry: p1C, playerNum: 2 });

    broadcastWaitingList();
    console.log(`Room ${code} started: ${p1C.name} vs ${p2C.name}`);
  });

  // ── Challenge a waiting player ──────────────────────────
  socket.on('challenge', ({ targetId, myName, myFlag }) => {
    const targetSocket = io.sockets.sockets.get(targetId);
    if (!targetSocket) return socket.emit('error', { msg: 'Player no longer available.' });
    targetSocket.emit('challenge_received', {
      fromId: socket.id,
      fromName: myName,
      fromFlag: myFlag
    });
    socket.pendingChallengeTo = targetId;
  });

  socket.on('accept_challenge', ({ fromId }) => {
    const fromSocket = io.sockets.sockets.get(fromId);
    if (!fromSocket) return;

    // Use the challenger's room code
    const code = fromSocket.roomCode;
    const room = rooms[code];
    if (!room || room.players.length >= 2 || room.started) {
      socket.emit('error', { msg: 'Room no longer available.' });
      return;
    }

    room.players.push(socket.id);
    room.started = true;
    room.match = {
      hpById: { [fromId]: 100, [socket.id]: 100 },
      over: false
    };
    socket.roomCode = code;
    socket.join(code);

    const p1C = fromSocket.country;
    const p2C = socket.country;

    if (waitingPlayers[fromId])    waitingPlayers[fromId].status = 'in-game';
    if (waitingPlayers[socket.id]) waitingPlayers[socket.id].status = 'in-game';

    io.to(fromId).emit('game_start', { myCountry: p1C, enemyCountry: p2C, playerNum: 1 });
    socket.emit('game_start', { myCountry: p2C, enemyCountry: p1C, playerNum: 2 });

    broadcastWaitingList();
    console.log(`Challenge accepted: ${p1C.name} vs ${p2C.name}`);
  });

  socket.on('decline_challenge', ({ fromId }) => {
    const fromSocket = io.sockets.sockets.get(fromId);
    if (fromSocket) fromSocket.emit('challenge_declined');
  });

  // ── Game relay ──────────────────────────────────────────
  socket.on('player_state', (data) => {
    const room = rooms[socket.roomCode];
    if (!room || !room.started || (room.match && room.match.over)) return;
    socket.to(socket.roomCode).emit('opponent_state', data);
  });

  socket.on('shoot', (data) => {
    const room = rooms[socket.roomCode];
    if (!room || !room.started || (room.match && room.match.over)) return;
    socket.to(socket.roomCode).emit('opponent_shoot', data);
  });

  socket.on('hit', (data) => {
    const roomCode = socket.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.started || !room.players || room.players.length < 2) return;

    if (!room.match) {
      room.match = {
        hpById: { [room.players[0]]: 100, [room.players[1]]: 100 },
        over: false
      };
    }
    if (room.match.over) return;

    const [p1Id, p2Id] = room.players;
    const defenderId = socket.id === p1Id ? p2Id : socket.id === p2Id ? p1Id : null;
    if (!defenderId) return;

    const raw = Number(data && data.damage);
    const damage = Number.isFinite(raw) ? Math.max(0, Math.min(40, Math.floor(raw))) : 0;
    if (damage <= 0) return;

    const currentHp = room.match.hpById[defenderId] ?? 100;
    const nextHp = Math.max(0, currentHp - damage);
    room.match.hpById[defenderId] = nextHp;

    socket.to(roomCode).emit('opponent_hit', { damage });

    if (nextHp === 0) {
      room.match.over = true;
      const winner = socket.id === p1Id ? 1 : 2;
      io.to(roomCode).emit('game_over', { winner });
    }
  });

  socket.on('game_over', (data) => {
    const roomCode = socket.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.started || !room.players || room.players.length < 2) return;

    if (!room.match) {
      room.match = {
        hpById: { [room.players[0]]: 100, [room.players[1]]: 100 },
        over: false
      };
    }
    if (room.match.over) return;

    const winner = data && (data.winner === 1 || data.winner === 2) ? data.winner : null;
    if (!winner) return;

    room.match.over = true;
    io.to(roomCode).emit('game_over', { winner });
  });

  // ── Disconnect ──────────────────────────────────────────
  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (code && rooms[code]) {
      socket.to(code).emit('opponent_disconnected');
      delete rooms[code];
    }
    delete waitingPlayers[socket.id];
    broadcastWaitingList();
    console.log('- Disconnect:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`JET BATTLE server on :${PORT}`));
