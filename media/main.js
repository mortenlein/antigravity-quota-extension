(function() {
    const vscode = acquireVsCodeApi();
    const contentElement = document.getElementById('content');
    const lastUpdatedElement = document.getElementById('last-updated');

    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.type) {
            case 'update':
                updateUI(message.data);
                break;
            case 'loading':
                showLoading();
                break;
            case 'error':
                showError(message.message);
                break;
        }
    });

    function showLoading() {
        contentElement.innerHTML = '<div class="loader"><div class="spinner"></div> SYNCING HUD...</div>';
    }

    function showError(error) {
        contentElement.innerHTML = `<div class="error-msg">
            SERVICE ERROR: ${error.toUpperCase()}
        </div>`;
    }

    function updateUI(quotaData) {
        if (!quotaData.available) {
            showError(quotaData.error);
            return;
        }

        const models = quotaData.models || [];
        if (models.length === 0) {
            contentElement.innerHTML = '<div class="loader">NO DATA.</div>';
            return;
        }

        let html = '';
        models.forEach(model => {
            const statusClass = model.status || 'healthy';
            const percent = model.remainingPercent.toFixed(2);
            const resetIn = model.resetIn ? `${model.resetIn}` : 'PERSISTENT';

            html += `
                <div class="quota-row">
                    <div class="led led-${statusClass}"></div>
                    <div class="model-label">${model.name}</div>
                    <div class="progress-wrap">
                        <div class="bar" style="width: ${model.remainingPercent}%"></div>
                    </div>
                    <div class="stats-text">${percent}% -> ${resetIn}</div>
                </div>
            `;
        });

        contentElement.innerHTML = html;
        if (lastUpdatedElement) {
            lastUpdatedElement.innerText = `${new Date().toLocaleTimeString().toUpperCase()}`;
        }
    }
})();
