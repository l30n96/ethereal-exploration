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

// Test endpoint
app.get('/test', (req, res) => {
    res.json({
        status: 'Server is running',
        players: Object.keys(players).length,
        worldObjects: worldObjects.length,
        time: new Date().toISOString()
    });
});

// 🔧 WORLD SETTINGS - ADJUST THESE VALUES
const WORLD_SETTINGS = {
    discoveries: 60,
    explodingCreatures: 40,
    rareEntities: 15,
    spaceCreatures: 20,
    ringPortals: 12,
    worldSize: 2500,
    respawnDelay: 30000, // 30 seconds to respawn collected objects
    stealRadius: 100, // Distance within which players can compete for resources
    
    // 🔧 PVP RADIATION SETTINGS
    radiationRange: 150, // Distance at which players affect each other's radiation
    radiationIncrease: 0.08, // Rate of radiation increase when near other players
    deathRadiationBonus: 30, // Radiation reduction for surviving nearby deaths
    spawnDistance: 200, // Distance from other players when spawning
    maxSpawnDistance: 400, // Maximum spawn distance from nearest player
    creatureFleeDistance: 120, // Distance at which creatures flee from players
};

// Shared world state - all objects exist on server
let worldObjects = [];
let objectIdCounter = 0;

// Player storage
const players = {};

// Object types and their properties
const OBJECT_TYPES = {
    discovery: { points: 10, collectRadius: 30, respawnTime: 30000 },
    exploding: { points: 15, collectRadius: 25, respawnTime: 45000 },
    rare: { points: 50, collectRadius: 20, respawnTime: 120000 }, // 2 minutes for rare
    spaceCreature: { points: 25, collectRadius: 35, respawnTime: 60000 },
    ringPortal: { points: 5, collectRadius: 30, respawnTime: 180000 } // 3 minutes for portals
};

// Player class with competitive features
class Player {
    constructor(id, socket) {
        this.id = id;
        this.socket = socket;
        this.name = `Player_${id.substring(0, 6)}`;
        
        // Spawn near other players for PvP action
        const spawnPos = this.getSpawnPosition();
        this.x = spawnPos.x;
        this.y = spawnPos.y;
        this.z = spawnPos.z;
        this.spawnRotation = spawnPos.rotation; // Look towards nearest player
        
        this.rotationX = 0;
        this.rotationY = spawnPos.rotation || 0;
        this.color = Math.floor(Math.random() * 0xffffff);
        this.radiationLevel = 0;
        this.score = 0;
        this.discoveries = 0;
        this.rareItems = 0;
        this.creatures = 0;
        this.lastUpdate = Date.now();
        this.joinTime = Date.now();
        
        // Competition tracking
        this.resourcesStolen = 0;
        this.resourcesLost = 0;
        this.nearbyPlayers = [];
        
        // 🔧 PVP TRACKING
        this.kills = 0;
        this.deaths = 0;
        this.lastDeathTime = 0;
        this.radiationFromPlayers = 0; // Track radiation caused by nearby players
    }

    getSpawnPosition() {
        const otherPlayers = Object.values(players);
        
        if (otherPlayers.length === 0) {
            // First player spawns at origin
            return { x: 0, y: 0, z: 0, rotation: 0 };
        }
        
        // Find a random existing player to spawn near
        const targetPlayer = otherPlayers[Math.floor(Math.random() * otherPlayers.length)];
        
        // Generate position near target player but not too close
        const angle = Math.random() * Math.PI * 2;
        const distance = WORLD_SETTINGS.spawnDistance + Math.random() * (WORLD_SETTINGS.maxSpawnDistance - WORLD_SETTINGS.spawnDistance);
        
        const spawnX = targetPlayer.x + Math.cos(angle) * distance;
        const spawnZ = targetPlayer.z + Math.sin(angle) * distance;
        const spawnY = targetPlayer.y + (Math.random() - 0.5) * 100; // Some vertical variation
        
        // Calculate rotation to look towards target player
        const lookDirection = Math.atan2(targetPlayer.z - spawnZ, targetPlayer.x - spawnX);
        
        console.log(`👶 ${this.name} spawning ${Math.round(distance)}m from ${targetPlayer.name}, looking towards them`);
        
        return {
            x: spawnX,
            y: spawnY,
            z: spawnZ,
            rotation: lookDirection
        };
    }

    update(data) {
        this.x = data.x || this.x;
        this.y = data.y || this.y;
        this.z = data.z || this.z;
        this.rotationX = data.rotationX || this.rotationX;
        this.rotationY = data.rotationY || this.rotationY;
        this.radiationLevel = Math.min(100, (data.radiationLevel || this.radiationLevel));
        this.lastUpdate = Date.now();
        
        // Update radiation from nearby players
        this.updateRadiationFromPlayers();
        
        // Check for radiation death
        if (this.radiationLevel >= 100) {
            this.handleRadiationDeath();
        }
    }

    updateRadiationFromPlayers() {
        this.radiationFromPlayers = 0;
        this.nearbyPlayers = [];
        
        for (const [id, otherPlayer] of Object.entries(players)) {
            if (id === this.id) continue;
            
            const distance = Math.sqrt(
                Math.pow(otherPlayer.x - this.x, 2) +
                Math.pow(otherPlayer.y - this.y, 2) +
                Math.pow(otherPlayer.z - this.z, 2)
            );
            
            if (distance <= WORLD_SETTINGS.radiationRange) {
                // Radiation increases based on proximity (closer = more radiation)
                const radiationFactor = 1 - (distance / WORLD_SETTINGS.radiationRange);
                this.radiationFromPlayers += WORLD_SETTINGS.radiationIncrease * radiationFactor;
                
                this.nearbyPlayers.push({
                    id: otherPlayer.id,
                    name: otherPlayer.name,
                    distance: Math.round(distance),
                    radiationLevel: Math.round(otherPlayer.radiationLevel)
                });
            }
        }
        
        // Apply radiation from players to total radiation
        this.radiationLevel = Math.min(100, this.radiationLevel + this.radiationFromPlayers);
    }

    handleRadiationDeath() {
        console.log(`💀 ${this.name} died from radiation poisoning! (Level: ${this.radiationLevel}%)`);
        
        this.deaths++;
        this.lastDeathTime = Date.now();
        
        // Find nearby players who get radiation bonus
        const nearbyPlayers = [];
        for (const [id, otherPlayer] of Object.entries(players)) {
            if (id === this.id) continue;
            
            const distance = Math.sqrt(
                Math.pow(otherPlayer.x - this.x, 2) +
                Math.pow(otherPlayer.y - this.y, 2) +
                Math.pow(otherPlayer.z - this.z, 2)
            );
            
            if (distance <= WORLD_SETTINGS.radiationRange * 1.5) { // Slightly larger range for death bonus
                otherPlayer.radiationLevel = Math.max(0, otherPlayer.radiationLevel - WORLD_SETTINGS.deathRadiationBonus);
                otherPlayer.kills++;
                nearbyPlayers.push(otherPlayer);
                console.log(`💚 ${otherPlayer.name} gained radiation cleanse from ${this.name}'s death! (-${WORLD_SETTINGS.deathRadiationBonus}% radiation, Kills: ${otherPlayer.kills})`);
            }
        }
        
        // Reset player state
        this.radiationLevel = 0;
        this.score = Math.max(0, this.score - 50); // Death penalty
        
        // Respawn at new location
        const newSpawn = this.getSpawnPosition();
        this.x = newSpawn.x;
        this.y = newSpawn.y;
        this.z = newSpawn.z;
        this.rotationY = newSpawn.rotation;
        
        // Broadcast death event
        io.emit('player_death', {
            deadPlayer: this.name,
            killers: nearbyPlayers.map(p => ({ name: p.name, newKills: p.kills })),
            position: { x: this.x, y: this.y, z: this.z },
            radiationBonus: WORLD_SETTINGS.deathRadiationBonus
        });
        
        // Send respawn data to player
        this.socket.emit('player_respawn', {
            x: this.x,
            y: this.y,
            z: this.z,
            rotation: this.rotationY,
            message: `💀 You died from radiation! ${nearbyPlayers.length > 0 ? `${nearbyPlayers.length} nearby players got -${WORLD_SETTINGS.deathRadiationBonus}% radiation` : 'No one was nearby to benefit'}`
        });
    }

    addScore(points, reason) {
        this.score += points;
        console.log(`💰 ${this.name} earned ${points} points for ${reason} (Total: ${this.score})`);
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
            radiationFromPlayers: this.radiationFromPlayers,
            score: this.score,
            discoveries: this.discoveries,
            rareItems: this.rareItems,
            creatures: this.creatures,
            resourcesStolen: this.resourcesStolen,
            resourcesLost: this.resourcesLost,
            kills: this.kills,
            deaths: this.deaths,
            nearbyPlayers: this.nearbyPlayers
        };
    }
}

// World object class
class WorldObject {
    constructor(type, x, y, z) {
        this.id = ++objectIdCounter;
        this.type = type;
        this.x = x;
        this.y = y;
        this.z = z;
        this.available = true;
        this.collectedBy = null;
        this.collectedAt = null;
        this.competingPlayers = []; // Players trying to collect this
        
        // Type-specific properties
        if (type === 'exploding') {
            this.hue = Math.random();
        } else if (type === 'spaceCreature') {
            this.tentacleCount = 3 + Math.floor(Math.random() * 5);
            this.fleeSpeed = 1.1 + Math.random() * 0.3;
            this.detectionRange = 80 + Math.random() * 40;
        } else if (type === 'rare') {
            this.fleeSpeed = 0.8;
        }
    }

    // Check if object should respawn
    checkRespawn() {
        if (!this.available && this.collectedAt) {
            const respawnTime = OBJECT_TYPES[this.type].respawnTime;
            if (Date.now() - this.collectedAt > respawnTime) {
                this.available = true;
                this.collectedBy = null;
                this.collectedAt = null;
                this.competingPlayers = [];
                console.log(`🔄 ${this.type} ${this.id} respawned at (${Math.round(this.x)}, ${Math.round(this.y)}, ${Math.round(this.z)})`);
                return true;
            }
        }
        return false;
    }

    toJSON() {
        return {
            id: this.id,
            type: this.type,
            x: this.x,
            y: this.y,
            z: this.z,
            available: this.available,
            collectedBy: this.collectedBy,
            hue: this.hue,
            tentacleCount: this.tentacleCount,
            competingPlayers: this.competingPlayers.length
        };
    }
}

// Generate initial world
function generateWorld() {
    console.log('🌍 Generating competitive world...');
    worldObjects = [];
    objectIdCounter = 0;

    // Create discoveries
    for (let i = 0; i < WORLD_SETTINGS.discoveries; i++) {
        worldObjects.push(new WorldObject(
            'discovery',
            (Math.random() - 0.5) * WORLD_SETTINGS.worldSize,
            (Math.random() - 0.5) * 600,
            (Math.random() - 0.5) * WORLD_SETTINGS.worldSize
        ));
    }

    // Create exploding creatures
    for (let i = 0; i < WORLD_SETTINGS.explodingCreatures; i++) {
        worldObjects.push(new WorldObject(
            'exploding',
            (Math.random() - 0.5) * WORLD_SETTINGS.worldSize,
            (Math.random() - 0.5) * 600,
            (Math.random() - 0.5) * WORLD_SETTINGS.worldSize
        ));
    }

    // Create rare entities
    for (let i = 0; i < WORLD_SETTINGS.rareEntities; i++) {
        worldObjects.push(new WorldObject(
            'rare',
            (Math.random() - 0.5) * WORLD_SETTINGS.worldSize,
            (Math.random() - 0.5) * 600,
            (Math.random() - 0.5) * WORLD_SETTINGS.worldSize
        ));
    }

    // Create space creatures
    for (let i = 0; i < WORLD_SETTINGS.spaceCreatures; i++) {
        worldObjects.push(new WorldObject(
            'spaceCreature',
            (Math.random() - 0.5) * WORLD_SETTINGS.worldSize,
            (Math.random() - 0.5) * 600,
            (Math.random() - 0.5) * WORLD_SETTINGS.worldSize
        ));
    }

    // Create ring portals
    for (let i = 0; i < WORLD_SETTINGS.ringPortals; i++) {
        worldObjects.push(new WorldObject(
            'ringPortal',
            (Math.random() - 0.5) * WORLD_SETTINGS.worldSize,
            (Math.random() - 0.5) * 600,
            (Math.random() - 0.5) * WORLD_SETTINGS.worldSize
        ));
    }

    console.log(`✅ Generated world with ${worldObjects.length} objects`);
}

// Get nearby players for competition
function getNearbyPlayers(excludeId, x, y, z, range = 1000) {
    const nearby = [];
    const excludedPlayerName = players[excludeId] ? players[excludeId].name : 'unknown';
    
    for (const [id, player] of Object.entries(players)) {
        if (id === excludeId) continue;
        
        const distance = Math.sqrt(
            Math.pow(player.x - x, 2) +
            Math.pow(player.y - y, 2) +
            Math.pow(player.z - z, 2)
        );
        
        if (distance <= range) {
            const playerData = player.toJSON();
            playerData.distance = Math.round(distance);
            nearby.push(playerData);
        }
    }
    
    return nearby;
}

// Get available world objects near player
function getNearbyObjects(playerId, x, y, z, range = 1000) {
    const nearby = [];
    
    worldObjects.forEach(obj => {
        const distance = Math.sqrt(
            Math.pow(obj.x - x, 2) +
            Math.pow(obj.y - y, 2) +
            Math.pow(obj.z - z, 2)
        );
        
        if (distance <= range) {
            const objData = obj.toJSON();
            objData.distance = Math.round(distance);
            nearby.push(objData);
        }
    });
    
    return nearby;
}

// Handle resource collection with competition
function handleResourceCollection(playerId, objectId) {
    const player = players[playerId];
    const obj = worldObjects.find(o => o.id === objectId);
    
    if (!player || !obj || !obj.available) {
        return { success: false, reason: 'Object not available' };
    }

    const distance = Math.sqrt(
        Math.pow(obj.x - player.x, 2) +
        Math.pow(obj.y - player.y, 2) +
        Math.pow(obj.z - player.z, 2)
    );

    const collectRadius = OBJECT_TYPES[obj.type].collectRadius;
    
    if (distance > collectRadius) {
        return { success: false, reason: 'Too far away' };
    }

    // Check for competing players
    const competingPlayers = [];
    for (const [id, otherPlayer] of Object.entries(players)) {
        if (id === playerId) continue;
        
        const competitorDistance = Math.sqrt(
            Math.pow(obj.x - otherPlayer.x, 2) +
            Math.pow(obj.y - otherPlayer.y, 2) +
            Math.pow(obj.z - otherPlayer.z, 2)
        );
        
        if (competitorDistance <= WORLD_SETTINGS.stealRadius) {
            competingPlayers.push({
                player: otherPlayer,
                distance: competitorDistance
            });
        }
    }

    // If multiple players competing, closest wins but others get notified
    if (competingPlayers.length > 0) {
        const closestCompetitor = competingPlayers.reduce((closest, current) => 
            current.distance < closest.distance ? current : closest
        );

        if (closestCompetitor.distance < distance) {
            // Another player is closer - they steal it!
            const thief = closestCompetitor.player;
            const points = OBJECT_TYPES[obj.type].points;
            
            // Award points to thief
            thief.addScore(points, `stealing ${obj.type}`);
            thief.resourcesStolen++;
            
            // Track theft for original player
            player.resourcesLost++;
            
            // Mark object as collected
            obj.available = false;
            obj.collectedBy = thief.id;
            obj.collectedAt = Date.now();

            // Update player stats
            if (obj.type === 'discovery') thief.discoveries++;
            else if (obj.type === 'rare') thief.rareItems++;
            else if (obj.type === 'spaceCreature') thief.creatures++;

            // Broadcast the theft
            io.emit('resource_stolen', {
                objectId: obj.id,
                objectType: obj.type,
                thief: thief.name,
                victim: player.name,
                points: points,
                position: { x: obj.x, y: obj.y, z: obj.z }
            });

            console.log(`🏴‍☠️ ${thief.name} stole ${obj.type} from ${player.name}! (+${points} points)`);
            
            return { 
                success: false, 
                reason: 'stolen',
                stolenBy: thief.name,
                thiefDistance: Math.round(closestCompetitor.distance),
                yourDistance: Math.round(distance)
            };
        }
    }

    // Player successfully collects the resource
    const points = OBJECT_TYPES[obj.type].points;
    player.addScore(points, `collecting ${obj.type}`);
    
    // Mark object as collected
    obj.available = false;
    obj.collectedBy = playerId;
    obj.collectedAt = Date.now();

    // Update player stats
    if (obj.type === 'discovery') player.discoveries++;
    else if (obj.type === 'rare') player.rareItems++;
    else if (obj.type === 'spaceCreature') player.creatures++;

    // Special handling for portals (radiation reduction)
    let radiationReduction = 0;
    if (obj.type === 'ringPortal') {
        radiationReduction = 25 + Math.random() * 15;
        player.radiationLevel = Math.max(0, player.radiationLevel - radiationReduction);
    }

    // Broadcast the collection
    io.emit('resource_collected', {
        objectId: obj.id,
        objectType: obj.type,
        collector: player.name,
        points: points,
        radiationReduction: radiationReduction,
        position: { x: obj.x, y: obj.y, z: obj.z },
        competitorCount: competingPlayers.length
    });

    console.log(`✅ ${player.name} collected ${obj.type} (+${points} points)${competingPlayers.length > 0 ? ` despite ${competingPlayers.length} competitors nearby!` : ''}`);
    
    return { 
        success: true, 
        points: points,
        radiationReduction: radiationReduction,
        competitorCount: competingPlayers.length
    };
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
        color: player.color,
        rotation: player.spawnRotation // Send spawn rotation to look at nearest player
    });
    
    // Send initial world state
    socket.emit('world_sync', {
        objects: worldObjects.map(obj => obj.toJSON())
    });
    
    // Broadcast to all players that someone joined
    io.emit('player_joined', {
        name: player.name,
        totalPlayers: Object.keys(players).length
    });
    
    // Handle player movement and state updates
    socket.on('player_update', (data) => {
        const player = players[socket.id];
        if (!player) return;
        
        player.update(data);
        
        // Get nearby players and objects
        const nearbyPlayers = getNearbyPlayers(socket.id, player.x, player.y, player.z);
        const nearbyObjects = getNearbyObjects(socket.id, player.x, player.y, player.z);
        
        // Send game state back to this player
        socket.emit('game_state', {
            players: nearbyPlayers,
            objects: nearbyObjects,
            totalPlayers: Object.keys(players).length,
            yourStats: {
                score: player.score,
                discoveries: player.discoveries,
                rareItems: player.rareItems,
                creatures: player.creatures,
                radiationLevel: player.radiationLevel,
                radiationFromPlayers: player.radiationFromPlayers,
                resourcesStolen: player.resourcesStolen,
                resourcesLost: player.resourcesLost,
                kills: player.kills,
                deaths: player.deaths,
                nearbyPlayers: player.nearbyPlayers
            }
        });
    });
    
    // Handle resource collection attempts
    socket.on('collect_resource', (data) => {
        const result = handleResourceCollection(socket.id, data.objectId);
        socket.emit('collection_result', result);
    });
    
    // Handle chat messages
    socket.on('chat_message', (data) => {
        const player = players[socket.id];
        if (!player || !data.message) return;
        
        console.log(`💬 ${player.name}: "${data.message}"`);
        
        // Broadcast to all players
        io.emit('chat_message', {
            playerId: player.id,
            playerName: player.name,
            message: data.message,
            timestamp: Date.now()
        });
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
});

// World management loop - handle respawns, cleanup, and creature AI
setInterval(() => {
    let respawnCount = 0;
    
    // Check for object respawns
    worldObjects.forEach(obj => {
        if (obj.checkRespawn()) {
            respawnCount++;
        }
        
        // Update creature AI - make them flee from players
        if ((obj.type === 'spaceCreature' || obj.type === 'rare') && obj.available) {
            let closestPlayer = null;
            let closestDistance = Infinity;
            
            // Find closest player
            for (const [id, player] of Object.entries(players)) {
                const distance = Math.sqrt(
                    Math.pow(player.x - obj.x, 2) +
                    Math.pow(player.y - obj.y, 2) +
                    Math.pow(player.z - obj.z, 2)
                );
                
                if (distance < closestDistance) {
                    closestDistance = distance;
                    closestPlayer = player;
                }
            }
            
            // Make creature flee if player is too close
            if (closestPlayer && closestDistance < WORLD_SETTINGS.creatureFleeDistance) {
                const fleeSpeed = obj.type === 'spaceCreature' ? 2.0 : 1.5;
                
                // Calculate flee direction (away from player)
                const fleeDir = {
                    x: obj.x - closestPlayer.x,
                    y: obj.y - closestPlayer.y,
                    z: obj.z - closestPlayer.z
                };
                
                // Normalize and apply flee speed
                const length = Math.sqrt(fleeDir.x * fleeDir.x + fleeDir.y * fleeDir.y + fleeDir.z * fleeDir.z);
                if (length > 0) {
                    fleeDir.x = (fleeDir.x / length) * fleeSpeed;
                    fleeDir.y = (fleeDir.y / length) * fleeSpeed * 0.5; // Less vertical movement
                    fleeDir.z = (fleeDir.z / length) * fleeSpeed;
                    
                    // Update creature position
                    obj.x += fleeDir.x;
                    obj.y += fleeDir.y;
                    obj.z += fleeDir.z;
                    
                    // Keep creatures within world bounds
                    const halfWorld = WORLD_SETTINGS.worldSize / 2;
                    obj.x = Math.max(-halfWorld, Math.min(halfWorld, obj.x));
                    obj.z = Math.max(-halfWorld, Math.min(halfWorld, obj.z));
                    obj.y = Math.max(-300, Math.min(300, obj.y));
                }
            }
        }
    });
    
    if (respawnCount > 0) {
        console.log(`🔄 Respawned ${respawnCount} objects`);
        // Broadcast world sync to all players
        io.emit('world_sync', {
            objects: worldObjects.map(obj => obj.toJSON())
        });
    }
    
    // Clean up inactive players
    const now = Date.now();
    const timeout = 60000; // 1 minute timeout
    
    for (const [id, player] of Object.entries(players)) {
        if (now - player.lastUpdate > timeout) {
            console.log(`🧹 Removing inactive player: ${player.name}`);
            delete players[id];
        }
    }
}, 2000); // Check every 2 seconds for more responsive creature AI

// Generate leaderboard
function getLeaderboard() {
    const sortedPlayers = Object.values(players)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map((player, index) => ({
            rank: index + 1,
            name: player.name,
            score: player.score,
            discoveries: player.discoveries,
            rareItems: player.rareItems,
            creatures: player.creatures,
            resourcesStolen: player.resourcesStolen,
            resourcesLost: player.resourcesLost,
            kills: player.kills,
            deaths: player.deaths,
            kdr: player.deaths > 0 ? (player.kills / player.deaths).toFixed(2) : player.kills.toFixed(2),
            survivalTime: Math.floor((Date.now() - player.joinTime) / 1000),
            radiationLevel: Math.round(player.radiationLevel)
        }));
    
    return sortedPlayers;
}

// Broadcast leaderboard updates
setInterval(() => {
    if (Object.keys(players).length > 0) {
        const leaderboard = getLeaderboard();
        io.emit('leaderboard_update', { leaderboard });
    }
}, 30000); // Every 30 seconds

// Initialize world
generateWorld();

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Competitive Ethereal Exploration server running on port ${PORT}`);
    console.log(`🌐 Server ready for competitive multiplayer`);
    console.log(`🔧 World settings: ${WORLD_SETTINGS.discoveries + WORLD_SETTINGS.explodingCreatures + WORLD_SETTINGS.rareEntities + WORLD_SETTINGS.spaceCreatures + WORLD_SETTINGS.ringPortals} total objects`);
    console.log(`🏴‍☠️ Steal radius: ${WORLD_SETTINGS.stealRadius}m`);
    console.log(`🔄 Respawn times: Discovery(30s), Rare(2m), Portal(3m)`);
});
