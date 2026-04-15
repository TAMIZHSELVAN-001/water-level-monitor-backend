// ════════════════════════════════════════════════════════════
// 🌊 WATER LEVEL MONITOR - BACKEND API WITH SWAGGER
// Node.js + Express + PostgreSQL + Swagger UI
// ════════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
const adminRoutes = require('./routes/admin');
const { Expo } = require('expo-server-sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'dev-api-key';

// ══════════════════════════════════════════════════════════
// 🔌 DATABASE CONNECTION
// ══════════════════════════════════════════════════════════

const dbConfig = (() => {
  if (process.env.DATABASE_URL) {
    try {
      new URL(process.env.DATABASE_URL);
      return {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }  // required for Supabase
      };
    } catch (err) {
      console.error('⚠️ Invalid DATABASE_URL:', err.message);
      console.error('⚠️ Falling back to DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD configuration.');
    }
  }

  const config = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'water_level2',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
  };
  
  // Warn if using localhost in production
  if (config.host === 'localhost' && process.env.NODE_ENV === 'production') {
    console.warn('⚠️⚠️⚠️ WARNING: Using localhost in PRODUCTION! Set DB_HOST or DATABASE_URL env vars.');
  }
  
  console.log('📊 Using DB Config:', {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password ? '****' : '(empty)',
    ssl: config.ssl ? 'enabled' : 'disabled'
  });
  
  return config;
})();

const pool = new Pool(dbConfig);

module.exports = pool

pool.on('connect', () => console.log('✅ PostgreSQL connected'));
pool.on('error', (err) => console.error('❌ PostgreSQL pool error:', err?.message || err));

// Test connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Database connection failed:', err?.message || JSON.stringify(err));
  } else {
    console.log('✅ Database connection successful:', res.rows[0].now);
  }
});

// ══════════════════════════════════════════════════════════
// 📲 EXPO PUSH NOTIFICATIONS SETUP
// ══════════════════════════════════════════════════════════

const expo = new Expo();

// Create push_tokens table if it doesn't exist
pool.query(`
  CREATE TABLE IF NOT EXISTS push_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id)
  )
`).then(() => {
  console.log('✅ push_tokens table ready');
}).catch((err) => {
  console.error('❌ push_tokens table error:', err?.message || JSON.stringify(err));
});

// Track cooldowns in memory: { "userId-low": timestamp, "userId-high": timestamp }
const pushCooldowns = {};
const PUSH_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes default

/**
 * Send an Expo push notification to a user.
 * Respects their alert_settings cooldown and enable_push flag.
 */
async function sendPushToUser(userId, title, body, data = {}) {
  try {
    // Check if push is enabled for this user
    const settingsResult = await pool.query(
      'SELECT enable_push, notification_cooldown_minutes FROM alert_settings WHERE user_id = $1',
      [userId]
    );
    if (!settingsResult.rows.length) return;
    const { enable_push, notification_cooldown_minutes } = settingsResult.rows[0];
    if (!enable_push) {
      console.log(`📵 Push disabled for user ${userId}`);
      return;
    }

    // Check cooldown per user+type
    const cooldownKey = `${userId}-${data.type || 'alert'}`;
    const cooldownMs = (notification_cooldown_minutes || 10) * 60 * 1000;
    const lastSent = pushCooldowns[cooldownKey] || 0;
    if (Date.now() - lastSent < cooldownMs) {
      console.log(`⏳ Push cooldown active for user ${userId} type ${data.type}`);
      return;
    }
    pushCooldowns[cooldownKey] = Date.now();

    // Fetch push token
    const tokenResult = await pool.query(
      'SELECT token FROM push_tokens WHERE user_id = $1',
      [userId]
    );
    if (!tokenResult.rows.length) {
      console.log(`⚠️ No push token for user ${userId}`);
      return;
    }
    const token = tokenResult.rows[0].token;

    if (!Expo.isExpoPushToken(token)) {
      console.error(`❌ Invalid Expo push token for user ${userId}: ${token}`);
      return;
    }

    const messages = [{
      to: token,
      sound: 'default',
      title,
      body,
      data,
      priority: data.priority || 'high',
    }];

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      console.log(`📲 Push sent to user ${userId}:`, receipts);
    }
  } catch (err) {
    console.error(`❌ sendPushToUser error for user ${userId}:`, err.message);
  }
}

// ══════════════════════════════════════════════════════════
// 🔧 MIDDLEWARE
// ══════════════════════════════════════════════════════════
  
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'Authorization'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.use((req, res, next) => {
  req.db = pool;  // Your PostgreSQL pool
  next();
});

app.use('/admin', adminRoutes);

// ══════════════════════════════════════════════════════════
// 📚 SWAGGER CONFIGURATION
// ══════════════════════════════════════════════════════════

const swaggerDefinition = {
  openapi: "3.0.0",
  info: {
    title: "Water Tank API",
    version: "1.0.0",
  },
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: "apiKey",
        in: "header",
        name: "x-api-key"
      }
    },
    schemas: {
      User: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          email: { type: "string" }
        }
      },
      WaterLevel: {
        type: "object",
        properties: {
          id: { type: "integer" },
          level_cm: { type: "number" },
          created_at: { type: "string" }
        }
      },
      Settings: {
        type: "object",
        properties: {
          min_level_cm: { type: "number" },
          max_level_cm: { type: "number" }
        }
      },
      Error: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          message: { type: "string" }
        }
      }
    }
  },
  security: [
    {
      ApiKeyAuth: []
    }
  ]
};

const swaggerOptions = {
  definition: {
    openapi: "3.0.0",

    info: {
      title: "Water Level Monitor API",
      version: "1.0.0",
      description: "Water Tank Monitoring API",
    },

    servers: [
      {
        url: 'https://water-level-monitor-backend-1.onrender.com',
        description: 'Production server'
      },
      {
        url: `http://localhost:${PORT}`,
        description: 'Local development'
      } 
    ],

    components: {

      securitySchemes: {
        ApiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "x-api-key",
        },
      },

      schemas: {

        User: {
          type: "object",
          properties: {
            user_id: {
              type: "integer",
              example: 1,
            },
            name: {
              type: "string",
              example: "Tamizhselvan",
            },
            mobile_no: {
              type: "string",
              example: "9876543210",
            },
            e_mail: {
              type: "string",
              example: "user@gmail.com",
            },
            created_at: {
              type: "string",
              example: "2026-03-02T10:00:00Z",
            },
            is_admin: {
              type: "boolean",
              example: false,
            },
          },
        },

        Error: {
          type: "object",
          properties: {
            success: {
              type: "boolean",
              example: false,
            },
            message: {
              type: "string",
              example: "Error message",
            },
          },
        },

        WaterLevel: {
          type: "object",
          properties: {
            log_id: {
              type: "integer",
              example: 1,
            },
            user_id: {
              type: "integer",
              example: 1,
            },
            tank_id: {
              type: "integer",
              example: 1,
            },
            water_level: {
              type: "number",
              example: 75.5,
            },
            volume_liters: {
              type: "number",
              example: 755,
            },
            sensor_reading: {
              type: "number",
              example: 385,
            },
            timestamp: {
              type: "string",
              example: "2026-03-02T10:00:00Z",
            },
          },
        },

        Settings: {
          type: "object",
          properties: {
            setting_id: {
              type: "integer",
              example: 1,
            },
            user_id: {
              type: "integer",
              example: 1,
            },
            high_threshold: {
              type: "number",
              example: 80,
            },
            low_threshold: {
              type: "number",
              example: 20,
            },
            enable_push: {
              type: "boolean",
              example: true,
            },
            enable_email: {
              type: "boolean",
              example: true,
            },
            notification_cooldown_minutes: {
              type: "integer",
              example: 10,
            },
          },
        },

      },

    },

  },

  apis: ["./app.js"],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

// Swagger UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'Water Level Monitor API',
  customfavIcon: '/favicon.ico',
  swaggerOptions: {
    persistAuthorization: true,
  },
}));

// Swagger JSON
app.get('/api-docs.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

// API key validation for protected routes
const requireApiKey = (req, res, next) => {
  const headerApiKey = req.get('x-api-key');
  const authHeader = req.get('authorization');
  const queryApiKey = req.query.api_key;
  let requestApiKey = headerApiKey || queryApiKey;

  // Allow "Authorization: Bearer <key>" or "Authorization: ApiKey <key>" as fallback.
  if (!requestApiKey && authHeader) {
    const match = authHeader.match(/^(?:Bearer|ApiKey)\s+(.+)$/i);
    requestApiKey = match ? match[1] : authHeader;
  }

  // Dev fallback: allow Swagger UI "Try it out" from /api-docs without manual header.
  // This keeps local testing smooth when Swagger UI auth state is lost.
  if (!requestApiKey && process.env.NODE_ENV !== 'production') {
    const referer = req.get('referer') || '';
    if (referer.includes('/api-docs')) {
      requestApiKey = API_KEY;
    }
  }

  if (!requestApiKey) {
    return res.status(401).json({
      success: false,
      message: 'Missing API key. Use Swagger Authorize or add x-api-key header.',
    });
  }

  if (requestApiKey !== API_KEY) {
    return res.status(403).json({
      success: false,
      message: 'Invalid API key.',
    });
  }

  next();
};

if (!process.env.API_KEY) {
  console.warn('⚠️ API_KEY is not set in .env. Using dev fallback key: dev-api-key');
}

app.use('/api', requireApiKey);

// ══════════════════════════════════════════════════════════
// 📲 PUSH TOKEN ROUTES
// ══════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/push-token:
 *   post:
 *     summary: Save Expo push token
 *     description: Register or update a device's Expo push notification token
 *     tags: [Notifications]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - user_id
 *               - token
 *             properties:
 *               user_id:
 *                 type: integer
 *                 example: 1
 *               token:
 *                 type: string
 *                 example: ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]
 *     responses:
 *       200:
 *         description: Token saved successfully
 *       400:
 *         description: Missing user_id or token
 */
app.post('/api/push-token', async (req, res) => {
  try {
    const { user_id, token } = req.body;

    if (!user_id || !token) {
      return res.status(400).json({
        success: false,
        message: 'user_id and token are required',
      });
    }

    if (!Expo.isExpoPushToken(token)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Expo push token format',
      });
    }

    await pool.query(
      `INSERT INTO push_tokens (user_id, token, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET token = EXCLUDED.token, updated_at = NOW()`,
      [user_id, token]
    );

    console.log(`✅ Push token saved for user ${user_id}`);
    res.json({ success: true, message: 'Push token saved' });

  } catch (error) {
    console.error('❌ Save push token error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to save push token',
      error: error.message,
    });
  }
});

/**
 * @swagger
 * /api/push-token/{user_id}:
 *   delete:
 *     summary: Remove Expo push token
 *     description: Unregister a device's push token (on logout)
 *     tags: [Notifications]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: user_id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Token removed
 */
app.delete('/api/push-token/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params;
    await pool.query('DELETE FROM push_tokens WHERE user_id = $1', [user_id]);
    console.log(`🗑️ Push token removed for user ${user_id}`);
    res.json({ success: true, message: 'Push token removed' });
  } catch (error) {
    console.error('❌ Remove push token error:', error);
    res.status(500).json({ success: false, message: 'Failed to remove token' });
  }
});

// ══════════════════════════════════════════════════════════
// 🏥 HEALTH CHECK
// ══════════════════════════════════════════════════════════

/**
 * @swagger
 * /health:
 *   get:
 *     security: []
 *     summary: Health check endpoint
 *     description: Check if API and database are running
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: API is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: healthy
 *                 service:
 *                   type: string
 *                   example: Water Level Monitor API
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 database:
 *                   type: string
 *                   example: connected
 *       500:
 *         description: API is unhealthy
 */
app.get('/health', async (req, res) => {
  try {
    const dbResult = await pool.query('SELECT NOW()');
    res.json({
      status: 'healthy',
      service: 'Water Level Monitor API',
      timestamp: new Date().toISOString(),
      database: 'connected',
      dbTime: dbResult.rows[0].now,
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      service: 'Water Level Monitor API',
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      error: error.message,
    });
  }
});

// ══════════════════════════════════════════════════════════
// 🔐 AUTHENTICATION ROUTES
// ══════════════════════════════════════════════════════════

/**
 * @swagger
 * /users:
 *   post:
 *     security: []
 *     summary: Register a new user
 *     description: Create a new user account with email and password
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - e_mail
 *               - password
 *             properties:
 *               name:
 *                 type: string
 *                 example: John Doe
 *               mobile_no:
 *                 type: string
 *                 example: "9876543210"
 *               e_mail:
 *                 type: string
 *                 format: email
 *                 example: john@example.com
 *               password:
 *                 type: string
 *                 format: password
 *                 example: Test@1234
 *                 description: Min 8 chars with uppercase, lowercase, number, and special character
 *     responses:
 *       201:
 *         description: User registered successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: User registered successfully
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       400:
 *         description: Invalid input or email already exists
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.post('/users', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { name, mobile_no, e_mail, password } = req.body;

    console.log('📝 Registration request:', { name, mobile_no, e_mail });

    if (!name || !e_mail || !password) {
      return res.status(400).json({
        success: false,
        message: 'Name, email, and password are required',
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(e_mail)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format',
      });
    }

    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&]).{8,}$/;
    if (!passwordRegex.test(password)) {
      return res.status(400).json({
        success: false,
        message: 'Password must be 8+ characters with uppercase, lowercase, number, and special character',
      });
    }

    const existingUser = await client.query(
      'SELECT user_id FROM users WHERE e_mail = $1',
      [e_mail.toLowerCase()]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Email already registered',
      });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    await client.query('BEGIN');

    const userResult = await client.query(
      `INSERT INTO users (name, mobile_no, e_mail, password, created_by, modified_by)
       VALUES ($1, $2, $3, $4, 'App', 'App')
       RETURNING user_id, name, mobile_no, e_mail, created_at`,
      [name, mobile_no || null, e_mail.toLowerCase(), hashedPassword]
    );

    const user = userResult.rows[0];
    console.log('✅ User created:', user.user_id);

    const tankResult = await client.query(
      `INSERT INTO tanks (user_id, tank_name, capacity_liters, height_cm, location)
       VALUES ($1, 'Main Tank', 1000, 200, 'Default Location')
       RETURNING tank_id`,
      [user.user_id]
    );

    const tank = tankResult.rows[0];

    await client.query(
      `INSERT INTO alert_settings (user_id, tank_id, high_threshold, low_threshold, enable_push, enable_email)
       VALUES ($1, $2, 80, 20, true, true)`,
      [user.user_id, tank.tank_id]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      user: {
        user_id: user.user_id,
        name: user.name,
        mobile_no: user.mobile_no,
        e_mail: user.e_mail,
        created_at: user.created_at,
      },
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Registration error:', error);
    res.status(500).json({
      success: false,
      message: 'Registration failed',
      error: error.message,
    });
  } finally {
    client.release();
  }
});

/**
 * @swagger
 * /users/login:
 *   post:
 *     security: []
 *     summary: User login
 *     description: Authenticate user with email and password
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - e_mail
 *               - password
 *             properties:
 *               e_mail:
 *                 type: string
 *                 format: email
 *                 example: test@example.com
 *               password:
 *                 type: string
 *                 format: password
 *                 example: Test@1234
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Login successful
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       400:
 *         description: Invalid credentials
 *       404:
 *         description: User not found
 */
app.post('/users/login', async (req, res) => {
  try {
    const { e_mail, password } = req.body;

    console.log('🔑 Login request received');
    console.log('   Body:', req.body);
    console.log('   e_mail:', e_mail);
    console.log('   password:', password);

    if (!e_mail || !password) {
      console.log('❌ Missing e_mail or password');
      return res.status(400).json({
        success: false,
        message: 'Email and password are required',
      });
    }

    const result = await pool.query(
      'SELECT * FROM users WHERE e_mail = $1 AND is_active = TRUE',
      [e_mail.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No account found with this email',
      });
    }

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: 'Invalid password',
      });
    }

    console.log('✅ Login successful:', user.user_id);

    res.json({
      success: true,
      message: 'Login successful',
      user: {
        user_id: user.user_id,
        name: user.name,
        e_mail: user.e_mail,
        mobile_no: user.mobile_no,
        created_at: user.created_at,
        is_admin: Boolean(user.is_admin),
        is_active: Boolean(user.is_active),
      },
    });

  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Login failed',
      error: error.message,
    });
  }
});

// ════════════════════════════════════════════════════════════
// 👨‍💼 ADMIN API ROUTES
// backend/routes/admin.js
// Add this to your server.js
// ════════════════════════════════════════════════════════════
// Legacy inline admin routes kept for reference. Active routes live in ./routes/admin.
if (false) {
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

// ══════════════════════════════════════════════════════════
// 🔐 ADMIN MIDDLEWARE
// ══════════════════════════════════════════════════════════

// Simple admin check - improve this for production
const isAdmin = async (req, res, next) => {
  try {
    const userId = req.headers['x-user-id'];
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized - No user ID'
      });
    }

    // Check if user is admin (you can add is_admin column to users table)
    const result = await req.db.query(
      'SELECT is_admin FROM users WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length === 0 || !result.rows[0].is_admin) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden - Admin access required'
      });
    }

    next();
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Admin check failed',
      error: error.message
    });
  }
};

// ══════════════════════════════════════════════════════════
// 👥 USER MANAGEMENT ENDPOINTS
// ══════════════════════════════════════════════════════════

/**
 * @swagger
 * /admin/users:
 *   get:
 *     summary: Get all users (Admin only)
 *     tags: [Admin]
 *     responses:
 *       200:
 *         description: List of all users
 */
router.get('/users', isAdmin, async (req, res) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT 
        u.user_id,
        u.name,
        u.e_mail,
        u.mobile_no,
        u.created_at,
        u.is_active,
        COUNT(DISTINCT t.tank_id) as tank_count,
        MAX(wl.timestamp) as last_reading
      FROM users u
      LEFT JOIN tanks t ON u.user_id = t.user_id AND t.is_active = TRUE
      LEFT JOIN water_level_logs wl ON u.user_id = wl.user_id
      WHERE 1=1
    `;

    const params = [];

    if (search) {
      query += ` AND (u.name ILIKE $1 OR u.e_mail ILIKE $1)`;
      params.push(`%${search}%`);
    }

    query += `
      GROUP BY u.user_id
      ORDER BY u.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    params.push(limit, offset);

    const result = await req.db.query(query, params);

    // Get total count
    const countResult = await req.db.query(
      'SELECT COUNT(*) FROM users WHERE is_active = TRUE'
    );

    res.json({
      success: true,
      data: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count)
      }
    });

  } catch (error) {
    console.error('❌ Get users error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get users',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /admin/users/{id}:
 *   get:
 *     summary: Get user details (Admin only)
 *     tags: [Admin]
 */
router.get('/users/:id', isAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await req.db.query(
      `SELECT 
        u.user_id,
        u.name,
        u.e_mail,
        u.mobile_no,
        u.created_at,
        u.is_active,
        u.modified_at
      FROM users u
      WHERE u.user_id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Get user's tanks
    const tanksResult = await req.db.query(
      `SELECT * FROM tanks WHERE user_id = $1 AND is_active = TRUE`,
      [id]
    );

    res.json({
      success: true,
      user: result.rows[0],
      tanks: tanksResult.rows
    });

  } catch (error) {
    console.error('❌ Get user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get user',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /admin/users/{id}:
 *   put:
 *     summary: Update user (Admin only)
 *     tags: [Admin]
 */
router.put('/users/:id', isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, e_mail, mobile_no, is_active } = req.body;

    const result = await req.db.query(
      `UPDATE users 
       SET name = $1,
           e_mail = $2,
           mobile_no = $3,
           is_active = $4,
           modified_at = NOW()
       WHERE user_id = $5
       RETURNING user_id, name, e_mail, mobile_no, is_active`,
      [name, e_mail, mobile_no, is_active !== undefined ? is_active : true, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      message: 'User updated successfully',
      user: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Update user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update user',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /admin/users/{id}:
 *   delete:
 *     summary: Delete user (Admin only)
 *     tags: [Admin]
 */
router.delete('/users/:id', isAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Soft delete - set is_active to false
    const result = await req.db.query(
      `UPDATE users 
       SET is_active = FALSE,
           modified_at = NOW()
       WHERE user_id = $1
       RETURNING user_id, name, e_mail`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      message: 'User deleted successfully',
      user: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Delete user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete user',
      error: error.message
    });
  }
});

// ══════════════════════════════════════════════════════════
// 🚰 TANK MANAGEMENT ENDPOINTS
// ══════════════════════════════════════════════════════════

/**
 * @swagger
 * /admin/tanks:
 *   get:
 *     summary: Get all tanks (Admin only)
 *     tags: [Admin]
 */
router.get('/tanks', isAdmin, async (req, res) => {
  try {
    const { user_id, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT 
        t.*,
        u.name as user_name,
        u.e_mail,
        (SELECT water_level FROM water_level_logs 
         WHERE tank_id = t.tank_id 
         ORDER BY timestamp DESC LIMIT 1) as current_level,
        (SELECT timestamp FROM water_level_logs 
         WHERE tank_id = t.tank_id 
         ORDER BY timestamp DESC LIMIT 1) as last_update
      FROM tanks t
      JOIN users u ON t.user_id = u.user_id
      WHERE t.is_active = TRUE
    `;

    const params = [];

    if (user_id) {
      query += ` AND t.user_id = $1`;
      params.push(user_id);
    }

    query += `
      ORDER BY t.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    params.push(limit, offset);

    const result = await req.db.query(query, params);

    res.json({
      success: true,
      data: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit)
      }
    });

  } catch (error) {
    console.error('❌ Get tanks error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get tanks',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /admin/tanks:
 *   post:
 *     summary: Create new tank (Admin only)
 *     tags: [Admin]
 */
router.post('/tanks', isAdmin, async (req, res) => {
  const client = await req.db.connect();
  
  try {
    const { 
      user_id, 
      tank_name, 
      capacity_liters, 
      height_cm, 
      location,
      description 
    } = req.body;

    // Validate required fields
    if (!user_id || !tank_name || !capacity_liters || !height_cm) {
      return res.status(400).json({
        success: false,
        message: 'user_id, tank_name, capacity_liters, and height_cm are required'
      });
    }

    // Check if user exists
    const userCheck = await client.query(
      'SELECT user_id FROM users WHERE user_id = $1 AND is_active = TRUE',
      [user_id]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    await client.query('BEGIN');

    // Insert tank
    const tankResult = await client.query(
      `INSERT INTO tanks (
        user_id, 
        tank_name, 
        capacity_liters, 
        height_cm, 
        location,
        description
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [user_id, tank_name, capacity_liters, height_cm, location || null, description || null]
    );

    const tank = tankResult.rows[0];

    // Create default alert settings for this tank
    await client.query(
      `INSERT INTO alert_settings (
        user_id,
        tank_id,
        high_threshold,
        low_threshold,
        enable_push,
        enable_email
      )
      VALUES ($1, $2, 80, 20, true, true)`,
      [user_id, tank.tank_id]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'Tank created successfully',
      tank: tank
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Create tank error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create tank',
      error: error.message
    });
  } finally {
    client.release();
  }
});

/**
 * @swagger
 * /admin/tanks/{id}:
 *   put:
 *     summary: Update tank (Admin only)
 *     tags: [Admin]
 */
router.put('/tanks/:id', isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { tank_name, capacity_liters, height_cm, location, description, is_active } = req.body;

    const result = await req.db.query(
      `UPDATE tanks 
       SET tank_name = COALESCE($1, tank_name),
           capacity_liters = COALESCE($2, capacity_liters),
           height_cm = COALESCE($3, height_cm),
           location = COALESCE($4, location),
           description = COALESCE($5, description),
           is_active = COALESCE($6, is_active),
           modified_at = NOW()
       WHERE tank_id = $7
       RETURNING *`,
      [tank_name, capacity_liters, height_cm, location, description, is_active, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Tank not found'
      });
    }

    res.json({
      success: true,
      message: 'Tank updated successfully',
      tank: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Update tank error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update tank',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /admin/tanks/{id}:
 *   delete:
 *     summary: Delete tank (Admin only)
 *     tags: [Admin]
 */
router.delete('/tanks/:id', isAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Soft delete
    const result = await req.db.query(
      `UPDATE tanks 
       SET is_active = FALSE,
           modified_at = NOW()
       WHERE tank_id = $1
       RETURNING tank_id, tank_name`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Tank not found'
      });
    }

    res.json({
      success: true,
      message: 'Tank deleted successfully',
      tank: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Delete tank error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete tank',
      error: error.message
    });
  }
});

// ══════════════════════════════════════════════════════════
// 📊 ADMIN STATISTICS
// ══════════════════════════════════════════════════════════

/**
 * @swagger
 * /admin/stats:
 *   get:
 *     summary: Get system statistics (Admin only)
 *     tags: [Admin]
 */
router.get('/stats', isAdmin, async (req, res) => {
  try {
    // Total users
    const usersResult = await req.db.query(
      'SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE is_active = TRUE) as active FROM users'
    );

    // Total tanks
    const tanksResult = await req.db.query(
      'SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE is_active = TRUE) as active FROM tanks'
    );

    // Total readings today
    const readingsResult = await req.db.query(
      `SELECT COUNT(*) as count 
       FROM water_level_logs 
       WHERE timestamp >= CURRENT_DATE`
    );

    // Critical alerts (tanks below 20% or above 80%)
    const alertsResult = await req.db.query(
      `SELECT COUNT(*) as count
       FROM (
         SELECT DISTINCT ON (tank_id) tank_id, water_level
         FROM water_level_logs
         ORDER BY tank_id, timestamp DESC
       ) latest
       WHERE water_level < 20 OR water_level > 80`
    );

    res.json({
      success: true,
      stats: {
        users: {
          total: parseInt(usersResult.rows[0].total),
          active: parseInt(usersResult.rows[0].active)
        },
        tanks: {
          total: parseInt(tanksResult.rows[0].total),
          active: parseInt(tanksResult.rows[0].active)
        },
        readings_today: parseInt(readingsResult.rows[0].count),
        critical_alerts: parseInt(alertsResult.rows[0].count)
      }
    });

  } catch (error) {
    console.error('❌ Get stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get statistics',
      error: error.message
    });
  }
});

module.exports = router;
}

// ══════════════════════════════════════════════════════════
// 💧 WATER LEVEL ROUTES
// ══════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/water-level/current:
 *   get:
 *     summary: Get current water level
 *     description: Get the most recent water level reading for a user
 *     tags: [Water Level]
 *     parameters:
 *       - in: query
 *         name: user_id
 *         required: true
 *         schema:
 *           type: integer
 *         description: User ID
 *         example: 1
 *     responses:
 *       200:
 *         description: Current water level data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   $ref: '#/components/schemas/WaterLevel'
 *       400:
 *         description: Missing user_id parameter
 */
app.get('/api/water-level/current', async (req, res) => {
  try {
    const { user_id } = req.query;

    console.log('📊 Water level request received');
    console.log('   Query params:', req.query);
    console.log('   user_id:', user_id);

    if (!user_id) {
      console.log('❌ Missing user_id in water level request');
      return res.status(400).json({
        success: false,
        message: 'user_id is required',
        received: { user_id },
      });
    }

    const result = await pool.query(
      `SELECT 
        wl.log_id,
        wl.water_level,
        wl.volume_liters,
        wl.sensor_reading,
        wl.timestamp,
        t.tank_id,
        t.tank_name,
        t.capacity_liters,
        t.height_cm
       FROM water_level_logs wl
       JOIN tanks t ON wl.tank_id = t.tank_id
       WHERE wl.user_id = $1 AND wl.is_active = TRUE
       ORDER BY wl.timestamp DESC
       LIMIT 1`,
      [user_id]
    );

    if (result.rows.length === 0) {
      console.log('⚠️ No water level data for user:', user_id);
      return res.json({
        success: true,
        message: 'No data available yet',
        water_level: 50,
        tank_name: 'Main Tank',
      });
    }

    console.log('✅ Water level retrieved for user:', user_id);
    res.json({
      success: true,
      data: result.rows[0],
    });

  } catch (error) {
    console.error('❌ Get current level error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get water level',
      error: error.message,
    });
  }
});

/**
 * @swagger
 * /api/water-level/history:
 *   get:
 *     summary: Get water level history
 *     description: Get historical water level readings for a specific time period
 *     tags: [Water Level]
 *     parameters:
 *       - in: query
 *         name: user_id
 *         required: true
 *         schema:
 *           type: integer
 *         example: 1
 *       - in: query
 *         name: period
 *         required: false
 *         schema:
 *           type: string
 *           enum: [1h, 24h, 7d, 30d]
 *           default: 24h
 *         example: 24h
 *         description: Time period for history
 *     responses:
 *       200:
 *         description: Historical water level data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 count:
 *                   type: integer
 *                   example: 24
 *                 period:
 *                   type: string
 *                   example: 24h
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/WaterLevel'
 */
app.get('/api/water-level/history', async (req, res) => {
  try {
    const { user_id, period = '24h' } = req.query;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        message: 'user_id is required',
      });
    }

    const periodMap = {
      '1h': '1 hour',
      '24h': '24 hours',
      '7d': '7 days',
      '30d': '30 days',
    };

    const interval = periodMap[period] || '24 hours';

    const result = await pool.query(
      `SELECT 
        wl.log_id,
        wl.water_level,
        wl.volume_liters,
        wl.sensor_reading,
        wl.timestamp,
        t.tank_name
       FROM water_level_logs wl
       JOIN tanks t ON wl.tank_id = t.tank_id
       WHERE wl.user_id = $1 
         AND wl.is_active = TRUE
         AND wl.timestamp >= NOW() - INTERVAL '${interval}'
       ORDER BY wl.timestamp DESC`,
      [user_id]
    );

    res.json({
      success: true,
      count: result.rows.length,
      period: period,
      data: result.rows,
    });

  } catch (error) {
    console.error('❌ Get history error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get history',
      error: error.message,
    });
  }
});

/**
 * @swagger
 * /api/water-level/reading:
 *   post:
 *     summary: Add water level reading
 *     description: Record a new water level measurement from sensor
 *     tags: [Water Level]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - user_id
 *               - water_level
 *             properties:
 *               user_id:
 *                 type: integer
 *                 example: 1
 *               tank_id:
 *                 type: integer
 *                 example: 1
 *                 description: Optional - uses default tank if not provided
 *               water_level:
 *                 type: number
 *                 format: float
 *                 minimum: 0
 *                 maximum: 100
 *                 example: 75.5
 *                 description: Water level percentage (0-100)
 *               sensor_reading:
 *                 type: number
 *                 format: float
 *                 example: 385.2
 *                 description: Raw sensor value
 *     responses:
 *       201:
 *         description: Reading saved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Reading saved successfully
 *                 data:
 *                   $ref: '#/components/schemas/WaterLevel'
 *       400:
 *         description: Invalid input
 */
app.post('/api/water-level/reading', async (req, res) => {
  try {
    const { user_id, tank_id, water_level, sensor_reading } = req.body;

    console.log('💧 New reading:', { user_id, water_level });

    if (!user_id || water_level === undefined) {
      return res.status(400).json({
        success: false,
        message: 'user_id and water_level are required',
      });
    }

    if (water_level < 0 || water_level > 100) {
      return res.status(400).json({
        success: false,
        message: 'water_level must be between 0 and 100',
      });
    }

    let finalTankId = tank_id;
    let capacity = null;

    if (!finalTankId) {
      const tankResult = await pool.query(
        'SELECT tank_id, capacity_liters FROM tanks WHERE user_id = $1 AND is_active = TRUE LIMIT 1',
        [user_id]
      );

      if (tankResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'No tank found for user',
        });
      }

      finalTankId = tankResult.rows[0].tank_id;
      capacity = tankResult.rows[0].capacity_liters;
    } else {
      const tankResult = await pool.query(
        'SELECT capacity_liters FROM tanks WHERE tank_id = $1',
        [finalTankId]
      );
      capacity = tankResult.rows[0]?.capacity_liters;
    }

    const volumeLiters = capacity ? (water_level / 100) * capacity : null;

    const result = await pool.query(
      `INSERT INTO water_level_logs (tank_id, user_id, water_level, volume_liters, sensor_reading)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [finalTankId, user_id, water_level, volumeLiters, sensor_reading || null]
    );

    console.log('✅ Reading saved:', result.rows[0].log_id);

    // ── 🔔 THRESHOLD CHECK → SEND PUSH NOTIFICATION ──────────────────────
    // Run async — don't block the response to the IoT sensor
    (async () => {
      try {
        const settingsResult = await pool.query(
          'SELECT high_threshold, low_threshold, enable_push FROM alert_settings WHERE user_id = $1',
          [user_id]
        );
        if (!settingsResult.rows.length) return;

        const { high_threshold, low_threshold, enable_push } = settingsResult.rows[0];
        if (!enable_push) return;

        const tankResult = await pool.query(
          'SELECT tank_name FROM tanks WHERE tank_id = $1',
          [finalTankId]
        );
        const tankName = tankResult.rows[0]?.tank_name || 'Main Tank';

        if (water_level <= low_threshold) {
          console.log(`🚨 Low water alert: user ${user_id}, tank ${tankName}, level ${water_level}%`);
          await sendPushToUser(
            user_id,
            '🚨 Critical Low Water Level!',
            `${tankName}: ${water_level}% (Below ${low_threshold}%) — Refill needed immediately!`,
            { type: 'low_water', level: water_level, threshold: low_threshold, tankName, priority: 'high' }
          );
        } else if (water_level >= high_threshold) {
          console.log(`⚠️ High water alert: user ${user_id}, tank ${tankName}, level ${water_level}%`);
          await sendPushToUser(
            user_id,
            '⚠️ High Water Level Alert',
            `${tankName}: ${water_level}% (Above ${high_threshold}%) — Stop filling!`,
            { type: 'high_water', level: water_level, threshold: high_threshold, tankName, priority: 'high' }
          );
        }
      } catch (alertErr) {
        console.error('❌ Threshold alert error:', alertErr.message);
      }
    })();
    // ─────────────────────────────────────────────────────────────────────

    res.status(201).json({
      success: true,
      message: 'Reading saved successfully',
      data: result.rows[0],
    });

  } catch (error) {
    console.error('❌ Add reading error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to save reading',
      error: error.message,
    });
  }
});


// ══════════════════════════════════════════════════════════
// ⚙️ SETTINGS ROUTES
// ══════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/settings/get:
 *   get:
 *     summary: Get alert settings
 *     description: Get user's alert preferences and thresholds
 *     tags: [Settings]
 *     parameters:
 *       - in: query
 *         name: user_id
 *         required: true
 *         schema:
 *           type: integer
 *         example: 1
 *     responses:
 *       200:
 *         description: User settings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   $ref: '#/components/schemas/Settings'
 */
app.get('/api/settings/get', async (req, res) => {
  try {
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        message: 'user_id is required',
      });
    }

    const result = await pool.query(
      `SELECT * FROM alert_settings WHERE user_id = $1 LIMIT 1`,
      [user_id]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        message: 'No settings found, using defaults',
        data: {
          high_threshold: 80,
          low_threshold: 20,
          enable_push: true,
          enable_email: true,
          notification_cooldown_minutes: 10,
        },
      });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });

  } catch (error) {
    console.error('❌ Get settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get settings',
      error: error.message,
    });
  }
});

/**
 * @swagger
 * /api/settings/post:
 *   post:
 *     summary: Update alert settings
 *     description: Update user's alert preferences and thresholds
 *     tags: [Settings]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - user_id
 *             properties:
 *               user_id:
 *                 type: integer
 *                 example: 1
 *               high_threshold:
 *                 type: number
 *                 format: float
 *                 minimum: 0
 *                 maximum: 100
 *                 example: 85
 *               low_threshold:
 *                 type: number
 *                 format: float
 *                 minimum: 0
 *                 maximum: 100
 *                 example: 15
 *               enable_push:
 *                 type: boolean
 *                 example: true
 *               enable_email:
 *                 type: boolean
 *                 example: true
 *               notification_cooldown_minutes:
 *                 type: integer
 *                 example: 10
 *     responses:
 *       200:
 *         description: Settings updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Settings updated successfully
 *                 data:
 *                   $ref: '#/components/schemas/Settings'
 */
app.post('/api/settings/post', async (req, res) => {
  try {
    const {
      user_id,
      high_threshold,
      low_threshold,
      enable_push,
      enable_email,
      notification_cooldown_minutes,
    } = req.body;

    console.log('⚙️ Update settings:', user_id);

    if (!user_id) {
      return res.status(400).json({
        success: false,
        message: 'user_id is required',
      });
    }

    const result = await pool.query(
      `INSERT INTO alert_settings (
        user_id,
        high_threshold,
        low_threshold,
        enable_push,
        enable_email,
        notification_cooldown_minutes
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (user_id)
      DO UPDATE SET
        high_threshold = EXCLUDED.high_threshold,
        low_threshold = EXCLUDED.low_threshold,
        enable_push = EXCLUDED.enable_push,
        enable_email = EXCLUDED.enable_email,
        notification_cooldown_minutes = EXCLUDED.notification_cooldown_minutes,
        modified_at = NOW()
      RETURNING *`,
      [
        user_id,
        high_threshold || 80,
        low_threshold || 20,
        enable_push !== undefined ? enable_push : true,
        enable_email !== undefined ? enable_email : true,
        notification_cooldown_minutes || 10,
      ]
    );

    console.log('✅ Settings updated');

    res.json({
      success: true,
      message: 'Settings updated successfully',
      data: result.rows[0],
    });

  } catch (error) {
    console.error('❌ Update settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update settings',
      error: error.message,
    });
  }
});

// ══════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════
// 🛑 GRACEFUL SHUTDOWN
// ══════════════════════════════════════════════════════════

process.on('SIGTERM', async () => {
  console.log('\n🛑 SIGTERM received, closing server...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n🛑 SIGINT received, closing server...');
  await pool.end();
  process.exit(0);
});

module.exports = app;

/**
 * @swagger
 * /api/settings/put:
 *   put:
 *     summary: Update alert settings
 *     description: Update user's alert thresholds and notification preferences
 *     tags: [Settings]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - user_id
 *             properties:
 *               user_id:
 *                 type: integer
 *                 example: 1
 *               high_threshold:
 *                 type: number
 *                 format: float
 *                 minimum: 0
 *                 maximum: 100
 *                 example: 85
 *                 description: High water level percentage threshold
 *               low_threshold:
 *                 type: number
 *                 format: float
 *                 minimum: 0
 *                 maximum: 100
 *                 example: 15
 *                 description: Low water level percentage threshold
 *               enable_push:
 *                 type: boolean
 *                 example: true
 *                 description: Enable push notifications
 *               enable_email:
 *                 type: boolean
 *                 example: true
 *                 description: Enable email notifications
 *               notification_cooldown_minutes:
 *                 type: integer
 *                 example: 10
 *                 description: Minimum minutes between alerts
 *     responses:
 *       200:
 *         description: Settings updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Settings updated successfully
 *                 data:
 *                   $ref: '#/components/schemas/Settings'
 *       400:
 *         description: Invalid input
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Missing API key
 *       403:
 *         description: Invalid API key
 *       500:
 *         description: Server error
 */

app.put('/api/settings/put', async (req, res) => {
  try {
    const {
      user_id,
      high_threshold,
      low_threshold,
      enable_push,
      enable_email,
      notification_cooldown_minutes,
    } = req.body;

    console.log('⚙️ PUT Update settings:', user_id);

    if (!user_id) {
      return res.status(400).json({
        success: false,
        message: 'user_id is required',
      });
    }

    // Validate thresholds
    if (
      high_threshold !== undefined &&
      (high_threshold < 0 || high_threshold > 100)
    ) {
      return res.status(400).json({
        success: false,
        message: 'high_threshold must be between 0 and 100',
      });
    }

    if (
      low_threshold !== undefined &&
      (low_threshold < 0 || low_threshold > 100)
    ) {
      return res.status(400).json({
        success: false,
        message: 'low_threshold must be between 0 and 100',
      });
    }

    const result = await pool.query(
      `INSERT INTO alert_settings (
        user_id,
        high_threshold,
        low_threshold,
        enable_push,
        enable_email,
        notification_cooldown_minutes
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (user_id)
      DO UPDATE SET
        high_threshold = COALESCE(EXCLUDED.high_threshold, alert_settings.high_threshold),
        low_threshold = COALESCE(EXCLUDED.low_threshold, alert_settings.low_threshold),
        enable_push = COALESCE(EXCLUDED.enable_push, alert_settings.enable_push),
        enable_email = COALESCE(EXCLUDED.enable_email, alert_settings.enable_email),
        notification_cooldown_minutes = COALESCE(EXCLUDED.notification_cooldown_minutes, alert_settings.notification_cooldown_minutes),
        modified_at = NOW()
      RETURNING *`,
      [
        user_id,
        high_threshold ?? null,
        low_threshold ?? null,
        enable_push ?? null,
        enable_email ?? null,
        notification_cooldown_minutes ?? null,
      ]
    );

    console.log('✅ Settings updated via PUT');

    res.json({
      success: true,
      message: 'Settings updated successfully',
      data: result.rows[0],
    });

  } catch (error) {
    console.error('❌ PUT settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update settings',
      error: error.message,
    });
  }
});

// ══════════════════════════════════════════════════════════
// 🚫 404 HANDLER
// ══════════════════════════════════════════════════════════

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found',
    path: req.path,
  });
});

// ══════════════════════════════════════════════════════════
// 🚀 START SERVER
// ══════════════════════════════════════════════════════════

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('🌊 WATER LEVEL MONITOR API WITH SWAGGER');
  console.log('═══════════════════════════════════════════════════');
  console.log(`🚀 Server:  http://localhost:${PORT}`);
  console.log(`🏥 Health:  http://localhost:${PORT}/health`);
  console.log(`📚 Swagger: http://localhost:${PORT}/api-docs`);
  console.log(`📄 JSON:    http://localhost:${PORT}/api-docs.json`);
  console.log('═══════════════════════════════════════════════════\n');
});

// ══════════════════════════════════════════════════════════
// 🛑 GRACEFUL SHUTDOWN
// ══════════════════════════════════════════════════════════

process.on('SIGTERM', async () => {
  console.log('⚠️ SIGTERM received, closing server...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n⚠️ SIGINT received, closing server...');
  await pool.end();
  process.exit(0);
});
