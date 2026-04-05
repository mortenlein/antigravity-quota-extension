const vscode = require('vscode');
const { getQuota } = require('./quota-service');

class QuotaWebviewViewProvider {
    static viewType = 'antigravity-quota.view';

    constructor(_extensionUri) {
        this._extensionUri = _extensionUri;
        this._view = undefined;
    }

    resolveWebviewView(webviewView, context, _token) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'refresh':
                    this.refresh();
                    break;
            }
        });

        // Initial fetch
        this.refresh();
    }

    async refresh() {
        if (!this._view) return;

        this._view.webview.postMessage({ type: 'loading' });
        
        try {
            const quotaData = await getQuota();
            this._view.webview.postMessage({ type: 'update', data: quotaData });
        } catch (err) {
            this._view.webview.postMessage({ type: 'error', message: err.message });
        }
    }

    _getHtmlForWebview(webview) {
        const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'reset.css'));
        const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'vscode.css'));
        const styleMainUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'styles.css'));
        const scriptMainUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'));

        const nonce = getNonce();

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
                <link href="${styleResetUri}" rel="stylesheet">
                <link href="${styleVSCodeUri}" rel="stylesheet">
                <link href="${styleMainUri}" rel="stylesheet">
                <title>Antigravity Quota</title>
            </head>
            <body>
                <div id="app">
                    <div class="header">
                        <h1>🚀 AG Quota Overview</h1>
                    </div>
                    <div id="content">
                        <div class="loader">
                            <div class="spinner"></div>
                            INITIALIZING HUD...
                        </div>
                    </div>
                    <div class="footer"></div>
                </div>
                <script nonce="${nonce}" src="${scriptMainUri}"></script>
            </body>
            </html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

module.exports = { QuotaWebviewViewProvider };
