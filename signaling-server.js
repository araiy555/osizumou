const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// CORS設定
app.use(cors({
    origin: true,
    credentials: true
}));

app.use(express.json());

// ヘルスチェック用エンドポイント
app.get('/', (req, res) => {
    res.json({ 
        status: 'OK', 
        message: 'P2P Sumo Game Signaling Server',
        activeRooms: Object.keys(rooms).length,
        activeConnections: wss.clients.size
    });
});

// WebSocketサーバー作成
const wss = new WebSocket.Server({ server });

// ルーム管理
const rooms = {};

// クライアント情報管理
const clients = new Map();

// ルーム作成
function createRoom(roomCode, hostClient) {
    rooms[roomCode] = {
        host: hostClient,
        guest: null,
        created: Date.now(),
        status: 'waiting' // waiting, full, closed
    };
    
    hostClient.roomCode = roomCode;
    hostClient.role = 'host';
    
    console.log(`ルーム作成: ${roomCode}`);
    
    // ホストにルーム作成成功を通知
    hostClient.send(JSON.stringify({
        type: 'roomCreated',
        roomCode: roomCode,
        role: 'host'
    }));
}

// ルーム参加
function joinRoom(roomCode, guestClient) {
    const room = rooms[roomCode];
    
    if (!room) {
        guestClient.send(JSON.stringify({
            type: 'error',
            message: 'ルームが見つかりません'
        }));
        return false;
    }
    
    if (room.status === 'full') {
        guestClient.send(JSON.stringify({
            type: 'error',
            message: 'ルームが満員です'
        }));
        return false;
    }
    
    if (room.guest) {
        guestClient.send(JSON.stringify({
            type: 'error',
            message: 'ルームが満員です'
        }));
        return false;
    }
    
    // ゲストをルームに追加
    room.guest = guestClient;
    room.status = 'full';
    guestClient.roomCode = roomCode;
    guestClient.role = 'guest';
    
    console.log(`ルーム参加: ${roomCode}`);
    
    // ゲストに参加成功を通知
    guestClient.send(JSON.stringify({
        type: 'roomJoined',
        roomCode: roomCode,
        role: 'guest'
    }));
    
    // ホストにゲスト参加を通知
    if (room.host && room.host.readyState === WebSocket.OPEN) {
        room.host.send(JSON.stringify({
            type: 'guestJoined',
            roomCode: roomCode
        }));
    }
    
    return true;
}

// ルームから退出
function leaveRoom(client) {
    const roomCode = client.roomCode;
    if (!roomCode || !rooms[roomCode]) return;
    
    const room = rooms[roomCode];
    
    if (room.host === client) {
        // ホストが退出
        if (room.guest && room.guest.readyState === WebSocket.OPEN) {
            room.guest.send(JSON.stringify({
                type: 'hostLeft',
                message: 'ホストが退出しました'
            }));
        }
        delete rooms[roomCode];
        console.log(`ルーム削除: ${roomCode}`);
    } else if (room.guest === client) {
        // ゲストが退出
        room.guest = null;
        room.status = 'waiting';
        
        if (room.host && room.host.readyState === WebSocket.OPEN) {
            room.host.send(JSON.stringify({
                type: 'guestLeft',
                message: 'ゲストが退出しました'
            }));
        }
        console.log(`ゲスト退出: ${roomCode}`);
    }
    
    client.roomCode = null;
    client.role = null;
}

// メッセージをルーム内の相手に転送
function forwardToPartner(client, message) {
    const roomCode = client.roomCode;
    if (!roomCode || !rooms[roomCode]) return;
    
    const room = rooms[roomCode];
    let partner = null;
    
    if (room.host === client) {
        partner = room.guest;
    } else if (room.guest === client) {
        partner = room.host;
    }
    
    if (partner && partner.readyState === WebSocket.OPEN) {
        partner.send(JSON.stringify(message));
    }
}

// WebSocket接続処理
wss.on('connection', (ws, req) => {
    const clientId = generateClientId();
    clients.set(ws, clientId);
    
    console.log(`クライアント接続: ${clientId} (IP: ${req.socket.remoteAddress})`);
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            
            switch (message.type) {
                case 'createRoom':
                    const roomCode = generateRoomCode();
                    createRoom(roomCode, ws);
                    break;
                    
                case 'joinRoom':
                    if (message.roomCode) {
                        joinRoom(message.roomCode.toUpperCase(), ws);
                    }
                    break;
                    
                case 'offer':
                case 'answer':
                case 'ice-candidate':
                    // WebRTCシグナリングメッセージを相手に転送
                    forwardToPartner(ws, message);
                    break;
                    
                case 'ping':
                    // ハートビート
                    ws.send(JSON.stringify({ type: 'pong' }));
                    break;
                    
                default:
                    console.log(`未知のメッセージタイプ: ${message.type}`);
                    break;
            }
        } catch (error) {
            console.error('メッセージ処理エラー:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'メッセージの処理中にエラーが発生しました'
            }));
        }
    });
    
    ws.on('close', () => {
        console.log(`クライアント切断: ${clientId}`);
        leaveRoom(ws);
        clients.delete(ws);
    });
    
    ws.on('error', (error) => {
        console.error(`WebSocketエラー (${clientId}):`, error);
        leaveRoom(ws);
        clients.delete(ws);
    });
    
    // 接続完了を通知
    ws.send(JSON.stringify({
        type: 'connected',
        clientId: clientId
    }));
});

// ユーティリティ関数
function generateRoomCode() {
    return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function generateClientId() {
    return Math.random().toString(36).substr(2, 9);
}

// 古いルームの定期クリーンアップ（30分）
setInterval(() => {
    const now = Date.now();
    const timeout = 30 * 60 * 1000; // 30分
    
    Object.keys(rooms).forEach(roomCode => {
        const room = rooms[roomCode];
        if (now - room.created > timeout) {
            console.log(`古いルームを削除: ${roomCode}`);
            delete rooms[roomCode];
        }
    });
}, 5 * 60 * 1000); // 5分ごとにチェック

// サーバー起動
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`シグナリングサーバーが起動しました: ポート ${PORT}`);
    console.log(`WebSocket URL: ws://localhost:${PORT}`);
});

// エラーハンドリング
process.on('uncaughtException', (error) => {
    console.error('未処理の例外:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('未処理のPromise拒否:', reason);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM受信、サーバーを停止します...');
    server.close(() => {
        console.log('サーバーが停止しました');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT受信、サーバーを停止します...');
    server.close(() => {
        console.log('サーバーが停止しました');
        process.exit(0);
    });
});
