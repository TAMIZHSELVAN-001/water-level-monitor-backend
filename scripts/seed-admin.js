require('dotenv').config();

const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const requiredAdminEnv = ['ADMIN_NAME', 'ADMIN_EMAIL', 'ADMIN_PASSWORD'];
const missingAdminEnv = requiredAdminEnv.filter((key) => !process.env[key]);

if (missingAdminEnv.length > 0) {
  console.error(
    `Missing required admin environment variables: ${missingAdminEnv.join(', ')}`
  );
  console.error('Add them to .env and rerun "npm run seed:admin".');
  process.exit(1);
}

const adminName = process.env.ADMIN_NAME.trim();
const adminEmail = process.env.ADMIN_EMAIL.trim().toLowerCase();
const adminPassword = process.env.ADMIN_PASSWORD;
const adminMobile = (process.env.ADMIN_MOBILE || '').trim() || null;

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&]).{8,}$/;

if (!emailRegex.test(adminEmail)) {
  console.error('ADMIN_EMAIL must be a valid email address.');
  process.exit(1);
}

if (!passwordRegex.test(adminPassword)) {
  console.error(
    'ADMIN_PASSWORD must be 8+ characters with uppercase, lowercase, number, and special character.'
  );
  process.exit(1);
}

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'water_level2',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'Password',
  max: 2,
  idleTimeoutMillis: 5000,
  connectionTimeoutMillis: 2000,
});

const ensureUsersTableExists = async (client) => {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'users'
     ) AS exists`
  );

  return result.rows[0].exists;
};

const hasColumn = async (client, columnName) => {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'users'
         AND column_name = $1
     ) AS exists`,
    [columnName]
  );

  return result.rows[0].exists;
};

const ensureAdminSchema = async (client) => {
  await client.query(
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE'
  );
};

const run = async () => {
  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();

    const usersTableExists = await ensureUsersTableExists(client);

    if (!usersTableExists) {
      throw new Error('users table does not exist. Create the app schema first.');
    }

    await ensureAdminSchema(client);

    const supportsIsActive = await hasColumn(client, 'is_active');
    const supportsCreatedBy = await hasColumn(client, 'created_by');
    const supportsModifiedBy = await hasColumn(client, 'modified_by');
    const hashedPassword = await bcrypt.hash(adminPassword, 12);
    const auditValue = 'Admin Seed Script';

    await client.query('BEGIN');
    transactionStarted = true;

    const existingUser = await client.query(
      'SELECT user_id FROM users WHERE e_mail = $1',
      [adminEmail]
    );

    if (existingUser.rows.length > 0) {
      const setClauses = [
        'name = $1',
        'mobile_no = $2',
        'password = $3',
        'is_admin = TRUE',
      ];
      const values = [adminName, adminMobile, hashedPassword];

      if (supportsIsActive) {
        setClauses.push('is_active = TRUE');
      }

      if (supportsModifiedBy) {
        setClauses.push(`modified_by = $${values.length + 1}`);
        values.push(auditValue);
      }

      values.push(existingUser.rows[0].user_id);

      const result = await client.query(
        `UPDATE users
         SET ${setClauses.join(', ')}
         WHERE user_id = $${values.length}
         RETURNING user_id, name, e_mail, mobile_no, created_at, is_admin`,
        values
      );

      await client.query('COMMIT');
      transactionStarted = false;

      console.log('Existing user promoted to admin successfully.');
      console.log(result.rows[0]);
      return;
    }

    const columns = ['name', 'mobile_no', 'e_mail', 'password', 'is_admin'];
    const values = [adminName, adminMobile, adminEmail, hashedPassword, true];

    if (supportsCreatedBy) {
      columns.push('created_by');
      values.push(auditValue);
    }

    if (supportsModifiedBy) {
      columns.push('modified_by');
      values.push(auditValue);
    }

    const placeholders = values.map((_, index) => `$${index + 1}`);

    const result = await client.query(
      `INSERT INTO users (${columns.join(', ')})
       VALUES (${placeholders.join(', ')})
       RETURNING user_id, name, e_mail, mobile_no, created_at, is_admin`,
      values
    );

    await client.query('COMMIT');
    transactionStarted = false;

    console.log('Admin user created successfully.');
    console.log(result.rows[0]);
  } catch (error) {
    if (client && transactionStarted) {
      try {
      await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Rollback failed:', rollbackError.message);
      }
    }

    console.error('Admin seeding failed:', error.message);
    process.exitCode = 1;
  } finally {
    if (client) {
      client.release();
    }

    await pool.end();
  }
};

run().catch((error) => {
  console.error('Admin seeding failed:', error.message);
  process.exit(1);
});
