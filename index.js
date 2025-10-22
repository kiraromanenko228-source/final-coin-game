const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Хранилище данных в памяти
const players = new Map();
const rooms = new Map();
const matchmakingQueue = [];
const serverStats = {
    totalGames: 0,
    totalCommission: 0,
    peakOnline: 0,
    startupTime: Date.now()
};

// 🎯 УМНАЯ СИСТЕМА ШАНСОВ ДЛЯ МУЛЬТИПЛЕЕРА
const SmartMultiplayerSystem = {
    calculateWinProbability(playerId, betAmount) {
        const player = players.get(playerId);
        if (!player) return 0.5;
        
        const totalGames = player.wins + player.losses;
        const balanceRatio = player.balance / 1000;
        
        if (totalGames < 3) return 0.75;
        if (player.lossStreak >= 2) return 0.65;
        if (balanceRatio > 1.8) return 0.2;
        if (balanceRatio > 1.3) return 0.35;
        if (betAmount > 300) return 0.3;
        
        return 0.45;
    }
};

// === HEALTH CHECK И МОНИТОРИНГ ===
app.get('/', (req, res) => {
    res.json({
        message: '🎰 Smart CoinFlip Casino Server - Render.com',
        status: 'online',
        version: '2.0.0',
        uptime: Math.floor(process.uptime()),
        online: players.size,
        rooms: rooms.size,
        queue: matchmakingQueue.length,
        totalGames: serverStats.totalGames
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        timestamp: new Date().toISOString(),
        players: players.size,
        memory: process.memoryUsage()
    });
});

app.get('/stats', (req, res) => {
    const stats = {
        online: players.size,
        rooms: rooms.size,
        queue: matchmakingQueue.length,
        totalGames: serverStats.totalGames,
        totalCommission: serverStats.totalCommission,
        peakOnline: serverStats.peakOnline,
        uptime: Date.now() - serverStats.startupTime
    };
    
    res.json(stats);
});

// === PING ДЛЯ ПРЕДОТВРАЩЕНИЯ СНА ===
app.get('/ping', (req, res) => {
    res.json({ 
        status: 'pong', 
        timestamp: Date.now(),
        activePlayers: players.size
    });
});

// === WEB SOCKET СЕРВЕР ===
wss.on('connection', (ws, req) => {
    console.log(`🟢 Новое подключение`);
    
    ws.isAlive = true;
    
    ws.on('pong', () => {
        ws.isAlive = true;
    });
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            handleMessage(ws, message);
        } catch (error) {
            console.error('❌ Ошибка парсинга:', error);
            sendError(ws, 'Неверный формат сообщения');
        }
    });
    
    ws.on('close', () => {
        console.log(`🔴 Отключение`);
        handleDisconnect(ws);
    });
    
    ws.on('error', (error) => {
        console.error(`💥 Ошибка WebSocket:`, error);
    });
});

// Проверка живых соединений
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
            console.log('🟡 Убиваем мертвое соединение');
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// === ОБРАБОТЧИКИ СООБЩЕНИЙ ===
function handleMessage(ws, message) {
    switch (message.type) {
        case 'auth':
            handleAuth(ws, message);
            break;
        case 'find_opponent':
            handleFindOpponent(ws, message);
            break;
        case 'make_bet':
            handleMakeBet(ws, message);
            break;
        case 'cancel_search':
            handleCancelSearch(ws, message);
            break;
        case 'ping':
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            break;
        default:
            sendError(ws, 'Неизвестная команда: ' + message.type);
    }
}

function handleAuth(ws, message) {
    const { playerId, balance = 1000 } = message;
    
    if (!playerId) {
        sendError(ws, 'Отсутствует playerId');
        return;
    }
    
    let player = players.get(playerId);
    if (!player) {
        player = {
            id: playerId,
            ws: ws,
            balance: balance,
            wins: 0,
            losses: 0,
            winStreak: 0,
            lossStreak: 0,
            roomId: null,
            connectedAt: Date.now()
        };
        console.log(`🎁 НОВЫЙ ИГРОК: ${playerId} с балансом ${balance} ₽`);
    } else {
        player.ws = ws;
        player.balance = balance;
    }
    
    players.set(playerId, player);
    ws.playerId = playerId;
    
    if (players.size > serverStats.peakOnline) {
        serverStats.peakOnline = players.size;
    }
    
    ws.send(JSON.stringify({
        type: 'auth_success',
        playerId: playerId,
        serverTime: Date.now()
    }));
    
    broadcastStats();
}

function handleFindOpponent(ws, message) {
    const player = players.get(ws.playerId);
    if (!player) {
        sendError(ws, 'Игрок не авторизован');
        return;
    }
    
    const { betAmount } = message;
    
    if (betAmount < 10 || betAmount > 10000) {
        sendError(ws, 'Неверная сумма ставки (10-10000)');
        return;
    }
    
    if (betAmount > player.balance) {
        sendError(ws, 'Недостаточно средств');
        return;
    }
    
    player.betAmount = betAmount;
    
    const opponentIndex = matchmakingQueue.findIndex(p => 
        p.playerId !== player.playerId &&
        p.betAmount === betAmount
    );
    
    if (opponentIndex !== -1) {
        const opponent = matchmakingQueue[opponentIndex];
        matchmakingQueue.splice(opponentIndex, 1);
        createRoom(player, opponent);
    } else {
        if (!matchmakingQueue.some(p => p.playerId === player.playerId)) {
            matchmakingQueue.push(player);
        }
        
        ws.send(JSON.stringify({
            type: 'searching',
            queuePosition: matchmakingQueue.length,
            betAmount: betAmount
        }));
    }
}

function createRoom(player1, player2) {
    const roomId = `room_${Date.now()}`;
    
    const room = {
        id: roomId,
        player1: player1,
        player2: player2,
        bets: {},
        state: 'betting',
        timer: 30,
        result: null,
        betAmount: player1.betAmount,
        createdAt: Date.now()
    };
    
    rooms.set(roomId, room);
    player1.roomId = roomId;
    player2.roomId = roomId;
    
    const roomInfo = {
        type: 'opponent_found',
        roomId: roomId,
        betAmount: player1.betAmount,
        timer: 30
    };
    
    player1.ws.send(JSON.stringify({
        ...roomInfo,
        opponent: { id: player2.id, balance: player2.balance }
    }));
    
    player2.ws.send(JSON.stringify({
        ...roomInfo,
        opponent: { id: player1.id, balance: player1.balance }
    }));
    
    startBettingTimer(room);
}

function startBettingTimer(room) {
    room.timerInterval = setInterval(() => {
        room.timer--;
        
        broadcastToRoom(room.id, {
            type: 'timer_update',
            timer: room.timer
        });
        
        if (room.timer <= 0) {
            clearInterval(room.timerInterval);
            handleTimeOut(room);
        }
    }, 1000);
}

function handleMakeBet(ws, message) {
    const player = players.get(ws.playerId);
    if (!player || !player.roomId) return;
    
    const room = rooms.get(player.roomId);
    if (!room || room.state !== 'betting') return;
    
    const { bet } = message;
    
    if (bet !== 'heads' && bet !== 'tails') {
        sendError(ws, 'Неверная ставка (heads/tails)');
        return;
    }
    
    room.bets[player.id] = bet;
    
    broadcastToRoom(room.id, {
        type: 'bet_made',
        playerId: player.id,
        bet: bet
    });
    
    if (Object.keys(room.bets).length === 2) {
        clearInterval(room.timerInterval);
        startCoinFlip(room);
    }
}

function startCoinFlip(room) {
    room.state = 'flipping';
    
    const { player1, player2, bets, betAmount } = room;
    
    const targetPlayer = Math.random() > 0.5 ? player1 : player2;
    const otherPlayer = targetPlayer === player1 ? player2 : player1;
    
    const winProbability = SmartMultiplayerSystem.calculateWinProbability(targetPlayer.id, betAmount);
    const playerWins = Math.random() < winProbability;
    
    room.result = playerWins ? bets[targetPlayer.id] : bets[otherPlayer.id];
    room.winner = playerWins ? targetPlayer.id : otherPlayer.id;
    
    serverStats.totalGames++;
    
    broadcastToRoom(room.id, {
        type: 'coin_flip_start',
        result: room.result
    });
    
    setTimeout(() => finishGame(room), 3000);
}

function finishGame(room) {
    const { player1, player2, result, winner, betAmount } = room;
    
    const commission = Math.floor(betAmount * 0.1);
    const winAmount = (betAmount * 2) - commission;
    
    serverStats.totalCommission += commission;
    
    if (winner) {
        const winnerPlayer = players.get(winner);
        const loserPlayer = players.get(winner === player1.id ? player2.id : player1.id);
        
        if (winnerPlayer) {
            winnerPlayer.balance += winAmount;
            winnerPlayer.wins++;
            winnerPlayer.winStreak++;
            winnerPlayer.lossStreak = 0;
        }
        if (loserPlayer) {
            loserPlayer.balance -= betAmount;
            loserPlayer.losses++;
            loserPlayer.lossStreak++;
            loserPlayer.winStreak = 0;
        }
    }
    
    broadcastToRoom(room.id, {
        type: 'game_result',
        result: result,
        winner: winner,
        winAmount: winAmount,
        commission: commission,
        balances: {
            [player1.id]: player1.balance,
            [player2.id]: player2.balance
        }
    });
    
    setTimeout(() => cleanupRoom(room.id), 8000);
}

function cleanupRoom(roomId) {
    const room = rooms.get(roomId);
    if (room) {
        if (room.player1) room.player1.roomId = null;
        if (room.player2) room.player2.roomId = null;
        if (room.timerInterval) clearInterval(room.timerInterval);
        rooms.delete(roomId);
    }
}

function handleDisconnect(ws) {
    const playerId = ws.playerId;
    if (!playerId) return;
    
    const player = players.get(playerId);
    if (player) {
        const queueIndex = matchmakingQueue.findIndex(p => p.playerId === playerId);
        if (queueIndex !== -1) matchmakingQueue.splice(queueIndex, 1);
        
        if (player.roomId) {
            const room = rooms.get(player.roomId);
            if (room) {
                const opponent = room.player1.id === playerId ? room.player2 : room.player1;
                if (opponent && opponent.ws) {
                    opponent.ws.send(JSON.stringify({
                        type: 'opponent_disconnected',
                        message: 'Соперник отключился'
                    }));
                }
                cleanupRoom(player.roomId);
            }
        }
        
        players.delete(playerId);
    }
    
    broadcastStats();
}

function broadcastToRoom(roomId, message) {
    const room = rooms.get(roomId);
    if (!room) return;
    
    [room.player1, room.player2].forEach(player => {
        if (player && player.ws && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify(message));
        }
    });
}

function broadcastStats() {
    const stats = {
        type: 'stats_update',
        online: players.size,
        rooms: rooms.size,
        queue: matchmakingQueue.length,
        peakOnline: serverStats.peakOnline,
        totalGames: serverStats.totalGames
    };
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(stats));
        }
    });
}

function sendError(ws, message) {
    ws.send(JSON.stringify({
        type: 'error',
        message: message
    }));
}

// === ЗАПУСК СЕРВЕРА ДЛЯ RENDER.COM ===
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log('🚀 ===========================================');
    console.log('🎰 SMART COINFLIP CASINO SERVER ЗАПУЩЕН!');
    console.log('🌐 Хостинг: Render.com');
    console.log(`📡 Порт: ${PORT}`);
    console.log(`❤️  Health: https://your-app.onrender.com/health`);
    console.log(`🔄 Ping: https://your-app.onrender.com/ping`);
    console.log('🎮 Ожидаем подключения игроков...');
    console.log('🚀 ===========================================');
});

// Авто-пинг для предотвращения сна
setInterval(() => {
    console.log('🔄 Keep-alive ping для Render.com');
}, 14 * 60 * 1000); // Каждые 14 минут