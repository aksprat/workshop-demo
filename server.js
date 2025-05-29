// server.js
const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');
const AWS = require('aws-sdk');
const path = require('path');
const fs = require('fs');
require('dotenv').config();
const cors = require('cors');
const helmet = require('helmet');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// DigitalOcean Spaces configuration
const spacesEndpoint = new AWS.Endpoint(process.env.DO_SPACES_ENDPOINT);
const s3 = new AWS.S3({
  endpoint: spacesEndpoint,
  accessKeyId: process.env.DO_SPACES_KEY,
  secretAccessKey: process.env.DO_SPACES_SECRET,
  region: process.env.DO_SPACES_REGION || 'sgp1'
});

// Multer configuration for handling file uploads
const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only images and documents are allowed'));
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
  } catch (err) {
    console.error('Database initialization error:', err);
  }
}

// Upload file to DigitalOcean Spaces
async function uploadToSpaces(file) {
  const fileKey = `todos/${Date.now()}-${file.originalname}`;
  const fileContent = fs.readFileSync(file.path);
  
  const params = {
    Bucket: process.env.DO_SPACES_BUCKET,
    Key: fileKey,
    Body: fileContent,
    ACL: 'public-read',
    ContentType: file.mimetype
  };
  
  try {
    const data = await s3.upload(params).promise();
    // Clean up temporary file
    fs.unlinkSync(file.path);
    return {
      url: data.Location,
      key: fileKey
    };
  } catch (error) {
    // Clean up temporary file even if upload fails
    if (fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }
    throw error;
  }
}

// Routes

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Get all todos
app.get('/api/todos', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM todos ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching todos:', err);
    res.status(500).json({ error: 'Failed to fetch todos' });
  }
});

// Create new todo
app.post('/api/todos', upload.single('file'), async (req, res) => {
  try {
    const { title, description } = req.body;
    
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }
    
    let fileUrl = null;
    let fileName = null;

    // Upload file to Spaces if provided
    if (req.file) {
      const uniqueFileName = `${Date.now()}-${req.file.originalname}`;
      const uploadParams = {
        Bucket: process.env.SPACES_BUCKET,
        Key: `uploads/${uniqueFileName}`,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
        ACL: 'public-read'
      };

      const uploadResult = await s3.upload(uploadParams).promise();
      fileUrl = uploadResult.Location;
      fileName = req.file.originalname;
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
  console.log(`Server running on port ${port}`);
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
