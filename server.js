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
    proximityKillDistance: 50, // Distance for proximity kill
    proximityKillTime: 6000, // 6 seconds proximity kill timer
};

// 🎯 PVP SYSTEM SETTINGS
const PVP_SETTINGS = {
    baseSpeed: 1.0,
    boostSpeed: 3.5,
    boostDuration: 2000,
    scoreSpeedBonus: 0.005,
    maxScoreSpeed: 2.5,
    radiationKillThreshold: 100,
    speedBoostOnCollection: true
};

// Shared world state - all objects exist on server
let worldObjects = [];
let objectIdCounter = 0;

// Player storage with enhanced PvP features
const players = {};

// Active proximity battles
const proximityBattles = new Map();

// Object types and their properties
const OBJECT_TYPES = {
    discovery: { points: 10, collectRadius: 30, respawnTime: 30000 },
    exploding: { points: 15, collectRadius: 25, respawnTime: 45000 },
    rare: { points: 50, collectRadius: 20, respawnTime: 120000 }, // 2 minutes for rare
    spaceCreature: { points: 25, collectRadius: 35, respawnTime: 60000 },
    ringPortal: { points: 5, collectRadius: 30, respawnTime: 180000 } // 3 minutes for portals
};

// Enhanced Player class with PvP features
class Player {
    constructor(id, socket) {
        this.id = id;
        this.socket = socket;
        this.name = `Player_${id.substring(0, 6)}`;
        this.x = (Math.random() - 0.5) * 100; // Spawn closer together for competition
        this.y = (Math.random() - 0.5) * 100;
        this.z = (Math.random() - 0.5) * 100;
        this.rotationX = 0;
        this.rotationY = 0;
        this.color = Math.floor(Math.random() * 0xffffff);
        this.radiationLevel = 0;
        this.score = 0;
        this.discoveries = 0;
        this.rareItems = 0;
        this.creatures = 0;
        this.lastUpdate = Date.now();
        this.lastBroadcast = 0; // For throttling broadcasts
        this.joinTime = Date.now();
        
        // Competition tracking
        this.resourcesStolen = 0;
        this.resourcesLost = 0;
        this.nearbyPlayers = [];
        
        // 🎯 PVP SYSTEM PROPERTIES
        this.currentSpeedMultiplier = 1.0;
        this.speedBoostEndTime = 0;
        this.lastCollectionTime = 0;
        this.isInProximityDanger = false;
        this.proximityTarget = null;
        this.proximityKillStartTime = 0;
        this.deathCount = 0;
        this.killCount = 0;
        this.isAlive = true;
        this.lastDeathTime = 0;
        this.respawnTime = 5000; // 5 seconds respawn
    }

    update(data) {
        if (!this.isAlive) return; // Dead players can't move
        
        this.x = data.x || this.x;
        this.y = data.y || this.y;
        this.z = data.z || this.z;
        this.rotationX = data.rotationX || this.rotationX;
        this.rotationY = data.rotationY || this.rotationY;
        this.radiationLevel = Math.min(100, (data.radiationLevel || this.radiationLevel));
        this.lastUpdate = Date.now();
        
        // Update speed multiplier based on score and boosts
        this.updateSpeedMultiplier();
        
        // Check radiation death
        if (this.radiationLevel >= PVP_SETTINGS.radiationKillThreshold && this.isAlive) {
            this.triggerRadiationDeath();
        }
    }
    
    updateSpeedMultiplier() {
        const now = Date.now();
        let speedMultiplier = PVP_SETTINGS.baseSpeed;
        
        // Score-based speed bonus
        const scoreBonus = Math.min(
            this.score * PVP_SETTINGS.scoreSpeedBonus,
            PVP_SETTINGS.maxScoreSpeed - PVP_SETTINGS.baseSpeed
        );
        speedMultiplier += scoreBonus;
        
        // Collection boost
        if (now < this.speedBoostEndTime) {
            speedMultiplier = PVP_SETTINGS.boostSpeed;
        }
        
        this.currentSpeedMultiplier = speedMultiplier;
    }
    
    giveSpeedBoost() {
        if (PVP_SETTINGS.speedBoostOnCollection) {
            this.speedBoostEndTime = Date.now() + PVP_SETTINGS.boostDuration;
            this.lastCollectionTime = Date.now();
            console.log(`⚡ ${this.name} got speed boost! (${PVP_SETTINGS.boostSpeed}x for ${PVP_SETTINGS.boostDuration}ms)`);
        }
    }
    
    triggerRadiationDeath() {
        if (!this.isAlive) return;
        
        this.isAlive = false;
        this.deathCount++;
        this.lastDeathTime = Date.now();
        this.radiationLevel = 0; // Reset radiation on death
        
        // Reset position to spawn area
        this.x = (Math.random() - 0.5) * 100;
        this.y = (Math.random() - 0.5) * 100;
        this.z = (Math.random() - 0.5) * 100;
        
        console.log(`💀 ${this.name} died from radiation! Deaths: ${this.deathCount}`);
        
        // Broadcast death
        io.emit('player_death', {
            playerId: this.id,
            playerName: this.name,
            cause: 'radiation',
            deathCount: this.deathCount,
            respawnTime: this.respawnTime
        });
        
        // Schedule respawn
        setTimeout(() => {
            this.respawn();
        }, this.respawnTime);
    }
    
    respawn() {
        this.isAlive = true;
        this.radiationLevel = 0;
        
        console.log(`🔄 ${this.name} respawned!`);
        
        // Broadcast respawn
        io.emit('player_respawn', {
            playerId: this.id,
            playerName: this.name,
            x: this.x,
            y: this.y,
            z: this.z
        });
        
        // Send updated state to player
        this.socket.emit('respawn_complete', {
            x: this.x,
            y: this.y,
            z: this.z,
            radiationLevel: this.radiationLevel
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
            score: this.score,
            discoveries: this.discoveries,
            rareItems: this.rareItems,
            creatures: this.creatures,
            resourcesStolen: this.resourcesStolen,
            resourcesLost: this.resourcesLost,
            currentSpeedMultiplier: this.currentSpeedMultiplier,
            isAlive: this.isAlive,
            deathCount: this.deathCount,
            killCount: this.killCount
        };
    }
}

// World object class with enhanced properties
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
            this.fleeSpeed = 0.7 + Math.random() * 0.2; // 🔧 Slower flee speed (0.7-0.9 vs player 1.0-2.0)
            this.detectionRange = 80 + Math.random() * 40;
            this.fleeing = false;
            this.fleeDirection = { x: 0, y: 0, z: 0 };
            this.lastTrajectoryUpdate = Date.now();
        } else if (type === 'rare') {
            this.fleeSpeed = 0.6; // 🔧 Rare entities also slower
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

// Get nearby players for competition and PvP
function getNearbyPlayers(excludeId, x, y, z, range = 1000) {
    const nearby = [];
    const excludedPlayerName = players[excludeId] ? players[excludeId].name : 'unknown';
    
    for (const [id, player] of Object.entries(players)) {
        if (id === excludeId || !player.isAlive) continue;
        
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

// 🎯 NEW: Check and handle proximity battles
function checkProximityBattles() {
    const activeBattles = new Map();
    
    for (const [playerId, player] of Object.entries(players)) {
        if (!player.isAlive) continue;
        
        // Find nearby players within proximity kill distance
        const nearbyEnemies = [];
        for (const [otherId, otherPlayer] of Object.entries(players)) {
            if (otherId === playerId || !otherPlayer.isAlive) continue;
            
            const distance = Math.sqrt(
                Math.pow(player.x - otherPlayer.x, 2) +
                Math.pow(player.y - otherPlayer.y, 2) +
                Math.pow(player.z - otherPlayer.z, 2)
            );
            
            if (distance <= WORLD_SETTINGS.proximityKillDistance) {
                nearbyEnemies.push({ player: otherPlayer, distance });
            }
        }
        
        if (nearbyEnemies.length > 0) {
            // Sort by radiation level (highest radiation dies first)
            nearbyEnemies.push({ player, distance: 0 });
            nearbyEnemies.sort((a, b) => b.player.radiationLevel - a.player.radiationLevel);
            
            const battleKey = nearbyEnemies.map(e => e.player.id).sort().join('-');
            
            if (!proximityBattles.has(battleKey)) {
                // Start new proximity battle
                proximityBattles.set(battleKey, {
                    startTime: Date.now(),
                    players: nearbyEnemies.map(e => e.player),
                    highestRadiationPlayer: nearbyEnemies[0].player
                });
                
                console.log(`⚔️ Proximity battle started: ${nearbyEnemies.map(e => e.player.name).join(' vs ')}`);
                
                // Notify all players in battle
                nearbyEnemies.forEach(enemy => {
                    enemy.player.socket.emit('proximity_battle_start', {
                        battleId: battleKey,
                        players: nearbyEnemies.map(e => ({
                            id: e.player.id,
                            name: e.player.name,
                            radiationLevel: e.player.radiationLevel,
                            distance: e.distance
                        })),
                        timeLimit: WORLD_SETTINGS.proximityKillTime,
                        highestRadiation: nearbyEnemies[0].player.radiationLevel
                    });
                });
            }
            
            activeBattles.set(battleKey, proximityBattles.get(battleKey));
        }
    }
    
    // Check for battles that should end
    for (const [battleKey, battle] of proximityBattles) {
        if (!activeBattles.has(battleKey)) {
            // Battle ended - players moved apart
            console.log(`🏃 Proximity battle ended: players separated`);
            
            battle.players.forEach(player => {
                if (player.socket) {
                    player.socket.emit('proximity_battle_end', {
                        battleId: battleKey,
                        reason: 'separated'
                    });
                }
            });
            
            proximityBattles.delete(battleKey);
        } else if (Date.now() - battle.startTime >= WORLD_SETTINGS.proximityKillTime) {
            // Battle timeout - kill highest radiation player
            const victim = battle.highestRadiationPlayer;
            
            if (victim.isAlive) {
                console.log(`💀 Proximity kill: ${victim.name} died from proximity with higher radiation!`);
                
                victim.triggerRadiationDeath();
                
                // Award kill credit to other players
                battle.players.forEach(player => {
                    if (player.id !== victim.id && player.isAlive) {
                        player.killCount++;
                        player.addScore(25, 'proximity kill');
                    }
                });
                
                // Broadcast proximity kill
                io.emit('proximity_kill', {
                    victimId: victim.id,
                    victimName: victim.name,
                    battlePlayers: battle.players.map(p => p.name),
                    radiationLevel: victim.radiationLevel
                });
            }
            
            proximityBattles.delete(battleKey);
        }
    }
}

// Handle resource collection with enhanced competition
function handleResourceCollection(playerId, objectId) {
    const player = players[playerId];
    const obj = worldObjects.find(o => o.id === objectId);
    
    if (!player || !player.isAlive || !obj || !obj.available) {
        return { success: false, reason: 'Object not available or player dead' };
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
        if (id === playerId || !otherPlayer.isAlive) continue;
        
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
            thief.giveSpeedBoost(); // Give speed boost for successful theft
            
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
                thiefId: thief.id,
                victim: player.name,
                victimId: player.id,
                points: points,
                position: { x: obj.x, y: obj.y, z: obj.z },
                speedBoost: true
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
    player.giveSpeedBoost(); // Give speed boost for collection
    
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
        
        // Portals are consumed when used - mark as collected
        obj.available = false;
        obj.collectedBy = playerId;
        obj.collectedAt = Date.now();
    }

    // Broadcast the collection
    io.emit('resource_collected', {
        objectId: obj.id,
        objectType: obj.type,
        collector: player.name,
        collectorId: player.id,
        points: points,
        radiationReduction: radiationReduction,
        position: { x: obj.x, y: obj.y, z: obj.z },
        competitorCount: competingPlayers.length,
        speedBoost: true
    });

    console.log(`✅ ${player.name} collected ${obj.type} (+${points} points)${competingPlayers.length > 0 ? ` despite ${competingPlayers.length} competitors nearby!` : ''}`);
    
    return { 
        success: true, 
        points: points,
        radiationReduction: radiationReduction,
        competitorCount: competingPlayers.length,
        speedBoost: true
    };
}

// Broadcast world state to all players with enhanced info
function broadcastWorldState() {
    console.log(`📡 Broadcasting world state to ${Object.keys(players).length} players`);
    
    for (const [playerId, player] of Object.entries(players)) {
        if (!player.isAlive) continue; // Don't send updates to dead players
        
        const nearbyPlayers = getNearbyPlayers(playerId, player.x, player.y, player.z);
        const nearbyObjects = getNearbyObjects(playerId, player.x, player.y, player.z);
        
        player.socket.emit('game_state', {
            players: nearbyPlayers,
            objects: nearbyObjects,
            totalPlayers: Object.keys(players).length,
            yourStats: {
                score: player.score,
                discoveries: player.discoveries,
                rareItems: player.rareItems,
                creatures: player.creatures,
                radiationLevel: player.radiationLevel,
                resourcesStolen: player.resourcesStolen,
                resourcesLost: player.resourcesLost,
                currentSpeedMultiplier: player.currentSpeedMultiplier,
                speedBoostEndTime: player.speedBoostEndTime,
                isAlive: player.isAlive,
                deathCount: player.deathCount,
                killCount: player.killCount
            }
        });
    }
}

// Socket.IO connection handling with enhanced features
io.on('connection', (socket) => {
    console.log(`🟢 Player connected: ${socket.id}`);
    
    // Create new player
    const player = new Player(socket.id, socket);
    players[socket.id] = player;
    
    console.log(`👤 ${player.name} joined at (${Math.round(player.x)}, ${Math.round(player.y)}, ${Math.round(player.z)})`);
    console.log(`👥 Total players: ${Object.keys(players).length}`);
    
    // Send initial player data with PvP settings
    socket.emit('player_init', {
        id: player.id,
        name: player.name,
        x: player.x,
        y: player.y,
        z: player.z,
        color: player.color,
        pvpSettings: PVP_SETTINGS,
        worldSettings: WORLD_SETTINGS
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
    
    // Handle player movement and state updates with enhanced data
    socket.on('player_update', (data) => {
        const player = players[socket.id];
        if (!player) return;
        
        player.update(data);
        
        // More frequent world state updates for better PvP sync
        if (!player.lastBroadcast || Date.now() - player.lastBroadcast > 150) {
            const nearbyPlayers = getNearbyPlayers(socket.id, player.x, player.y, player.z);
            const nearbyObjects = getNearbyObjects(socket.id, player.x, player.y, player.z);
            
            // Send enhanced game state
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
                    resourcesStolen: player.resourcesStolen,
                    resourcesLost: player.resourcesLost,
                    currentSpeedMultiplier: player.currentSpeedMultiplier,
                    speedBoostEndTime: player.speedBoostEndTime,
                    isAlive: player.isAlive,
                    deathCount: player.deathCount,
                    killCount: player.killCount
                }
            });
            
            player.lastBroadcast = Date.now();
        }
    });
    
    // Handle resource collection attempts with enhanced features
    socket.on('collect_resource', (data) => {
        const player = players[socket.id];
        const obj = worldObjects.find(o => o.id === data.objectId);
        
        if (!player || !player.isAlive || !obj) {
            console.log(`❌ Collection failed: ${!player ? 'No player' : !player.isAlive ? 'Player dead' : 'No object'}`);
            return;
        }
        
        console.log(`🎯 ${player.name} attempting to collect ${obj.type} (ID: ${data.objectId})`);
        
        // Enhanced collection processing
        const result = handleResourceCollection(socket.id, data.objectId);
        
        if (result.success) {
            console.log(`✅ ${player.name} successfully collected ${obj.type} with speed boost`);
            
            // Broadcast removal to all players immediately
            io.emit('object_removed', {
                objectId: data.objectId,
                objectType: obj.type,
                collectedBy: player.name,
                collectorId: socket.id,
                points: result.points,
                speedBoost: result.speedBoost,
                timestamp: Date.now()
            });
            
            // Send success confirmation to collector
            socket.emit('collection_result', { 
                success: true, 
                points: result.points,
                competitorCount: result.competitorCount,
                speedBoost: result.speedBoost,
                radiationReduction: result.radiationReduction,
                message: result.competitorCount > 0 ? `Beat ${result.competitorCount} competitors!` : 'Resource collected!'
            });
            
        } else if (result.reason === 'stolen') {
            console.log(`🏴‍☠️ ${player.name}'s collection was stolen by ${result.stolenBy}`);
            socket.emit('collection_result', result);
        }
        
        // Broadcast updated world state after collection
        setTimeout(() => {
            broadcastWorldState();
        }, 100);
    });
    
    // Handle creature trajectory updates from clients
    socket.on('creature_trajectory', (data) => {
        const obj = worldObjects.find(o => o.id === data.objectId);
        const player = players[socket.id];
        
        if (obj && player && player.isAlive && obj.available) {
            // Update creature position on server with trajectory
            obj.x = data.startPosition.x;
            obj.y = data.startPosition.y;
            obj.z = data.startPosition.z;
            obj.fleeing = data.fleeing;
            obj.fleeDirection = data.fleeDirection;
            obj.lastTrajectoryUpdate = data.timestamp;
            
            // Broadcast trajectory to other nearby players
            const nearbyPlayers = getNearbyPlayers(socket.id, player.x, player.y, player.z, 800);
            nearbyPlayers.forEach(nearbyPlayer => {
                const targetPlayer = players[nearbyPlayer.id];
                if (targetPlayer && targetPlayer.socket && targetPlayer.isAlive) {
                    targetPlayer.socket.emit('creature_trajectory', {
                        objectId: data.objectId,
                        startPosition: data.startPosition,
                        fleeDirection: data.fleeDirection,
                        fleeSpeed: data.fleeSpeed,
                        timestamp: data.timestamp,
                        fleeing: data.fleeing
                    });
                }
            });
            
            console.log(`🎯 ${obj.type} ${obj.id} trajectory updated by ${player.name} - broadcast to ${nearbyPlayers.length} players`);
        }
    });
    
    // 🎯 NEW: Handle speed boost requests
    socket.on('request_speed_boost', (data) => {
        const player = players[socket.id];
        if (!player || !player.isAlive) return;
        
        if (data.reason === 'collection' && Date.now() - player.lastCollectionTime < 5000) {
            player.giveSpeedBoost();
            socket.emit('speed_boost_granted', {
                multiplier: PVP_SETTINGS.boostSpeed,
                duration: PVP_SETTINGS.boostDuration,
                reason: data.reason
            });
        }
    });
    
    // 🎯 NEW: Handle proximity danger updates
    socket.on('proximity_danger_update', (data) => {
        const player = players[socket.id];
        if (!player || !player.isAlive) return;
        
        player.isInProximityDanger = data.inDanger;
        player.proximityTarget = data.targetPlayer;
        
        console.log(`⚔️ ${player.name} proximity danger: ${data.inDanger} (target: ${data.targetPlayer})`);
    });
    
    // Handle chat messages with enhanced features
    socket.on('chat_message', (data) => {
        const player = players[socket.id];
        if (!player || !data.message) return;
        
        // Add player status to chat message
        const playerStatus = player.isAlive ? '' : ' 💀';
        const speedIndicator = player.currentSpeedMultiplier > 1.2 ? ' ⚡' : '';
        
        console.log(`💬 ${player.name}${playerStatus}${speedIndicator}: "${data.message}"`);
        
        // Broadcast enhanced chat message
        io.emit('chat_message', {
            playerId: player.id,
            playerName: player.name + playerStatus + speedIndicator,
            message: data.message,
            timestamp: Date.now(),
            playerStats: {
                score: player.score,
                isAlive: player.isAlive,
                speedMultiplier: player.currentSpeedMultiplier
            }
        });
    });
    
    // Handle disconnect
    socket.on('disconnect', () => {
        const player = players[socket.id];
        console.log(`🔴 Player disconnected: ${socket.id}`);
        
        if (player) {
            console.log(`👋 ${player.name} left the game (Score: ${player.score}, Deaths: ${player.deathCount})`);
            
            // Remove from any active proximity battles
            for (const [battleKey, battle] of proximityBattles) {
                if (battle.players.some(p => p.id === socket.id)) {
                    console.log(`⚔️ Removing ${player.name} from proximity battle`);
                    battle.players = battle.players.filter(p => p.id !== socket.id);
                    
                    if (battle.players.length < 2) {
                        // End battle if not enough players
                        battle.players.forEach(p => {
                            if (p.socket) {
                                p.socket.emit('proximity_battle_end', {
                                    battleId: battleKey,
                                    reason: 'player_disconnected'
                                });
                            }
                        });
                        proximityBattles.delete(battleKey);
                    }
                }
            }
            
            // Broadcast enhanced leave message
            socket.broadcast.emit('player_left', {
                name: player.name,
                finalScore: player.score,
                deaths: player.deathCount,
                kills: player.killCount,
                totalPlayers: Object.keys(players).length - 1
            });
            
            delete players[socket.id];
        }
        
        console.log(`👥 Total players: ${Object.keys(players).length}`);
    });
});

// Enhanced world management loop
setInterval(() => {
    let respawnCount = 0;
    
    // Check for object respawns
    worldObjects.forEach(obj => {
        if (obj.checkRespawn()) {
            respawnCount++;
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
    
    // 🎯 NEW: Check proximity battles
    if (Object.keys(players).length > 1) {
        checkProximityBattles();
    }
    
}, 5000); // Check every 5 seconds

// Enhanced leaderboard with PvP stats
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
            deathCount: player.deathCount,
            killCount: player.killCount,
            currentSpeedMultiplier: Math.round(player.currentSpeedMultiplier * 100),
            isAlive: player.isAlive,
            survivalTime: Math.floor((Date.now() - player.joinTime) / 1000)
        }));
    
    return sortedPlayers;
}

// Enhanced leaderboard updates with PvP stats
setInterval(() => {
    if (Object.keys(players).length > 0) {
        const leaderboard = getLeaderboard();
        const battleStats = {
            activeBattles: proximityBattles.size,
            totalDeaths: Object.values(players).reduce((sum, p) => sum + p.deathCount, 0),
            totalKills: Object.values(players).reduce((sum, p) => sum + p.killCount, 0),
            averageRadiation: Math.round(Object.values(players).reduce((sum, p) => sum + p.radiationLevel, 0) / Object.keys(players).length)
        };
        
        io.emit('leaderboard_update', { 
            leaderboard,
            battleStats,
            serverStats: {
                uptime: Math.floor(process.uptime()),
                objectsRespawned: worldObjects.filter(o => !o.available).length,
                totalObjects: worldObjects.length
            }
        });
    }
}, 30000); // Every 30 seconds

// 🎯 NEW: Radiation damage loop - gradually increase radiation for all alive players
setInterval(() => {
    const radiationIncrement = 0.5; // 0.5% radiation every 2 seconds
    
    for (const [id, player] of Object.entries(players)) {
        if (player.isAlive) {
            player.radiationLevel = Math.min(100, player.radiationLevel + radiationIncrement);
            
            // Broadcast radiation warning at certain thresholds
            if (player.radiationLevel >= 80 && player.radiationLevel < 80.5) {
                player.socket.emit('radiation_warning', {
                    level: 'critical',
                    currentRadiation: player.radiationLevel,
                    message: 'CRITICAL RADIATION LEVELS!'
                });
            } else if (player.radiationLevel >= 60 && player.radiationLevel < 60.5) {
                player.socket.emit('radiation_warning', {
                    level: 'high',
                    currentRadiation: player.radiationLevel,
                    message: 'High radiation detected!'
                });
            }
        }
    }
}, 2000); // Every 2 seconds

// 🎯 NEW: Enhanced speed boost cleanup
setInterval(() => {
    const now = Date.now();
    
    for (const [id, player] of Object.entries(players)) {
        if (now > player.speedBoostEndTime && player.currentSpeedMultiplier > PVP_SETTINGS.baseSpeed + 0.1) {
            player.updateSpeedMultiplier();
            
            // Notify player that speed boost ended
            if (player.socket) {
                player.socket.emit('speed_boost_ended', {
                    newMultiplier: player.currentSpeedMultiplier
                });
            }
        }
    }
}, 1000); // Every second

// Initialize world
generateWorld();

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Enhanced Competitive Ethereal Exploration server running on port ${PORT}`);
    console.log(`🌐 Server ready for competitive multiplayer with PvP features`);
    console.log(`🔧 World settings: ${WORLD_SETTINGS.discoveries + WORLD_SETTINGS.explodingCreatures + WORLD_SETTINGS.rareEntities + WORLD_SETTINGS.spaceCreatures + WORLD_SETTINGS.ringPortals} total objects`);
    console.log(`🏴‍☠️ PvP settings: ${WORLD_SETTINGS.stealRadius}m steal radius, ${WORLD_SETTINGS.proximityKillDistance}m proximity kill distance`);
    console.log(`⚡ Speed system: Base ${PVP_SETTINGS.baseSpeed}x, Boost ${PVP_SETTINGS.boostSpeed}x for ${PVP_SETTINGS.boostDuration}ms`);
    console.log(`🔄 Respawn times: Discovery(30s), Rare(2m), Portal(3m)`);
    console.log(`☢️ Radiation: +0.5% every 2 seconds, death at 100%`);
});
