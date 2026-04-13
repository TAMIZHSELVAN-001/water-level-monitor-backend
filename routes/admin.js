const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

const router = express.Router();
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&]).{8,}$/;
const adminUiDir = path.join(__dirname, '..', 'public', 'admin');
const adminAssetsDir = path.join(adminUiDir, 'assets');
const adminTokenTtlMs = 1000 * 60 * 60 * 12;
const adminAuthSecret =
  process.env.ADMIN_AUTH_SECRET || process.env.API_KEY || 'dev-admin-secret';

let adminSchemaReady = false;

const ensureAdminSchema = async (db) => {
  if (adminSchemaReady) {
    return;
  }

  await db.query(
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE'
  );

  await db.query(
    'ALTER TABLE tanks ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ'
  );

  adminSchemaReady = true;
};

const getTableColumns = async (db, tableName) => {
  const result = await db.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName]
  );

  return new Set(result.rows.map((row) => row.column_name));
};

const createDefaultAlertSettingsIfNeeded = async (db, userId, tankId) => {
  try {
    const columns = await getTableColumns(db, 'alert_settings');

    if (!columns.has('user_id')) {
      return;
    }

    const existingSettings = await db.query(
      'SELECT 1 FROM alert_settings WHERE user_id = $1 LIMIT 1',
      [userId]
    );

    if (existingSettings.rows.length > 0) {
      return;
    }

    const insertColumns = [];
    const insertValues = [];
    const placeholders = [];

    const addColumn = (columnName, value) => {
      if (!columns.has(columnName)) {
        return;
      }

      insertColumns.push(columnName);
      insertValues.push(value);
      placeholders.push(`$${insertValues.length}`);
    };

    addColumn('user_id', userId);
    addColumn('tank_id', tankId);
    addColumn('high_threshold', 80);
    addColumn('low_threshold', 20);
    addColumn('enable_push', true);
    addColumn('enable_email', true);
    addColumn('notification_cooldown_minutes', 10);

    if (insertColumns.length === 0) {
      return;
    }

    await db.query(
      `INSERT INTO alert_settings (${insertColumns.join(', ')})
       VALUES (${placeholders.join(', ')})`,
      insertValues
    );
  } catch (error) {
    if (error?.code === '23505') {
      return;
    }

    const errorMessage =
      error instanceof Error ? error.message : 'Unknown alert settings initialization error';
    console.warn('Skipping alert_settings initialization:', errorMessage);
  }
};

const formatAdminUser = (user) => ({
  user_id: user.user_id,
  name: user.name,
  e_mail: user.e_mail,
  mobile_no: user.mobile_no,
  created_at: user.created_at,
  is_admin: Boolean(user.is_admin),
});

const toBase64Url = (value) =>
  Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

const fromBase64Url = (value) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
};

const signAdminToken = (value) =>
  toBase64Url(
    crypto.createHmac('sha256', adminAuthSecret).update(value).digest()
  );

const safeTokenCompare = (left, right) => {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const createAdminToken = (user) => {
  const payload = {
    type: 'admin',
    user_id: user.user_id,
    e_mail: user.e_mail,
    exp: Date.now() + adminTokenTtlMs,
  };

  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = signAdminToken(encodedPayload);

  return `${encodedPayload}.${signature}`;
};

const verifyAdminToken = (token) => {
  if (!token) {
    return null;
  }

  const [encodedPayload, signature] = token.split('.');

  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = signAdminToken(encodedPayload);

  if (!safeTokenCompare(expectedSignature, signature)) {
    return null;
  }

  try {
    const payload = JSON.parse(fromBase64Url(encodedPayload).toString('utf8'));

    if (payload.type !== 'admin' || payload.exp <= Date.now()) {
      return null;
    }

    return payload;
  } catch (error) {
    return null;
  }
};

const readAdminToken = (req) => {
  const authHeader = req.get('authorization') || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);

  return bearerMatch ? bearerMatch[1] : req.get('x-admin-token') || null;
};

const sendAdminPage = (res, pageName) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(adminUiDir, pageName));
};

const getActiveAdminCount = async (db) => {
  await ensureAdminSchema(db);

  const result = await db.query(
    'SELECT COUNT(*) AS count FROM users WHERE is_admin = TRUE AND is_active = TRUE'
  );

  return parseInt(result.rows[0].count, 10);
};

const getAdminById = async (db, userId) => {
  await ensureAdminSchema(db);

  const result = await db.query(
    `SELECT user_id, name, e_mail, mobile_no, created_at, is_admin
     FROM users
     WHERE user_id = $1 AND is_admin = TRUE AND is_active = TRUE`,
    [userId]
  );

  return result.rows[0] || null;
};

router.use(
  '/assets',
  express.static(adminAssetsDir, {
    index: false,
    redirect: false,
  })
);

router.get('/', (req, res) => {
  res.redirect('/admin/login-page');
});

router.get('/login', (req, res) => {
  sendAdminPage(res, 'login.html');
});

router.get('/login-page', (req, res) => {
  sendAdminPage(res, 'login.html');
});

router.get('/panel', (req, res) => {
  sendAdminPage(res, 'panel.html');
});

router.get('/dashboard', (req, res) => {
  res.redirect('/admin/panel');
});

router.get('/control-panel', (req, res) => {
  res.redirect('/admin/panel');
});

/**
 * @swagger
 * /admin/create-new-admin:
 *   post:
 *     summary: Create a new admin account
 *     description: Creates the first admin without auth. After that, an existing admin must send x-user-id to create more admins. Legacy alias: POST /admin/create
 *     tags:
 *       - Admin
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
 *                 example: Super Admin
 *               mobile_no:
 *                 type: string
 *                 example: 9876543210
 *               e_mail:
 *                 type: string
 *                 format: email
 *                 example: admin@example.com
 *               password:
 *                 type: string
 *                 format: password
 *                 example: Admin@1234
 *     responses:
 *       201:
 *         description: Admin created successfully
 *       403:
 *         description: Only an existing admin can create more admin users
 */
const createAdmin = async (req, res) => {
  const client = await req.db.connect();

  try {
    await ensureAdminSchema(client);

    const { name, mobile_no, e_mail, password } = req.body;
    const normalizedEmail = (e_mail || '').toLowerCase().trim();

    if (!name || !normalizedEmail || !password) {
      return res.status(400).json({
        success: false,
        message: 'Name, email, and password are required',
      });
    }

    if (!emailRegex.test(normalizedEmail)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format',
      });
    }

    if (!passwordRegex.test(password)) {
      return res.status(400).json({
        success: false,
        message: 'Password must be 8+ characters with uppercase, lowercase, number, and special character',
      });
    }

    const adminCount = await getActiveAdminCount(client);
    let auditSource = 'Admin API';

    if (adminCount > 0) {
      const requesterId = req.headers['x-user-id'];
      const requester = requesterId ? await getAdminById(client, requesterId) : null;

      if (!requester) {
        return res.status(403).json({
          success: false,
          message: 'An existing admin must create additional admin accounts',
        });
      }

      auditSource = `Admin:${requester.user_id}`;
    }

    const existingUser = await client.query(
      'SELECT user_id, is_admin FROM users WHERE e_mail = $1',
      [normalizedEmail]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: existingUser.rows[0].is_admin
          ? 'Admin email already registered'
          : 'Email already registered as a regular user',
      });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const result = await client.query(
      `INSERT INTO users (name, mobile_no, e_mail, password, is_admin, created_by, modified_by)
       VALUES ($1, $2, $3, $4, TRUE, $5, $6)
       RETURNING user_id, name, mobile_no, e_mail, created_at, is_admin`,
      [name.trim(), mobile_no || null, normalizedEmail, hashedPassword, auditSource, auditSource]
    );

    res.status(201).json({
      success: true,
      message: adminCount === 0
        ? 'First admin created successfully'
        : 'Admin created successfully',
      user: formatAdminUser(result.rows[0]),
    });
  } catch (error) {
    console.error('Create admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create admin',
      error: error.message,
    });
  } finally {
    client.release();
  }
};

router.post('/create-new-admin', createAdmin);
router.post('/create', createAdmin);

/**
 * @swagger
 * /admin/login:
 *   post:
 *     security: []
 *     summary: Admin login
 *     description: Authenticate an admin using email and password
 *     tags: [Admin]
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
 *                 example: admin@example.com
 *               password:
 *                 type: string
 *                 format: password
 *                 example: Admin@1234
 *     responses:
 *       200:
 *         description: Admin login successful
 *       403:
 *         description: Account does not have admin access
 */
const adminLogin = async (req, res) => {
  try {
    await ensureAdminSchema(req.db);

    const { e_mail, password } = req.body;
    const normalizedEmail = (e_mail || '').toLowerCase().trim();

    if (!normalizedEmail || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required',
      });
    }

    const result = await req.db.query(
      `SELECT user_id, name, mobile_no, e_mail, password, created_at, is_admin, is_active
       FROM users
       WHERE e_mail = $1`,
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No account found with this email',
      });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        message: 'Admin account is inactive',
      });
    }

    if (!user.is_admin) {
      return res.status(403).json({
        success: false,
        message: 'This account does not have admin access',
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: 'Invalid password',
      });
    }

    res.json({
      success: true,
      message: 'Admin login successful',
      token: createAdminToken(user),
      token_type: 'Bearer',
      expires_in: Math.floor(adminTokenTtlMs / 1000),
      dashboard_url: '/admin/panel',
      user: formatAdminUser(user),
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({
      success: false,
      message: 'Admin login failed',
      error: error.message,
    });
  }
};

router.post('/login', adminLogin);

// Simple admin check - improve this for production
const isAdmin = async (req, res, next) => {
  try {
    await ensureAdminSchema(req.db);

    const adminToken = readAdminToken(req);
    const tokenPayload = adminToken ? verifyAdminToken(adminToken) : null;
    const userId = tokenPayload ? tokenPayload.user_id : req.headers['x-user-id'];

    if (adminToken && !tokenPayload) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized - Invalid or expired admin session',
      });
    }

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized - Admin login required',
      });
    }

    const result = await req.db.query(
      `SELECT user_id, name, e_mail, mobile_no, created_at, is_admin, is_active
       FROM users
       WHERE user_id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized - Admin account not found',
      });
    }

    const adminUser = result.rows[0];

    if (!adminUser.is_active) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden - Admin account is inactive',
      });
    }

    if (!adminUser.is_admin) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden - Admin access required',
      });
    }

    req.admin = formatAdminUser(adminUser);
    req.adminUser = adminUser;
    req.adminAuthMode = tokenPayload ? 'token' : 'x-user-id';

    next();
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Admin check failed',
      error: error.message,
    });
  }
};

router.get('/me', isAdmin, async (req, res) => {
  res.json({
    success: true,
    auth_mode: req.adminAuthMode,
    user: req.admin,
  });
});

router.post('/logout', (req, res) => {
  res.json({
    success: true,
    message: 'Admin logout handled on the client by clearing the stored token.',
  });
});

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
        u.is_admin,
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

    const countResult = await req.db.query(
      'SELECT COUNT(*) FROM users WHERE is_active = TRUE'
    );

    res.json({
      success: true,
      data: result.rows,
      pagination: {
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        total: parseInt(countResult.rows[0].count, 10),
      },
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get users',
      error: error.message,
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
        u.is_admin,
        u.modified_at
      FROM users u
      WHERE u.user_id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    const tanksResult = await req.db.query(
      'SELECT * FROM tanks WHERE user_id = $1 AND is_active = TRUE',
      [id]
    );

    res.json({
      success: true,
      user: result.rows[0],
      tanks: tanksResult.rows,
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get user',
      error: error.message,
    });
  }
});

/**
 * @swagger
 * /admin/users:
 *   post:
 *     summary: Create new user (Admin only)
 *     tags: [Admin]
 */
router.post('/users', isAdmin, async (req, res) => {
  try {
    const { name, e_mail, mobile_no, password, is_active, is_admin } = req.body;
    const normalizedEmail = (e_mail || '').toLowerCase().trim();

    if (!name || !normalizedEmail || !password) {
      return res.status(400).json({
        success: false,
        message: 'Name, email, and password are required',
      });
    }

    if (!emailRegex.test(normalizedEmail)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format',
      });
    }

    if (!passwordRegex.test(password)) {
      return res.status(400).json({
        success: false,
        message: 'Password must be 8+ characters with uppercase, lowercase, number, and special character',
      });
    }

    const existingUser = await req.db.query(
      'SELECT user_id FROM users WHERE e_mail = $1',
      [normalizedEmail]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Email already registered',
      });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const result = await req.db.query(
      `INSERT INTO users (name, mobile_no, e_mail, password, is_admin, is_active, created_by, modified_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING user_id, name, mobile_no, e_mail, created_at, is_active, is_admin`,
      [name.trim(), mobile_no || null, normalizedEmail, hashedPassword, Boolean(is_admin), Boolean(is_active !== false), req.admin.user_id]
    );

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      user: formatAdminUser(result.rows[0]),
    });
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create user',
      error: error.message,
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
    const { name, e_mail, mobile_no, is_active, is_admin } = req.body;

    const result = await req.db.query(
      `UPDATE users
       SET name = $1,
           e_mail = $2,
           mobile_no = $3,
           is_active = $4,
           is_admin = $5,
           modified_at = NOW()
       WHERE user_id = $6
       RETURNING user_id, name, e_mail, mobile_no, is_active, is_admin`,
      [name, e_mail, mobile_no, is_active !== undefined ? is_active : true, is_admin !== undefined ? is_admin : false, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    res.json({
      success: true,
      message: 'User updated successfully',
      user: result.rows[0],
    });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update user',
      error: error.message,
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
        message: 'User not found',
      });
    }

    res.json({
      success: true,
      message: 'User deleted successfully',
      user: result.rows[0],
    });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete user',
      error: error.message,
    });
  }
});

/**
 * @swagger
 * /admin/tanks:
 *   get:
 *     summary: Get all tanks (Admin only)
 *     tags: [Admin]
 */
router.get('/tanks', isAdmin, async (req, res) => {
  try {
    const { user_id, page = 1, limit = 20, status = 'all' } = req.query;
    const offset = (page - 1) * limit;
    const normalizedStatus =
      typeof status === 'string' ? status.trim().toLowerCase() : 'all';
    const tankColumns = await getTableColumns(req.db, 'tanks');
    const supportsDeletedAt = tankColumns.has('deleted_at');
    const tankSelect = supportsDeletedAt
      ? 't.*'
      : 't.*, NULL::timestamptz AS deleted_at';

    let query = `
      SELECT
        ${tankSelect},
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
      WHERE 1=1
    `;

    const params = [];

    if (normalizedStatus === 'active') {
      query += supportsDeletedAt
        ? ' AND t.is_active = TRUE AND t.deleted_at IS NULL'
        : ' AND t.is_active = TRUE';
    } else if (normalizedStatus === 'inactive') {
      query += supportsDeletedAt
        ? ' AND t.is_active = FALSE AND t.deleted_at IS NULL'
        : ' AND t.is_active = FALSE';
    } else if (normalizedStatus === 'deleted') {
      query += supportsDeletedAt
        ? ' AND t.deleted_at IS NOT NULL'
        : ' AND 1 = 0';
    }

    if (user_id) {
      query += ` AND t.user_id = $${params.length + 1}`;
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
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
      },
      filters: {
        status: normalizedStatus,
      },
    });
  } catch (error) {
    console.error('Get tanks error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get tanks',
      error: error.message,
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
  let transactionStarted = false;

  try {
    const {
      user_id,
      tank_name,
      capacity_liters,
      height_cm,
      location,
      description,
    } = req.body;

    if (!user_id || !tank_name || !capacity_liters || !height_cm) {
      return res.status(400).json({
        success: false,
        message: 'user_id, tank_name, capacity_liters, and height_cm are required',
      });
    }

    const userCheck = await client.query(
      'SELECT user_id FROM users WHERE user_id = $1 AND is_active = TRUE',
      [user_id]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    await client.query('BEGIN');
    transactionStarted = true;

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

    await client.query('COMMIT');
    transactionStarted = false;

    await createDefaultAlertSettingsIfNeeded(client, user_id, tank.tank_id);

    res.status(201).json({
      success: true,
      message: 'Tank created successfully',
      tank,
    });
  } catch (error) {
    if (transactionStarted) {
      await client.query('ROLLBACK');
    }
    console.error('Create tank error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create tank',
      error: error.message,
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
    const tankColumns = await getTableColumns(req.db, 'tanks');
    const supportsDeletedAt = tankColumns.has('deleted_at');

    const deletedAtClause = supportsDeletedAt
      ? `deleted_at = CASE
           WHEN $6 = TRUE THEN NULL
           ELSE deleted_at
         END,`
      : '';

    const result = await req.db.query(
      `UPDATE tanks
       SET tank_name = COALESCE($1, tank_name),
           capacity_liters = COALESCE($2, capacity_liters),
           height_cm = COALESCE($3, height_cm),
           location = COALESCE($4, location),
           description = COALESCE($5, description),
           is_active = COALESCE($6, is_active),
           ${deletedAtClause}
           modified_at = NOW()
       WHERE tank_id = $7
       RETURNING *`,
      [tank_name, capacity_liters, height_cm, location, description, is_active, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Tank not found',
      });
    }

    res.json({
      success: true,
      message: 'Tank updated successfully',
      tank: result.rows[0],
    });
  } catch (error) {
    console.error('Update tank error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update tank',
      error: error.message,
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
    const tankColumns = await getTableColumns(req.db, 'tanks');
    const supportsDeletedAt = tankColumns.has('deleted_at');

    const deleteSetClause = supportsDeletedAt
      ? `is_active = FALSE,
           deleted_at = NOW(),
           modified_at = NOW()`
      : `is_active = FALSE,
           modified_at = NOW()`;

    const deleteReturningClause = supportsDeletedAt
      ? 'tank_id, tank_name, deleted_at'
      : 'tank_id, tank_name, NULL::timestamptz AS deleted_at';

    const result = await req.db.query(
      `UPDATE tanks
       SET ${deleteSetClause}
       WHERE tank_id = $1
       RETURNING ${deleteReturningClause}`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Tank not found',
      });
    }

    res.json({
      success: true,
      message: 'Tank deleted successfully',
      tank: result.rows[0],
    });
  } catch (error) {
    console.error('Delete tank error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete tank',
      error: error.message,
    });
  }
});

/**
 * @swagger
 * /admin/stats:
 *   get:
 *     summary: Get system statistics (Admin only)
 *     tags: [Admin]
 */
router.get('/stats', isAdmin, async (req, res) => {
  try {
    const usersResult = await req.db.query(
      'SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE is_active = TRUE) as active FROM users'
    );

    const tanksResult = await req.db.query(
      'SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE is_active = TRUE) as active FROM tanks'
    );

    const readingsResult = await req.db.query(
      `SELECT COUNT(*) as count
       FROM water_level_logs
       WHERE timestamp >= CURRENT_DATE`
    );

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
          total: parseInt(usersResult.rows[0].total, 10),
          active: parseInt(usersResult.rows[0].active, 10),
        },
        tanks: {
          total: parseInt(tanksResult.rows[0].total, 10),
          active: parseInt(tanksResult.rows[0].active, 10),
        },
        readings_today: parseInt(readingsResult.rows[0].count, 10),
        critical_alerts: parseInt(alertsResult.rows[0].count, 10),
      },
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get statistics',
      error: error.message,
    });
  }
});

module.exports = router;
