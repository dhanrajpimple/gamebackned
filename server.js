const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.get('/', (req, res) => res.send('JET BATTLE Server Running ✈️'));

// rooms: { roomCode: { players: [socket1, socket2], state: {} } }
const rooms = {};

function generateCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // Player 1 creates a room
  socket.on('create_room', ({ country }) => {
    let code;
    do { code = generateCode(); } while (rooms[code]);

    rooms[code] = {
      code,
      players: [{ id: socket.id, country, playerNum: 1 }],
      gameStarted: false
    };

    socket.join(code);
    socket.roomCode = code;
    socket.playerNum = 1;

    socket.emit('room_created', { code, playerNum: 1 });
    console.log(`Room ${code} created by ${socket.id}`);
  });

  // Player 2 joins a room
  socket.on('join_room', ({ code, country }) => {
    const room = rooms[code];

    if (!room) {
      socket.emit('error', { msg: 'Room not found! Check the code.' });
      return;
    }
    if (room.players.length >= 2) {
      socket.emit('error', { msg: 'Room is full! Game already in progress.' });
      return;
    }
    if (room.gameStarted) {
      socket.emit('error', { msg: 'Game already started!' });
      return;
    }

    room.players.push({ id: socket.id, country, playerNum: 2 });
    socket.join(code);
    socket.roomCode = code;
    socket.playerNum = 2;

    // Tell P2 their number
    socket.emit('room_joined', { code, playerNum: 2 });

    // Tell both players to start — send each other's country
    const p1Country = room.players[0].country;
    const p2Country = room.players[1].country;

    io.to(room.players[0].id).emit('game_start', {
      myCountry: p1Country,
      enemyCountry: p2Country,
      playerNum: 1
    });
    io.to(room.players[1].id).emit('game_start', {
      myCountry: p2Country,
      enemyCountry: p1Country,
      playerNum: 2
    });

    room.gameStarted = true;
    console.log(`Room ${code} game started!`);
  });

  // Relay player state (position, bullets, hp) to opponent
  socket.on('player_state', (data) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    // Send to everyone else in the room
    socket.to(code).emit('opponent_state', data);
  });

  // Relay shoot event
  socket.on('shoot', (data) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    socket.to(code).emit('opponent_shoot', data);
  });

  // Relay hit/damage
  socket.on('hit', (data) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    socket.to(code).emit('opponent_hit', data);
  });

  // Game over
  socket.on('game_over', (data) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    io.to(code).emit('game_over', data);
  });

  // Disconnect
  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (code && rooms[code]) {
      socket.to(code).emit('opponent_disconnected');
      delete rooms[code];
      console.log(`Room ${code} closed (disconnect)`);
    }
    console.log('Disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`JET BATTLE server on port ${PORT}`));