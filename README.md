# Wasabi Video Streaming Worker for Cloudflare

A high-performance Cloudflare Worker that streams videos from Wasabi S3 with a beautiful modern player interface.

## Features

- 🎥 **Modern Video Player** - Beautiful UI with playback controls
- ⚡ **Ultra-Fast Streaming** - Cloudflare's global CDN edge network
- 🔗 **Presigned URL Generation** - Secure 7-day expiring links
- 📱 **Responsive Design** - Works on mobile, tablet, desktop
- 🎬 **4K Ready** - Supports high-resolution streaming
- 🔒 **CORS Enabled** - Works with any frontend
- 🚀 **Zero Latency** - Optimized for instant playback

## Prerequisites

1. Cloudflare account with Workers enabled
2. Wasabi S3 account with bucket created
3. Node.js installed (for Wrangler CLI)

## Installation

### 1. Install Wrangler CLI

```bash
npm install -g wrangler
