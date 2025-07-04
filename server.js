// 🔥 PVP SYSTEM FUNCTIONS

// Load available voices
function loadVoices() {
    availableVoices = speechSynthesis.getVoices();
    console.log('🎤 Available voices:', availableVoices.length);
    
    // Filter out system voices and keep interesting ones
    availableVoices = availableVoices.filter(voice => {
        return voice.lang.startsWith('en') || 
               voice.lang.includes('fr') || 
               voice.lang.includes('de') || 
               voice.lang.includes('it') || 
               voice.lang.includes('es') ||
               voice.lang.includes('ja') ||
               voice.lang.includes('ru');
    });
    
    console.log('🎤 Filtered voices:', availableVoices.length);
}

// Initialize voices
speechSynthesis.onvoiceschanged = loadVoices;
loadVoices();

function speakChatMessage(playerName, message) {
    if (!chatTTSEnabled || !speechSynthesis || availableVoices.length === 0) return;
    if (playerName === 'System' || playerName === 'You') return;
    
    const utterance = new SpeechSynthesisUtterance(message);
    const randomVoice = availableVoices[Math.floor(Math.random() * availableVoices.length)];
    utterance.voice = randomVoice;
    
    utterance.pitch = 0.6 + Math.random() * 0.8;
    utterance.rate = 0.7 + Math.random() * 0.6;
    utterance.volume = 0.6 + Math.random() * 0.3;
    
    if (Math.random() < 0.1) {
        utterance.pitch = 0.3 + Math.random() * 1.4;
        utterance.rate = 0.5 + Math.random() * 1.0;
    }
    
    const notificationText = `🎤 ${playerName} (${randomVoice.name.split(' ')[0]})`;
    showNotification(notificationText, 2000);
    
    utterance.onerror = (event) => console.warn('🎤 Speech error:', event.error);
    utterance.onstart = () => console.log(`🎤 Speaking: "${message}" in ${randomVoice.name} voice`);
    
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
}

function toggleChatTTS() {
    chatTTSEnabled = !chatTTSEnabled;
    if (chatTTSEnabled) {
        showNotification('🎤 Chat voice enabled!', 2000);
        addChatMessage('System', 'Chat voice enabled! Messages will be spoken aloud.');
    } else {
        showNotification('🔇 Chat voice disabled', 2000);
        addChatMessage('System', 'Chat voice disabled.');
        speechSynthesis.cancel();
    }
}

// ⚡ SPEED BOOST SYSTEM
function triggerItemSpeedBoost() {
    console.log('⚡ Item speed boost triggered!');
    speedBoostEndTime = Date.now() + SPEED_SETTINGS.boostDuration;
    
    // Visual feedback
    showNotification('⚡ SPEED BOOST!', 1000);
    
    // Sound feedback
    playSpeedBoostSound();
}

function updateSpeedMultiplier() {
    const now = Date.now();
    
    // Base speed from score (continuous bonus)
    const scoreBonus = Math.min(score * SPEED_SETTINGS.scoreSpeedBonus, SPEED_SETTINGS.maxScoreSpeed - SPEED_SETTINGS.baseSpeed);
    
    // Temporary item boost
    let itemBoost = 0;
    if (now < speedBoostEndTime) {
        const remaining = (speedBoostEndTime - now) / SPEED_SETTINGS.boostDuration;
        itemBoost = (SPEED_SETTINGS.boostSpeed - SPEED_SETTINGS.baseSpeed) * remaining;
    }
    
    currentSpeedMultiplier = SPEED_SETTINGS.baseSpeed + scoreBonus + itemBoost;
    
    // Update HUD with speed info
    updateSpeedDisplay();
}

function updateSpeedDisplay() {
    // Add speed indicator to HUD (we'll update the HUD display later)
    const speedPercent = Math.round((currentSpeedMultiplier / SPEED_SETTINGS.baseSpeed - 1) * 100);
    if (speedPercent > 0) {
        document.getElementById('speed-indicator').textContent = `+${speedPercent}% Speed`;
        document.getElementById('speed-indicator').style.display = 'block';
    } else {
        document.getElementById('speed-indicator').style.display = 'none';
    }
}

// 💀 PROXIMITY KILL SYSTEM
function checkProximityKill() {
    if (!otherPlayers || otherPlayers.size === 0) {
        if (isInProximityDanger) {
            stopProximityKill();
        }
        return;
    }
    
    let nearestPlayer = null;
    let nearestDistance = Infinity;
    
    // Find nearest player within kill range
    for (const [id, playerObj] of otherPlayers) {
        const distance = new THREE.Vector3(player.x, player.y, player.z).distanceTo(playerObj.mesh.position);
        if (distance < 30 && distance < nearestDistance) { // 30 unit proximity kill range
            nearestDistance = distance;
            nearestPlayer = playerObj;
        }
    }
    
    if (nearestPlayer && !isInProximityDanger) {
        startProximityKill(nearestPlayer);
    } else if (!nearestPlayer && isInProximityDanger) {
        stopProximityKill();
    } else if (nearestPlayer && isInProximityDanger) {
        updateProximityKill(nearestPlayer, nearestDistance);
    }
}

function startProximityKill(targetPlayer) {
    console.log('💀 Proximity kill started with', targetPlayer.data.name);
    isInProximityDanger = true;
    proximityTarget = targetPlayer;
    proximityKillStartTime = Date.now();
    
    // Start countdown timer
    proximityKillTimer = setTimeout(() => {
        executeProximityKill();
    }, SPEED_SETTINGS.proximityKillTime);
    
    // Start ominous sound
    startProximityWarningSound();
    
    // Visual feedback
    showProximityCountdown();
    
    // Chat notification
    addChatMessage('System', `💀 PROXIMITY DANGER: ${targetPlayer.data.name} nearby! 6 seconds to escape!`);
}

function stopProximityKill() {
    console.log('✅ Proximity kill stopped - players separated');
    isInProximityDanger = false;
    proximityTarget = null;
    
    if (proximityKillTimer) {
        clearTimeout(proximityKillTimer);
        proximityKillTimer = null;
    }
    
    stopProximityWarningSound();
    hideProximityCountdown();
    
    addChatMessage('System', '✅ Safe distance restored');
}

function updateProximityKill(targetPlayer, distance) {
    // Update countdown display
    const elapsed = Date.now() - proximityKillStartTime;
    const remaining = Math.max(0, SPEED_SETTINGS.proximityKillTime - elapsed);
    const seconds = Math.ceil(remaining / 1000);
    
    updateProximityCountdownDisplay(seconds, targetPlayer.data.name, Math.round(distance));
}

function executeProximityKill() {
    if (!proximityTarget) return;
    
    console.log('💀 Executing proximity kill!');
    
    // Determine who dies based on radiation level
    const myRadiation = radiationLevel;
    const theirRadiation = proximityTarget.data.radiationLevel || 0;
    
    if (myRadiation >= theirRadiation) {
        // I die
        triggerProximityDeath(proximityTarget.data.name);
    } else {
        // They die (we just show notification)
        showNotification(`💀 ${proximityTarget.data.name} died from proximity radiation!`, 5000);
        addChatMessage('System', `💀 ${proximityTarget.data.name} succumbed to radiation exposure`);
        playVictorySound();
    }
    
    stopProximityKill();
}

function triggerProximityDeath(killerName) {
    gameStarted = false;
    
    // Calculate final score
    const finalSurvivalScore = Math.floor(survivalTime / 1000) * POINTS.survivalBonus;
    score = discoveries * POINTS.discovery + 
           rareItems * POINTS.rareEntity + 
           creaturesFound * POINTS.spaceCreature + 
           finalSurvivalScore;
    
    // Save score
    saveScore();
    
    // Show death screen with killer info
    document.getElementById('finalScore').textContent = score;
    document.getElementById('finalDiscoveries').textContent = discoveries;
    document.getElementById('finalRare').textContent = rareItems;
    document.getElementById('finalCreatures').textContent = creaturesFound;
    
    // Update death title
    document.querySelector('.death-title').textContent = 'PROXIMITY KILL';
    document.querySelector('.death-title').style.color = '#ff6b00';
    
    // Add killer info
    const deathScreen = document.getElementById('deathScreen');
    const killerInfo = document.createElement('div');
    killerInfo.innerHTML = `<h2 style="color: #ff6b00; margin: 20px 0;">Killed by: ${killerName}</h2>`;
    deathScreen.insertBefore(killerInfo, deathScreen.querySelector('.current-score'));
    
    playDeathSound();
    document.getElementById('deathScreen').style.display = 'flex';
    
    // Notify chat
    if (socket && socket.connected) {
        addChatMessage('System', `💀 You were killed by ${killerName} in proximity combat!`);
    }
}

// 🔊 PROXIMITY SOUND SYSTEM
function startProximityWarningSound() {
    if (!audioContext) return;
    
    try {
        // Create ominous heartbeat-like sound
        const createHeartbeat = () => {
            const osc = audioContext.createOscillator();
            const gain = audioContext.createGain();
            const filter = audioContext.createBiquadFilter();
            
            osc.frequency.setValueAtTime(40, audioContext.currentTime);
            osc.type = 'sine';
            
            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(200, audioContext.currentTime);
            
            gain.gain.setValueAtTime(0, audioContext.currentTime);
            gain.gain.linearRampToValueAtTime(0.3, audioContext.currentTime + 0.1);
            gain.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.8);
            
            osc.connect(filter);
            filter.connect(gain);
            gain.connect(masterGain);
            
            osc.start();
            osc.stop(audioContext.currentTime + 0.8);
        };
        
        // Create recurring heartbeat
        proximityWarningSound = setInterval(createHeartbeat, 1000); // Every second
        createHeartbeat(); // Start immediately
        
    } catch (e) {
        console.warn('Proximity sound error:', e);
    }
}

function stopProximityWarningSound() {
    if (proximityWarningSound) {
        clearInterval(proximityWarningSound);
        proximityWarningSound = null;
    }
}

function playSpeedBoostSound() {
    if (!audioContext) return;
    
    try {
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        
        osc.frequency.setValueAtTime(440, audioContext.currentTime);
        osc.frequency.exponentialRampToValueAtTime(880, audioContext.currentTime + 0.3);
        osc.type = 'triangle';
        
        gain.gain.setValueAtTime(0, audioContext.currentTime);
        gain.gain.linearRampToValueAtTime(0.2, audioContext.currentTime + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
        
        osc.connect(gain);
        gain.connect(masterGain);
        
        osc.start();
        osc.stop(audioContext.currentTime + 0.5);
    } catch (e) {
        console.warn('Speed boost sound error:', e);
    }
}

function playVictorySound() {
    if (!audioContext) return;
    
    try {
        const frequencies = [523, 659, 784, 1047]; // C, E, G, C
        frequencies.forEach((freq, i) => {
            setTimeout(() => {
                const osc = audioContext.createOscillator();
                const gain = audioContext.createGain();
                
                osc.frequency.setValueAtTime(freq, audioContext.currentTime);
                osc.type = 'triangle';
                
                gain.gain.setValueAtTime(0, audioContext.currentTime);
                gain.gain.linearRampToValueAtTime(0.15, audioContext.currentTime + 0.1);
                gain.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.6);
                
                osc.connect(gain);
                gain.connect(masterGain);
                
                osc.start();
                osc.stop(audioContext.currentTime + 0.6);
            }, i * 150);
        });
    } catch (e) {
        console.warn('Victory sound error:', e);
    }
}

// 🎯 PLAYER TRACKING SYSTEM
function createPlayerDirectionIndicators() {
    // Create indicators at screen edges pointing to other players
    const indicators = document.getElementById('player-indicators');
    if (!indicators) {
        const indicatorContainer = document.createElement('div');
        indicatorContainer.id = 'player-indicators';
        indicatorContainer.style.cssText = `
            position: fixed;
            top: 0; left: 0; width: 100%; height: 100%;
            pointer-events: none; z-index: 90;
        `;
        document.body.appendChild(indicatorContainer);
    }
}

function updatePlayerDirectionIndicators() {
    const container = document.getElementById('player-indicators');
    if (!container) return;
    
    // Clear existing indicators
    container.innerHTML = '';
    
    // Create indicators for each other player
    for (const [id, playerObj] of otherPlayers) {
        const playerPos = playerObj.mesh.position;
        const myPos = new THREE.Vector3(player.x, player.y, player.z);
        const distance = myPos.distanceTo(playerPos);
        
        // Calculate direction vector
        const direction = new THREE.Vector3().subVectors(playerPos, myPos).normalize();
        
        // Convert to screen coordinates
        const screenPos = worldToScreen(playerPos);
        
        // If player is off-screen, create edge indicator
        if (screenPos.x < 0 || screenPos.x > window.innerWidth || 
            screenPos.y < 0 || screenPos.y > window.innerHeight) {
            
            createEdgeIndicator(container, direction, playerObj.data, distance);
        }
    }
}

function worldToScreen(worldPos) {
    const vector = worldPos.clone();
    vector.project(camera);
    
    const x = (vector.x * 0.5 + 0.5) * window.innerWidth;
    const y = (vector.y * -0.5 + 0.5) * window.innerHeight;
    
    return { x, y };
}

function createEdgeIndicator(container, direction, playerData, distance) {
    const indicator = document.createElement('div');
    
    // Calculate edge position
    const margin = 50;
    let x, y;
    
    if (Math.abs(direction.x) > Math.abs(direction.z)) {
        // Place on left/right edge
        x = direction.x > 0 ? window.innerWidth - margin : margin;
        y = window.innerHeight / 2 + direction.z * (window.innerHeight / 4);
    } else {
        // Place on top/bottom edge
        y = direction.z > 0 ? window.innerHeight - margin : margin;
        x = window.innerWidth / 2 + direction.x * (window.innerWidth / 4);
    }
    
    // Clamp to screen bounds
    x = Math.max(margin, Math.min(window.innerWidth - margin, x));
    y = Math.max(margin, Math.min(window.innerHeight - margin, y));
    
    // Calculate rotation angle
    const angle = Math.atan2(direction.z, direction.x) * 180 / Math.PI;
    
    indicator.style.cssText = `
        position: absolute;
        left: ${x}px;
        top: ${y}px;
        width: 40px;
        height: 40px;
        background: linear-gradient(45deg, #${playerData.color.toString(16).padStart(6, '0')}, #ffffff);
        border: 2px solid #ffffff;
        border-radius: 50%;
        transform: translate(-50%, -50%) rotate(${angle}deg);
        box-shadow: 0 0 10px rgba(255,255,255,0.5);
        z-index: 91;
    `;
    
    // Add arrow pointer
    const arrow = document.createElement('div');
    arrow.style.cssText = `
        position: absolute;
        right: -5px;
        top: 50%;
        width: 0;
        height: 0;
        border-left: 8px solid #ffffff;
        border-top: 5px solid transparent;
        border-bottom: 5px solid transparent;
        transform: translateY(-50%);
    `;
    indicator.appendChild(arrow);
    
    // Add distance text
    const distanceText = document.createElement('div');
    distanceText.textContent = Math.round(distance) + 'm';
    distanceText.style.cssText = `
        position: absolute;
        top: -25px;
        left: 50%;
        transform: translateX(-50%);
        color: #ffffff;
        font-size: 12px;
        font-weight: bold;
        text-shadow: 0 0 4px rgba(0,0,0,0.8);
        white-space: nowrap;
    `;
    indicator.appendChild(distanceText);
    
    container.appendChild(indicator);
}
