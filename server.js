require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const SALT_ROUNDS = 10;
const crypto = require('crypto');

// Database  setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Express setup
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// File upload config
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) =>
    cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

// Middleware
app.use(express.json());
app.use('/uploads', express.static(uploadDir));

// User session management
const connectedUsers = new Map(); // userId -> { ws, user }
const CALL_TIMEOUT = 12000; // 12 seconds
const callTimeouts = new Map();

// Active calls management
const activeCalls = new Map(); // callId -> { participants, status, callData }

const logError = (context, error) => {
  console.error(`🔥 Error in ${context}:`, error.message);
};

const logResponse = (context, action, response) => {
  console.log(`📤 Response from ${context} - Action: ${action} - Response:`, JSON.stringify(response, null, 2));
};

// Helper: JWT auth
const authenticate = (token) => {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
};

// Add this near the top with other helper functions
const broadcastUpdates = async (userId, updateType, data) => {
  try {
    const userSession = connectedUsers.get(userId);
    if (userSession && userSession.ws.readyState === WebSocket.OPEN) {
      const message = {
        action: 'broadcast_update',
        type: updateType,
        data: data,
        timestamp: new Date().toISOString()
      };
      userSession.ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  } catch (error) {
    logError('Broadcasting update', error);
    return false;
  }
};

const broadcastToAllRelevantUsers = async (userIds, updateType, data) => {
  let successCount = 0;
  for (const userId of userIds) {
    if (await broadcastUpdates(userId, updateType, data)) {
      successCount++;
    }
  }
  return successCount;
};

// Helper: Get user by ID
const getUserById = (userId) => {
  return connectedUsers.get(userId);
};

// Helper: Broadcast to specific user
const broadcastToUser = (userId, message) => {
  const userSession = getUserById(userId);
  if (userSession && userSession.ws.readyState === WebSocket.OPEN) {
    userSession.ws.send(JSON.stringify(message));
    return true;
  }
  return false;
};

// Helper: Broadcast to multiple users
const broadcastToUsers = (userIds, message) => {
  let sentCount = 0;
  userIds.forEach(userId => {
    if (broadcastToUser(userId, message)) {
      sentCount++;
    }
  });
  return sentCount;
};

// Helper: Generate random 6-digit code
const generateLoginCode = () => {
  return Math.floor(100000 + Math.random() * 900000);
};

// ===========================
// WEBSOCKET HANDLER
// ===========================

wss.on('connection', (ws) => {
  console.log('🔌 New client connected');
  let currentUser  = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      console.log(`📩 Received action: ${data.action}`, data);

      // Actions that don't require authentication
      if (!['create_user', 'login', 'check_iin', 'verify_login'].includes(data.action)) {
        if (!data.token) {
          return ws.send(
            JSON.stringify({ action: data.action, error: '🔒 Authentication required' })
          );
        }

        currentUser  = authenticate(data.token);
        if (!currentUser ) {
          return ws.send(
            JSON.stringify({ action: data.action, error: '❌ Invalid token' })
          );
        }

        // Update user session mapping
        connectedUsers.set(currentUser .userId, { ws, user: currentUser  });
        ws.userId = currentUser .userId;
      }

      switch (data.action) {
        case 'create_user':
          await handleCreateUser (ws, data);
          break;
        case 'login':
          await handleLogin(ws, data);
          break;
        case 'verify_login':
          await handleVerifyLogin(ws, data);
          break;
        case 'check_iin':
          await handleCheckIIN(ws, data);
          break;
        case 'get_user_profile':
          await handleGetUserProfile(ws, data);
          break;
        case 'update_user_profile':
          await handleUpdateUserProfile(ws, data);
          break;
        case 'create_message':
        await handleCreateMessage(ws, data);
        break;
        case 'update_delivery_status':
        await handleUpdateDeliveryStatus(ws, data);
        break;
        case 'get_messages':
          await handleGetMessages(ws, data);
          break;
        case 'connection_quality':
          await handleConnectionQuality(ws, data);
          break;
        case 'get_user_chats':
          await handleGetUserChats(ws, data);
          break;
        case 'authenticate':
          await handleAuthenticate(ws, data);
          break;
          case 'sync_confirmation':
            await handleSyncConfirmation(ws, data);
            break;
        case 'create_chat':
          await handleCreateChat(ws, data);
          break;
        case 'create_group':
          await handleCreateGroup(ws, data);
          break;
        case 'get_group_info':
          await handleGetGroupInfo(ws, data);
          break;
        case 'update_group':
          await handleUpdateGroup(ws, data);
          break;
        case 'search_users':
          await handleSearchUsers(ws, data);
          break;
        case 'get_statuses':
          await handleGetStatuses(ws, data);
          break;
        case 'create_status':
          await handleCreateStatus(ws, data);
          break;
        case 'view_status':
          await handleViewStatus(ws, data);
          break;
        case 'upload_media':
          await handleUploadMedia(ws, data);
          break;
        case 'update_delivery_status':
          await handleUpdateDeliveryStatus(ws, data);
          break;
      
        // WebRTC Call Signaling
        case 'initiate_call':
          await handleInitiateCall(ws, data);
          break;

        case 'accept_call':
          await handleAcceptCall(ws, data);
          break;
        case 'reject_call':
          await handleRejectCall(ws, data);
          break;
        case 'end_call':
          await handleEndCall(ws, data);
          break;
        case 'webrtc_offer':
          await handleWebRTCOffer(ws, data);
          break;
        case 'webrtc_answer':
          await handleWebRTCAnswer(ws, data);
          break;
        case 'ice_candidate':
          await handleICECandidate(ws, data);
          break;
        case 'call_status_update':
          await handleCallStatusUpdate(ws, data);
          break;
      
        default:
          // Log the unknown action and its content
          console.error('Unknown action received:', data.action, 'Content:', data);
          ws.send(JSON.stringify({ action: data.action, error: '❌ Unknown action' }));
      }
      
      } catch (error) {
        logError('WebSocket message', error);
        ws.send(JSON.stringify({ action: 'error', error: '🚨 Server error', details: error.message }));
      }
      
  });

  ws.on('close', () => {
    const userText = currentUser  
      ? `User  ID: ${currentUser .userId}` 
      : 'Unauthenticated client';
    
    console.log(`⚠️ Client disconnected. ${userText}. Remaining connections: ${wss.clients.size}`);
    
    if (currentUser ) {
      // Update user offline status
      pool.query('UPDATE users SET is_online = false WHERE id = $1', [currentUser .userId])
        .catch((err) => logError('User  disconnect', err));
      
      // Remove from connected users
      connectedUsers.delete(currentUser .userId);
      console.log(`🗑️ Removed user ${currentUser .userId} from connectedUsers. Current users:`, connectedUsers.size);
      
      // Handle any active calls
      handleUserDisconnect(currentUser .userId);
    }
  });

  ws.on('authenticated', async (user) => {
    await broadcastFullSync(user.userId);
    console.log(`Broadcasting Updates to user ${currentUser .userId}`);
  });
  
});


// ===========================
// ACTION HANDLERS
// ===========================

async function handleCreateMessage(ws, data) {
  const { chat_id, content, type, is_reply, replied_to, id, base64_data } = data;
  const currentUser = authenticate(data.token);

  try {
    const messageId = id || uuidv4(); // Use provided ID or generate a new one

    // Get sender info
    const senderResult = await pool.query('SELECT name FROM users WHERE id = $1', [currentUser.userId]);
    const senderName = senderResult.rows[0]?.name || 'Unknown';

    // Insert message into messages table including base64_data
    const result = await pool.query(
      `INSERT INTO messages (
        id, 
        chat_id, 
        sender_id, 
        sender_name, 
        content, 
        type, 
        is_reply, 
        replied_to, 
        delivery_status,
        base64_data
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        messageId, 
        chat_id, 
        currentUser.userId, 
        senderName, 
        content, 
        type, 
        is_reply || false, 
        replied_to, 
        'sent',
        base64_data || null
      ]
    );
    
    const message = result.rows[0];

    // Update chat last message
    await pool.query(
      `UPDATE chats SET last_message_id = $1, last_message_type = $2, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $3`,
      [messageId, type, chat_id]
    );

    // Broadcast to other participants
    await broadcastNewMessage(message);

    const response = {
      action: 'create_message_response',
      success: true,
      message: message
    };

    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'create_message_response', response);
  } catch (error) {
    logError('Creating message', error);
    const response = {
      action: 'create_message_response',
      success: false,
      error: error.message
    };
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'create_message_response', response);
  }
}

async function handleUpdateDeliveryStatus(ws, data) {
  const { message_id, delivery_status } = data;
  const currentUser = authenticate(data.token);

  try {
    // Update message delivery status in database
    const result = await pool.query(
      `UPDATE messages 
       SET delivery_status = $1 
       WHERE id = $2
       RETURNING id, chat_id, sender_id, delivery_status`,
      [delivery_status, message_id]
    );

    if (result.rows.length === 0) {
      throw new Error('Message not found');
    }

    const updatedMessage = result.rows[0];

    // Get chat participants to know who to notify
    const chatResult = await pool.query(
      `SELECT participants FROM chats WHERE id = $1`,
      [updatedMessage.chat_id]
    );
    
    if (chatResult.rows.length === 0) {
      throw new Error('Chat not found');
    }

    const participants = chatResult.rows[0].participants;
    const receiverIds = participants.filter(id => id !== updatedMessage.sender_id);

    // Prepare broadcast message
    const updateData = {
      action: 'message_status_broadcast',
      updates: [
        { id: message_id, status: delivery_status }
      ],
      updated_at: new Date().toISOString()
    };

    // Broadcast to all participants except the sender
    broadcastToUsers(receiverIds, updateData);

    const response = {
      action: 'update_delivery_status_response',
      success: true,
      message_id: message_id,
      delivery_status: delivery_status
    };

    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'update_delivery_status_response', response);
  } catch (error) {
    logError('Updating delivery status', error);
    const response = {
      action: 'update_delivery_status_response',
      success: false,
      error: error.message
    };
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'update_delivery_status_response', response);
  }
}

async function handleSyncConfirmation(ws, data) {
  // Validate WebSocket connection
  if (!ws || ws.readyState !== ws.OPEN) {
    console.error('WebSocket is not open for communication');
    return;
  }

  const sendResponse = (response) => {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(response));
      } else {
        console.error('Cannot send response - WebSocket not open');
      }
    } catch (sendError) {
      console.error('Failed to send WebSocket response:', sendError);
    }
  };

  try {
    // Log the incoming data for debugging
    console.log('Received sync confirmation data:', data);

    // Validate required fields in the payload
    const requiredFields = ['token', 'user_id', 'sync_type', 'timestamp'];
    const missingFields = requiredFields.filter(field => !data?.[field]);

    if (missingFields.length > 0) {
      console.log('Missing required fields:', missingFields);
      throw new Error(`Invalid payload: Missing required fields - ${missingFields.join(', ')}`);
    }

    console.log(`Processing sync confirmation for user ${data.user_id}`);
    console.log(`Sync type: ${data.sync_type}`);
    console.log(`Timestamp: ${data.timestamp}`);

    // Initialize counters
    const markedCount = {
      chats: 0,
      groups: 0,
      messages: 0,
      calls: 0
    };

    // Process updates in transaction to ensure atomicity
    const client = await pool.connect();
    
    try {
      await pool.query('BEGIN');

      // 1. Mark calls as synced instead of deleting
      if (data.synced_chats?.length > 0) {
        const callsResult = await pool.query(
          `UPDATE calls SET 
             sync_status = 'synced',
             updated_at = NOW()
           WHERE chat_id = ANY($1) 
           AND (sync_status IS NULL OR sync_status != 'synced')
           RETURNING id`,
          [data.synced_chats]
        );
        markedCount.calls += callsResult.rowCount;
        console.log(`Marked ${callsResult.rowCount} calls referencing chats as synced`);
      }

      // 2. Mark explicitly listed calls
      if (data.synced_calls?.length > 0) {
        const result = await pool.query(
          `UPDATE calls SET 
             sync_status = 'synced',
             updated_at = NOW()
           WHERE id = ANY($1) 
           AND (sync_status IS NULL OR sync_status != 'synced')
           RETURNING id`,
          [data.synced_calls]
        );
        markedCount.calls += result.rowCount;
        console.log(`Marked ${result.rowCount} explicit calls as synced`);
      }
      
      // 3. Mark messages that reference chats/groups to be synced
      if (data.synced_chats?.length > 0) {
        const messagesResult = await pool.query(
          `UPDATE messages SET 
             sync_status = 'synced',
             updated_at = NOW()
           WHERE chat_id = ANY($1) 
           AND (sync_status IS NULL OR sync_status != 'synced')
           RETURNING id`,
          [data.synced_chats]
        );
        markedCount.messages += messagesResult.rowCount;
        console.log(`Marked ${messagesResult.rowCount} messages referencing chats as synced`);
      }

      if (data.synced_groups?.length > 0) {
        const messagesResult = await pool.query(
          `UPDATE messages SET 
             sync_status = 'synced',
             updated_at = NOW()
           WHERE group_id = ANY($1) 
           AND (sync_status IS NULL OR sync_status != 'synced')
           RETURNING id`,
          [data.synced_groups]
        );
        markedCount.messages += messagesResult.rowCount;
        console.log(`Marked ${messagesResult.rowCount} messages referencing groups as synced`);
      }

      // 4. Mark explicitly listed messages
      if (data.synced_messages?.length > 0) {
        const result = await pool.query(
          `UPDATE messages SET 
             sync_status = 'synced',
             updated_at = NOW()
           WHERE id = ANY($1) 
           AND (sync_status IS NULL OR sync_status != 'synced')
           RETURNING id`,
          [data.synced_messages]
        );
        markedCount.messages += result.rowCount;
        console.log(`Marked ${result.rowCount} explicit messages as synced`);
      }

      // 5. Mark chats as synced
      if (data.synced_chats?.length > 0) {
        const result = await pool.query(
          `UPDATE chats SET 
             sync_status = 'synced',
             updated_at = NOW()
           WHERE id = ANY($1) 
           AND (sync_status IS NULL OR sync_status != 'synced')
           RETURNING id`,
          [data.synced_chats]
        );
        markedCount.chats = result.rowCount;
        console.log(`Marked ${result.rowCount} chats as synced`);
      }

      // 6. Mark groups as synced
      if (data.synced_groups?.length > 0) {
        const result = await pool.query(
          `UPDATE groups SET 
             sync_status = 'synced',
             updated_at = NOW()
           WHERE id = ANY($1) 
           AND (sync_status IS NULL OR sync_status != 'synced')
           RETURNING id`,
          [data.synced_groups]
        );
        markedCount.groups = result.rowCount;
        console.log(`Marked ${result.rowCount} groups as synced`);
      }

      await pool.query('COMMIT');
      
      console.log('Sync confirmation processed successfully', markedCount);
      sendResponse({
        success: true,
        message: 'Sync confirmation processed successfully',
        markedCount,
        timestamp: new Date().toISOString()
      });
    } catch (dbError) {
      await pool.query('ROLLBACK');
      console.error('Database error during sync confirmation:', dbError);
      throw dbError;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error processing sync confirmation:', error);
    
    sendResponse({
      success: false,
      message: 'Failed to process sync confirmation',
      errorDetails: {
        name: error.name,
        code: error.code,
        constraint: error.constraint,
        table: error.table,
        detail: error.detail,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      },
      timestamp: new Date().toISOString()
    });
  }
}

async function handleConnectionQuality(ws, data) {
  const { call_id, quality_data } = data;
  const currentUser = authenticate(data.token);
  
  try {
    const call = activeCalls.get(call_id);
    if (!call) {
      throw new Error('Call not found');
    }
    
    // Store quality data
    if (!call.qualityData) {
      call.qualityData = {};
    }
    call.qualityData[currentUser.userId] = {
      ...quality_data,
      timestamp: new Date()
    };
    
    activeCalls.set(call_id, call);
    
    // Broadcast quality issues to other participants if severe
    if (quality_data.severity === 'poor') {
      const qualityAlert = {
        action: 'connection_quality_alert',
        call_id: call_id,
        user_id: currentUser.userId,
        quality: quality_data
      };
      
      call.participants.forEach(participantId => {
        if (participantId !== currentUser.userId) {
          broadcastToUser(participantId, qualityAlert);
        }
      });
    }
    
    const response = {
      action: 'connection_quality_response',
      success: true,
      call_id: call_id
    };
    
    ws.send(JSON.stringify(response));
  } catch (error) {
    logError('Handling connection quality', error);
    ws.send(JSON.stringify({
      action: 'connection_quality_response',
      success: false,
      error: error.message
    }));
  }
}

function handleUserDisconnect(userId) {
  // Clear any pending timeouts for calls started by this user
  for (const [callId, call] of activeCalls.entries()) {
    if (call.participants.includes(userId)) {
      const timeout = callTimeouts.get(callId);
      if (timeout) {
        clearTimeout(timeout);
        callTimeouts.delete(callId);
      }
      
      // Rest of the existing disconnect logic...
      if (call.participants.length === 2) {
        pool.query(
          'UPDATE calls SET status = $1, ended_at = CURRENT_TIMESTAMP WHERE id = $2',
          ['ended', callId]
        ).catch(err => logError('Ending call on disconnect', err));
        
        const otherParticipant = call.participants.find(p => p !== userId);
        if (otherParticipant) {
          broadcastToUser(otherParticipant, {
            action: 'call_ended',
            call_id: callId,
            ended_by: userId,
            reason: 'disconnected'
          });
        }
        
        activeCalls.delete(callId);
      } else {
        call.participants = call.participants.filter(p => p !== userId);
        activeCalls.set(callId, call);
        
        const leaveData = {
          action: 'participant_left',
          call_id: callId,
          user_id: userId,
          reason: 'disconnected'
        };
        
        call.participants.forEach(participantId => {
          broadcastToUser(participantId, leaveData);
        });
      }
    }
  }
}

async function handleCallTimeout(callId) {
  const call = activeCalls.get(callId);
  if (!call || call.status !== 'initiated') {
    return;
  }
  
  try {
    // Update call status to timeout
    await pool.query(
      'UPDATE calls SET status = $1, ended_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['timeout', callId]
    );
    
    // Remove from active calls
    activeCalls.delete(callId);
    
    // Clear timeout
    const timeout = callTimeouts.get(callId);
    if (timeout) {
      clearTimeout(timeout);
      callTimeouts.delete(callId);
    }
    
    // Notify all participants
    const timeoutData = {
      action: 'call_timeout',
      call_id: callId,
      reason: 'No answer'
    };
    
    call.participants.forEach(participantId => {
      broadcastToUser(participantId, timeoutData);
    });
    
    console.log(`📞 Call ${callId} timed out`);
  } catch (error) {
    logError('Handling call timeout', error);
  }
}

async function handleUpdateDeliveryStatus(ws, data) {
  const { message_id, delivery_status } = data;
  const currentUser = authenticate(data.token);

  try {
    // Update message delivery status in database
    const result = await pool.query(
      `UPDATE messages 
       SET delivery_status = $1 
       WHERE id = $2
       RETURNING id, chat_id, sender_id, delivery_status`,
      [delivery_status, message_id]
    );

    if (result.rows.length === 0) {
      throw new Error('Message not found');
    }

    const updatedMessage = result.rows[0];

    // Get chat participants to know who to notify
    const chatResult = await pool.query(
      `SELECT participants FROM chats WHERE id = $1`,
      [updatedMessage.chat_id]
    );
    
    if (chatResult.rows.length === 0) {
      throw new Error('Chat not found');
    }

    const participants = chatResult.rows[0].participants;
    const receiverIds = participants.filter(id => id !== updatedMessage.sender_id);

    // Prepare broadcast message
    const updateData = {
      action: 'delivery_status_update',
      message_id: message_id,
      delivery_status: delivery_status,
      updated_at: new Date().toISOString()
    };

    // Broadcast to all participants except the sender (if needed)
    broadcastToUsers(receiverIds, updateData);

    const response = {
      action: 'update_delivery_status_response',
      success: true,
      message_id: message_id,
      delivery_status: delivery_status
    };

    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'update_delivery_status_response', response);
  } catch (error) {
    logError('Updating delivery status', error);
    const response = {
      action: 'update_delivery_status_response',
      success: false,
      error: error.message
    };
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'update_delivery_status_response', response);
  }
}


async function handleLogin(ws, data) {
  const { iin, login_code } = data;
  const clientAddress = ws._socket.remoteAddress || 'unknown';
  
  console.log(`🔐 Login attempt from ${clientAddress} for IIN: ${iin.substring(0, 4)}******`);
  
  try {
    console.log(`🔍 Querying user with IIN: ${iin}`);
    const result = await pool.query(
      `SELECT * FROM users WHERE iin = $1`, 
      [iin]
    );
    
    if (result.rows.length === 0) {
      console.warn('⚠️ No user found with IIN:', iin);
      throw new Error('Invalid credentials');
    }

    const user = result.rows[0];
    console.log('👤 User found:', { id: user.id, name: user.name });
    
    console.log('🔒 Verifying login code...');
    const isValid = await bcrypt.compare(
      login_code.toString(),
      user.login_code
    );
    
    if (!isValid) {
      console.warn('❌ Invalid login code for user:', user.id);
      throw new Error('Invalid credentials');
    }
    console.log('✅ Login code verified successfully');
    
    console.log('🟢 Updating user online status');
    await pool.query(
      'UPDATE users SET is_online = true, last_login = CURRENT_TIMESTAMP, last_ip = $1 WHERE id = $2', 
      [clientAddress, user.id]
    );
    
    console.log('🔑 Generating JWT token');
    const token = jwt.sign(
      { userId: user.id }, 
      process.env.JWT_SECRET, 
      { expiresIn: '30d' }
    );
    
    console.log('💾 Storing user session');
    currentUser  = { userId: user.id, ip: clientAddress, connectedAt: new Date() };
    connectedUsers.set(user.id, { 
      ws, 
      user: currentUser ,
      lastActivity: new Date()
    });
    ws.userId = user.id;
    
    const response = { 
      action: 'login_response', 
      success: true, 
      token,
      user: {
        id: user.id,
        iin: user.iin,
        name: user.name,
        bio: user.bio,
        profile_image: user.profile_image,
        is_online: true
      }
    };
    
    console.log('📤 Sending successful login response:', {
      userId: user.id,
      userDetails: {
        name: user.name,
        ip: clientAddress
      }
    });
    
    ws.send(JSON.stringify(response));
    
    console.log(`🟢 User ${user.id} logged in successfully from ${clientAddress}`);
    console.log(`📊 Total authenticated connections: ${connectedUsers.size}`);
    
  } catch (error) {
    console.error('🔥 Login error:', {
      iin: data.iin,
      error: error.message,
      ip: clientAddress
    });
    
    const response = { 
      action: 'login_response', 
      success: false, 
      error: 'Invalid credentials' 
    };
    
    ws.send(JSON.stringify(response));
  }
}

async function handleCreateUser (ws, data) {
  const { iin, name, bio, login_code } = data;
  const clientAddress = ws._socket.remoteAddress || 'unknown';
  
  console.log(`🆕 New user registration attempt from ${clientAddress}`);
  console.log(`📝 IIN: ${iin.substring(0, 4)}******, Name: ${name}`);
  
  try {
    console.log('🔒 Hashing login code...');
    const hashedLoginCode = await bcrypt.hash(login_code.toString(), SALT_ROUNDS);
    const userId = uuidv4();
    
    console.log(`🆔 Generated user ID: ${userId}`);
    
    const result = await pool.query(
      `INSERT INTO users (id, iin, name, bio, login_code, last_ip, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       RETURNING id, iin, name, bio, profile_image, is_online`,
      [userId, iin, name, bio, hashedLoginCode, clientAddress]
    );

    const user = result.rows[0];
    console.log(`✨ User created successfully: ${user.id}`);
    
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    console.log(`🔑 JWT token generated for user: ${user.id}`);
    
    currentUser  = { userId: user.id, ip: clientAddress, connectedAt: new Date() };
    connectedUsers.set(user.id, { 
      ws, 
      user: currentUser ,
      lastActivity: new Date()
    });
    ws.userId = user.id;
    
    const response = { 
      action: 'create_user_response', 
      success: true, 
      token,
      user: {
        id: user.id,
        iin: user.iin,
        name: user.name,
        bio: user.bio,
        profile_image: user.profile_image,
        is_online: true
      }
    };
    
    console.log('📤 Sending registration response:', {
      userId: user.id,
      name: user.name,
      ip: clientAddress
    });
    
    ws.send(JSON.stringify(response));
    
    console.log(`🎉 New user registered: ${user.id} (${user.name}) from ${clientAddress}`);
    console.log(`📊 Total authenticated connections: ${connectedUsers.size}`);
    
  } catch (error) {
    console.error('💥 Registration error:', {
      error: error.message,
      stack: error.stack,
      ip: clientAddress,
      inputData: {
        iin: iin.substring(0, 4) + '******',
        nameLength: name.length,
        bioLength: bio?.length || 0
      }
    });
    
    const errorResponse = {
      action: 'create_user_response',
      success: false,
      error: 'Failed to create user',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    };
    
    ws.send(JSON.stringify(errorResponse));
  }
}


async function handleCheckIIN(ws, data) {
  const { iin } = data;
  
  try {
    const result = await pool.query('SELECT id, name, iin FROM users WHERE iin = $1', [iin]);
    
    const response = {
      action: 'check_iin_response',
      exists: result.rows.length > 0,
      user: result.rows[0] || null,
    };
    
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'check_iin_response', response);
  } catch (error) {
    logError('Checking IIN', error);
    const response = { 
      action: 'check_iin_response', 
      error: 'Failed to check IIN', 
      details: error.message 
    };
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'check_iin_response', response);
  }
}

async function handleGetUserProfile(ws, data) {
  console.log('🔄 Handling get_user_profile for user:', data.user_id); // Debug log
  
  const { user_id } = data;
  
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [user_id]);
    
    if (result.rows.length === 0) {
      throw new Error('User not found');
    }
    
    const user = result.rows[0];
    delete user.login_code;
    
    const response = { 
      action: 'get_user_profile_response', 
      success: true,
      user 
    };
    
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'get_user_profile_response', response);
    
  } catch (error) {
    console.error('❌ Error in handleGetUserProfile:', error); // Detailed error
    logError('Getting user profile', error);
    
    const response = { 
      action: 'get_user_profile_response', 
      success: false,
      error: error.message 
    };
    
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'get_user_profile_response', response);
  }
}

async function handleUpdateUserProfile(ws, data) {
  const { name, bio, profile_image } = data;
  const currentUser = authenticate(data.token);
  
  try {
    const result = await pool.query(
      `UPDATE users SET name = $1, bio = $2, profile_image = $3, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $4 RETURNING *`,
      [name, bio, profile_image, currentUser.userId]
    );
    
    const user = result.rows[0];
    delete user.login_code;
    
    const response = { 
      action: 'update_user_profile_response', 
      success: true,
      user 
    };
    
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'update_user_profile_response', response);
  } catch (error) {
    logError('Updating user profile', error);
    const response = { 
      action: 'update_user_profile_response', 
      success: false,
      error: error.message 
    };
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'update_user_profile_response', response);
  }
}

async function broadcastNewMessage(message) {
  try {
    const chatResult = await pool.query(
      'SELECT participants FROM chats WHERE id = $1',
      [message.chat_id]
    );
    
    if (chatResult.rows.length > 0) {
      const participants = chatResult.rows[0].participants;
      await broadcastToAllRelevantUsers(
        participants,
        'new_message',
        message
      );
    }
  } catch (error) {
    logError('Broadcasting new message', error);
  }
}

// Broadcast chat updates (new chat, updated chat, etc.)
async function broadcastChatUpdate(chat) {
  try {
    await broadcastToAllRelevantUsers(
      chat.participants,
      'chat_update',
      chat
    );
  } catch (error) {
    logError('Broadcasting chat update', error);
  }
}

// Broadcast group updates
async function broadcastGroupUpdate(group) {
  try {
    const chatResult = await pool.query(
      'SELECT participants FROM chats WHERE id = $1',
      [group.chat_id]
    );
    
    if (chatResult.rows.length > 0) {
      const participants = chatResult.rows[0].participants;
      await broadcastToAllRelevantUsers(
        participants,
        'group_update',
        group
      );
    }
  } catch (error) {
    logError('Broadcasting group update', error);
  }
}

// Broadcast media updates
async function broadcastMediaUpdate(mediaData, recipientIds) {
  try {
    await broadcastToAllRelevantUsers(
      recipientIds,
      'media_update',
      mediaData
    );
  } catch (error) {
    logError('Broadcasting media update', error);
  }
}

// Broadcast call updates
async function broadcastCallUpdate(call) {
  try {
    await broadcastToAllRelevantUsers(
      call.participants,
      'call_update',
      call
    );
  } catch (error) {
    logError('Broadcasting call update', error);
  }
}

// Broadcast full sync data to a specific user
async function broadcastFullSync(userId) {
  try {
    // Strict input validation: userId must be a non-empty string
    if (typeof userId !== 'string' || !userId.trim()) {
      throw new Error(`Invalid userId: expected non-empty string but got ${JSON.stringify(userId)}`);
    }

    console.log(`Starting full sync for userId: ${userId}`);

const [chatsResult, messagesResult, groupsResult, mediaResult, callsResult] = await Promise.all([
  pool.query(`
    SELECT TRIM(c.id) as id, c.*, g.name AS group_name, g.description AS group_description
    FROM chats c
    LEFT JOIN groups g ON TRIM(c.id) = TRIM(g.chat_id)
    WHERE TRIM($1) = ANY(SELECT TRIM(unnest(c.participants)))
  `, [userId.trim()]),
  pool.query(`
    SELECT TRIM(m.id) as id, TRIM(m.chat_id) as chat_id, TRIM(m.sender_id) as sender_id, m.*, md.media_url, md.base64_data
    FROM messages m
    LEFT JOIN media_data md ON TRIM(m.id) = TRIM(md.message_id)
    WHERE TRIM(m.chat_id) IN (
      SELECT TRIM(id) FROM chats WHERE TRIM($1) = ANY(SELECT TRIM(unnest(participants)))
    )
    ORDER BY m.created_at DESC
    LIMIT 100
  `, [userId.trim()]),
  pool.query(`
    SELECT TRIM(g.id) as id, TRIM(g.chat_id) as chat_id, TRIM(g.created_by) as created_by, g.*
    FROM groups g
    JOIN chats c ON TRIM(g.chat_id) = TRIM(c.id)
    WHERE TRIM($1) = ANY(SELECT TRIM(unnest(c.participants)))
  `, [userId.trim()]),
  pool.query(`
    SELECT TRIM(id) as id, TRIM(message_id) as message_id, *
    FROM media_data
    WHERE TRIM(message_id) IN (
      SELECT TRIM(id) FROM messages
      WHERE TRIM(chat_id) IN (
        SELECT TRIM(id) FROM chats WHERE TRIM($1) = ANY(SELECT TRIM(unnest(participants)))
      )
    )
    ORDER BY media_data.created_at DESC
    LIMIT 50
  `, [userId.trim()]),
  pool.query(`
    SELECT TRIM(id) as id, *
    FROM calls
    WHERE TRIM($1) = ANY(SELECT TRIM(unnest(participants)))
      AND started_at > NOW() - INTERVAL '7 days'
    ORDER BY started_at DESC
    LIMIT 20
  `, [userId.trim()])
]);

    const syncData = {
      chats: chatsResult.rows,
      messages: messagesResult.rows,
      groups: groupsResult.rows,
      media: mediaResult.rows,
      calls: callsResult.rows,
    };

    await broadcastUpdates(userId, 'full_sync', syncData);

    console.log(`Successfully broadcasted full sync to user ${userId}`);

  } catch (error) {
    logError('Broadcasting full sync', error);
  }
}

async function handleGetMessages(ws, data) {
  const { chat_id, limit = 50, offset = 0 } = data;
  const currentUserId = authenticate(data.token).userId; // Get the current user's ID
  
  try {
    const result = await pool.query(`
      SELECT m.*, md.media_url, md.base64_data
      FROM messages m
      LEFT JOIN media_data md ON m.id = md.message_id
      WHERE m.chat_id = $1
      ORDER BY m.created_at DESC
      LIMIT $2 OFFSET $3
    `, [chat_id, limit, offset]);

    const messages = result.rows.reverse(); // Reverse to get chronological order
    
    const response = {
      action: 'get_messages_response',
      success: true,
      messages: messages.map(msg => ({
        ...msg,
        media_data: msg.base64_data ? { media_url: msg.media_url, base64_data: msg.base64_data } : null, // Include media data
        delivery_status: msg.delivery_status // Include delivery_status in the response
      })),
      metadata: {
        count: messages.length,
        has_more: messages.length === limit
      }
    };

    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'get_messages_response', response);
  } catch (error) {
    logError('Getting messages', error);
    const response = {
      action: 'get_messages_response',
      success: false,
      error: error.message
    };
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'get_messages_response', response);
  }
}

async function handleGetUserChats(ws, data) {
  const currentUser  = authenticate(data.token);

  try {
    const result = await pool.query(`
      SELECT DISTINCT c.*, g.name as group_name, g.description as group_description,
             m.content as last_message_content, m.created_at as last_message_time,
             m.sender_name as last_message_sender, m.delivery_status as last_message_status
      FROM chats c
      LEFT JOIN groups g ON c.id = g.chat_id
      LEFT JOIN messages m ON c.last_message_id = m.id
      WHERE $1 = ANY(c.participants)
      ORDER BY c.updated_at DESC
    `, [currentUser .userId]);

    const chats = result.rows.map(chat => ({
      id: chat.id,
      is_group: chat.is_group,
      participants: chat.participants,
      group_name: chat.group_name,
      group_description: chat.group_description,
      last_message: {
        content: chat.last_message_content,
        time: chat.last_message_time,
        sender: chat.last_message_sender,
        type: chat.last_message_type,
        delivery_status: chat.last_message_status // Include delivery_status in the last message
      },
      updated_at: chat.updated_at
    }));

    const response = {
      action: 'get_user_chats_response',
      success: true,
      chats: chats
    };

    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'get_user_chats_response', response);
  } catch (error) {
    logError('Getting user chats', error);
    const response = {
      action: 'get_user_chats_response',
      success: false,
      error: error.message
    };
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'get_user_chats_response', response);
  }
}

async function handleAuthenticate(ws, data) {
  const currentUser = authenticate(data.token);
  
  if (!currentUser) {
    return ws.send(JSON.stringify({ action: 'authenticate', error: '❌ Invalid token' }));
  }

  // Emit authenticated event
  ws.emit('authenticated', currentUser);

  const response = {
    action: 'authenticate_response',
    success: true,
    user: {
      id: currentUser.userId,
    }
  };

  ws.send(JSON.stringify(response));
}


async function handleCreateChat(ws, data) {
  const { 
    participants, 
    last_message_content,
    last_message_id,
    last_message_delivery_status,
    last_message_type,
    participant_names,
    sync_status = 'synced'
  } = data;
  const currentUser = authenticate(data.token);

  try {
    // Combine and sort all participants (including current user)
    const allParticipants = [currentUser.userId, ...participants].sort();

    // Generate deterministic hash from sorted participants
    const participantsHash = crypto.createHash('sha256')
      .update(JSON.stringify(allParticipants))
      .digest('hex');

    // Check if a chat with this exact participants_hash already exists
    const existingChat = await pool.query(
      `SELECT * FROM chats WHERE participants_hash = $1`,
      [participantsHash]
    );

    if (existingChat.rows.length > 0) {
      const response = {
        action: 'create_chat_response',
        success: true,
        chat: existingChat.rows[0],
        exists: true,
        message: 'Chat already exists'
      };
      console.log('Create chat response (existing):', response);
      ws.send(JSON.stringify(response));
      return;
    }

    // Create a new chat
    const chatId = uuidv4();
    const result = await pool.query(
      `INSERT INTO chats (
        id, is_group, participants, participants_hash, created_by,
        last_message_content, last_message_id, last_message_delivery_status,
        last_message_type, participant_names, sync_status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [
        chatId, 
        false, 
        JSON.stringify(allParticipants), 
        participantsHash, 
        currentUser.userId,
        last_message_content,
        last_message_id,
        last_message_delivery_status,
        last_message_type,
        participant_names,
        sync_status
      ]
    );

    const newChat = result.rows[0];
    
    // Broadcast chat update to all participants
    await broadcastChatUpdate(newChat);

    const response = {
      action: 'create_chat_response',
      success: true,
      chat: newChat,
      exists: false
    };

    console.log('Create chat response (new):', response);
    ws.send(JSON.stringify(response));
  } catch (error) {
    const response = {
      action: 'create_chat_response',
      success: false,
      error: error.message
    };
    console.error('Create chat error:', response);
    ws.send(JSON.stringify(response));
  }
}
async function handleCreateGroup(ws, data) {
  const { name, description, members } = data;
  const currentUser = authenticate(data.token);
  
  try {
    const chatId = uuidv4();
    const groupId = uuidv4();
    const allMembers = [currentUser.userId, ...members];
    
    // Create chat
    await pool.query(
      `INSERT INTO chats (id, is_group, participants, created_by)
       VALUES ($1, $2, $3, $4)`,
      [chatId, true, JSON.stringify(allMembers), currentUser.userId]
    );
    
    // Create group
    const result = await pool.query(
      `INSERT INTO groups (id, chat_id, name, description, members, admins, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [groupId, chatId, name, description, JSON.stringify(allMembers), JSON.stringify([currentUser.userId]), currentUser.userId]
    );

    const group = result.rows[0];
    
    // Broadcast group update to all members
    await broadcastGroupUpdate(group);
    
    const response = {
      action: 'create_group_response',
      success: true,
      group: group
    };

    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'create_group_response', response);
  } catch (error) {
    logError('Creating group', error);
    const response = {
      action: 'create_group_response',
      success: false,
      error: error.message
    };
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'create_group_response', response);
  }
}

async function handleSearchUsers(ws, data) {
  const { query, limit = 10 } = data;

  try {
    const userId = authenticate(data.token).userId;

    const sql = `
      SELECT id, name, iin, profile_image, is_online
      FROM users 
      WHERE id != $1 AND (
        iin = $2 OR id::text = $3
      )
      LIMIT $4
    `;

    const values = [
      userId,
      query, // exact match for iin
      query, // exact match for id (as string)
      limit
    ];

    const result = await pool.query(sql, values);
    const users = result.rows;

    const response = {
      action: 'search_users_response',
      success: true,
      users
    };

    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'search_users_response', response);
  } catch (error) {
    logError('Searching users', error);
    const response = {
      action: 'search_users_response',
      success: false,
      error: error.message
    };
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'search_users_response', response);
  }
}


async function handleGetStatuses(ws, data) {
  const currentUser = authenticate(data.token);
  
  try {
    const result = await pool.query(`
      SELECT s.*, u.name as poster_name, u.profile_image as poster_image
      FROM statuses s
      JOIN users u ON s.poster_id = u.id
      WHERE s.expires_at > CURRENT_TIMESTAMP
      AND s.poster_id != $1
      AND NOT ($1 = ANY(u.blocked_users))
      ORDER BY s.created_at DESC
    `, [currentUser.userId]);

    const statuses = result.rows;
    
    const response = {
      action: 'get_statuses_response',
      success: true,
      statuses: statuses
    };

    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'get_statuses_response', response);
  } catch (error) {
    logError('Getting statuses', error);
    const response = {
      action: 'get_statuses_response',
      success: false,
      error: error.message
    };
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'get_statuses_response', response);
  }
}

async function handleCreateStatus(ws, data) {
  const { type, media_data, caption } = data;
  const currentUser = authenticate(data.token);
  
  try {
    const statusId = uuidv4();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now
    
    const result = await pool.query(
      `INSERT INTO statuses (id, poster_id, type, media_data, caption, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [statusId, currentUser.userId, type, media_data, caption, expiresAt]
    );

    const status = result.rows[0];
    
    const response = {
      action: 'create_status_response',
      success: true,
      status: status
    };

    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'create_status_response', response);
  } catch (error) {
    logError('Creating status', error);
    const response = {
      action: 'create_status_response',
      success: false,
      error: error.message
    };
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'create_status_response', response);
  }
}

async function handleViewStatus(ws, data) {
  const { status_id } = data;
  const currentUser = authenticate(data.token);
  
  try {
    // Add viewer to status
    await pool.query(`
      UPDATE statuses 
      SET viewers = CASE 
        WHEN viewers IS NULL THEN $1::json
        ELSE (viewers::jsonb || $1::jsonb)::json
      END
      WHERE id = $2
    `, [JSON.stringify([currentUser.userId]), status_id]);
    
    const response = {
      action: 'view_status_response',
      success: true,
      status_id: status_id
    };

    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'view_status_response', response);
  } catch (error) {
    logError('Viewing status', error);
    const response = {
      action: 'view_status_response',
      success: false,
      error: error.message
    };
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'view_status_response', response);
  }
}

// ===========================
// WEBRTC CALL HANDLERS
// ===========================

async function handleInitiateCall(ws, data) {
  const { chat_id, call_type, participants } = data;
  const currentUser = authenticate(data.token);
  
  try {
    const callId = uuidv4();
    
    // Get caller's name from database
    const userResult = await pool.query('SELECT name FROM users WHERE id = $1', [currentUser.userId]);
    const callerName = userResult.rows[0]?.name || 'Unknown';
    
    // Create call record
    await pool.query(
      `INSERT INTO calls (id, call_type, is_group_call, chat_id, participants, started_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [callId, call_type, participants.length > 2, chat_id, JSON.stringify(participants), currentUser.userId, 'initiated']
    );
    
    // Store active call
    const callData = {
      id: callId,
      participants: participants,
      status: 'initiated',
      startedBy: currentUser.userId,
      callType: call_type,
      startedAt: new Date(),
      callerName: callerName
    };
    activeCalls.set(callId, callData);
    
    // Set call timeout
    const timeout = setTimeout(() => {
      handleCallTimeout(callId);
    }, CALL_TIMEOUT);
    callTimeouts.set(callId, timeout);
    
    // Broadcast call update to all participants
    await broadcastCallUpdate(callData);
    
    const response = {
      action: 'initiate_call_response',
      success: true,
      call_id: callId
    };
    
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'initiate_call_response', response);
  } catch (error) {
    logError('Initiating call', error);
    const response = {
      action: 'initiate_call_response',
      success: false,
      error: error.message
    };
    ws.send(JSON.stringify(response));
  }
}

async function handleAcceptCall(ws, data) {
  const { call_id } = data;
  const currentUser = authenticate(data.token);
  
  try {
    const call = activeCalls.get(call_id);
    if (!call) {
      throw new Error('Call not found');
    }
    
    // Clear timeout since call is accepted
    const timeout = callTimeouts.get(call_id);
    if (timeout) {
      clearTimeout(timeout);
      callTimeouts.delete(call_id);
    }
    
    // Update call status
    await pool.query(
      'UPDATE calls SET status = $1, started_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['accepted', call_id]
    );
    
    const updatedCallData = {
      ...call,
      status: 'accepted',
      acceptedAt: new Date()
    };
    activeCalls.set(call_id, updatedCallData);
    
    // Broadcast call update to all participants
    await broadcastCallUpdate(updatedCallData);
    
    const response = {
      action: 'accept_call_response',
      success: true,
      call_id: call_id,
      call_data: updatedCallData
    };
    
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'accept_call_response', response);
  } catch (error) {
    logError('Accepting call', error);
    const response = {
      action: 'accept_call_response',
      success: false,
      error: error.message
    };
    ws.send(JSON.stringify(response));
  }
}

async function handleRejectCall(ws, data) {
  const { call_id, reason } = data;
  const currentUser = authenticate(data.token);
  
  try {
    const call = activeCalls.get(call_id);
    if (!call) {
      throw new Error('Call not found');
    }
    
    // Update call status
    await pool.query('UPDATE calls SET status = $1, ended_at = CURRENT_TIMESTAMP WHERE id = $2', ['rejected', call_id]);
    
    const updatedCallData = {
      ...call,
      status: 'rejected',
      endedAt: new Date(),
      endedBy: currentUser.userId,
      reason: reason || 'declined'
    };
    
    // Broadcast call update before removing from active calls
    await broadcastCallUpdate(updatedCallData);
    
    // Remove from active calls
    activeCalls.delete(call_id);
    
    const response = {
      action: 'reject_call_response',
      success: true,
      call_id: call_id
    };
    
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'reject_call_response', response);
  } catch (error) {
    logError('Rejecting call', error);
    const response = {
      action: 'reject_call_response',
      success: false,
      error: error.message
    };
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'reject_call_response', response);
  }
}

async function handleEndCall(ws, data) {
  const { call_id } = data;
  const currentUser = authenticate(data.token);
  
  try {
    const call = activeCalls.get(call_id);
    if (!call) {
      throw new Error('Call not found');
    }
    
    // Calculate duration
    const callStartTime = await pool.query('SELECT started_at FROM calls WHERE id = $1', [call_id]);
    const duration = callStartTime.rows[0] ? 
      Math.floor((new Date() - new Date(callStartTime.rows[0].started_at)) / 1000) : 0;
    
    // Update call status
    await pool.query(
      'UPDATE calls SET status = $1, ended_at = CURRENT_TIMESTAMP, duration = $2 WHERE id = $3',
      ['ended', duration, call_id]
    );
    
    const updatedCallData = {
      ...call,
      status: 'ended',
      endedAt: new Date(),
      endedBy: currentUser.userId,
      duration: duration
    };
    
    // Broadcast call update before removing from active calls
    await broadcastCallUpdate(updatedCallData);
    
    // Remove from active calls
    activeCalls.delete(call_id);
    
    const response = {
      action: 'end_call_response',
      success: true,
      call_id: call_id,
      duration: duration
    };
    
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'end_call_response', response);
  } catch (error) {
    logError('Ending call', error);
    const response = {
      action: 'end_call_response',
      success: false,
      error: error.message
    };
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'end_call_response', response);
  }
}

async function handleWebRTCOffer(ws, data) {
  const { call_id, offer, target_user_id } = data;
  const currentUser = authenticate(data.token);
  
  try {
    const call = activeCalls.get(call_id);
    if (!call) {
      throw new Error('Call not found');
    }
    
    // Validate that both users are participants
    if (!call.participants.includes(currentUser.userId) || !call.participants.includes(target_user_id)) {
      throw new Error('Unauthorized participants');
    }
    
    // Forward offer to target user
    const offerData = {
      action: 'webrtc_offer',
      call_id: call_id,
      offer: offer,
      from_user_id: currentUser.userId
    };
    
    const success = broadcastToUser(target_user_id, offerData);
    
    const response = {
      action: 'webrtc_offer_response',
      success: success,
      call_id: call_id,
      target_user_id: target_user_id
    };
    
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'webrtc_offer_response', response);
  } catch (error) {
    logError('Handling WebRTC offer', error);
    const response = {
      action: 'webrtc_offer_response',
      success: false,
      error: error.message
    };
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'webrtc_offer_response', response);
  }
}

async function handleWebRTCAnswer(ws, data) {
  const { call_id, answer, target_user_id } = data;
  const currentUser = authenticate(data.token);
  
  try {
    const call = activeCalls.get(call_id);
    if (!call) {
      throw new Error('Call not found');
    }
    
    // Validate that both users are participants
    if (!call.participants.includes(currentUser.userId) || !call.participants.includes(target_user_id)) {
      throw new Error('Unauthorized participants');
    }
    
    // Forward answer to target user
    const answerData = {
      action: 'webrtc_answer',
      call_id: call_id,
      answer: answer,
      from_user_id: currentUser.userId
    };
    
    const success = broadcastToUser(target_user_id, answerData);
    
    const response = {
      action: 'webrtc_answer_response',
      success: success,
      call_id: call_id,
      target_user_id: target_user_id
    };
    
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'webrtc_answer_response', response);
  } catch (error) {
    logError('Handling WebRTC answer', error);
    const response = {
      action: 'webrtc_answer_response',
      success: false,
      error: error.message
    };
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'webrtc_answer_response', response);
  }
}

async function handleICECandidate(ws, data) {
  const { call_id, candidate, target_user_id } = data;
  const currentUser = authenticate(data.token);
  
  try {
    const call = activeCalls.get(call_id);
    if (!call) {
      throw new Error('Call not found');
    }
    
    // Validate that both users are participants
    if (!call.participants.includes(currentUser.userId) || !call.participants.includes(target_user_id)) {
      throw new Error('Unauthorized participants');
    }
    
    // Forward ICE candidate to target user
    const candidateData = {
      action: 'ice_candidate',
      call_id: call_id,
      candidate: candidate,
      from_user_id: currentUser.userId
    };
    
    const success = broadcastToUser(target_user_id, candidateData);
    
    const response = {
      action: 'ice_candidate_response',
      success: success,
      call_id: call_id,
      target_user_id: target_user_id
    };
    
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'ice_candidate_response', response);
  } catch (error) {
    logError('Handling ICE candidate', error);
    const response = {
      action: 'ice_candidate_response',
      success: false,
      error: error.message
    };
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'ice_candidate_response', response);
  }
}

async function handleCallStatusUpdate(ws, data) {
  const { call_id, status, metadata } = data;
  const currentUser = authenticate(data.token);
  
  try {
    const call = activeCalls.get(call_id);
    if (!call) {
      throw new Error('Call not found');
    }
    
    // Update call status
    call.status = status;
    if (metadata) {
      call.metadata = { ...call.metadata, ...metadata };
    }
    activeCalls.set(call_id, call);
    
    // Broadcast status update to other participants
    const statusData = {
      action: 'call_status_update',
      call_id: call_id,
      status: status,
      from_user_id: currentUser.userId,
      metadata: metadata
    };
    
    call.participants.forEach(participantId => {
      if (participantId !== currentUser.userId) {
        broadcastToUser(participantId, statusData);
      }
    });
    
    const response = {
      action: 'call_status_update_response',
      success: true,
      call_id: call_id,
      status: status
    };
    
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'call_status_update_response', response);
  } catch (error) {
    logError('Handling call status update', error);
    const response = {
      action: 'call_status_update_response',
      success: false,
      error: error.message
    };
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'call_status_update_response', response);
  }
}

// Handle user disconnect during calls
function handleUserDisconnect(userId) {
  // Find all active calls where this user is a participant
  for (const [callId, call] of activeCalls.entries()) {
    if (call.participants.includes(userId)) {
      // If it's a 1-on-1 call, end it
      if (call.participants.length === 2) {
        // End the call
        pool.query(
          'UPDATE calls SET status = $1, ended_at = CURRENT_TIMESTAMP WHERE id = $2',
          ['ended', callId]
        ).catch(err => logError('Ending call on disconnect', err));
        
        // Notify other participant
        const otherParticipant = call.participants.find(p => p !== userId);
        if (otherParticipant) {
          broadcastToUser(otherParticipant, {
            action: 'call_ended',
            call_id: callId,
            ended_by: userId,
            reason: 'disconnected'
          });
        }
        
        activeCalls.delete(callId);
      } else {
        // Group call - remove participant and notify others
        call.participants = call.participants.filter(p => p !== userId);
        activeCalls.set(callId, call);
        
        // Notify remaining participants
        const leaveData = {
          action: 'participant_left',
          call_id: callId,
          user_id: userId,
          reason: 'disconnected'
        };
        
        call.participants.forEach(participantId => {
          broadcastToUser(participantId, leaveData);
        });
      }
    }
  }
}

// Additional call management functions
async function handleGetActiveCall(ws, data) {
  const currentUser = authenticate(data.token);
  
  try {
    // Find any active call for this user
    let userCall = null;
    for (const [callId, call] of activeCalls.entries()) {
      if (call.participants.includes(currentUser.userId)) {
        userCall = call;
        break;
      }
    }
    
    const response = {
      action: 'get_active_call_response',
      success: true,
      call: userCall
    };
    
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'get_active_call_response', response);
  } catch (error) {
    logError('Getting active call', error);
    const response = {
      action: 'get_active_call_response',
      success: false,
      error: error.message
    };
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'get_active_call_response', response);
  }
}

async function handleMuteCall(ws, data) {
  const { call_id, muted } = data;
  const currentUser = authenticate(data.token);
  
  try {
    const call = activeCalls.get(call_id);
    if (!call) {
      throw new Error('Call not found');
    }
    
    // Broadcast mute status to other participants
    const muteData = {
      action: 'participant_muted',
      call_id: call_id,
      user_id: currentUser.userId,
      muted: muted
    };
    
    call.participants.forEach(participantId => {
      if (participantId !== currentUser.userId) {
        broadcastToUser(participantId, muteData);
      }
    });
    
    const response = {
      action: 'mute_call_response',
      success: true,
      call_id: call_id,
      muted: muted
    };
    
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'mute_call_response', response);
  } catch (error) {
    logError('Muting call', error);
    const response = {
      action: 'mute_call_response',
      success: false,
      error: error.message
    };
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'mute_call_response', response);
  }
}

async function handleVideoToggle(ws, data) {
  const { call_id, video_enabled } = data;
  const currentUser = authenticate(data.token);
  
  try {
    const call = activeCalls.get(call_id);
    if (!call) {
      throw new Error('Call not found');
    }
    
    // Broadcast video status to other participants
    const videoData = {
      action: 'participant_video_toggled',
      call_id: call_id,
      user_id: currentUser.userId,
      video_enabled: video_enabled
    };
    
    call.participants.forEach(participantId => {
      if (participantId !== currentUser.userId) {
        broadcastToUser(participantId, videoData);
      }
    });
    
    const response = {
      action: 'video_toggle_response',
      success: true,
      call_id: call_id,
      video_enabled: video_enabled
    };
    
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'video_toggle_response', response);
  } catch (error) {
    logError('Toggling video', error);
    const response = {
      action: 'video_toggle_response',
      success: false,
      error: error.message
    };
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'video_toggle_response', response);
  }
}

// Add these new actions to the main switch statement in the WebSocket handler
// Add these cases after the existing call handlers:

/*
        case 'get_active_call':
          await handleGetActiveCall(ws, data);
          break;
        case 'mute_call':
          await handleMuteCall(ws, data);
          break;
        case 'video_toggle':
          await handleVideoToggle(ws, data);
          break;
*/

// Media upload handler (for profile pictures, status media, etc.)
async function handleUploadMedia(ws, data) {
  const { media_type, base64_data, filename } = data;
  const currentUser = authenticate(data.token);
  
  try {
    const mediaId = uuidv4();
    const fileExtension = filename ? path.extname(filename) : '.jpg';
    const fileName = `${mediaId}${fileExtension}`;
    const filePath = path.join(uploadDir, fileName);
    
    // Convert base64 to buffer and save
    const buffer = Buffer.from(base64_data, 'base64');
    fs.writeFileSync(filePath, buffer);
    
    const mediaUrl = `/uploads/${fileName}`;
    
    // Broadcast media update to the current user (and potentially others)
    await broadcastMediaUpdate(
      { 
        media_id: mediaId, 
        media_url: mediaUrl, 
        media_type: media_type 
      },
      [currentUser.userId] // Can add more recipients if needed
    );
    
    const response = {
      action: 'upload_media_response',
      success: true,
      media_id: mediaId,
      media_url: mediaUrl,
      media_type: media_type
    };
    
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'upload_media_response', response);
  } catch (error) {
    logError('Uploading media', error);
    const response = {
      action: 'upload_media_response',
      success: false,
      error: error.message
    };
    ws.send(JSON.stringify(response));
    logResponse('WebSocket', 'upload_media_response', response);
  }
}

// Enhanced user presence management
const updateUserPresence = async (userId, isOnline) => {
  try {
    await pool.query('UPDATE users SET is_online = $1 WHERE id = $2', [isOnline, userId]);
    
    // Broadcast presence update to contacts
    const contactsResult = await pool.query(`
      SELECT DISTINCT u.id
      FROM users u
      JOIN chats c ON u.id = ANY(c.participants::text[])
      WHERE $1 = ANY(c.participants::text[])
      AND u.id != $1
    `, [userId]);
    
    const presenceData = {
      action: 'user_presence_update',
      user_id: userId,
      is_online: isOnline,
      last_seen: new Date().toISOString()
    };
    
    contactsResult.rows.forEach(contact => {
      broadcastToUser(contact.id, presenceData);
    });
  } catch (error) {
    logError('Updating user presence', error);
  }
};

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 WebSocket server ready for connections`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down server...');
  
  // Close all WebSocket connections
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.close();
    }
  });
  
  // Close database connections
  await pool.end();
  
  process.exit(0);
});

// Error handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('🚨 Uncaught Exception:', error);
  process.exit(1);
});
