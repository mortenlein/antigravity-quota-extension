const https = require('https');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

// API endpoint 
const GET_USER_STATUS_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus';

// Thresholds for status colors
const THRESHOLDS = {
    WARNING: 30,
    CRITICAL: 10
};

// Cache
let cachedQuota = null;
let lastFetch = 0;
const CACHE_TTL = 15000; // 15 seconds

let cachedConnection = null;
let lastConnectionCheck = 0;
const CONNECTION_CACHE_TTL = 60000; // 1 minute

/**
 * Scan running processes to find Antigravity language server
 * and extract port + CSRF token from command line
 */
async function findLanguageServer() {
    // Check cache
    if (cachedConnection && Date.now() - lastConnectionCheck < CONNECTION_CACHE_TTL) {
        return cachedConnection;
    }

    const GLOBAL_TIMEOUT = 12000; // 12s total timeout for discovery
    
    const scanPromise = (async () => {
        try {
            // PowerShell command to find language_server process with csrf_token
            // Filter by Name to speed up the query significantly
            const command = `powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter \\"Name LIKE '%language%server%' OR Name LIKE '%node%'\\" | Where-Object { $_.CommandLine -match 'csrf_token' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json"`;

            const { stdout } = await execAsync(command, { timeout: 8000, maxBuffer: 1024 * 1024 });

            if (!stdout || stdout.trim().length === 0) {
                return null;
            }

            // Parse JSON output
            let processes;
            try {
                const trimmed = stdout.trim();
                const jsonStart = trimmed.indexOf('[') >= 0 ? trimmed.indexOf('[') : trimmed.indexOf('{');
                if (jsonStart < 0) return null;
                const jsonStr = trimmed.substring(jsonStart);
                processes = JSON.parse(jsonStr);
                if (!Array.isArray(processes)) {
                    processes = [processes];
                }
            } catch (e) {
                console.error('[QuotaService] Failed to parse process list:', e.message);
                return null;
            }

            // Identify all candidate processes
            const candidates = [];
            for (const proc of processes) {
                const cmdLine = proc.CommandLine || '';
                if (!cmdLine.includes('--extension_server_port') || !cmdLine.includes('--csrf_token')) continue;
                if (!/--app_data_dir\s+antigravity\b/i.test(cmdLine)) continue;

                const tokenMatch = cmdLine.match(/--csrf_token[=\s]+([a-f0-9-]+)/i);
                const token = tokenMatch ? tokenMatch[1] : null;
                if (!token) continue;

                candidates.push({ pid: proc.ProcessId, token });
            }

            if (candidates.length === 0) return null;

            // Test all candidates and their ports in parallel
            const testPromises = candidates.map(async (cand) => {
                const ports = await getProcessListeningPorts(cand.pid);
                if (ports.length === 0) return null;

                // Test each port for this candidate. Resolve with the first successful one.
                for (const port of ports) {
                    const works = await testApiPort(port, cand.token);
                    if (works) {
                        return { port, token: cand.token, pid: cand.pid };
                    }
                }
                return null;
            });

            const results = await Promise.all(testPromises);
            const successful = results.find(r => r !== null);

            if (successful) {
                cachedConnection = successful;
                lastConnectionCheck = Date.now();
                return successful;
            }

            return null;
        } catch (e) {
            console.error('[QuotaService] Error scanning processes:', e.message);
            return null;
        }
    })();

    // Race the scan against the global timeout
    return Promise.race([
        scanPromise,
        new Promise((resolve) => setTimeout(() => {
            console.warn('[QuotaService] Scanning process exceeded global timeout.');
            resolve(null);
        }, GLOBAL_TIMEOUT))
    ]);
}

/**
 * Get listening ports for a process
 */
async function getProcessListeningPorts(pid) {
    try {
        const command = `powershell -NoProfile -NonInteractive -Command "$ports = Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort; if ($ports) { $ports | Sort-Object -Unique }"`;
        const { stdout } = await execAsync(command, { timeout: 5000 });

        const ports = [];
        const matches = stdout.match(/\b\d{1,5}\b/g) || [];

        for (const m of matches) {
            const p = parseInt(m, 10);
            if (p > 0 && p <= 65535) {
                ports.push(p);
            }
        }
        return ports.sort((a, b) => b - a);
    } catch (e) {
        return [];
    }
}

/**
 * Test if a port responds to the API
 */
async function testApiPort(port, token) {
    return new Promise((resolve) => {
        const data = JSON.stringify({ metadata: { ideName: 'antigravity' } });

        const options = {
            hostname: '127.0.0.1',
            port,
            path: GET_USER_STATUS_PATH,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                'Connect-Protocol-Version': '1',
                'X-Codeium-Csrf-Token': token
            },
            rejectUnauthorized: false,
            timeout: 3000
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                resolve(res.statusCode === 200 || body.includes('"user_status"'));
            });
        });

        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });

        req.write(data);
        req.end();
    });
}

/**
 * Make API request to the language server
 */
function apiRequest(port, token, path, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);

        const options = {
            hostname: '127.0.0.1',
            port,
            path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                'Connect-Protocol-Version': '1',
                'X-Codeium-Csrf-Token': token
            },
            rejectUnauthorized: false,
            timeout: 10000
        };

        const req = https.request(options, (res) => {
            let responseData = '';
            res.on('data', chunk => responseData += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}: ${responseData.substring(0, 200)}`));
                    return;
                }
                try {
                    resolve(JSON.parse(responseData));
                } catch (e) {
                    reject(new Error(`Failed to parse response: ${e.message}`));
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timed out'));
        });

        req.write(data);
        req.end();
    });
}

const MODEL_NAMES = {
    'MODEL_PLACEHOLDER_M12': 'Claude Opus 4.6',
    'MODEL_CLAUDE_4_5_SONNET': 'Claude Sonnet 4.6',
    'MODEL_CLAUDE_4_5_SONNET_THINKING': 'Claude Sonnet 4.6 Thinking',
    'MODEL_PLACEHOLDER_M18': 'Gemini 3 Flash',
    'MODEL_PLACEHOLDER_M7': 'Gemini 3.1 Pro High',
    'MODEL_PLACEHOLDER_M8': 'Gemini 3.1 Pro Low',
    'MODEL_PLACEHOLDER_M9': 'Gemini 3.1 Pro Image',
    'MODEL_OPENAI_GPT_OSS_120B_MEDIUM': 'GPT-OSS 120B'
};

function getDisplayName(modelId) {
    return MODEL_NAMES[modelId] || modelId?.replace('MODEL_', '').replace(/_/g, ' ') || 'Unknown';
}

function formatResetTime(resetAtMs) {
    if (!resetAtMs) return null;
    const now = Date.now();
    
    // Robustly handle different timestamp formats
    let resetAt = resetAtMs;
    if (typeof resetAtMs === 'string') {
        resetAt = isNaN(resetAtMs) ? new Date(resetAtMs).getTime() : parseInt(resetAtMs);
    } else if (typeof resetAtMs === 'object' && resetAtMs.seconds) {
        // Handle common gRPC timestamp format
        resetAt = resetAtMs.seconds * 1000 + (resetAtMs.nanos || 0) / 1000000;
    }
    
    if (isNaN(resetAt) || resetAt === 0) return null;

    const diffMs = resetAt - now;
    if (diffMs <= 0) return 'Now';

    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

function getStatus(remainingPercent) {
    if (remainingPercent <= 0) return 'exhausted';
    if (remainingPercent <= THRESHOLDS.CRITICAL) return 'danger';
    if (remainingPercent <= THRESHOLDS.WARNING) return 'warning';
    return 'healthy';
}

function parseQuotaResponse(response) {
    const models = [];
    const clientConfigs = response?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];

    for (const config of clientConfigs) {
        const qInfo = config.quotaInfo || config.quota_info || config.quota || {};
        const resetAtSource = qInfo.resetAt || qInfo.reset_at || qInfo.resetAtMs || qInfo.resetTime;
        
        let remainingFraction = qInfo.remainingFraction ?? qInfo.remaining_fraction;
        
        // Resilience check: if we have a reset time but no remainingFraction, 
        // it likely means the value is 0 and was omitted by the API serializer.
        // If we have NEITHER, we assume unlimited/100% (or truly no quota).
        if (remainingFraction === undefined || remainingFraction === null) {
            remainingFraction = resetAtSource ? 0 : 1;
        }

        const remainingPercent = Number((remainingFraction * 100).toFixed(2));
        const modelId = config.modelOrAlias?.model || config.modelOrAlias || 'unknown';
        const label = config.label || getDisplayName(modelId);
        
        // Resilience check for reset time fields
        const resetAt = resetAtSource ? (typeof resetAtSource === 'object' ? resetAtSource : new Date(resetAtSource).getTime()) : null;

        models.push({
            id: modelId,
            name: label,
            remaining: remainingPercent,
            limit: 100,
            remainingPercent,
            resetAt,
            resetIn: formatResetTime(resetAt),
            status: getStatus(remainingPercent)
        });
    }
    return models;
}

async function getQuota() {
    if (cachedQuota && Date.now() - lastFetch < CACHE_TTL) {
        return cachedQuota;
    }

    try {
        const connection = await findLanguageServer();
        if (!connection) {
            return { available: false, error: 'Antigravity language server not found.', models: [] };
        }

        const response = await apiRequest(
            connection.port,
            connection.token,
            GET_USER_STATUS_PATH,
            {
                metadata: {
                    ideName: 'antigravity',
                    extensionName: 'antigravity',
                    locale: 'en'
                }
            }
        );

        const models = parseQuotaResponse(response);
        const result = {
            available: true,
            models,
            fetchedAt: new Date().toISOString()
        };

        cachedQuota = result;
        lastFetch = Date.now();
        return result;
    } catch (e) {
        return { available: false, error: e.message, models: [] };
    }
}

module.exports = {
    getQuota,
    clearCache: () => {
        cachedQuota = null;
        lastFetch = 0;
        cachedConnection = null;
        lastConnectionCheck = 0;
    }
};
