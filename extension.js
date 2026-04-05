const vscode = require('vscode');
const { getQuota } = require('./quota-service');
const { QuotaWebviewViewProvider } = require('./webview-provider');

let statusBarItem;

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('Antigravity Quota Dashboard is now active!');

    const provider = new QuotaWebviewViewProvider(context.extensionUri);

    // 0. Register Explorer View Provider
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            QuotaWebviewViewProvider.viewType,
            provider
        )
    );

    // 1. Status Bar HUD
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'antigravity-quota.openDashboard';
    context.subscriptions.push(statusBarItem);
    statusBarItem.show();

    // 2. Dashboard Command (Integrated View)
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity-quota.openDashboard', () => {
            const panel = vscode.window.createWebviewPanel(
                'antigravityQuotaDashboard',
                'Quota HUD',
                vscode.ViewColumn.Beside, // Opens to the side of the current editor
                {
                    enableScripts: true,
                    localResourceRoots: [context.extensionUri],
                    retainContextWhenHidden: true
                }
            );

            panel.webview.html = provider._getHtmlForWebview(panel.webview);
            
            // Sync logic for the panel
            const syncInterval = setInterval(async () => {
                const data = await getQuota();
                if (panel.webview) {
                    panel.webview.postMessage({ type: 'update', data });
                }
                updateStatusBar(data);
            }, 60000);

            panel.onDidDispose(() => clearInterval(syncInterval));
            
            // Initial sync for panel
            getQuota().then(data => {
                panel.webview.postMessage({ type: 'update', data });
                updateStatusBar(data);
            });
        })
    );

    // 3. Global Background Polling (for Status Bar)
    const globalInterval = setInterval(async () => {
        const data = await getQuota();
        updateStatusBar(data);
    }, 60000);

    context.subscriptions.push({
        dispose: () => clearInterval(globalInterval)
    });

    // Initial global sync
    getQuota().then(updateStatusBar);
}

function updateStatusBar(data) {
    if (!data || !data.available || !data.models || !data.models.length) {
        statusBarItem.text = '$(dashboard) AG Quota: --';
        return;
    }

    // Prioritize models that are below 100%, sorted by lowest remaining
    const sorted = [...data.models].sort((a, b) => {
        if (a.remainingPercent === 100 && b.remainingPercent < 100) return 1;
        if (a.remainingPercent < 100 && b.remainingPercent === 100) return -1;
        return a.remainingPercent - b.remainingPercent;
    });

    const topModels = sorted.slice(0, 2);
    
    const statusText = topModels.map(model => {
        let icon = '$(circle-filled)';
        if (model.remainingPercent < 15) icon = '$(circle-outline)';
        else if (model.remainingPercent < 30) icon = '$(circle-slash)';
        
        // Use shorter name for status bar if possible
        const shortName = model.name.replace('Antigravity ', '').split(' (')[0];
        return `${icon} ${shortName}: ${Math.round(model.remainingPercent)}%`;
    }).join('  |  ');

    statusBarItem.text = statusText;
    statusBarItem.tooltip = `Antigravity Quota Monitor\n` + 
        data.models.map(m => `${m.name}: ${m.remainingPercent}% (${m.resetIn || 'Persistent'})`).join('\n');
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};
