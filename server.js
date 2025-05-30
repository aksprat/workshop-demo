// server.js
const express = require('express');
const multer = require('multer');
const AWS = require('aws-sdk');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();
const cors = require('cors');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 8080; // DigitalOcean uses port 8080

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Environment variable validation
const requiredEnvVars = {
  DATABASE_URL: process.env.DATABASE_URL,
  SPACES_ENDPOINT: process.env.SPACES_ENDPOINT,
  SPACES_KEY: process.env.SPACES_KEY,
  SPACES_SECRET: process.env.SPACES_SECRET,
  SPACES_BUCKET: process.env.SPACES_BUCKET,
  SPACES_REGION: process.env.SPACES_REGION || 'sgp1'
};

console.log('Environment check:');
Object.keys(requiredEnvVars).forEach(key => {
  console.log(`${key}: ${requiredEnvVars[key] ? 'SET' : 'NOT SET'}`);
});

// Configure DigitalOcean Spaces (S3-compatible) only if env vars are available
let s3 = null;
let spacesConfigured = false;

if (requiredEnvVars.SPACES_ENDPOINT && requiredEnvVars.SPACES_KEY && requiredEnvVars.SPACES_SECRET) {
  try {
    const spacesEndpoint = new AWS.Endpoint(requiredEnvVars.SPACES_ENDPOINT);
    s3 = new AWS.S3({
      endpoint: spacesEndpoint,
      accessKeyId: requiredEnvVars.SPACES_KEY,
      secretAccessKey: requiredEnvVars.SPACES_SECRET,
      region: requiredEnvVars.SPACES_REGION
    });
    spacesConfigured = true;
    console.log('✅ Spaces configured successfully');
  } catch (error) {
    console.error('❌ Spaces configuration error:', error.message);
  }
} else {
  console.log('⚠️ Spaces not configured - missing environment variables');
}

// Configure PostgreSQL connection
let pool = null;
let dbConfigured = false;

if (requiredEnvVars.DATABASE_URL) {
  try {
    pool = new Pool({
      connectionString: requiredEnvVars.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });
    dbConfigured = true;
    console.log('✅ Database configured successfully');
  } catch (error) {
    console.error('❌ Database configuration error:', error.message);
  }
} else {
  console.log('⚠️ Database not configured - missing DATABASE_URL');
}

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|pdf|txt|doc|docx/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only images, PDFs, documents and text files are allowed'));
    }
  }
});

// Initialize database
async function initDB() {
  if (!dbConfigured) {
    console.log('⚠️ Skipping database initialization - not configured');
    return;
  }
  
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todos (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        completed BOOLEAN DEFAULT FALSE,
        file_url VARCHAR(500),
        file_name VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization error:', error.message);
  }
}

// Routes

// Health check - IMPORTANT: This must work for App Platform
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    port: PORT,
    services: {
      database: dbConfigured ? 'Connected' : 'Not configured',
      spaces: spacesConfigured ? 'Connected' : 'Not configured'
    },
    environment: {
      NODE_ENV: process.env.NODE_ENV || 'development',
      PORT: PORT
    }
  });
});

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Get all todos
app.get('/api/todos', async (req, res) => {
  if (!dbConfigured) {
    return res.status(503).json({ 
      error: 'Database not configured. Please set DATABASE_URL environment variable.' 
    });
  }
  
  try {
    const result = await pool.query('SELECT * FROM todos ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching todos:', error);
    res.status(500).json({ error: 'Failed to fetch todos' });
  }
});

// Create new todo
app.post('/api/todos', upload.single('file'), async (req, res) => {
  if (!dbConfigured) {
    return res.status(503).json({ 
      error: 'Database not configured. Please set DATABASE_URL environment variable.' 
    });
  }
  
  try {
    const { title, description } = req.body;
    
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }
    
    let fileUrl = null;
    let fileName = null;

    // Upload file to Spaces if provided and Spaces is configured
    if (req.file && spacesConfigured) {
      try {
        const uniqueFileName = `${Date.now()}-${req.file.originalname}`;
        const uploadParams = {
          Bucket: requiredEnvVars.SPACES_BUCKET,
          Key: `uploads/${uniqueFileName}`,
          Body: req.file.buffer,
          ContentType: req.file.mimetype,
          ACL: 'public-read'
        };

        const uploadResult = await s3.upload(uploadParams).promise();
        fileUrl = uploadResult.Location;
        fileName = req.file.originalname;
        console.log('✅ File uploaded to Spaces:', fileUrl);
      } catch (uploadError) {
        console.error('❌ File upload error:', uploadError);
        // Continue without file if upload fails
      }
    } else if (req.file && !spacesConfigured) {
      console.log('⚠️ File upload skipped - Spaces not configured');
    }

    const result = await pool.query(
      'INSERT INTO todos (title, description, file_url, file_name) VALUES ($1, $2, $3, $4) RETURNING *',
      [title, description, fileUrl, fileName]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating todo:', error);
    res.status(500).json({ error: 'Failed to create todo: ' + error.message });
  }
});

// Update todo
app.put('/api/todos/:id', async (req, res) => {
  const { id } = req.params;
  const { title, description, completed } = req.body;
  
  try {
    const result = await pool.query(
      'UPDATE todos SET title = $1, description = $2, completed = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *',
      [title, description, completed, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Todo not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating todo:', err);
    res.status(500).json({ error: 'Failed to update todo' });
  }
});

// Delete todo
app.delete('/api/todos/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    // Get todo first to delete file from Spaces if exists
    const todoResult = await pool.query('SELECT * FROM todos WHERE id = $1', [id]);
    
    if (todoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Todo not found' });
    }
    
    const todo = todoResult.rows[0];
    
    // Delete file from Spaces if exists
    if (todo.file_url) {
      const fileKey = todo.file_url.split('/').slice(-2).join('/'); // Extract key from URL
      try {
        await s3.deleteObject({
          Bucket: process.env.DO_SPACES_BUCKET,
          Key: fileKey
        }).promise();
      } catch (deleteError) {
        console.error('Error deleting file from Spaces:', deleteError);
        // Continue with todo deletion even if file deletion fails
      }
    }
    
    // Delete todo from database
    await pool.query('DELETE FROM todos WHERE id = $1', [id]);
    
    res.json({ message: 'Todo deleted successfully' });
  } catch (err) {
    console.error('Error deleting todo:', err);
    res.status(500).json({ error: 'Failed to delete todo' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large' });
    }
  }
  
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(port, async () => {
  console.log(`Server running on port ${PORT}`);
  await initDB();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  pool.end(() => {
    console.log('Database pool closed');
    process.exit(0);
  });
});

module.exports = app;
