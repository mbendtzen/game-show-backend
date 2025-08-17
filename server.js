const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
// --- Firebase Setup ---
const admin = require('firebase-admin');

// Parse the service account JSON from environment variable
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

// Initialize Firebase Admin SDK
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.database();
// --- End Firebase Setup ---

const app = express();
const server = http.createServer(app);

// Enable CORS for all routes
app.use(cors({
    origin: true,
    credentials: true
}));

const oneHour = 60 * 60 * 1000; // 1 hour in milliseconds

app.use(express.json());
app.use(express.static('public'));

// WebSocket Server
const wss = new WebSocket.Server({ server });

// Game State Management
const games = new Map(); // gameCode -> gameState
const connections = new Map(); // ws -> connectionInfo

class GameState {
    constructor(gameCode, hostId) {
        this.gameCode = gameCode;
        this.hostId = hostId;
        this.hostConnection = null;
        this.currentGame = 1;
        this.currentRound = 1;
        this.games = [];
        this.teams = new Map();
        this.players = new Map();
        this.buzzedPlayers = [];
        this.scoringEnabled = false;
        this.gameStarted = false;
        this.gameEnded = false;
        this.createdAt = Date.now();
    }

    addPlayer(playerId, playerData) {
        this.players.set(playerId, playerData);
        
        // Add to team
        if (!this.teams.has(playerData.teamName)) {
            this.teams.set(playerData.teamName, {
                name: playerData.teamName,
                members: [],
                totalScore: 0,
                roundScores: [],
                manager: null
            });
        }

        const team = this.teams.get(playerData.teamName);
        
        // Check if player already in team (rejoin case)
        const existingMember = team.members.find(m => m.playerId === playerId);
        if (!existingMember) {
            team.members.push({
                playerId: playerId,
                name: playerData.name,
                isManager: playerData.isManager || team.members.length === 0
            });
        }

        // Set manager if this is first player or explicitly marked as manager
        if (playerData.isManager || !team.manager) {
            team.manager = playerId;
            team.members.forEach(member => {
                member.isManager = member.playerId === playerId;
            });
        }
    }

    removePlayer(playerId) {
        const player = this.players.get(playerId);
        if (player && this.teams.has(player.teamName)) {
            const team = this.teams.get(player.teamName);
            team.members = team.members.filter(m => m.playerId !== playerId);
            
            // If manager left, assign new manager
            if (team.manager === playerId && team.members.length > 0) {
                team.manager = team.members[0].playerId;
                team.members[0].isManager = true;
            }

            // Remove team if empty
            if (team.members.length === 0) {
                this.teams.delete(player.teamName);
            }
        }
        
        this.players.delete(playerId);
        this.buzzedPlayers = this.buzzedPlayers.filter(b => b.playerId !== playerId);
    }

    handleBuzz(playerId) {
        const player = this.players.get(playerId);
        if (!player || !this.gameStarted) return false;

        // Check if player or teammate already buzzed
        const teamHasBuzzed = this.buzzedPlayers.some(b => {
            const buzzedPlayer = this.players.get(b.playerId);
            return buzzedPlayer && buzzedPlayer.teamName === player.teamName;
        });

        if (teamHasBuzzed) return false;

        const buzzData = {
            playerId: playerId,
            playerName: player.name,
            teamName: player.teamName,
            timestamp: Date.now()
        };

        this.buzzedPlayers.push(buzzData);
        return true;
    }

    getTeamsData() {
        const teamsArray = [];
        this.teams.forEach(team => {
            teamsArray.push({
                name: team.name,
                members: team.members,
                totalScore: team.totalScore,
                roundScores: team.roundScores
            });
        });
        return teamsArray;
    }
}

// --- Firebase Helpers ---
// Save game state to Firebase
function saveGameState(gameCode, gameState) {
    try {
        const plainState = {
            gameCode: gameState.gameCode,
            hostId: gameState.hostId,
            currentGame: gameState.currentGame,
            currentRound: gameState.currentRound,
            games: gameState.games,
            teams: Array.from(gameState.teams.values()),
            players: Array.from(gameState.players.entries()),
            buzzedPlayers: gameState.buzzedPlayers,
            scoringEnabled: gameState.scoringEnabled,
            gameStarted: gameState.gameStarted,
            gameEnded: gameState.gameEnded,
            createdAt: gameState.createdAt
        };

plainState.expiresAt = Date.now() + (4 * 60 * 60 * 1000); // expire in 4 hours
return db.ref(`games/${gameCode}`).set(plainState);
    } catch (err) {
        console.error("Error saving game:", err);
    }
}

// Load game state from Firebase
async function loadGameState(gameCode) {
    try {
        const snapshot = await db.ref(`games/${gameCode}`).once('value');
        if (!snapshot.exists()) return null;
const data = snapshot.val();

// Ignore if expired
if (data.expiresAt && Date.now() > data.expiresAt) {
    console.log(`Game ${gameCode} expired, ignoring restore`);
    return null;
}

        // Rebuild GameState object
        const restored = new GameState(data.gameCode, data.hostId);
        restored.currentGame = data.currentGame;
        restored.currentRound = data.currentRound;
        restored.games = data.games || [];
        restored.teams = new Map((data.teams || []).map(team => [team.name, team]));
        restored.players = new Map(data.players || []);
        restored.buzzedPlayers = data.buzzedPlayers || [];
        restored.scoringEnabled = data.scoringEnabled;
        restored.gameStarted = data.gameStarted;
        restored.gameEnded = data.gameEnded;
        restored.createdAt = data.createdAt;

        return restored;
    } catch (err) {
        console.error("Error loading game:", err);
        return null;
    }
}
// --- End Firebase Helpers ---

// Utility Functions
function generateGameCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function broadcast(gameCode, message, excludeConnection = null) {
    const game = games.get(gameCode);
    if (!game) return;

    connections.forEach((connInfo, ws) => {
        if (ws === excludeConnection) return;
        if (connInfo.gameCode === gameCode && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    });
}

function sendToHost(gameCode, message) {
    const game = games.get(gameCode);
    if (game && game.hostConnection && game.hostConnection.readyState === WebSocket.OPEN) {
        game.hostConnection.send(JSON.stringify(message));
    }
}

function sendToPlayer(gameCode, playerId, message) {
    connections.forEach((connInfo, ws) => {
        if (connInfo.gameCode === gameCode && 
            connInfo.playerId === playerId && 
            ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    });
}

// WebSocket Connection Handling
wss.on('connection', (ws) => {
    console.log('New WebSocket connection');
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            handleMessage(ws, message);
        } catch (error) {
            console.error('Error parsing message:', error);
            ws.send(JSON.stringify({
                type: 'ERROR',
                message: 'Invalid message format'
            }));
        }
    });

    ws.on('close', () => {
        handleDisconnection(ws);
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        handleDisconnection(ws);
    });
});

function handleMessage(ws, message) {
    console.log('Received message:', message.type);

    switch (message.type) {
        case 'CREATE_GAME':
            handleCreateGame(ws, message);
            break;

        case 'JOIN_GAME':
            handleJoinGame(ws, message);
            break;

        case 'REJOIN_GAME':
            handleRejoinGame(ws, message);
            break;

        case 'GAME_STARTED':
            handleGameStarted(ws, message);
            break;

        case 'ROUND_UPDATE':
            handleRoundUpdate(ws, message);
            break;

        case 'PLAYER_BUZZ':
            handlePlayerBuzz(ws, message);
            break;

        case 'CLEAR_BUZZERS':
            handleClearBuzzers(ws, message);
            break;

        case 'CLEAR_PLAYER_BUZZ':
            handleClearPlayerBuzz(ws, message);
            break;

        case 'ENABLE_SCORING':
            handleEnableScoring(ws, message);
            break;

        case 'SUBMIT_SCORE':
            handleSubmitScore(ws, message);
            break;

        case 'MANAGER_CHANGED':
            handleManagerChanged(ws, message);
            break;
            
        case 'SCORE_UPDATED':
            handleScoreUpdated(ws, message);
            break;

        case 'REVEAL_FINAL_SCORES':
            handleRevealFinalScores(ws, message);
            break;

        case 'LEAVE_GAME':
            handleLeaveGame(ws, message);
            break;

        case 'PLAYER_DISCONNECT':
            handlePlayerDisconnect(ws, message);
            break;

        case 'GET_TEAMS':
            handleGetTeams(ws, message);
            break;
            
        default:
            ws.send(JSON.stringify({
                type: 'ERROR',
                message: 'Unknown message type'
            }));
    }
}

function handleCreateGame(ws, message) {
    let gameCode = message.gameCode || generateGameCode();
    
    // Ensure unique game code for new games
    while (games.has(gameCode)) {
        gameCode = generateGameCode();
    }

    const gameState = new GameState(gameCode, message.hostId);
    gameState.hostConnection = ws;
    games.set(gameCode, gameState);
        // Save new game to Firebase
    saveGameState(gameCode, gameState);


    connections.set(ws, {
        type: 'host',
        gameCode: gameCode,
        hostId: message.hostId
    });

    ws.send(JSON.stringify({
        type: 'GAME_CREATED',
        gameCode: gameCode,
        restored: false
    }));

    console.log(`Game created: ${gameCode}`);
}

function handleJoinGame(ws, message) {
    const { gameCode, playerId, playerName, teamName, isManager } = message;
    let game = games.get(gameCode);

if (!game) {
    // Try to load from Firebase
    loadGameState(gameCode).then(restored => {
        if (!restored) {
            ws.send(JSON.stringify({
                type: 'ERROR',
                message: 'Game not found'
            }));
            return;
        }
        // Put restored game back into memory
        games.set(gameCode, restored);
        game = restored;

        // Continue normal join process
        finishJoin();
    });
} else {
    finishJoin();
}

function finishJoin() {
    // Add player to game
    game.addPlayer(playerId, {
        name: playerName,
        teamName: teamName,
        isManager: isManager,
        connection: ws
    });

    connections.set(ws, {
        type: 'player',
        gameCode: gameCode,
        playerId: playerId,
        teamName: teamName
    });

    // Confirm join to player
    ws.send(JSON.stringify({
        type: 'GAME_JOINED',
        gameCode: gameCode,
        gameStarted: game.gameStarted,
        currentGame: game.currentGame,
        currentRound: game.currentRound,
        games: game.games,
        teams: game.getTeamsData(),
        buzzedPlayers: game.buzzedPlayers,
        restored: true
    }));

    // Notify host of new player
    sendToHost(gameCode, {
        type: 'PLAYER_JOINED',
        playerId: playerId,
        playerName: playerName,
        teamName: teamName,
        isManager: isManager,
        teams: Array.from(game.teams.values())
    });

    console.log(`Player ${playerName} joined game ${gameCode} on team ${teamName}`);
}


    // Add player to game
    game.addPlayer(playerId, {
        name: playerName,
        teamName: teamName,
        isManager: isManager,
        connection: ws
    });

    connections.set(ws, {
        type: 'player',
        gameCode: gameCode,
        playerId: playerId,
        teamName: teamName
    });

    // Confirm join to player
    ws.send(JSON.stringify({
        type: 'GAME_JOINED',
        gameCode: gameCode,
        gameStarted: game.gameStarted,
        currentGame: game.currentGame,
        currentRound: game.currentRound,
        games: game.games,
        teams: game.getTeamsData(),
        buzzedPlayers: game.buzzedPlayers,
        restored: true
    }));

    // Notify host of new player
    sendToHost(gameCode, {
        type: 'PLAYER_JOINED',
        playerId: playerId,
        playerName: playerName,
        teamName: teamName,
        isManager: isManager,
        teams: Array.from(game.teams.values())
    });

    console.log(`Player ${playerName} joined game ${gameCode} on team ${teamName}`);
}

function handleRejoinGame(ws, message) {
    // Same as join game - server handles rejoins the same way
    handleJoinGame(ws, message);
}

function handleGameStarted(ws, message) {
    const game = games.get(message.gameCode);
    if (!game || connections.get(ws)?.type !== 'host') return;

    game.gameStarted = true;
    game.games = message.games;
    game.currentGame = message.currentGame;
    game.currentRound = message.currentRound;
  
    broadcast(message.gameCode, {
        type: 'GAME_STARTED',
        games: message.games,
        currentGame: message.currentGame,
        currentRound: message.currentRound
    }, ws);

    console.log(`Game ${message.gameCode} started`);
}

function handleRoundUpdate(ws, message) {
    const game = games.get(message.gameCode);
    if (!game || connections.get(ws)?.type !== 'host') return;

    game.currentGame = message.currentGame;
    game.currentRound = message.currentRound;
    game.scoringEnabled = false;
  
    broadcast(message.gameCode, {
        type: 'ROUND_UPDATE',
        currentGame: message.currentGame,
        currentRound: message.currentRound
    }, ws);

    console.log(`Game ${message.gameCode} updated to Game ${message.currentGame}, Round ${message.currentRound}`);
}

function handlePlayerBuzz(ws, message) {
    const { gameCode, playerId, playerName, teamName } = message;
    const game = games.get(gameCode);
    
    if (!game) {
        ws.send(JSON.stringify({
            type: 'BUZZ_RESPONSE',
            success: false,
            reason: 'Game not found'
        }));
        return;
    }

    const success = game.handleBuzz(playerId);
    
    // Send response to buzzing player
    ws.send(JSON.stringify({
        type: 'BUZZ_RESPONSE',
        playerId: playerId,
        success: success,
        reason: success ? 'Buzzed in!' : 'Team already buzzed or game not started'
    }));

    if (success) {
        // Notify host
        sendToHost(gameCode, {
            type: 'PLAYER_BUZZED',
            playerId: playerId,
            playerName: playerName,
            teamName: teamName,
            timestamp: Date.now()
        });

        // Lock out other team members
        connections.forEach((connInfo, playerWs) => {
            if (connInfo.gameCode === gameCode && 
                connInfo.type === 'player' && 
                connInfo.teamName === teamName &&
                connInfo.playerId !== playerId) {
                playerWs.send(JSON.stringify({
                    type: 'BUZZ_RESPONSE',
                    playerId: connInfo.playerId,
                    success: false,
                    reason: 'Your teammate beat you to it!'
                }));
            }
        });
    }
}

function handleClearBuzzers(ws, message) {
    const game = games.get(message.gameCode);
    if (!game || connections.get(ws)?.type !== 'host') return;

    game.buzzedPlayers = [];

    broadcast(message.gameCode, {
        type: 'CLEAR_BUZZERS'
    }, ws);

    console.log(`Buzzers cleared for game ${message.gameCode}`);
}

function handleClearPlayerBuzz(ws, message) {
    const game = games.get(message.gameCode);
    if (!game || connections.get(ws)?.type !== 'host') return;
    
    const { playerId } = message;
    
    // Find and remove the specific player from buzzed list
    const buzzIndex = game.buzzedPlayers.findIndex(buzz => buzz.playerId === playerId);
    if (buzzIndex !== -1) {
        const clearedBuzz = game.buzzedPlayers.splice(buzzIndex, 1)[0];
      
        // Re-enable buzzer for cleared player's team
        connections.forEach((connInfo, playerWs) => {
            if (connInfo.gameCode === message.gameCode && 
                connInfo.type === 'player' && 
                connInfo.teamName === clearedBuzz.teamName) {
                playerWs.send(JSON.stringify({
                    type: 'CLEAR_BUZZERS'
                }));
            }
        });
        
        console.log(`Cleared buzz for player ${playerId} in game ${message.gameCode}`);
    }
}

function handleEnableScoring(ws, message) {
    const game = games.get(message.gameCode);
    if (!game || connections.get(ws)?.type !== 'host') return;

    game.scoringEnabled = true;

    broadcast(message.gameCode, {
        type: 'ENABLE_SCORING'
    }, ws);

    console.log(`Scoring enabled for game ${message.gameCode}`);
}

function handleSubmitScore(ws, message) {
    const { gameCode, playerId, teamName, score, game: gameNum, round } = message;
    const game = games.get(gameCode);
    
    if (!game) return;

    const team = game.teams.get(teamName);
    if (!team) return;

    // Verify player is team manager
    const player = game.players.get(playerId);
    if (!player || team.manager !== playerId) {
        ws.send(JSON.stringify({
            type: 'ERROR',
            message: 'Only team managers can submit scores'
        }));
        return;
    }

    // Calculate round index based on current position in game
    let roundIndex = 0;
    for (let g = 1; g < gameNum; g++) {
        if (game.games[g-1]) {
            roundIndex += parseInt(game.games[g-1][1]);
        }
    }
    roundIndex += (round - 1);

    // Initialize roundScores array if needed
    if (!team.roundScores) {
        team.roundScores = [];
    }

    // Set score
    team.roundScores[roundIndex] = score;
    team.totalScore = team.roundScores.reduce((sum, s) => sum + (s || 0), 0);

    // Notify host
    sendToHost(gameCode, {
        type: 'SCORE_SUBMITTED',
        teamName: teamName,
        score: score,
        roundIndex: roundIndex,
        totalScore: team.totalScore,
        roundScores: team.roundScores
    });

    // Confirm to player
    ws.send(JSON.stringify({
        type: 'SCORE_CONFIRMED',
        score: score,
        totalScore: team.totalScore
    }));

    console.log(`Score submitted: ${teamName} - ${score} points (Round ${roundIndex + 1})`);
}

function handleManagerChanged(ws, message) {
    const game = games.get(message.gameCode);
    if (!game || connections.get(ws)?.type !== 'host') return;

    const team = game.teams.get(message.teamName);
    if (!team) return;

    // Update manager
    team.manager = message.newManagerId;
    team.members.forEach(member => {
        member.isManager = member.playerId === message.newManagerId;
    });

    broadcast(message.gameCode, {
        type: 'MANAGER_CHANGED',
        teamName: message.teamName,
        newManagerId: message.newManagerId
    }, ws);

    console.log(`Manager changed for team ${message.teamName}`);
}

function handleScoreUpdated(ws, message) {
    const game = games.get(message.gameCode);
    if (!game || connections.get(ws)?.type !== 'host') return;

    const team = game.teams.get(message.teamName);
    if (!team) return;

    team.roundScores = message.scores;
    team.totalScore = message.totalScore;

    // Notify team members
    connections.forEach((connInfo, playerWs) => {
        if (connInfo.gameCode === message.gameCode && 
            connInfo.type === 'player' && 
            connInfo.teamName === message.teamName) {
            playerWs.send(JSON.stringify({
                type: 'SCORE_UPDATED',
                roundScores: message.scores,
                totalScore: message.totalScore
            }));
        }
    });
}

function handleRevealFinalScores(ws, message) {
    const game = games.get(message.gameCode);
    if (!game || connections.get(ws)?.type !== 'host') return;

    game.gameEnded = true;

    broadcast(message.gameCode, {
        type: 'REVEAL_FINAL_SCORES',
        standings: message.standings
    }, ws);

    console.log(`Final scores revealed for game ${message.gameCode}`);
}

function handleLeaveGame(ws, message) {
    const connInfo = connections.get(ws);
    if (!connInfo) return;

    const game = games.get(message.gameCode);
    if (game) {
        game.removePlayer(message.playerId);
        
        // Notify host
        sendToHost(message.gameCode, {
            type: 'PLAYER_LEFT',
            playerId: message.playerId,
            teams: Array.from(game.teams.values())
        });
    }

    connections.delete(ws);
    console.log(`Player left game ${message.gameCode}`);
}

function handlePlayerDisconnect(ws, message) {
    handleDisconnection(ws);
}

function handleDisconnection(ws) {
    const connInfo = connections.get(ws);
    if (!connInfo) return;

    const game = games.get(connInfo.gameCode);
    if (!game) return;

    if (connInfo.type === 'host') {
        // Host disconnected - notify all players
        broadcast(connInfo.gameCode, {
            type: 'HOST_DISCONNECTED'
        });
        console.log(`Host disconnected from game ${connInfo.gameCode}`);
        
        // Optionally clean up game after some time
        setTimeout(() => {
            games.delete(connInfo.gameCode);
            console.log(`Game ${connInfo.gameCode} cleaned up`);
        }, 300000); // 5 minutes
        
    } else if (connInfo.type === 'player') {
        // Player disconnected - remove from buzz list but keep in team
        game.buzzedPlayers = game.buzzedPlayers.filter(b => b.playerId !== connInfo.playerId);
        
        // Notify host
        sendToHost(connInfo.gameCode, {
            type: 'PLAYER_DISCONNECTED',
            playerId: connInfo.playerId
        });
        
        console.log(`Player disconnected from game ${connInfo.gameCode}`);
    }

    connections.delete(ws);
}

function handleGetTeams(ws, message) {
    const game = games.get(message.gameCode);
    if (!game) {
        ws.send(JSON.stringify({
            type: 'ERROR',
            message: 'Game not found'
        }));
        return;
    }

    // Convert teams Map to array format expected by client
    const teamsArray = [];
    game.teams.forEach(team => {
        teamsArray.push({
            name: team.name,
            members: team.members.length
        });
    });

    ws.send(JSON.stringify({
        type: 'TEAMS_LIST',
        teams: teamsArray
    }));

    console.log(`Sent teams list for game ${message.gameCode}: ${teamsArray.length} teams`);
}

// HTTP Routes
app.get('/', (req, res) => {
    res.send(`
        <h1>Get in the Game Show - Server</h1>
        <p>WebSocket server is running!</p>
        <p>Active games: ${games.size}</p>
        <p>Active connections: ${connections.size}</p>
    `);
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        activeGames: games.size,
        activeConnections: connections.size,
        uptime: process.uptime()
    });
});

// Game cleanup - remove old games every hour
setInterval(() => {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    
    games.forEach((game, gameCode) => {
        if (now - game.createdAt > oneHour) {
            games.delete(gameCode);
            console.log(`Cleaned up old game: ${gameCode}`);
        }
    });
}, oneHour);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎮 Get in the Game Show Server running on port ${PORT}`);
    console.log(`WebSocket ready for connections!`);
});
