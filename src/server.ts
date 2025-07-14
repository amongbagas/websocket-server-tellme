import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { parse } from 'url';

export interface WebSocketMessage {
    type: 'join' | 'leave' | 'mute' | 'unmute' | 'offer' | 'answer' | 'ice-candidate' | 'participant-update';
    roomId: string;
    uid: number;
    role?: 'speaker' | 'listener';
    data?: {
        action?: string;
        participants?: Array<{ uid: number; role: string; isMuted: boolean }>;
        targetUid?: number;
        fromUid?: number;
        isMuted?: boolean;
        sdp?: string;
        candidate?: RTCIceCandidate;
        [key: string]: unknown;
    };
}

export interface Participant {
    uid: number;
    role: 'speaker' | 'listener';
    isMuted: boolean;
    ws: WebSocket;
}

class VoiceCallWebSocketServer {
    private wss: WebSocketServer;
    private rooms: Map<string, Map<number, Participant>> = new Map();

    constructor() {
        const port = parseInt(process.env.WEBSOCKET_PORT || '8080');
        this.wss = new WebSocketServer({
            port,
            // Remove path filter, handle it in connection handler
        });

        this.wss.on('connection', this.handleConnection.bind(this));
        console.log(`WebSocket server started on port ${port}`);
    }

    private handleConnection(ws: WebSocket, req: IncomingMessage) {
        console.log('New WebSocket connection attempt');
        console.log('Request URL:', req.url);

        // Check if this is a voice-call request
        if (!req.url || !req.url.includes('voice-call')) {
            console.error('Invalid path:', req.url);
            ws.close(1008, 'Invalid path');
            return;
        }

        const url = parse(req.url!, true);
        const roomId = url.query.roomId as string;
        const uid = parseInt(url.query.uid as string);
        const role = url.query.role as 'speaker' | 'listener';

        console.log('Connection params:', { roomId, uid, role });

        if (!roomId || !uid || !role) {
            console.error('Missing parameters:', { roomId, uid, role });
            ws.close(1008, 'Missing parameters: roomId, uid, or role');
            return;
        }

        if (isNaN(uid)) {
            console.error('Invalid UID:', uid);
            ws.close(1008, 'Invalid UID');
            return;
        }

        console.log(`New connection: Room ${roomId}, UID ${uid}, Role ${role}`);

        // Initialize room if not exists
        if (!this.rooms.has(roomId)) {
            this.rooms.set(roomId, new Map());
        }

        const room = this.rooms.get(roomId)!;

        // Add participant to room
        const participant: Participant = {
            uid,
            role,
            isMuted: false, // Start unmuted for simultaneous communication
            ws,
        };

        room.set(uid, participant);

        // Send current participants to new user immediately
        this.sendParticipantsList(roomId, uid);

        // Broadcast new participant joined to all other users
        this.broadcast(
            roomId,
            {
                type: 'participant-update',
                roomId,
                uid,
                role,
                data: { action: 'joined', participants: this.getParticipantsList(roomId) },
            },
            uid
        );

        console.log(`✅ Participant ${uid} (${role}) added to room ${roomId}. Total participants: ${room.size}`);

        ws.on('message', (data: Buffer) => {
            try {
                const message: WebSocketMessage = JSON.parse(data.toString());
                this.handleMessage(message, ws, roomId, uid);
            } catch (error) {
                console.error('Invalid message format:', error);
            }
        });

        ws.on('close', () => {
            this.handleDisconnection(roomId, uid);
        });

        ws.on('error', (error: Error) => {
            console.error('WebSocket error:', error);
            this.handleDisconnection(roomId, uid);
        });
    }

    private handleMessage(message: WebSocketMessage, ws: WebSocket, roomId: string, uid: number) {
        console.log(`📨 WebSocket message received from ${uid} in room ${roomId}:`, message.type);

        const room = this.rooms.get(roomId);
        if (!room) {
            console.log(`❌ Room ${roomId} not found`);
            return;
        }

        const participant = room.get(uid);
        if (!participant) {
            console.log(`❌ Participant ${uid} not found in room ${roomId}`);
            return;
        }

        switch (message.type) {
            case 'mute':
                console.log(`🔇 Participant ${uid} muted in room ${roomId}`);
                participant.isMuted = true;
                this.broadcast(roomId, {
                    type: 'participant-update',
                    roomId,
                    uid,
                    data: { action: 'muted', isMuted: true, participants: this.getParticipantsList(roomId) },
                });
                break;

            case 'unmute':
                console.log(`🔊 Participant ${uid} unmuted in room ${roomId}`);
                participant.isMuted = false;
                this.broadcast(roomId, {
                    type: 'participant-update',
                    roomId,
                    uid,
                    data: { action: 'unmuted', isMuted: false, participants: this.getParticipantsList(roomId) },
                });
                break;

            case 'offer':
            case 'answer':
            case 'ice-candidate':
                // Forward WebRTC signaling messages to target participant
                const targetUid = message.data?.targetUid;
                console.log(`📡 Forwarding ${message.type} from ${uid} to ${targetUid} in room ${roomId}`);
                if (targetUid) {
                    const targetParticipant = room.get(targetUid);
                    if (targetParticipant) {
                        targetParticipant.ws.send(
                            JSON.stringify({
                                ...message,
                                data: { ...message.data, fromUid: uid },
                            })
                        );
                        console.log(`✅ ${message.type} forwarded successfully`);
                    } else {
                        console.log(`❌ Target participant ${targetUid} not found`);
                    }
                }
                break;

            default:
                console.warn(`❓ Unknown message type: ${message.type}`);
        }
    }

    private handleDisconnection(roomId: string, uid: number) {
        const room = this.rooms.get(roomId);
        if (!room) return;

        room.delete(uid);

        // Broadcast participant left
        this.broadcast(roomId, {
            type: 'participant-update',
            roomId,
            uid,
            data: { action: 'left', participants: this.getParticipantsList(roomId) },
        });

        // Clean up empty rooms
        if (room.size === 0) {
            this.rooms.delete(roomId);
        }
    }

    private broadcast(roomId: string, message: WebSocketMessage, excludeUid?: number) {
        const room = this.rooms.get(roomId);
        if (!room) return;

        const messageStr = JSON.stringify(message);

        room.forEach((participant, uid) => {
            if (uid !== excludeUid && participant.ws.readyState === WebSocket.OPEN) {
                participant.ws.send(messageStr);
            }
        });
    }

    private sendParticipantsList(roomId: string, targetUid: number) {
        const room = this.rooms.get(roomId);
        if (!room) return;

        const targetParticipant = room.get(targetUid);
        if (!targetParticipant) return;

        const participants = this.getParticipantsList(roomId);

        targetParticipant.ws.send(
            JSON.stringify({
                type: 'participant-update',
                roomId,
                uid: targetUid,
                data: { action: 'list', participants },
            })
        );
    }

    private getParticipantsList(roomId: string) {
        const room = this.rooms.get(roomId);
        if (!room) return [];

        return Array.from(room.values()).map((p) => ({
            uid: p.uid,
            role: p.role,
            isMuted: p.isMuted,
        }));
    }

    public getStats() {
        return {
            totalRooms: this.rooms.size,
            totalParticipants: Array.from(this.rooms.values()).reduce((total, room) => total + room.size, 0),
        };
    }
}

new VoiceCallWebSocketServer();
