const WebSocket = require('ws');
const { Client } = require('pg');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
require('dotenv').config();

// Initialize WebSocket server
const wss = new WebSocket.Server({ port: 8080 });
const dbClient = new Client({
  connectionString: process.env.DATABASE_URL,
});

// Connect to database
dbClient.connect().catch(err => {
  console.error('Database connection error:', err);
  process.exit(1);
});

// Store active connections mapped to user IDs
const userConnections = {};
const typingUsers = {};

// Helper functions
function generateId() {
  return crypto.randomBytes(16).toString('hex');
}

function generateToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return null;
  }
}

function broadcastToChat(chatId, message, excludeUserId = null) {
  dbClient.query('SELECT participants FROM chats WHERE id = $1', [chatId])
    .then(res => {
      if (res.rows.length > 0) {
        const participants = JSON.parse(res.rows[0].participants);
        participants.forEach(userId => {
          if (userId !== excludeUserId && userConnections[userId]) {
            userConnections[userId].send(JSON.stringify(message));
          }
        });
      }
    })
    .catch(err => console.error('Broadcast error:', err));
}

function notifyUser (userId, message) {
  if (userConnections[userId]) {
    userConnections[userId].send(JSON.stringify(message));
  }
}

// WebSocket server event handlers
wss.on('connection', (ws) => {
  let userId = null;
  let authenticated = false;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      // Handle authentication separately
      if (data.type === 'authenticate') {
        const { token } = data.payload;
        const decoded = verifyToken(token);
        
        if (!decoded) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
          return;
        }
        
        userId = decoded.userId;
        authenticated = true;
        userConnections[userId] = ws;
        await updateOnlineStatus(userId, true);
        ws.send(JSON.stringify({ type: 'authentication_success' }));
        return;
      }

      // Authentication check for all requests except login/create account
      if (data.type !== 'login' && data.type !== 'create_account' && !authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
        return;
      }

      switch (data.type) {
        case 'create_account':
          await handleCreateAccount(ws, data.payload);
          break;
        case 'login':
          userId = await handleLogin(ws, data.payload);
          if (userId) {
            authenticated = true;
            userConnections[userId] = ws;
            await updateOnlineStatus(userId, true);
          }
          break;
        case 'create_chat':
          await handleCreateChat(userId, data.payload);
          break;
        case 'send_message':
          await handleSendMessage(userId, data.payload);
          break;
        case 'send_media':
          await handleSendMedia(userId, data.payload);
          break;
        case 'send_voice_note':
          await handleSendVoiceNote(userId, data.payload);
          break;
        case 'view_chat':
          await handleViewChat(userId, data.payload);
          break;
        case 'update_message_status':
          await handleUpdateMessageStatus(userId, data.payload);
          break;
        case 'edit_message':
          await handleEditMessage(userId, data.payload);
          break;
        case 'delete_message':
          await handleDeleteMessage(userId, data.payload);
          break;
        case 'place_call':
          await handlePlaceCall(userId, data.payload);
          break;
        case 'accept_call':
          await handleAcceptCall(userId, data.payload);
          break;
        case 'reject_call':
          await handleRejectCall(userId, data.payload);
          break;
        case 'block_user':
          await handleBlockUser (userId, data.payload);
          break;
        case 'unblock_user':
          await handleUnblockUser (userId, data.payload);
          break;
        case 'create_group':
          await handleCreateGroup(userId, data.payload);
          break;
        case 'add_user_to_group':
          await handleAddUserToGroup(userId, data.payload);
          break;
        case 'add_admin_to_group':
          await handleAddAdminToGroup(userId, data.payload);
          break;
        case 'is_typing':
          await handleTyping(userId, data.payload);
          break;
        case 'upload_status':
          await handleUploadStatus(userId, data.payload);
          break;
        case 'view_status':
          await handleViewStatus(userId, data.payload);
          break;
        default:
          ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
      }
    } catch (err) {
      console.error('Message handling error:', err);
      ws.send(JSON.stringify({ type: 'error', message: 'Internal server error' }));
    }
  });

  ws.on('close', () => {
    if (userId) {
      delete userConnections[userId];
      updateOnlineStatus(userId, false).catch(err => console.error('Online status update error:', err));
    }
  });
});
async function updateOnlineStatus(userId, isOnline) {
  try {
    // Update user's online status
    await dbClient.query(
      'UPDATE users SET is_online = $1 WHERE id = $2',
      [isOnline, userId]
    );

    // Notify contacts about the online status change
    // Using jsonb_array_elements to properly check array membership
    const chatsRes = await dbClient.query(
      `SELECT id, participants 
       FROM chats 
       WHERE $1::text = ANY(ARRAY(SELECT jsonb_array_elements_text(participants::jsonb)))`,
      [userId]
    );

    // Alternative query if the above doesn't work:
    // const chatsRes = await dbClient.query(
    //   `SELECT id, participants 
    //    FROM chats 
    //    WHERE participants::jsonb @> $1::jsonb`,
    //   [JSON.stringify([userId])]
    // );

    chatsRes.rows.forEach(chat => {
      const participants = JSON.parse(chat.participants);
      participants.forEach(participantId => {
        if (participantId !== userId && userConnections[participantId]) {
          userConnections[participantId].send(JSON.stringify({
            type: 'user_status_update',
            userId,
            isOnline
          }));
        }
      });
    });
  } catch (err) {
    console.error('Online status update error:', err);
  }
}
// Handler implementations
async function handleCreateAccount(ws, payload) {
  const { iin, name, loginCode } = payload;
  const id = generateId();
  
  try {
    await dbClient.query(
      'INSERT INTO users (id, iin, name, login_code) VALUES ($1, $2, $3, $4)',
      [id, iin, name, loginCode]
    );
    
    ws.send(JSON.stringify({ 
      type: 'account_created', 
      userId: id 
    }));
  } catch (err) {
    console.error('Account creation error:', err);
    ws.send(JSON.stringify({ 
      type: 'error', 
      message: 'Account creation failed' 
    }));
  }
}

async function handleLogin(ws, payload) {
  const { iin, loginCode } = payload;
  
  try {
    const res = await dbClient.query(
      'SELECT id FROM users WHERE iin = $1 AND login_code = $2',
      [iin, loginCode]
    );
    
    if (res.rows.length > 0) {
      const userId = res.rows[0].id;
      const token = generateToken(userId);
      
      ws.send(JSON.stringify({ 
        type: 'login_success', 
        userId,
        token
      }));
      return userId;
    } else {
      ws.send(JSON.stringify({ 
        type: 'login_failed', 
        message: 'Invalid credentials' 
      }));
      return null;
    }
  } catch (err) {
    console.error('Login error:', err);
    ws.send(JSON.stringify({ 
      type: 'error', 
      message: 'Login failed' 
    }));
    return null;
  }
}

async function handleCreateChat(userId, payload) {
  const { participantIds } = payload;
  const chatId = generateId();
  const participants = JSON.stringify([userId, ...participantIds]);
  
  try {
    await dbClient.query(
      'INSERT INTO chats (id, participants, created_by) VALUES ($1, $2, $3)',
      [chatId, participants, userId]
    );
    
    const notification = {
      type: 'new_chat',
      chatId,
      participants: JSON.parse(participants)
    };
    
    participantIds.forEach(participantId => {
      notifyUser (participantId, notification);
    });
    
    notifyUser (userId, {
      type: 'chat_created',
      chatId
    });
  } catch (err) {
    console.error('Chat creation error:', err);
    notifyUser (userId, { 
      type: 'error', 
      message: 'Chat creation failed' 
    });
  }
}

async function handleSendMessage(userId, payload) {
  const { chatId, content, isReply, repliedTo } = payload;
  const messageId = generateId();
  
  try {
    const userRes = await dbClient.query(
      'SELECT name FROM users WHERE id = $1',
      [userId]
    );
    
    if (userRes.rows.length === 0) {
      throw new Error('User  not found');
    }
    
    const senderName = userRes.rows[0].name;
    
    await dbClient.query(
      `INSERT INTO messages (id, chat_id, sender_id, sender_name, content, type, is_reply, replied_to)
       VALUES ($1, $2, $3, $4, $5, 'text', $6, $7)`,
      [messageId, chatId, userId, senderName, content, isReply, repliedTo]
    );
    
    await dbClient.query(
      `UPDATE chats 
       SET last_message_id = $1, 
           last_message_delivery_status = 'sent',
           last_message_type = 'text',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [messageId, chatId]
    );
    
    const message = {
      type: 'new_message',
      message: {
        id: messageId,
        chatId,
        senderId: userId,
        senderName,
        content,
        type: 'text',
        createdAt: new Date().toISOString(),
        isReply,
        repliedTo
      }
    };
    
    broadcastToChat(chatId, message, userId);
  } catch (err) {
    console.error('Message sending error:', err);
    notifyUser (userId, { 
      type: 'error', 
      message: 'Failed to send message' 
    });
  }
}

async function handleSendMedia(userId, payload) {
  const { chatId, mediaUrl, metadata } = payload;
  const messageId = generateId();
  const mediaId = generateId();
  
  try {
    const userRes = await dbClient.query(
      'SELECT name FROM users WHERE id = $1',
      [userId]
    );
    
    if (userRes.rows.length === 0) {
      throw new Error('User  not found');
    }
    
    const senderName = userRes.rows[0].name;
    
    await dbClient.query(
      `INSERT INTO messages (id, chat_id, sender_id, sender_name, content, type)
       VALUES ($1, $2, $3, $4, $5, 'media')`,
      [messageId, chatId, userId, senderName, mediaUrl]
    );
    
    await dbClient.query(
      `INSERT INTO media_data (id, message_id, media_url, metadata)
       VALUES ($1, $2, $3, $4)`,
      [mediaId, messageId, mediaUrl, JSON.stringify(metadata)]
    );
    
    await dbClient.query(
      `UPDATE chats 
       SET last_message_id = $1, 
           last_message_delivery_status = 'sent',
           last_message_type = 'media',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [messageId, chatId]
    );
    
    const message = {
      type: 'new_message',
      message: {
        id: messageId,
        chatId,
        senderId: userId,
        senderName,
        content: mediaUrl,
        type: 'media',
        metadata,
        createdAt: new Date().toISOString()
      }
    };
    
    broadcastToChat(chatId, message, userId);
  } catch (err) {
    console.error('Media sending error:', err);
    notifyUser (userId, { 
      type: 'error', 
      message: 'Failed to send media' 
    });
  }
}

async function handleSendVoiceNote(userId, payload) {
  const { chatId, audioUrl, duration } = payload;
  const messageId = generateId();
  
  try {
    const userRes = await dbClient.query(
      'SELECT name FROM users WHERE id = $1',
      [userId]
    );
    
    if (userRes.rows.length === 0) {
      throw new Error('User  not found');
    }
    
    const senderName = userRes.rows[0].name;
    
    await dbClient.query(
      `INSERT INTO messages (id, chat_id, sender_id, sender_name, content, type)
       VALUES ($1, $2, $3, $4, $5, 'voice_note')`,
      [messageId, chatId, userId, senderName, audioUrl]
    );
    
    await dbClient.query(
      `UPDATE chats 
       SET last_message_id = $1, 
           last_message_delivery_status = 'sent',
           last_message_type = 'voice_note',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [messageId, chatId]
    );
    
    const message = {
      type: 'new_message',
      message: {
        id: messageId,
        chatId,
        senderId: userId,
        senderName,
        content: audioUrl,
        type: 'voice_note',
        duration,
        createdAt: new Date().toISOString()
      }
    };
    
    broadcastToChat(chatId, message, userId);
  } catch (err) {
    console.error('Voice note sending error:', err);
    notifyUser (userId, { 
      type: 'error', 
      message: 'Failed to send voice note' 
    });
  }
}

async function handleViewChat(userId, payload) {
  const { chatId } = payload;
  
  try {
    const messagesRes = await dbClient.query(
      `SELECT m.*, md.metadata as media_metadata
       FROM messages m
       LEFT JOIN media_data md ON m.id = md.message_id
       WHERE m.chat_id = $1
       ORDER BY m.created_at DESC
       LIMIT 50`,
      [chatId]
    );
    
    const chatRes = await dbClient.query(
      'SELECT * FROM chats WHERE id = $1',
      [chatId]
    );
    
    if (chatRes.rows.length === 0) {
      throw new Error('Chat not found');
    }
    
    const chat = chatRes.rows[0];
    const participants = JSON.parse(chat.participants);
    
    const participantsRes = await dbClient.query(
      'SELECT id, name, profile_image, is_online FROM users WHERE id = ANY($1::text[])',
      [participants]
    );
    
    notifyUser (userId, {
      type: 'chat_view',
      chat: {
        id: chat.id,
        isGroup: chat.is_group,
        participants: participantsRes.rows,
        lastMessageId: chat.last_message_id,
        lastMessageType: chat.last_message_type,
        updatedAt: chat.updated_at
      },
      messages: messagesRes.rows.map(m => ({
        ...m,
        mediaMetadata: m.media_metadata ? JSON.parse(m.media_metadata) : null,
        deletedFor: m.deleted_for ? JSON.parse(m.deleted_for) : []
      }))
    });
  } catch (err) {
    console.error('Chat view error:', err);
    notifyUser (userId, { 
      type: 'error', 
      message: 'Failed to load chat' 
    });
  }
}

async function handleUpdateMessageStatus(userId, payload) {
  const { messageId, status } = payload;
  
  try {
    const messageRes = await dbClient.query(
      'SELECT chat_id, sender_id FROM messages WHERE id = $1',
      [messageId]
    );
    
    if (messageRes.rows.length === 0) {
      throw new Error('Message not found');
    }
    
    const chatId = messageRes.rows[0].chat_id;
    const senderId = messageRes.rows[0].sender_id;
    
    if (status === 'delivered' || status === 'read') {
      await dbClient.query(
        `UPDATE chats 
         SET last_message_delivery_status = $1
         WHERE id = $2 AND last_message_id = $3`,
        [status, chatId, messageId]
      );
    }
    
    if (senderId !== userId && userConnections[senderId]) {
      userConnections[senderId].send(JSON.stringify({
        type: 'message_status_update',
        messageId,
        status
      }));
    }
    
    if (status === 'read') {
      broadcastToChat(chatId, {
        type: 'chat_read_update',
        userId,
        messageId
      });
    }
  } catch (err) {
    console.error('Message status update error:', err);
    notifyUser (userId, { 
      type: 'error', 
      message: 'Failed to update message status' 
    });
  }
}

async function handleEditMessage(userId, payload) {
  const { messageId, newContent } = payload;
  
  try {
    const messageRes = await dbClient.query(
      'SELECT chat_id FROM messages WHERE id = $1 AND sender_id = $2',
      [messageId, userId]
    );
    
    if (messageRes.rows.length === 0) {
      throw new Error('Message not found or not authorized');
    }
    
    const chatId = messageRes.rows[0].chat_id;
    
    await dbClient.query(
      `UPDATE messages 
       SET content = $1, edited = true 
       WHERE id = $2`,
      [newContent, messageId]
    );
    
    broadcastToChat(chatId, {
      type: 'message_edited',
      messageId,
      newContent
    });
  } catch (err) {
    console.error('Message edit error:', err);
    notifyUser (userId, { 
      type: 'error', 
      message: 'Failed to edit message' 
    });
  }
}

async function handleDeleteMessage(userId, payload) {
  const { messageId, forEveryone } = payload;
  
  try {
    const messageRes = await dbClient.query(
      'SELECT chat_id, sender_id FROM messages WHERE id = $1',
      [messageId]
    );
    
    if (messageRes.rows.length === 0) {
      throw new Error('Message not found');
    }
    
    const chatId = messageRes.rows[0].chat_id;
    const senderId = messageRes.rows[0].sender_id;
    
    if (forEveryone) {
      if (senderId !== userId) {
        throw new Error('Not authorized');
      }
      
      await dbClient.query('DELETE FROM messages WHERE id = $1', [messageId]);
      
      broadcastToChat(chatId, {
        type: 'message_deleted',
        messageId,
        forEveryone: true
 });
    } else {
      await dbClient.query(
        `UPDATE messages 
         SET deleted_for = COALESCE(deleted_for, '[]')::jsonb || $1::jsonb 
         WHERE id = $2`,
        [JSON.stringify([userId]), messageId]
      );
      
      notifyUser  (senderId, {
        type: 'message_deleted',
        messageId,
        forEveryone: false
      });
    }
  } catch (err) {
    console.error('Message delete error:', err);
    notifyUser  (userId, { 
      type: 'error', 
      message: 'Failed to delete message' 
    });
  }
}

async function handlePlaceCall(userId, payload) {
  const { recipientId } = payload;
  
  try {
    if (userConnections[recipientId]) {
      notifyUser  (recipientId, {
        type: 'incoming_call',
        callerId: userId
      });
    } else {
      notifyUser  (userId, { 
        type: 'error', 
        message: 'Recipient is not online' 
      });
    }
  } catch (err) {
    console.error('Call placement error:', err);
    notifyUser  (userId, { 
      type: 'error', 
      message: 'Failed to place call' 
    });
  }
}

async function handleAcceptCall(userId, payload) {
  const { callerId } = payload;
  
  try {
    if (userConnections[callerId]) {
      notifyUser  (callerId, {
        type: 'call_accepted',
        recipientId: userId
      });
    } else {
      notifyUser  (userId, { 
        type: 'error', 
        message: 'Caller is not online' 
      });
    }
  } catch (err) {
    console.error('Call acceptance error:', err);
    notifyUser  (userId, { 
      type: 'error', 
      message: 'Failed to accept call' 
    });
  }
}

async function handleRejectCall(userId, payload) {
  const { callerId } = payload;
  
  try {
    if (userConnections[callerId]) {
      notifyUser  (callerId, {
        type: 'call_rejected',
        recipientId: userId
      });
    }
  } catch (err) {
    console.error('Call rejection error:', err);
    notifyUser  (userId, { 
      type: 'error', 
      message: 'Failed to reject call' 
    });
  }
}

async function handleBlockUser (userId, payload) {
  const { userIdToBlock } = payload;
  
  try {
    await dbClient.query(
      'UPDATE users SET blocked_users = COALESCE(blocked_users, \'[]\')::jsonb || $1::jsonb WHERE id = $2',
      [JSON.stringify([userIdToBlock]), userId]
    );
    
    notifyUser  (userId, {
      type: 'user_blocked',
      userId: userIdToBlock
    });
  } catch (err) {
    console.error('User  blocking error:', err);
    notifyUser  (userId, { 
      type: 'error', 
      message: 'Failed to block user' 
    });
  }
}

async function handleUnblockUser (userId, payload) {
  const { userIdToUnblock } = payload;
  
  try {
    await dbClient.query(
      'UPDATE users SET blocked_users = (blocked_users - $1::text[]) WHERE id = $2',
      [JSON.stringify([userIdToUnblock]), userId]
    );
    
    notifyUser  (userId, {
      type: 'user_unblocked',
      userId: userIdToUnblock
    });
  } catch (err) {
    console.error('User  unblocking error:', err);
    notifyUser  (userId, { 
      type: 'error', 
      message: 'Failed to unblock user' 
    });
  }
}

async function handleCreateGroup(userId, payload) {
  const { groupName, participantIds } = payload;
  const groupId = generateId();
  const participants = JSON.stringify([userId, ...participantIds]);
  
  try {
    await dbClient.query(
      'INSERT INTO chats (id, participants, created_by, is_group) VALUES ($1, $2, $3, true)',
      [groupId, participants, userId]
    );
    
    notifyUser  (userId, {
      type: 'group_created',
      groupId,
      participants: JSON.parse(participants)
    });
    
    participantIds.forEach(participantId => {
      notifyUser  (participantId, {
        type: 'added_to_group',
        groupId,
        addedBy: userId
      });
    });
  } catch (err) {
    console.error('Group creation error:', err);
    notifyUser  (userId, { 
      type: 'error', 
      message: 'Failed to create group' 
    });
  }
}

async function handleAddUserToGroup(userId, payload) {
  const { groupId, userIdToAdd } = payload;
  
  try {
    await dbClient.query(
      'UPDATE chats SET participants = participants || $1::text[] WHERE id = $2',
      [[userIdToAdd], groupId]
    );
    
    notifyUser  (userIdToAdd, {
      type: 'added_to_group',
      groupId,
      addedBy: userId
    });
  } catch (err) {
    console.error('Add user to group error:', err);
    notifyUser  (userId, { 
      type: 'error', 
      message: 'Failed to add user to group' 
    });
  }
}

async function handleAddAdminToGroup(userId, payload) {
  const { groupId, userIdToAdd } = payload;
  
  try {
    await dbClient.query(
      'UPDATE chats SET admins = COALESCE(admins, \'[]\')::jsonb || $1::jsonb WHERE id = $2',
      [JSON.stringify([userIdToAdd]), groupId]
    );
    
    notifyUser  (userIdToAdd, {
      type: 'made_admin',
      groupId,
      madeBy: userId
    });
  } catch (err) {
    console.error('Add admin to group error:', err);
    notifyUser  (userId, { 
      type: 'error', 
      message: 'Failed to add admin to group' 
    });
  }
}

async function handleTyping(userId, payload) {
  const { chatId } = payload;
  
  try {
    broadcastToChat(chatId, {
      type: 'user_typing',
      userId
    });
  } catch (err) {
    console.error('Typing notification error:', err);
  }
}

async function handleUploadStatus(userId, payload) {
  const { statusUrl } = payload;
  
  try {
    await dbClient.query(
      'INSERT INTO statuses (user_id, status_url, created_at) VALUES ($1, $2, CURRENT_TIMESTAMP)',
      [userId, statusUrl]
    );
    
    notifyUser  (userId, {
      type: 'status_uploaded',
      statusUrl
    });
  } catch (err) {
    console.error('Status upload error:', err);
    notifyUser  (userId, { 
      type: 'error', 
      message: 'Failed to upload status' 
    });
  }
}

async function handleViewStatus(userId, payload) {
  const { statusId } = payload;
  
  try {
    const statusRes = await dbClient.query(
      'SELECT * FROM statuses WHERE id = $1',
      [statusId]
    );
    
    if (statusRes.rows.length > 0) {
      notifyUser  (userId, {
        type: 'status_viewed',
        status: statusRes.rows[0]
      });
    } else {
      notifyUser  (userId, { 
        type: 'error', 
        message: 'Status not found' 
      });
    }
  } catch (err) {
    console.error('Status view error:', err);
    notifyUser  (userId, { 
      type: 'error', 
      message: 'Failed to view status' 
    });
  }
}

// Start the server
console.log('WebSocket server is running on ws://localhost:8080');

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  await dbClient.end();
  wss.close();
  process.exit();
});