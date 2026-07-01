const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const RANKINGS_FILE = path.join(__dirname, 'rankings.json');
const BLACKHOLES_FILE = path.join(__dirname, 'blackholes.json');

// Ensure rankings file exists
if (!fs.existsSync(RANKINGS_FILE)) {
    fs.writeFileSync(RANKINGS_FILE, JSON.stringify([]));
}
if (!fs.existsSync(BLACKHOLES_FILE)) {
    fs.writeFileSync(BLACKHOLES_FILE, JSON.stringify([]));
}

function getRankings() {
    try {
        const data = fs.readFileSync(RANKINGS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        return [];
    }
}

function saveRankings(rankings) {
    // Keep top 10 per rule
    const rules = ['STANDARD', 'TACTICAL', 'SPEED'];
    let filtered = [];
    rules.forEach(r => {
        let rList = rankings.filter(x => x.rule === r);
        rList.sort((a, b) => b.winStreak - a.winStreak);
        filtered = filtered.concat(rList.slice(0, 10));
    });
    fs.writeFileSync(RANKINGS_FILE, JSON.stringify(filtered, null, 2));
}

function getBlackholes() {
    try {
        const data = fs.readFileSync(BLACKHOLES_FILE, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        return [];
    }
}

function saveBlackhole(name, rule) {
    const list = getBlackholes();
    list.push({ name, rule, date: new Date().toISOString() });
    // Keep top 50 recent blackholes
    if (list.length > 50) list.shift();
    fs.writeFileSync(BLACKHOLES_FILE, JSON.stringify(list, null, 2));
    return list;
}

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// State
const waitingQueues = {
    STANDARD: null,
    TACTICAL: null,
    SPEED: null
};

const rooms = {};

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Send initial rankings
    socket.emit('update_rankings', getRankings());
    socket.emit('update_blackholes', getBlackholes());

    socket.on('join_queue', ({ rule, name, winStreak }) => {
        socket.playerName = name || 'Guest';
        socket.winStreak = winStreak || 0;

        if (!waitingQueues[rule]) {
            waitingQueues[rule] = null;
        }

        // Check if someone is waiting
        if (waitingQueues[rule] && waitingQueues[rule].id !== socket.id) {
            const p1 = waitingQueues[rule];
            const p2 = socket;
            waitingQueues[rule] = null; // consume queue

            const roomId = `room_${p1.id}_${p2.id}`;
            p1.join(roomId);
            p2.join(roomId);

            rooms[roomId] = {
                players: [p1.id, p2.id],
                rule: rule,
                actions: {},
                turnNumber: 0
            };

            const playersData = {
                [p1.id]: { name: p1.playerName, winStreak: p1.winStreak },
                [p2.id]: { name: p2.playerName, winStreak: p2.winStreak }
            };

            io.to(roomId).emit('match_found', { rule, roomId, players: playersData });
            
            // Start first turn
            setTimeout(() => {
                rooms[roomId].actions = {};
                io.to(roomId).emit('start_turn');
            }, 2000); // 2s delay to show match found UI

        } else {
            waitingQueues[rule] = socket;
            socket.emit('waiting_for_match');
        }
    });

    socket.on('submit_action', ({ roomId, action }) => {
        const room = rooms[roomId];
        if (!room) return;

        room.actions[socket.id] = action;

        // Check if both have submitted
        if (Object.keys(room.actions).length === 2) {
            const p1Id = room.players[0];
            const p2Id = room.players[1];
            
            const result = {
                [p1Id]: room.actions[p1Id],
                [p2Id]: room.actions[p2Id]
            };

            io.to(roomId).emit('resolve_turn', result);
            
            // Clear actions for next turn
            room.actions = {};
            
            // Trigger next turn automatically after some delay (handled by client, but we can just reset state here)
            // The client decides if the game ends. If it continues, clients will expect another start_turn.
            // For safety, let the clients handle the delay and start next turn visually, then send actions again.
            // If they want another turn, they just submit actions again.
        }
    });
    
    socket.on('start_next_turn', ({ roomId }) => {
        // If a game continues after resolve, clients emit this.
        // Once both emit, or just let one emit and start.
        // To be simple, we just clear actions on resolve, so they can just submit new actions anytime.
        // Let's send start_turn to both so they sync timer.
        const room = rooms[roomId];
        if (room) {
            if (!room.readyForNext) room.readyForNext = 0;
            room.readyForNext++;
            if (room.readyForNext >= 2) {
                room.readyForNext = 0;
                room.actions = {};
                io.to(roomId).emit('start_turn');
            }
        }
    });

    socket.on('submit_score', ({ name, winStreak, rule }) => {
        if (winStreak > 0) {
            const rankings = getRankings();
            rankings.push({ name, winStreak, rule, date: new Date().toISOString() });
            saveRankings(rankings);
            io.emit('update_rankings', getRankings());
        }
    });

    socket.on('submit_blackhole', ({ name, rule }) => {
        const list = saveBlackhole(name, rule);
        io.emit('update_blackholes', list);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        // Remove from waiting queue
        for (let rule in waitingQueues) {
            if (waitingQueues[rule] && waitingQueues[rule].id === socket.id) {
                waitingQueues[rule] = null;
            }
        }

        // Notify opponent if in room
        for (let roomId in rooms) {
            const room = rooms[roomId];
            if (room.players.includes(socket.id)) {
                socket.to(roomId).emit('opponent_disconnected');
                delete rooms[roomId];
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
