const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Serve static files
app.use(express.static('public'));

// Simple test endpoint
app.get('/test', (req, res) => {
    res.json({
        status: 'Server is running',
        players: Object.keys(players).length,
        time: new Date().toISOString()
    });
});

// Simple in-memory player storage
const players = {};

// Basic player class
class Player {
    constructor(id, socket) {
        this.id = id;
        this.socket = socket;
        this.name = `Player_${id.substring(0, 6)}`;
        // Spawn players very close to origin for testing
        this.x = (Math.random() - 0.5) * 50; // Reduced from 200 to 50
        this.y = (Math.random() - 0.5) * 50;
        this.z = (Math.random() - 0.5) * 50;
        this.rotationX = 0;
        this.rotationY = 0;
        this.color = Math.floor(Math.random() * 0xffffff);
        this.radiationLevel = 0;
        this.score = 0;
        this.lastUpdate = Date.now();
    }

    update(data) {
        this.x = data.x || this.x;
        this.y = data.y || this.y;
        this.z = data.z || this.z;
        this.rotationX = data.rotationX || this.rotationX;
        this.rotationY = data.rotationY || this.rotationY;
        this.radiationLevel = Math.min(100, this.radiationLevel + 0.05);
        this.lastUpdate = Date.now();
    }

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            x: this.x,
            y: this.y,
            z: this.z,
            rotationX: this.rotationX,
            rotationY: this.rotationY,
            color: this.color,
            radiationLevel: this.radiationLevel,
            score: this.score
        };
    }
}

// Get nearby players
function getNearbyPlayers(excludeId, x, y, z, range = 1000) { // Increased from 500 to 1000
    const nearby = [];
    const excludedPlayerName = players[excludeId] ? players[excludeId].name : 'unknown';
    
    for (const [id, player] of Object.entries(players)) {
        if (id === excludeId) continue;
        
        const distance = Math.sqrt(
            Math.pow(player.x - x, 2) +
            Math.pow(player.y - y, 2) +
            Math.pow(player.z - z, 2)
        );
        
        console.log(`📏 Distance from ${excludedPlayerName} to ${player.name}: ${Math.round(distance)} (range: ${range})`);
        
        if (distance <= range) {
            const playerData = player.toJSON();
            playerData.distance = Math.round(distance);
            nearby.push(playerData);
            console.log(`✅ ${player.name} is within range - adding to nearby list`);
        } else {
            console.log(`❌ ${player.name} is too far (${Math.round(distance)} > ${range})`);
        }
    }
    console.log(`📋 Total nearby players for ${excludedPlayerName}: ${nearby.length}`);
    return nearby;
}

// Get all player dots for radar
function getAllPlayerDots(excludeId) {
    const dots = [];
    for (const [id, player] of Object.entries(players)) {
        if (id === excludeId) continue;
        dots.push({
            x: player.x,
            y: player.y,
            z: player.z,
            color: player.color
        });
    }
    return dots;
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`🟢 Player connected: ${socket.id}`);
    
    // Create new player
    const player = new Player(socket.id, socket);
    players[socket.id] = player;
    
    console.log(`👤 ${player.name} joined at (${Math.round(player.x)}, ${Math.round(player.y)}, ${Math.round(player.z)})`);
    console.log(`👥 Total players: ${Object.keys(players).length}`);
    
    // Send initial player data
    socket.emit('player_init', {
        id: player.id,
        name: player.name,
        x: player.x,
        y: player.y,
        z: player.z,
        color: player.color
    });
    
    // Broadcast to all players that someone joined
    io.emit('player_joined', {
        name: player.name,
        totalPlayers: Object.keys(players).length
    });
    
    // Handle player movement
    socket.on('player_update', (data) => {
        const player = players[socket.id];
        if (!player) return;
        
        player.update(data);
        
        // Get nearby players
        const nearbyPlayers = getNearbyPlayers(socket.id, player.x, player.y, player.z);
        const allPlayerDots = getAllPlayerDots(socket.id);
        
        // Send game state back to this player
        socket.emit('game_state', {
            players: nearbyPlayers,
            playerDots: allPlayerDots,
            totalPlayers: Object.keys(players).length,
            yourPosition: {
                x: player.x,
                y: player.y,
                z: player.z
            }
        });
    });
    
    // Handle chat messages
    socket.on('chat_message', (data) => {
        const player = players[socket.id];
        if (!player || !data.message) {
            console.log('❌ Invalid chat message:', { player: !!player, message: data.message });
            return;
        }
        
        console.log(`💬 ${player.name}: "${data.message}"`);
        
        // Send to ALL players for now (easier debugging)
        const allPlayerIds = Object.keys(players);
        console.log(`📢 Broadcasting to ${allPlayerIds.length} players: ${allPlayerIds.map(id => players[id].name).join(', ')}`);
        
        allPlayerIds.forEach(playerId => {
            const targetPlayer = players[playerId];
            if (targetPlayer && targetPlayer.socket) {
                targetPlayer.socket.emit('chat_message', {
                    playerId: player.id,
                    playerName: player.name,
                    message: data.message,
                    timestamp: Date.now()
                });
            }
        });
        
        console.log(`✅ Chat message sent successfully`);
    });
    
    // Handle disconnect
    socket.on('disconnect', () => {
        const player = players[socket.id];
        console.log(`🔴 Player disconnected: ${socket.id}`);
        
        if (player) {
            console.log(`👋 ${player.name} left the game`);
            
            // Broadcast to remaining players
            socket.broadcast.emit('player_left', {
                name: player.name,
                totalPlayers: Object.keys(players).length - 1
            });
            
            delete players[socket.id];
        }
        
        console.log(`👥 Total players: ${Object.keys(players).length}`);
    });
    
    // Send initial game state immediately
    setTimeout(() => {
        const nearbyPlayers = getNearbyPlayers(socket.id, player.x, player.y, player.z);
        const allPlayerDots = getAllPlayerDots(socket.id);
        
        console.log(`📡 Sending initial game state to ${player.name}: ${nearbyPlayers.length} nearby players, ${allPlayerDots.length} dots`);
        
        socket.emit('game_state', {
            players: nearbyPlayers,
            playerDots: allPlayerDots,
            totalPlayers: Object.keys(players).length,
            yourPosition: {
                x: player.x,
                y: player.y,
                z: player.z
            }
        });
    }, 100);
});

// Clean up inactive players
setInterval(() => {
    const now = Date.now();
    const timeout = 30000; // 30 seconds
    
    for (const [id, player] of Object.entries(players)) {
        if (now - player.lastUpdate > timeout) {
            console.log(`🧹 Removing inactive player: ${player.name}`);
            delete players[id];
        }
    }
}, 10000);

const PORT = process.env.PORT || 3000; // Railway will set PORT automatically
server.listen(PORT, '0.0.0.0', () => { // Listen on all interfaces for Railway
    console.log(`🚀 Ethereal Exploration server running on port ${PORT}`);
    console.log(`🌐 Server is ready for connections`);
    console.log(`🔧 Health check endpoint: /test`);
});
