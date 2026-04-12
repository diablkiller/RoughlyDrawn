const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// 🔥 NEW: Guessing helpers
const { doubleMetaphone } = require('double-metaphone');
const levenshtein = require('fast-levenshtein').get;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const wordBank = require('./words.json');

const rooms = {};

// 🧠 HYBRID GUESS SYSTEM
function checkGuess(input, word) {
    if (!input || !word) return { correct: false }; // ✅ prevent crash

    const guess = input.toUpperCase().trim();
    const target = word.toUpperCase().trim();

    // 1. Exact
    if (guess === target) {
        return { correct: true, type: 'exact' };
    }

    // 2. Typo tolerance
    const distance = levenshtein(guess, target);
    let tolerance = 0;

    if (target.length > 7) {
        tolerance = 2;
    } else if (target.length > 4) {
        tolerance = 1;
    }

    if (distance <= tolerance) {
        return { correct: true, type: 'close' };
    }

    // 3. Phonetic
    const [g1, g2] = doubleMetaphone(guess);
    const [t1, t2] = doubleMetaphone(target);

    if (
        (g1 && t1 && (g1 === t1 || g1 === t2)) ||
        (g2 && t1 && (g2 === t1 || g2 === t2))
    ) {
        return { correct: true, type: 'phonetic' };
    }

    return { correct: false };
}

function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
        code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (rooms[code]);
    return code;
}

function createRoom(hostSocketID) {
    const code = generateCode();
    rooms[code] = {
        players: {},
        gameStarted: false,
        hostID: hostSocketID,
        currentWord: "",
        drawerID: null,
        timeLeft: 60,
        timerInterval: null,
        selectionTimeout: null,
        nextRoundTimeout: null,
        totalRounds: 3,
        currentRoundNum: 1,
        drawOrder: [],
        drawOrderIndex: 0,
        correctGuessers: [],
        roundPoints: {},
    };
    return code;
}

function broadcastScoreboard(code) {
    const room = rooms[code];
    if (!room) return;
    io.to(code).emit('updateScoreboard', {
        players: room.players,
        drawerID: room.drawerID,
        correctGuessers: room.correctGuessers
    });
}

function endRound(code, systemMessage) {
    const room = rooms[code];
    if (!room) return;

    clearInterval(room.timerInterval);
    clearInterval(room.hintInterval);
    clearTimeout(room.selectionTimeout);
    clearTimeout(room.nextRoundTimeout);

    if (room.correctGuessers.length > 0 && room.drawerID && room.players[room.drawerID]) {
        const bonus = 50 * room.correctGuessers.length;
        room.players[room.drawerID].score += bonus;
        room.roundPoints[room.drawerID] = (room.roundPoints[room.drawerID] || 0) + bonus;
    }

    io.to(code).emit('roundOver', {
        message: systemMessage,
        word: room.currentWord,
        roundPoints: room.roundPoints,
        players: room.players,
        drawerID: room.drawerID
    });

    room.nextRoundTimeout = setTimeout(() => startNewRound(code), 5000);
}

function startNewRound(code) {
    const room = rooms[code];
    if (!room) return;

    const ids = Object.keys(room.players);
    if (ids.length === 0) return;

    // Advance the draw order index; if we've gone through everyone, start next round number
    if (room.drawOrderIndex >= room.drawOrder.length) {
        room.currentRoundNum++;
        room.drawOrderIndex = 0;
    }

    if (room.currentRoundNum > room.totalRounds) {
        io.to(code).emit('gameOver', room.players);
        room.gameStarted = false;
        setTimeout(() => { delete rooms[code]; }, 60000);
        return;
    }

    clearInterval(room.timerInterval);
    clearInterval(room.hintInterval);
    clearTimeout(room.selectionTimeout);

    room.correctGuessers = [];
    room.roundPoints = {};

    // Pick the next drawer in order, skipping anyone who disconnected
    let nextDrawer = null;
    while (room.drawOrderIndex < room.drawOrder.length) {
        const candidate = room.drawOrder[room.drawOrderIndex];
        room.drawOrderIndex++;
        if (room.players[candidate]) { nextDrawer = candidate; break; }
    }
    // If everyone in this pass disconnected, recurse to next round
    if (!nextDrawer) { startNewRound(code); return; }

    room.drawerID = nextDrawer;

    // Picking 3 random, unique words from one big list
    const choices = [];
    while(choices.length < 3) {
        const randomWord = wordBank[Math.floor(Math.random() * wordBank.length)];
        if(!choices.includes(randomWord)) {
            choices.push(randomWord);
        }
    }

    io.to(code).emit('clearScreen');
    broadcastScoreboard(code);
    io.to(code).emit('updateRoundDisplay', { current: room.currentRoundNum, total: room.totalRounds });
    io.to(room.drawerID).emit('requestWordChoice', choices);

    room.selectionTimeout = setTimeout(() => confirmWordSelection(code, choices[0]), 15000);
}

function confirmWordSelection(code, word) {
    const room = rooms[code];
    if (!room) return;

    room.currentWord = word.toUpperCase();
    room.timeLeft = 60;

    io.sockets.sockets.forEach((s) => {
        if (!room.players[s.id]) return;
        const role = (s.id === room.drawerID) ? 'drawer' : 'guesser';
        const display = (role === 'drawer')
            ? room.currentWord
            : room.currentWord.split('').map(c => c === ' ' ? '  ' : '_').join(' ');
        s.emit('newRound', { role, word: display, drawerID: room.drawerID });
    });

    // ── Hint reveal: expose one random hidden letter every 15s ───────────
    const wordArr = room.currentWord.split('');
    room.revealedIndices = new Set(
        wordArr.reduce((acc, ch, i) => { if (ch === ' ') acc.push(i); return acc; }, [])
    );

    function buildHintDisplay() {
        return wordArr.map((ch, i) =>
            (ch === ' ' || room.revealedIndices.has(i)) ? ch : '_'
        ).join(' ');
    }

    room.hintInterval = setInterval(() => {
        const hidden = wordArr
            .map((ch, i) => ({ ch, i }))
            .filter(({ ch, i }) => ch !== ' ' && !room.revealedIndices.has(i));
        if (hidden.length === 0) return;
        const pick = hidden[Math.floor(Math.random() * hidden.length)];
        room.revealedIndices.add(pick.i);
        const display = buildHintDisplay();
        Object.keys(room.players).forEach(pid => {
            if (pid !== room.drawerID) io.to(pid).emit('hintUpdate', display);
        });
    }, 15000);

    room.timerInterval = setInterval(() => {
        room.timeLeft--;
        io.to(code).emit('timerUpdate', room.timeLeft);
        if (room.timeLeft <= 0) {
            endRound(code, `⏰ Time's up! The word was: ${room.currentWord}`);
        }
    }, 1000);
}

io.on('connection', (socket) => {

    socket.on('createRoom', (userData) => {
        const code = createRoom(socket.id);
        socket.join(code);
        socket.roomCode = code;
        rooms[code].players[socket.id] = { score: 0, nickname: userData.name || "Guest", avatar: userData.avatar || "public/images/1.png", color: userData.color || "#e74c3c" };
        socket.emit('roomCreated', { code });
        io.to(code).emit('updateLobby', { players: rooms[code].players, hostID: rooms[code].hostID });
    });

    socket.on('joinRoom', (data) => {
        const code = data.code.trim().toUpperCase();
        const room = rooms[code];
        if (!room) { socket.emit('joinError', 'Room not found.'); return; }
        if (room.gameStarted) { socket.emit('joinError', 'Game already started.'); return; }
        socket.join(code);
        socket.roomCode = code;
        room.players[socket.id] = { score: 0, nickname: data.name || "Guest", avatar: data.avatar || "public/images/1.png", color: data.color || "#3498db" };
        socket.emit('joinSuccess', { code });
        io.to(code).emit('updateLobby', { players: room.players, hostID: room.hostID });
    });

    socket.on('wordSelected', (word) => {
        const room = rooms[socket.roomCode];
        if (!room || socket.id !== room.drawerID) return;
        clearTimeout(room.selectionTimeout);
        confirmWordSelection(socket.roomCode, word);
    });

    socket.on('startGame', () => {
        const room = rooms[socket.roomCode];
        if (!room || socket.id !== room.hostID) return;
        room.gameStarted = true;
        // Lock in draw order: sorted by score desc (all 0 at start = join order)
        room.drawOrder = Object.keys(room.players);
        room.drawOrderIndex = 0;
        io.to(socket.roomCode).emit('gameStarting');
        startNewRound(socket.roomCode);
    });

    // 🎯 UPDATED CHAT HANDLER
    socket.on('chatMessage', (msg) => {
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room || !room.players[socket.id]) return;

        // Drawer can't chat; already-correct guessers can't chat
        if (socket.id === room.drawerID) return;
        if (room.correctGuessers.includes(socket.id)) return;

        const clean = msg.trim();
        if (!clean || clean.length > 25) return;

        if (!room.currentWord) return;
        const result = checkGuess(clean, room.currentWord);

        if (
            room.gameStarted &&
            result.correct
        ) {
            const points = 100 + Math.floor(room.timeLeft / 0.6);

            room.players[socket.id].score += points;
            room.roundPoints[socket.id] = (room.roundPoints[socket.id] || 0) + points;
            room.correctGuessers.push(socket.id);

            broadcastScoreboard(code);

            let message = `⭐ ${room.players[socket.id].nickname} guessed it! (+${points})`;

            if (result.type === 'close') {
                message = `⭐ ${room.players[socket.id].nickname} got it (close enough 😄) (+${points})`;
            } else if (result.type === 'phonetic') {
                message = `⭐ ${room.players[socket.id].nickname} sounded it out! 🔊 (+${points})`;
            }

            io.to(code).emit('receiveMessage', { user: "SYSTEM", text: message });

            const nonDrawers = Object.keys(room.players).filter(id => id !== room.drawerID);
            if (room.correctGuessers.length >= nonDrawers.length) {
                endRound(code, `🎉 Everyone got it! The word was: ${room.currentWord}`);
            }

        } else {
            io.to(code).emit('receiveMessage', {
                user: room.players[socket.id].nickname,
                text: clean
            });
        }
    });

    // ── Drawing relay: forward strokes to every OTHER player in the room ──
    socket.on('draw', (data) => {
        const room = rooms[socket.roomCode];
        if (!room || socket.id !== room.drawerID) return;
        socket.to(socket.roomCode).emit('drawData', data);
    });

    socket.on('fill', (data) => {
        const room = rooms[socket.roomCode];
        if (!room || socket.id !== room.drawerID) return;
        socket.to(socket.roomCode).emit('fillData', data);
    });

    socket.on('requestClear', () => {
        const room = rooms[socket.roomCode];
        if (!room || socket.id !== room.drawerID) return;
        io.to(socket.roomCode).emit('clearScreen');
    });

    socket.on('syncHistory', (dataURL) => {
        const room = rooms[socket.roomCode];
        if (!room || socket.id !== room.drawerID) return;
        socket.to(socket.roomCode).emit('applyState', dataURL);
    });

    socket.on('disconnect', () => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        delete room.players[socket.id];
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'Game.html'));
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => { console.log(`Server running on port ${PORT}`); });