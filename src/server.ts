import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { parse } from 'url';
import { createServer, Server as HttpServer } from 'http'; // Import Server as HttpServer

// --- Interface Definitions (No changes, but included for completeness) ---
export interface WebSocketMessage {
    type:
        | 'join'
        | 'leave'
        | 'mute'
        | 'unmute'
        | 'offer'
        | 'answer'
        | 'ice-candidate'
        | 'participant-update'
        | 'error'
        | 'heartbeat';
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
        message?: string;
        originalMessage?: string;
        availableParticipants?: number[];
        [key: string]: unknown;
    };
}

export interface Participant {
    uid: number;
    role: 'speaker' | 'listener';
    isMuted: boolean;
    wsId: string; // A unique ID for the WebSocket connection
    lastHeartbeat: number; // Timestamp of last received heartbeat
    roomId: string; // Add roomId to track which room the participant belongs to
}

// Map to store WebSocket instances by their unique ID
const activeWebsockets: Map<string, WebSocket> = new Map();

class VoiceCallWebSocketServer {
    private wss: WebSocketServer;
    // Store participants in rooms, keyed by roomId, then uid
    private rooms: Map<string, Map<number, Participant>> = new Map();
    private httpServer: HttpServer; // Use HttpServer type
    private wsIdCounter = 0; // Counter for unique WebSocket IDs
    private heartbeatInterval: NodeJS.Timeout | null = null; // Server-side heartbeat check
    private lastBroadcastTime: Map<string, number> = new Map(); // Rate limiting for broadcasts

    constructor() {
        const port = parseInt(process.env.WEBSOCKET_PORT || '8080');

        this.httpServer = createServer((req, res) => {
            // Set CORS headers
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

            if (req.method === 'OPTIONS') {
                res.writeHead(200);
                res.end();
                return;
            }

            if (req.url === '/health' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(
                    JSON.stringify({
                        status: 'healthy',
                        timestamp: new Date().toISOString(),
                        totalRooms: this.rooms.size,
                        totalParticipants: Array.from(this.rooms.values()).reduce(
                            (total, room) => total + room.size,
                            0
                        ),
                        totalActiveWebSockets: activeWebsockets.size,
                        uptime: process.uptime(),
                        endpoint: `ws://localhost:${port}/voice-call`,
                    })
                );
                return;
            }

            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
        });

        this.wss = new WebSocketServer({
            server: this.httpServer,
            path: '/voice-call',
        });

        this.wss.on('connection', this.handleConnection.bind(this));
        this.wss.on('error', (error: Error) => {
            console.error('❌ WebSocket Server error:', error);
            // Consider more graceful shutdown or logging
        });
        this.httpServer.on('error', (error: Error) => {
            console.error('❌ HTTP Server error:', error);
            // Fatal error for HTTP server, should probably exit
            process.exit(1);
        });

        this.httpServer.listen(port, () => {
            console.log(`✅ WebSocket server started on port ${port}`);
            console.log(`📋 Health check available at http://localhost:${port}/health`);
            console.log(`🔌 WebSocket endpoint: ws://localhost:${port}/voice-call`);
        });

        // Start server-side heartbeat check
        this.startHeartbeatCheck();
    }

    private startHeartbeatCheck() {
        // Ping all connected clients every 30 seconds (increased from 25)
        // This helps detect dead connections even if client-side pings fail
        this.heartbeatInterval = setInterval(() => {
            activeWebsockets.forEach((ws, wsId) => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.ping();
                } else {
                    console.warn(`⚠️ WebSocket ${wsId} not open, removing from activeWebsockets map.`);
                    activeWebsockets.delete(wsId); // Clean up stale WS references
                    // Further action: find associated participant and disconnect them
                    this.rooms.forEach((room) => {
                        room.forEach((participant) => {
                            if (participant.wsId === wsId) {
                                console.log(
                                    `Attempting to clean up participant ${participant.uid} from room ${participant.roomId} due to stale WS.`
                                );
                                this.handleDisconnection(participant.roomId, participant.uid, participant.wsId);
                            }
                        });
                    });
                }
            });
        }, 30 * 1000); // Send ping every 30 seconds (increased interval)

        // Check for client heartbeats (or lack thereof) every 45 seconds (increased from 30)
        // This is separate from ping/pong and relies on client sending 'heartbeat' message
        setInterval(() => {
            const now = Date.now();
            this.rooms.forEach((room) => {
                room.forEach((participant) => {
                    if (now - participant.lastHeartbeat > 90 * 1000) {
                        // If no heartbeat for 90 seconds (increased from 60)
                        console.warn(
                            `💔 Participant ${participant.uid} in room ${participant.roomId} did not send heartbeat for 90s. Disconnecting.`
                        );
                        const ws = activeWebsockets.get(participant.wsId);
                        if (ws && ws.readyState === WebSocket.OPEN) {
                            ws.close(1008, 'No heartbeat received');
                        }
                        this.handleDisconnection(participant.roomId, participant.uid, participant.wsId);
                    }
                });
            });
        }, 45 * 1000); // Check every 45 seconds
    }

    private handleConnection(ws: WebSocket, req: IncomingMessage) {
        console.log('\n🔌 New WebSocket connection attempt');

        // Generate a unique ID for this WebSocket instance
        const wsId = `ws_${this.wsIdCounter++}`;
        activeWebsockets.set(wsId, ws);
        (ws as any)._wsId = wsId; // Attach wsId to the WebSocket object for easier lookup

        // --- Initial Request Validation ---
        // Validate WebSocket state immediately
        if (ws.readyState !== WebSocket.OPEN) {
            console.error('❌ WebSocket is not in OPEN state during connection:', ws.readyState);
            ws.close(1002, 'WebSocket not in proper state');
            activeWebsockets.delete(wsId);
            return;
        }

        const url = parse(req.url!, true);
        const roomId = url.query.roomId as string;
        const uid = parseInt(url.query.uid as string);
        const role = url.query.role as 'speaker' | 'listener';

        // Log initial connection parameters and headers for debugging
        console.log(`🔌 [${wsId}] Request from: ${req.headers.origin || 'unknown'}`);
        console.log(`🔌 [${wsId}] Connection params: Room ${roomId}, UID ${uid}, Role ${role}`);

        // --- Parameter Validation ---
        if (!roomId || typeof roomId !== 'string' || roomId.trim() === '' || roomId === 'health-check') {
            console.error(`❌ [${wsId}] Missing or invalid roomId: '${roomId}'`);
            ws.close(1008, 'Missing or invalid roomId parameter');
            activeWebsockets.delete(wsId);
            return;
        }
        if (isNaN(uid) || uid <= 0) {
            // UID must be a positive integer
            console.error(`❌ [${wsId}] Missing or invalid UID: '${uid}'`);
            ws.close(1008, 'Missing or invalid UID parameter');
            activeWebsockets.delete(wsId);
            return;
        }
        if (!role || (role !== 'speaker' && role !== 'listener')) {
            console.error(`❌ [${wsId}] Missing or invalid role: '${role}'`);
            ws.close(1008, 'Missing or invalid role parameter (must be speaker or listener)');
            activeWebsockets.delete(wsId);
            return;
        }

        // --- Handle Existing Participant / Reconnection Scenario ---
        let existingParticipantInAnyRoom: { roomId: string; participant: Participant } | null = null;
        for (const [existingRoomId, room] of this.rooms) {
            if (room.has(uid)) {
                existingParticipantInAnyRoom = { roomId: existingRoomId, participant: room.get(uid)! };
                console.log(`⚠️ [${wsId}] Participant UID ${uid} already exists in room: ${existingRoomId}.`);
                break;
            }
        }

        if (existingParticipantInAnyRoom) {
            const { roomId: oldRoomId, participant: oldParticipant } = existingParticipantInAnyRoom;
            console.log(`🔄 [${wsId}] Disconnecting old connection for UID ${uid} from room ${oldRoomId}.`);

            const oldWs = activeWebsockets.get(oldParticipant.wsId);
            if (oldWs && oldWs.readyState === WebSocket.OPEN) {
                // Inform the old client it's being replaced
                oldWs.send(
                    JSON.stringify({
                        type: 'error',
                        roomId: oldRoomId,
                        uid: oldParticipant.uid,
                        data: {
                            message: 'Another connection with your UID was established. Disconnecting old session.',
                        },
                    })
                );
                oldWs.close(4000, 'New connection established with same UID'); // Custom close code
            } else if (oldWs) {
                // If old WS is not open, just clean up its entry
                activeWebsockets.delete(oldParticipant.wsId);
            }
            // Ensure old participant is removed from its room regardless of WS state
            this.rooms.get(oldRoomId)?.delete(uid);
            if (this.rooms.get(oldRoomId)?.size === 0) {
                this.rooms.delete(oldRoomId);
                console.log(`🗑️ [${wsId}] Room ${oldRoomId} became empty and was removed.`);
            }
            this.broadcastParticipantsUpdate(oldRoomId); // Update old room participants
        }

        // --- Add New Participant ---
        if (!this.rooms.has(roomId)) {
            this.rooms.set(roomId, new Map());
            console.log(`🏠 [${wsId}] Creating new room: ${roomId}`);
        }

        const room = this.rooms.get(roomId)!;
        const participant: Participant = {
            uid,
            role,
            isMuted: false,
            wsId: wsId, // Store the unique WebSocket ID
            lastHeartbeat: Date.now(), // Initialize last heartbeat
            roomId: roomId, // Set the roomId property
        };
        room.set(uid, participant);
        console.log(`✅ [${wsId}] Participant ${uid} (${role}) added to room ${roomId}. Room size: ${room.size}`);
        console.log('📊 Current server stats:', this.getStats());

        // Send current participants list to the new user joining
        this.sendParticipantsList(roomId, uid);

        // Broadcast participant update to everyone in the room (excluding the new participant, who already got full list)
        this.broadcastParticipantsUpdate(roomId, uid);

        // --- WebSocket Event Listeners ---
        ws.on('message', (data: Buffer) => {
            try {
                const message: WebSocketMessage = JSON.parse(data.toString());
                if (message.type === 'heartbeat') {
                    // Update heartbeat timestamp for this participant
                    const currentParticipant = room.get(uid);
                    if (currentParticipant) {
                        const now = Date.now();
                        // Only update if it's been at least 5 seconds since last heartbeat
                        if (now - currentParticipant.lastHeartbeat > 5000) {
                            currentParticipant.lastHeartbeat = now;
                            console.log(`❤️ Heartbeat updated for ${uid} in room ${roomId}`);
                        }
                    }
                    return; // Don't process heartbeat as other messages
                }
                this.handleMessage(message, wsId, roomId, uid);
            } catch (error) {
                console.error(`❌ [${wsId}] Invalid message format from ${uid} in room ${roomId}:`, error);
                ws.send(
                    JSON.stringify({
                        type: 'error',
                        roomId,
                        uid,
                        data: { message: 'Invalid JSON message format.', originalMessage: data.toString() },
                    })
                );
            }
        });

        ws.on('close', (code: number, reason: Buffer) => {
            console.log(
                `🔌 [${wsId}] WebSocket closed for ${uid} in room ${roomId} - Code: ${code}, Reason: ${reason.toString()}`
            );
            this.handleDisconnection(roomId, uid, wsId);
        });

        ws.on('error', (error: Error) => {
            console.error(`❌ [${wsId}] WebSocket error for ${uid} in room ${roomId}:`, error);
            // This error often precedes 'close', so handleDisconnection will be called.
            // Ensure no duplicate cleanup.
            this.handleDisconnection(roomId, uid, wsId); // Ensure cleanup on error
        });

        ws.on('pong', () => {
            // Client responded to our ping, indicating connection is alive
            // We can also update lastHeartbeat here if we rely solely on ping/pong for client activity
            // For now, we rely on explicit 'heartbeat' messages for client activity.
            // console.log(`🏓 Pong received from ${uid} in room ${roomId}`);
        });
    }

    private handleMessage(message: WebSocketMessage, senderWsId: string, roomId: string, uid: number) {
        console.log(`📨 [${senderWsId}] Message received from ${uid} in room ${roomId}: ${message.type}`);

        const room = this.rooms.get(roomId);
        if (!room) {
            console.warn(`⚠️ Room ${roomId} not found for message from ${uid}.`);
            this.sendErrorToClient(senderWsId, roomId, uid, `Room ${roomId} not found.`);
            return;
        }

        const senderParticipant = room.get(uid);
        if (!senderParticipant || senderParticipant.wsId !== senderWsId) {
            console.warn(`⚠️ Participant ${uid} not found or WS mismatch in room ${roomId}. WSId: ${senderWsId}`);
            this.sendErrorToClient(senderWsId, roomId, uid, `You are not a valid participant in room ${roomId}.`);
            // Consider forceful disconnection for invalid messages from unknown WS IDs
            const ws = activeWebsockets.get(senderWsId);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.close(1008, 'Invalid participant state or WS mismatch');
            }
            return;
        }

        switch (message.type) {
            case 'mute':
            case 'unmute':
                const isMuted = message.type === 'mute';
                console.log(
                    `${isMuted ? '🔇' : '🔊'} Participant ${uid} ${isMuted ? 'muted' : 'unmuted'} in room ${roomId}`
                );
                senderParticipant.isMuted = isMuted;
                this.broadcastParticipantsUpdate(roomId); // Broadcast to all in room
                break;

            case 'offer':
            case 'answer':
            case 'ice-candidate':
                const targetUid = message.data?.targetUid;
                if (!targetUid || typeof targetUid !== 'number') {
                    console.warn(`❌ No valid target UID specified for ${message.type} from ${uid}.`);
                    this.sendErrorToClient(senderWsId, roomId, uid, `No target UID specified for ${message.type}.`);
                    return;
                }

                const targetParticipant = room.get(targetUid);
                if (!targetParticipant) {
                    console.warn(
                        `❌ Target participant ${targetUid} not found in room ${roomId} for ${message.type} from ${uid}.`
                    );
                    this.sendErrorToClient(senderWsId, roomId, uid, `Target participant ${targetUid} not found.`);
                    return;
                }

                const targetWs = activeWebsockets.get(targetParticipant.wsId);
                if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                    // Ensure 'fromUid' is always set correctly by the server
                    const messageToSend: WebSocketMessage = {
                        ...message,
                        data: { ...message.data, fromUid: uid },
                    };
                    targetWs.send(JSON.stringify(messageToSend));
                    // console.log(`✅ [${senderWsId}] Forwarded ${message.type} from ${uid} to ${targetUid}`); // Keep this log quiet for high traffic
                } else {
                    console.warn(
                        `❌ [${senderWsId}] Target participant ${targetUid} WebSocket not open (state: ${
                            targetWs?.readyState || 'N/A'
                        }).`
                    );
                    this.sendErrorToClient(
                        senderWsId,
                        roomId,
                        uid,
                        `Target participant ${targetUid} is currently unreachable.`
                    );
                    // Proactively clean up if target WS is definitely closed
                    if (targetWs) {
                        this.handleDisconnection(roomId, targetUid, targetParticipant.wsId);
                    }
                }
                break;

            default:
                console.warn(`❓ [${senderWsId}] Unknown message type received: ${message.type}`);
                this.sendErrorToClient(senderWsId, roomId, uid, `Unknown message type: ${message.type}.`);
        }
    }

    private handleDisconnection(roomId: string, uid: number, wsId: string) {
        console.log(`\n🔌 Handling disconnection for [${wsId}] UID ${uid} in room ${roomId}`);

        const room = this.rooms.get(roomId);
        if (!room) {
            console.warn(`⚠️ Room ${roomId} not found during disconnection of ${uid}.`);
            // Still remove from activeWebsockets if it exists
            activeWebsockets.delete(wsId);
            return;
        }

        const participant = room.get(uid);

        // Only remove if the wsId matches, preventing removal of a new connection for the same UID
        if (participant && participant.wsId === wsId) {
            console.log(`🔌 Removing participant ${uid} from room ${roomId}.`);
            room.delete(uid);
            activeWebsockets.delete(wsId); // Remove WebSocket from active pool

            // Broadcast participant left
            this.broadcastParticipantsUpdate(roomId);

            console.log(`📊 Room ${roomId} now has ${room.size} participants.`);
        } else if (participant && participant.wsId !== wsId) {
            console.warn(
                `⚠️ Mismatch WSId for participant ${uid} in room ${roomId}. Old WSId ${wsId} attempting to disconnect, but current is ${participant.wsId}. Ignoring.`
            );
            activeWebsockets.delete(wsId); // Just remove the old/stale WS from the active pool
        } else {
            console.warn(
                `⚠️ Participant ${uid} (WSId: ${wsId}) not found in room ${roomId} during disconnection. Already cleaned up?`
            );
            activeWebsockets.delete(wsId); // Ensure WS is removed if no participant was found
        }

        // Clean up empty rooms
        if (room.size === 0) {
            console.log(`🗑️ Removing empty room ${roomId}.`);
            this.rooms.delete(roomId);
        }

        console.log('📊 Server stats after disconnection:', this.getStats());
    }

    // Sends an error message back to a specific client
    private sendErrorToClient(
        wsId: string,
        roomId: string,
        uid: number,
        errorMessage: string,
        originalMessage?: string
    ) {
        const ws = activeWebsockets.get(wsId);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(
                JSON.stringify({
                    type: 'error',
                    roomId,
                    uid,
                    data: {
                        message: errorMessage,
                        originalMessage: originalMessage,
                    },
                })
            );
            console.log(`⬆️ Error sent to [${wsId}] ${uid}: ${errorMessage}`);
        }
    }

    // Broadcasts a generic message to all participants in a room (excluding self)
    private broadcast(roomId: string, message: WebSocketMessage, excludeWsId?: string) {
        const room = this.rooms.get(roomId);
        if (!room) return;

        const messageStr = JSON.stringify(message);

        room.forEach((participant) => {
            if (participant.wsId !== excludeWsId) {
                const ws = activeWebsockets.get(participant.wsId);
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(messageStr);
                } else {
                    console.warn(
                        `⚠️ Failed to broadcast to ${participant.uid} (WSId: ${participant.wsId}), WS not open. Proactively cleaning up.`
                    );
                    this.handleDisconnection(roomId, participant.uid, participant.wsId);
                }
            }
        });
    }

    // Specific broadcast for participant updates, centralizing logic
    private broadcastParticipantsUpdate(roomId: string, excludeUid?: number) {
        // Rate limiting: don't broadcast more than once per second per room
        const now = Date.now();
        const lastBroadcast = this.lastBroadcastTime.get(roomId) || 0;

        if (now - lastBroadcast < 1000) {
            // Skip broadcast if less than 1 second since last broadcast for this room
            console.log(`⏳ Rate limiting: Skipping participant update for room ${roomId}`);
            return;
        }

        this.lastBroadcastTime.set(roomId, now);

        const participantsList = this.getParticipantsList(roomId);
        this.broadcast(
            roomId,
            {
                type: 'participant-update',
                roomId,
                // Server's UID is 0 or -1, or omitted as it's a server message
                uid: 0, // Using 0 as a neutral server UID for this message type
                data: { action: 'updated', participants: participantsList },
            },
            excludeUid ? this.rooms.get(roomId)?.get(excludeUid)?.wsId : undefined // Pass wsId to exclude
        );
        console.log(`📢 Broadcasted participant update for room ${roomId}. Total: ${participantsList.length}`);
    }

    // Sends participant list to a specific target UID
    private sendParticipantsList(roomId: string, targetUid: number) {
        const room = this.rooms.get(roomId);
        if (!room) return;

        const targetParticipant = room.get(targetUid);
        if (!targetParticipant) return;

        const ws = activeWebsockets.get(targetParticipant.wsId);
        if (ws && ws.readyState === WebSocket.OPEN) {
            const participants = this.getParticipantsList(roomId);
            ws.send(
                JSON.stringify({
                    type: 'participant-update',
                    roomId,
                    uid: targetUid, // Recipient's UID
                    data: { action: 'list', participants },
                })
            );
            console.log(`⬆️ Sent full participant list to ${targetUid} in room ${roomId}.`);
        }
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
            activeWebSockets: activeWebsockets.size, // Actual number of open WS connections
        };
    }
}

new VoiceCallWebSocketServer();
