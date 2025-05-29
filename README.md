# DigitalOcean Workshop Demo App

A simple todo application demonstrating integration between:
- **DigitalOcean App Platform** (hosting)
- **DigitalOcean Spaces** (file storage)
- **DigitalOcean Managed Database** (PostgreSQL)

## Features

- ✅ Create, read, update, delete todos
- 📎 File attachments (images, PDFs, text files)
- 🗄️ PostgreSQL database integration
- ☁️ File storage in DigitalOcean Spaces
- 📱 Responsive design
- 🔒 Security best practices

## Quick Deploy to DigitalOcean

### Prerequisites

1. DigitalOcean account
2. GitHub repository with this code
3. DigitalOcean Spaces bucket created
4. DigitalOcean Managed Database (PostgreSQL) created

### Setup Steps

1. **Create a Spaces bucket:**
   - Go to DigitalOcean > Spaces
   - Create new Space
   - Note the bucket name and endpoint

2. **Create a Managed Database:**
   - Go to DigitalOcean > Databases
   - Create PostgreSQL database
   - Note the connection string

3. **Generate Spaces API keys:**
   - Go to API > Spaces Keys
   - Generate new key pair

4. **Deploy to App Platform:**
   - Go to DigitalOcean > Apps
   - Create new app from GitHub
   - Use the `.do/app.yaml` configuration
   - Set environment variables:
     - `DATABASE_URL` (from managed database)
     - `SPACES_KEY` (Spaces access key)
     - `SPACES_SECRET` (Spaces secret key)
     - `SPACES_BUCKET` (your bucket name)

### Environment Variables

```bash
DATABASE_URL=postgresql://username:password@host:port/database?sslmode=require
SPACES_KEY=your_spaces_access_key
SPACES_SECRET=your_spaces_secret_key
SPACES_BUCKET=your_bucket_name
SPACES_ENDPOINT=nyc3.digitaloceanspaces.com
SPACES_REGION=nyc3
