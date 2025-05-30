// server.js
const express = require('express');
const multer = require('multer');
const AWS = require('aws-sdk');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configure DigitalOcean Spaces (S3-compatible)
const spacesEndpoint = new AWS.Endpoint(process.env.SPACES_ENDPOINT || 'sgp1.digitaloceanspaces.com');
const s3 = new AWS.S3({
  endpoint: spacesEndpoint,
  accessKeyId: process.env.SPACES_KEY,
  secretAccessKey: process.env.SPACES_SECRET,
  region: process.env.SPACES_REGION || 'sgp1'
});

// Configure PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|pdf|txt/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only images, PDFs, and text files are allowed'));
    }
  }
});

// Initialize database
async function initDB() {
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
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

// Health check
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    await s3.headBucket({ Bucket: process.env.SPACES_BUCKET }).promise();
    res.json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      services: {
        database: 'Connected',
        spaces: 'Configured'
      }
    });
  } catch (err) {
    console.error('Health check failed:', err);
    res.status(500).json({ status: 'FAIL', error: err.message });
  }
});

// Get all todos
app.get('/api/todos', async (req, res) => {
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
  try {
    const { title, description } = req.body;
    let fileUrl = null;
    let fileName = null;

    if (req.file) {
      const uploadFileName = `${Date.now()}-${req.file.originalname}`;
      const uploadParams = {
        Bucket: process.env.SPACES_BUCKET,
        Key: `uploads/${uploadFileName}`,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
        ACL: 'public-read'
      };

      const uploadResult = await s3.upload(uploadParams).promise();
      fileUrl = uploadResult.Location;
      fileName = uploadFileName;
      console.log(`File uploaded successfully to ${fileUrl}`);
    }

    const result = await pool.query(
      'INSERT INTO todos (title, description, file_url, file_name) VALUES ($1, $2, $3, $4) RETURNING *',
      [title, description, fileUrl, fileName]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating todo:', error);
    res.status(500).json({ error: 'Failed to create todo' });
  }
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large' });
    }
  }
  res.status(500).json({ error: error.message });
});

// Start server
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initDB();
});
