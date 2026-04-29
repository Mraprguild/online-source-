// ============================================
// WASABI VIDEO STREAMING WORKER - COMPLETE
// Cloudflare Worker with Player UI + Streaming
// ============================================

// Supported video formats
const SUPPORTED_VIDEO_FORMATS = ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.mpg', '.mpeg', '.3gp', '.flv'];

// Supported image formats for thumbnail (optional)
const SUPPORTED_IMAGE_FORMATS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

// CORS headers
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS, POST',
    'Access-Control-Allow-Headers': 'Range, Content-Type, Origin, Authorization, X-Auth-Token',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    'Access-Control-Max-Age': '86400'
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
    VIDEO_SEGMENT: 3600,    // 1 hour for video segments
    METADATA: 300,          // 5 minutes for metadata
    PRESIGNED: 3600         // 1 hour for presigned URLs
};

// ============================================
// HELPER FUNCTIONS
// ============================================

function isVideoFile(filename) {
    if (!filename) return false;
    const ext = filename.toLowerCase().substring(filename.lastIndexOf('.'));
    return SUPPORTED_VIDEO_FORMATS.includes(ext);
}

function isImageFile(filename) {
    if (!filename) return false;
    const ext = filename.toLowerCase().substring(filename.lastIndexOf('.'));
    return SUPPORTED_IMAGE_FORMATS.includes(ext);
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    }).replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, function(c) {
        return c;
    });
}

// ============================================
// AWS SIGNATURE V4 (for Wasabi/S3)
// ============================================

async function sha256(message) {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(key, message) {
    const encoder = new TextEncoder();
    const keyData = typeof key === 'string' ? encoder.encode(key) : key;
    const messageData = encoder.encode(message);
    const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
    return new Uint8Array(signature);
}

async function getSignatureKey(key, dateStamp, region, service) {
    const kDate = await hmacSha256(`AWS4${key}`, dateStamp);
    const kRegion = await hmacSha256(kDate, region);
    const kService = await hmacSha256(kRegion, service);
    const kSigning = await hmacSha256(kService, 'aws4_request');
    return kSigning;
}

async function generatePresignedUrl(key, expiresIn = 604800) {
    const accessKey = env.WASABI_ACCESS_KEY;
    const secretKey = env.WASABI_SECRET_KEY;
    const bucket = env.WASABI_BUCKET;
    const region = env.WASABI_REGION || 'eu-west-2';
    const endpoint = env.WASABI_ENDPOINT || 'https://s3.wasabisys.com';
    
    if (!accessKey || !secretKey || !bucket) {
        console.error('Missing Wasabi credentials');
        return null;
    }
    
    const method = 'GET';
    const host = `${bucket}.s3.${region}.wasabisys.com`;
    const encodedKey = encodeURIComponent(key).replace(/%2F/g, '/');
    
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    
    // Build query parameters
    const params = new URLSearchParams();
    params.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
    params.set('X-Amz-Credential', `${accessKey}/${dateStamp}/${region}/s3/aws4_request`);
    params.set('X-Amz-Date', amzDate);
    params.set('X-Amz-Expires', expiresIn.toString());
    params.set('X-Amz-SignedHeaders', 'host');
    
    const canonicalUri = '/' + encodedKey;
    const canonicalQueryString = params.toString();
    const canonicalHeaders = `host:${host}\n`;
    const signedHeaders = 'host';
    
    const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\nUNSIGNED-PAYLOAD`;
    const hashedCanonicalRequest = await sha256(canonicalRequest);
    
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${dateStamp}/${region}/s3/aws4_request\n${hashedCanonicalRequest}`;
    const signingKey = await getSignatureKey(secretKey, dateStamp, region, 's3');
    const signature = await hmacSha256(signingKey, stringToSign);
    const signatureHex = Array.from(signature).map(b => b.toString(16).padStart(2, '0')).join('');
    
    params.set('X-Amz-Signature', signatureHex);
    
    return `https://${host}${canonicalUri}?${params.toString()}`;
}

// ============================================
// HTML PLAYER TEMPLATES
// ============================================

function getModernPlayer(videoUrl, filename, options = {}) {
    const {
        thumbnail = null,
        subtitles = null,
        fileSize = null,
        directUrl = null
    } = options;
    
    const isVideo = isVideoFile(filename);
    const displayName = filename.length > 60 ? filename.substring(0, 57) + '...' : filename;
    const sizeText = fileSize ? ` • ${formatBytes(fileSize)}` : '';
    const downloadUrl = directUrl || videoUrl;
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>🎬 ${escapeHtml(displayName)} | Wasabi Stream</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%238b9eff'%3E%3Cpath d='M4 6h16v12H4z' stroke='white' stroke-width='2'/%3E%3C/svg%3E">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        :root {
            --bg-dark: #0a0c12;
            --bg-card: rgba(18, 22, 35, 0.92);
            --accent: #4f68b0;
            --accent-hover: #6b85c9;
            --text-primary: #f0f3ff;
            --text-secondary: #9ca3cf;
        }
        
        body {
            background: linear-gradient(135deg, var(--bg-dark) 0%, #0f111a 100%);
            font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui, sans-serif;
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 1rem;
        }
        
        .player-container {
            max-width: 1400px;
            width: 100%;
            background: var(--bg-card);
            backdrop-filter: blur(20px);
            border-radius: 2rem;
            overflow: hidden;
            box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05);
            transition: transform 0.2s ease;
        }
        
        .video-wrapper {
            position: relative;
            background: #000;
            width: 100%;
            aspect-ratio: 16 / 9;
            background-color: #0b0e16;
        }
        
        video {
            width: 100%;
            height: 100%;
            display: block;
            object-fit: contain;
        }
        
        .video-controls-overlay {
            position: absolute;
            bottom: 0;
            left: 0;
            right: 0;
            background: linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0) 100%);
            padding: 1.5rem 1.5rem 1rem;
            opacity: 0;
            transition: opacity 0.3s ease;
            pointer-events: none;
        }
        
        .video-wrapper:hover .video-controls-overlay {
            opacity: 1;
        }
        
        .control-bar {
            display: flex;
            align-items: center;
            gap: 1rem;
            flex-wrap: wrap;
            pointer-events: auto;
        }
        
        .ctrl-btn {
            background: rgba(30, 35, 55, 0.9);
            backdrop-filter: blur(8px);
            border: 0.5px solid rgba(255,255,255,0.1);
            color: white;
            font-size: 0.9rem;
            padding: 0.5rem 1.2rem;
            border-radius: 3rem;
            display: inline-flex;
            align-items: center;
            gap: 0.6rem;
            cursor: pointer;
            transition: 0.2s;
            font-weight: 500;
        }
        
        .ctrl-btn:hover {
            background: var(--accent);
            transform: scale(1.02);
        }
        
        .time-display {
            font-family: monospace;
            background: rgba(0,0,0,0.6);
            padding: 0.4rem 1rem;
            border-radius: 2rem;
            font-size: 0.85rem;
            font-weight: 500;
        }
        
        .info-panel {
            padding: 1.8rem 2rem 2rem;
        }
        
        .badge-row {
            display: flex;
            gap: 0.8rem;
            flex-wrap: wrap;
            margin-bottom: 1rem;
        }
        
        .badge {
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.3rem 1rem;
            border-radius: 40px;
            font-size: 0.7rem;
            font-weight: 600;
            letter-spacing: 0.3px;
        }
        
        .badge-video { background: #1e293b; color: #8b9eff; }
        .badge-quality { background: #2d1f3a; color: #c084fc; }
        
        h1 {
            font-size: 1.6rem;
            font-weight: 600;
            background: linear-gradient(135deg, #fff, #a5b4fc);
            background-clip: text;
            -webkit-background-clip: text;
            color: transparent;
            word-break: break-word;
        }
        
        .filename-box {
            background: #0f111f;
            padding: 0.8rem 1.2rem;
            border-radius: 1rem;
            font-family: monospace;
            font-size: 0.8rem;
            color: #a5b4fc;
            margin: 1rem 0;
            word-break: break-all;
            border: 0.5px solid #2a2f4e;
        }
        
        .button-group {
            display: flex;
            flex-wrap: wrap;
            gap: 0.8rem;
            margin: 1rem 0;
        }
        
        .btn {
            display: inline-flex;
            align-items: center;
            gap: 0.6rem;
            padding: 0.7rem 1.5rem;
            border-radius: 40px;
            font-weight: 600;
            font-size: 0.85rem;
            text-decoration: none;
            cursor: pointer;
            transition: all 0.2s;
            border: none;
            font-family: inherit;
        }
        
        .btn-primary {
            background: linear-gradient(135deg, var(--accent), #3b4f8c);
            color: white;
            box-shadow: 0 4px 10px rgba(0,0,0,0.3);
        }
        
        .btn-primary:hover {
            background: linear-gradient(135deg, var(--accent-hover), #4f68b0);
            transform: translateY(-2px);
        }
        
        .btn-secondary {
            background: transparent;
            border: 1px solid #4e5b8e;
            color: #d9e2ff;
        }
        
        .btn-secondary:hover {
            background: #2a2f4e;
            border-color: #7c8ed6;
        }
        
        .speed-info {
            margin-top: 1rem;
            padding: 0.6rem 1rem;
            background: #10131f;
            border-radius: 1rem;
            font-size: 0.7rem;
            color: #7e8ac0;
            display: flex;
            align-items: center;
            gap: 0.8rem;
            flex-wrap: wrap;
        }
        
        .speed-badge {
            display: inline-flex;
            align-items: center;
            gap: 0.3rem;
            background: #1a1e30;
            padding: 0.2rem 0.6rem;
            border-radius: 20px;
        }
        
        footer {
            text-align: center;
            padding: 1rem;
            font-size: 0.7rem;
            color: #5c689b;
            border-top: 1px solid rgba(255,255,255,0.05);
        }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        
        .loading-spinner {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 48px;
            height: 48px;
            border: 3px solid rgba(255,255,255,0.3);
            border-radius: 50%;
            border-top-color: var(--accent);
            animation: spin 0.8s linear infinite;
            display: none;
        }
        
        @keyframes spin { to { transform: translate(-50%, -50%) rotate(360deg); } }
        
        @media (max-width: 640px) {
            .info-panel { padding: 1.2rem; }
            h1 { font-size: 1.2rem; }
            .btn { padding: 0.5rem 1rem; font-size: 0.75rem; }
            .ctrl-btn { padding: 0.3rem 0.8rem; font-size: 0.75rem; }
        }
        
        .error-state {
            text-align: center;
            padding: 4rem 2rem;
        }
        
        .error-state i {
            font-size: 4rem;
            color: #f87171;
            margin-bottom: 1rem;
        }
    </style>
</head>
<body>
    <div class="player-container">
        <div class="video-wrapper" id="videoWrapper">
            ${isVideo ? `
            <video id="videoPlayer" preload="metadata" playsinline ${thumbnail ? `poster="${escapeHtml(thumbnail)}"` : ''}>
                <source src="${escapeHtml(videoUrl)}" type="video/mp4">
                Your browser does not support video playback.
            </video>
            <div class="loading-spinner" id="loadingSpinner"></div>
            <div class="video-controls-overlay">
                <div class="control-bar">
                    <button class="ctrl-btn" id="playPauseBtn"><i class="fas fa-play"></i> <span id="playPauseText">Play</span></button>
                    <button class="ctrl-btn" id="fullscreenBtn"><i class="fas fa-expand"></i> Fullscreen</button>
                    <div class="time-display" id="timeDisplay">--:-- / --:--</div>
                </div>
            </div>
            ` : `
            <div class="error-state">
                <i class="fas fa-file-alt"></i>
                <h3>📄 File Preview Unavailable</h3>
                <p style="margin-top: 1rem; color: #9ca3cf;">This file type cannot be streamed directly.</p>
                <a href="${escapeHtml(downloadUrl)}" class="btn btn-primary" style="margin-top: 1.5rem;">
                    <i class="fas fa-download"></i> Download File
                </a>
            </div>
            `}
        </div>
        <div class="info-panel">
            <div class="badge-row">
                <span class="badge badge-video"><i class="fas ${isVideo ? 'fa-video' : 'fa-cloud-upload-alt'}"></i> ${isVideo ? 'Streaming Ready' : 'Direct Access'}</span>
                <span class="badge badge-quality"><i class="fas fa-bolt"></i> Wasabi Edge</span>
            </div>
            <h1>🎬 ${escapeHtml(displayName)}</h1>
            <div class="filename-box">
                <i class="far fa-file"></i> ${escapeHtml(filename)}${sizeText}
            </div>
            <div class="button-group">
                <a href="${escapeHtml(downloadUrl)}" class="btn btn-primary" ${isVideo ? 'download' : ''}>
                    <i class="fas fa-download"></i> Download
                </a>
                <button class="btn btn-secondary" id="copyDirectBtn">
                    <i class="far fa-copy"></i> Copy Link
                </button>
                <button class="btn btn-secondary" id="copyPlayerBtn">
                    <i class="fas fa-share-alt"></i> Share
                </button>
            </div>
            <div class="speed-info">
                <span class="speed-badge"><i class="fas fa-tachometer-alt"></i> CDN: Cloudflare</span>
                <span class="speed-badge"><i class="fas fa-hdd"></i> Storage: Wasabi S3</span>
                <span class="speed-badge"><i class="fas fa-clock"></i> Link valid: 7 days</span>
            </div>
        </div>
        <footer>
            <i class="fas fa-shield-alt"></i> Encrypted transfer • 4K streaming • Instant playback
        </footer>
    </div>
    
    <script>
        (function() {
            const video = document.getElementById('videoPlayer');
            const playPauseBtn = document.getElementById('playPauseBtn');
            const playPauseText = document.getElementById('playPauseText');
            const fullscreenBtn = document.getElementById('fullscreenBtn');
            const timeDisplay = document.getElementById('timeDisplay');
            const loadingSpinner = document.getElementById('loadingSpinner');
            const videoUrl = "${escapeHtml(videoUrl)}";
            
            function formatTime(seconds) {
                if (isNaN(seconds)) return '00:00';
                const hrs = Math.floor(seconds / 3600);
                const mins = Math.floor((seconds % 3600) / 60);
                const secs = Math.floor(seconds % 60);
                if (hrs > 0) {
                    return hrs + ':' + mins.toString().padStart(2,'0') + ':' + secs.toString().padStart(2,'0');
                }
                return mins + ':' + secs.toString().padStart(2,'0');
            }
            
            function updateTime() {
                if (video && video.duration) {
                    timeDisplay.innerText = formatTime(video.currentTime) + ' / ' + formatTime(video.duration);
                }
            }
            
            if (video) {
                video.addEventListener('timeupdate', updateTime);
                video.addEventListener('loadedmetadata', updateTime);
                video.addEventListener('waiting', () => {
                    if (loadingSpinner) loadingSpinner.style.display = 'block';
                });
                video.addEventListener('canplay', () => {
                    if (loadingSpinner) loadingSpinner.style.display = 'none';
                });
                video.addEventListener('error', (e) => {
                    console.error('Video error');
                    if (loadingSpinner) loadingSpinner.style.display = 'none';
                });
                
                if (playPauseBtn) {
                    playPauseBtn.addEventListener('click', () => {
                        if (video.paused) {
                            video.play();
                            playPauseText.innerText = 'Pause';
                            playPauseBtn.querySelector('i').className = 'fas fa-pause';
                        } else {
                            video.pause();
                            playPauseText.innerText = 'Play';
                            playPauseBtn.querySelector('i').className = 'fas fa-play';
                        }
                    });
                    
                    video.addEventListener('play', () => {
                        playPauseText.innerText = 'Pause';
                        playPauseBtn.querySelector('i').className = 'fas fa-pause';
                    });
                    video.addEventListener('pause', () => {
                        playPauseText.innerText = 'Play';
                        playPauseBtn.querySelector('i').className = 'fas fa-play';
                    });
                }
                
                if (fullscreenBtn) {
                    fullscreenBtn.addEventListener('click', () => {
                        const wrapper = document.getElementById('videoWrapper');
                        if (!document.fullscreenElement) {
                            wrapper.requestFullscreen().catch(e => console.warn(e));
                        } else {
                            document.exitFullscreen();
                        }
                    });
                }
            }
            
            // Copy functionality
            document.getElementById('copyDirectBtn')?.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(videoUrl);
                    showToast('✅ Direct link copied!');
                } catch(e) {
                    prompt('Copy URL:', videoUrl);
                }
            });
            
            document.getElementById('copyPlayerBtn')?.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(window.location.href);
                    showToast('✅ Player link copied!');
                } catch(e) {
                    prompt('Copy URL:', window.location.href);
                }
            });
            
            function showToast(msg) {
                const toast = document.createElement('div');
                toast.textContent = msg;
                toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1f2b4e;color:white;padding:10px 20px;border-radius:40px;font-size:0.85rem;z-index:10000;backdrop-filter:blur(12px);';
                document.body.appendChild(toast);
                setTimeout(() => toast.remove(), 2500);
            }
            
            // Keyboard shortcuts
            document.addEventListener('keydown', (e) => {
                if (video) {
                    if (e.key === ' ' || e.key === 'Space') {
                        e.preventDefault();
                        video.paused ? video.play() : video.pause();
                    }
                    if (e.key === 'f' || e.key === 'F') {
                        e.preventDefault();
                        fullscreenBtn?.click();
                    }
                }
            });
        })();
    </script>
</body>
</html>`;
}

function getErrorPage(message, statusCode = 400) {
    return `<!DOCTYPE html>
<html>
<head><title>Error - Wasabi Stream</title>
<style>
body { background: #0a0c12; display: flex; justify-content: center; align-items: center; min-height: 100vh; font-family: system-ui; margin: 0; padding: 1rem; }
.card { background: #1a1e2f; padding: 2rem; border-radius: 2rem; text-align: center; max-width: 450px; }
.card i { font-size: 3.5rem; color: #f87171; display: block; margin-bottom: 1rem; }
.card h2 { color: white; margin-bottom: 0.5rem; }
.card p { color: #9ca3cf; line-height: 1.5; }
.card button { background: #4f68b0; color: white; border: none; padding: 0.7rem 1.5rem; border-radius: 2rem; margin-top: 1.5rem; cursor: pointer; }
</style>
</head>
<body>
<div class="card">
<i class="fas fa-exclamation-triangle"></i>
<h2>⚠️ ${statusCode === 404 ? 'Link Not Found' : 'Playback Error'}</h2>
<p>${escapeHtml(message)}</p>
<button onclick="history.back()">← Go Back</button>
</div>
</body>
</html>`;
}

// ============================================
// MAIN WORKER HANDLER
// ============================================

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        
        // Make env available globally for helpers
        globalThis.env = env;
        
        // Handle CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: CORS_HEADERS });
        }
        
        // Health check
        if (path === '/health' || path === '/') {
            return new Response(JSON.stringify({
                status: 'healthy',
                service: 'wasabi-stream-worker',
                version: '2.0.0',
                timestamp: new Date().toISOString(),
                region: env.WASABI_REGION || 'eu-west-2'
            }), {
                headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
            });
        }
        
        // ========== PLAYER ROUTE ==========
        if (path === '/player' || path === '/watch' || path.startsWith('/player/')) {
            let videoUrl = null;
            let filename = url.searchParams.get('name') || 'video.mp4';
            
            // Get URL from query parameter
            if (url.searchParams.has('url')) {
                videoUrl = decodeURIComponent(url.searchParams.get('url'));
            }
            // Get from path: /player/encodedBase64Url
            else if (path.startsWith('/player/')) {
                const encoded = path.substring(8);
                try {
                    let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
                    while (base64.length % 4) base64 += '=';
                    videoUrl = atob(base64);
                } catch (e) {
                    videoUrl = decodeURIComponent(encoded);
                }
            }
            // Get from /watch?file=...
            else if (path === '/watch' && url.searchParams.has('file')) {
                videoUrl = decodeURIComponent(url.searchParams.get('file'));
            }
            
            if (!videoUrl) {
                return new Response(getErrorPage('Missing video URL parameter. Please provide a valid stream URL.'), {
                    headers: { 'Content-Type': 'text/html' },
                    status: 400
                });
            }
            
            // Extract filename from URL if not provided
            if (filename === 'video.mp4' && videoUrl) {
                const urlParts = videoUrl.split('/');
                const lastPart = decodeURIComponent(urlParts.pop().split('?')[0]);
                if (lastPart && (lastPart.includes('.') || lastPart.length > 0)) {
                    filename = lastPart;
                }
            }
            
            const html = getModernPlayer(videoUrl, filename, {
                thumbnail: url.searchParams.get('thumb') || null,
                fileSize: url.searchParams.get('size') ? parseInt(url.searchParams.get('size')) : null
            });
            
            return new Response(html, {
                headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
        }
        
        // ========== GENERATE PRESIGNED URL API ==========
        if (path === '/api/presign' && request.method === 'POST') {
            const authHeader = request.headers.get('X-Auth-Token');
            const expectedToken = env.API_TOKEN || 'wasabi-secret-token-change-me';
            
            if (!authHeader || authHeader !== expectedToken) {
                return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                    status: 401,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            
            try {
                const body = await request.json();
                const { key, expires = 604800 } = body;
                
                if (!key) {
                    return new Response(JSON.stringify({ error: 'Missing key parameter' }), {
                        status: 400,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
                
                const presignedUrl = await generatePresignedUrl(key, expires);
                if (presignedUrl) {
                    return new Response(JSON.stringify({
                        success: true,
                        url: presignedUrl,
                        expires: expires,
                        key: key
                    }), {
                        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
                    });
                } else {
                    return new Response(JSON.stringify({ error: 'Failed to generate presigned URL' }), {
                        status: 500,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
            } catch (error) {
                return new Response(JSON.stringify({ error: error.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
        }
        
        // ========== DIRECT PROXY STREAM (optional) ==========
        if (path === '/stream' && request.method === 'GET') {
            const key = url.searchParams.get('key');
            if (!key) {
                return new Response('Missing key parameter', { status: 400 });
            }
            
            const presignedUrl = await generatePresignedUrl(key, 3600);
            if (!presignedUrl) {
                return new Response('Failed to generate stream URL', { status: 500 });
            }
            
            // Redirect to presigned URL
            return Response.redirect(presignedUrl, 302);
        }
        
        // ========== NOT FOUND ==========
        return new Response(getErrorPage('The requested page was not found.', 404), {
            status: 404,
            headers: { 'Content-Type': 'text/html' }
        });
    }
};
