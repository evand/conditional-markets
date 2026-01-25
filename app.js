// Conditional Markets Viewer - app.js

const API_BASE = 'https://api.manifold.markets/v0';

// State
let currentMarket = null;
let currentMarketConfig = null;
let marketProbabilities = null;

// DOM Elements
const marketSelect = document.getElementById('market-select');
const refreshBtn = document.getElementById('refresh-btn');
const apiKeyInput = document.getElementById('api-key');
const toggleKeyBtn = document.getElementById('toggle-key-visibility');
const clearKeyBtn = document.getElementById('clear-key');
const apiKeyStatus = document.getElementById('api-key-status');
const loadingSection = document.getElementById('loading');
const errorSection = document.getElementById('error');
const errorMessage = document.getElementById('error-message');
const marketInfo = document.getElementById('market-info');
const marketTitle = document.getElementById('market-title');
const marketLink = document.getElementById('market-link');
const matrixContainer = document.getElementById('matrix-container');
const betDialog = document.getElementById('bet-dialog');
const resultDialog = document.getElementById('result-dialog');

// Initialize
document.addEventListener('DOMContentLoaded', init);

async function init() {
    await loadMarketList();
    loadApiKey();
    setupEventListeners();
}

async function loadMarketList() {
    try {
        const response = await fetch('markets.json');
        const markets = await response.json();

        markets.forEach(market => {
            const option = document.createElement('option');
            option.value = market.slug;
            option.textContent = market.name;
            option.dataset.config = JSON.stringify(market);
            marketSelect.appendChild(option);
        });
    } catch (error) {
        console.error('Failed to load markets.json:', error);
        showError('Failed to load market list');
    }
}

function loadApiKey() {
    const savedKey = localStorage.getItem('manifold_api_key');
    if (savedKey) {
        apiKeyInput.value = savedKey;
        apiKeyStatus.textContent = 'Key saved';
        apiKeyStatus.classList.add('saved');
    }
}

function setupEventListeners() {
    marketSelect.addEventListener('change', onMarketSelect);
    refreshBtn.addEventListener('click', () => {
        if (currentMarketConfig) {
            loadMarket(currentMarketConfig);
        }
    });

    // API Key handling
    apiKeyInput.addEventListener('change', () => {
        const key = apiKeyInput.value.trim();
        if (key) {
            localStorage.setItem('manifold_api_key', key);
            apiKeyStatus.textContent = 'Key saved';
            apiKeyStatus.classList.add('saved');
        } else {
            localStorage.removeItem('manifold_api_key');
            apiKeyStatus.textContent = '';
            apiKeyStatus.classList.remove('saved');
        }
    });

    toggleKeyBtn.addEventListener('click', () => {
        if (apiKeyInput.type === 'password') {
            apiKeyInput.type = 'text';
            toggleKeyBtn.textContent = 'Hide';
        } else {
            apiKeyInput.type = 'password';
            toggleKeyBtn.textContent = 'Show';
        }
    });

    clearKeyBtn.addEventListener('click', () => {
        apiKeyInput.value = '';
        localStorage.removeItem('manifold_api_key');
        apiKeyStatus.textContent = '';
        apiKeyStatus.classList.remove('saved');
    });

    // Dialog handlers
    document.getElementById('close-bet-dialog').addEventListener('click', closeBetDialog);
    document.getElementById('cancel-bet').addEventListener('click', closeBetDialog);
    document.getElementById('execute-bet').addEventListener('click', executeBet);
    document.getElementById('close-result-dialog').addEventListener('click', closeResultDialog);
    document.getElementById('close-result').addEventListener('click', closeResultDialog);

    // Bet panel handlers
    document.getElementById('close-bet-panel').addEventListener('click', closeBetPanel);
    document.getElementById('panel-bet-amount').addEventListener('input', updatePanelPreview);
    document.getElementById('panel-execute-bet').addEventListener('click', executePanelBet);

    // Joint cell clicks for direct betting
    document.querySelectorAll('.cell.joint').forEach(cell => {
        cell.addEventListener('click', () => {
            const cellType = cell.dataset.cell;
            if (cellType) openBetPanel(cellType, cell);
        });
    });

    // Marginal cell clicks for multi-bet
    document.querySelectorAll('.cell.marginal[data-marginal]').forEach(cell => {
        cell.addEventListener('click', () => {
            const marginalType = cell.dataset.marginal;
            if (marginalType) openMarginalBetPanel(marginalType, cell);
        });
    });

    // Conditional cell clicks for hedged betting
    document.querySelectorAll('.conditional-cell').forEach(cell => {
        cell.addEventListener('click', () => {
            const condType = cell.dataset.cond;
            if (condType) openConditionalBetPanel(condType, cell);
        });
    });
}

async function onMarketSelect(event) {
    const slug = event.target.value;
    if (!slug) {
        hideAll();
        return;
    }

    const option = event.target.selectedOptions[0];
    const config = JSON.parse(option.dataset.config);
    await loadMarket(config);
}

async function loadMarket(config) {
    currentMarketConfig = config;
    showLoading();
    hideError();

    try {
        const market = await fetchMarket(config.slug);
        currentMarket = market;

        // Parse probabilities from answers
        marketProbabilities = parseMarketProbabilities(market, config);

        // Update UI
        displayMarketInfo(market);
        displayMatrix(marketProbabilities, config);
        displayConditionals(marketProbabilities);

        hideLoading();
        matrixContainer.classList.remove('hidden');
        marketInfo.classList.remove('hidden');
    } catch (error) {
        console.error('Failed to load market:', error);
        hideLoading();
        showError(`Failed to load market: ${error.message}`);
    }
}

async function fetchMarket(slug) {
    const response = await fetch(`${API_BASE}/slug/${slug}`);
    if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
    }
    return response.json();
}

function parseMarketProbabilities(market, config) {
    // Extract probabilities from multi-choice answers
    // Answers should follow pattern "A // B" or similar

    if (market.isResolved) {
        throw new Error('This market has resolved. Select an active market.');
    }

    const answers = market.answers || [];
    if (answers.length !== 4) {
        throw new Error(`Expected 4 answers for 2x2 market, got ${answers.length}`);
    }

    // Map answers to cells
    const probs = {
        a_yes_b_yes: 0,
        a_yes_b_no: 0,
        a_no_b_yes: 0,
        a_no_b_no: 0
    };

    // Store answer IDs for betting
    const answerIds = {
        a_yes_b_yes: null,
        a_yes_b_no: null,
        a_no_b_yes: null,
        a_no_b_no: null
    };

    // Build reverse mapping from answer text to cell type
    const textToCell = {};
    if (config.truthTable) {
        for (const [cellType, answerText] of Object.entries(config.truthTable)) {
            textToCell[answerText.toLowerCase()] = cellType;
        }
    }

    // Parse each answer
    for (const answer of answers) {
        const prob = answer.probability || 0;

        // Try explicit mapping first
        let cellType = textToCell[answer.text.toLowerCase()];

        // Fall back to heuristic parsing
        if (!cellType) {
            cellType = parseAnswerCell(answer.text, config.labelA, config.labelB);
        }

        if (cellType && cellType in probs) {
            probs[cellType] = prob;
            answerIds[cellType] = answer.id;
        } else {
            console.warn('Could not parse answer:', answer.text);
        }
    }

    // Calculate marginals
    const pA = probs.a_yes_b_yes + probs.a_yes_b_no;
    const pNotA = probs.a_no_b_yes + probs.a_no_b_no;
    const pB = probs.a_yes_b_yes + probs.a_no_b_yes;
    const pNotB = probs.a_yes_b_no + probs.a_no_b_no;

    // Calculate conditionals (with division safety)
    const pA_given_B = pB > 0 ? probs.a_yes_b_yes / pB : 0;
    const pA_given_notB = pNotB > 0 ? probs.a_yes_b_no / pNotB : 0;
    const pB_given_A = pA > 0 ? probs.a_yes_b_yes / pA : 0;
    const pB_given_notA = pNotA > 0 ? probs.a_no_b_yes / pNotA : 0;

    return {
        joint: probs,
        marginals: { pA, pNotA, pB, pNotB },
        conditionals: {
            a_given_b: pA_given_B,
            a_given_not_b: pA_given_notB,
            b_given_a: pB_given_A,
            b_given_not_a: pB_given_notA
        },
        answerIds: answerIds,
        answers: answers
    };
}

function parseAnswerCell(text, labelA, labelB) {
    // Parse answer text like "AGI // No Python 4" into cell type
    // Returns: 'a_yes_b_yes', 'a_yes_b_no', 'a_no_b_yes', 'a_no_b_no', or null

    const textLower = text.toLowerCase();
    const labelALower = labelA.toLowerCase();
    const labelBLower = labelB.toLowerCase();

    // Try to split on common separators
    const separators = [' // ', ' / ', ' & ', ' and ', ', '];
    let parts = null;

    for (const sep of separators) {
        if (textLower.includes(sep)) {
            parts = textLower.split(sep).map(p => p.trim());
            break;
        }
    }

    // If no separator found, try to match the whole text
    if (!parts || parts.length < 2) {
        parts = [textLower, textLower];
    }

    // Check each part for A and B status
    let aPositive = null;
    let bPositive = null;

    for (const part of parts) {
        // Check for A
        if (aPositive === null) {
            if (isNegatedIn(part, labelALower)) {
                aPositive = false;
            } else if (containsLabel(part, labelALower)) {
                aPositive = true;
            }
        }

        // Check for B
        if (bPositive === null) {
            if (isNegatedIn(part, labelBLower)) {
                bPositive = false;
            } else if (containsLabel(part, labelBLower)) {
                bPositive = true;
            }
        }
    }

    // If still not determined, try the full text
    if (aPositive === null) {
        if (isNegatedIn(textLower, labelALower)) aPositive = false;
        else if (containsLabel(textLower, labelALower)) aPositive = true;
    }
    if (bPositive === null) {
        if (isNegatedIn(textLower, labelBLower)) bPositive = false;
        else if (containsLabel(textLower, labelBLower)) bPositive = true;
    }

    if (aPositive === null || bPositive === null) {
        console.warn('Could not parse answer:', text, { aPositive, bPositive });
        return null;
    }

    if (aPositive && bPositive) return 'a_yes_b_yes';
    if (aPositive && !bPositive) return 'a_yes_b_no';
    if (!aPositive && bPositive) return 'a_no_b_yes';
    return 'a_no_b_no';
}

function isNegatedIn(text, label) {
    // Check if label appears in text with negation
    const words = label.split(' ');
    const significant = words.find(w => w.length > 2) || words[0];

    // Check for common negation patterns
    const negPatterns = [
        'no ' + label,
        'not ' + label,
        '~' + label,
        'no ' + significant,
        'not ' + significant,
        "doesn't " + significant,
        "don't " + significant,
        "won't " + significant,
    ];

    return negPatterns.some(p => text.includes(p));
}

function containsLabel(text, label) {
    // Check if label (or significant word) appears in text
    if (text.includes(label)) return true;

    const words = label.split(' ');
    const significant = words.find(w => w.length > 2);
    if (significant && text.includes(significant)) return true;

    return false;
}

function displayMarketInfo(market) {
    marketTitle.textContent = market.question;
    marketLink.href = `https://manifold.markets/${market.creatorUsername}/${market.slug}`;
}

function displayMatrix(probs, config) {
    // Update headers
    document.getElementById('col-header-b').textContent = config.labelB;
    document.getElementById('col-header-not-b').textContent = '~' + config.labelB;
    document.getElementById('row-header-a').textContent = config.labelA;
    document.getElementById('row-header-not-a').textContent = '~' + config.labelA;

    // Update joint cells
    setCellProb('cell-a-b', probs.joint.a_yes_b_yes);
    setCellProb('cell-a-not-b', probs.joint.a_yes_b_no);
    setCellProb('cell-not-a-b', probs.joint.a_no_b_yes);
    setCellProb('cell-not-a-not-b', probs.joint.a_no_b_no);

    // Update marginals (now have .prob-value spans)
    setMarginalProb('marginal-a', probs.marginals.pA);
    setMarginalProb('marginal-not-a', probs.marginals.pNotA);
    setMarginalProb('marginal-b', probs.marginals.pB);
    setMarginalProb('marginal-not-b', probs.marginals.pNotB);

    // Total sum (should be ~1.0)
    const total = Object.values(probs.joint).reduce((a, b) => a + b, 0);
    const totalEl = document.querySelector('#total-sum .prob-value');
    if (totalEl) totalEl.textContent = total.toFixed(2);
}

function setCellProb(cellId, prob) {
    const cell = document.getElementById(cellId);
    if (!cell) return;
    const probSpan = cell.querySelector('.prob-value');
    if (!probSpan) return;
    probSpan.textContent = formatProb(prob);

    // Color coding
    probSpan.className = 'prob-value';
    if (prob < 0.15) {
        probSpan.classList.add('prob-low');
    } else if (prob < 0.35) {
        probSpan.classList.add('prob-medium');
    } else {
        probSpan.classList.add('prob-high');
    }
}

function setMarginalProb(elementId, prob) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const probSpan = el.querySelector('.prob-value');
    if (probSpan) {
        probSpan.textContent = formatProb(prob);
    } else {
        el.textContent = formatProb(prob);
    }
}

function displayConditionals(probs) {
    const c = probs.conditionals;

    // Primary conditionals (new layout)
    const aGivenB = document.getElementById('cond-a-given-b');
    const aGivenNotB = document.getElementById('cond-a-given-not-b');
    const bGivenA = document.getElementById('cond-b-given-a');
    const bGivenNotA = document.getElementById('cond-b-given-not-a');

    if (aGivenB) aGivenB.textContent = formatProb(c.a_given_b);
    if (aGivenNotB) aGivenNotB.textContent = formatProb(c.a_given_not_b);
    if (bGivenA) bGivenA.textContent = formatProb(c.b_given_a);
    if (bGivenNotA) bGivenNotA.textContent = formatProb(c.b_given_not_a);

    // Derived statistics
    displayDerivedStats(probs);
}

function displayDerivedStats(probs) {
    const j = probs.joint;
    const m = probs.marginals;
    const c = probs.conditionals;

    // Correlation: Cov(A,B) / (sigma_A * sigma_B)
    // For binary: Cov = P(AB) - P(A)*P(B)
    // Var(A) = P(A)*(1-P(A)), sigma = sqrt(Var)
    const cov = j.a_yes_b_yes - m.pA * m.pB;
    const sigmaA = Math.sqrt(m.pA * m.pNotA);
    const sigmaB = Math.sqrt(m.pB * m.pNotB);
    const correlation = (sigmaA > 0 && sigmaB > 0) ? cov / (sigmaA * sigmaB) : 0;

    // Lift: P(A|B) / P(A)
    const liftA = m.pA > 0 ? c.a_given_b / m.pA : 0;
    const liftB = m.pB > 0 ? c.b_given_a / m.pB : 0;

    // Odds Ratio: (P(AB) * P(~A~B)) / (P(A~B) * P(~AB))
    const numerator = j.a_yes_b_yes * j.a_no_b_no;
    const denominator = j.a_yes_b_no * j.a_no_b_yes;
    const oddsRatio = denominator > 0 ? numerator / denominator : Infinity;

    // Display
    const corrEl = document.getElementById('stat-correlation');
    corrEl.textContent = correlation.toFixed(3);
    corrEl.className = 'stat-value ' + (correlation > 0.05 ? 'positive' : correlation < -0.05 ? 'negative' : 'neutral');

    const liftAEl = document.getElementById('stat-lift-a');
    liftAEl.textContent = liftA.toFixed(2) + 'x';
    liftAEl.className = 'stat-value ' + (liftA > 1.1 ? 'positive' : liftA < 0.9 ? 'negative' : 'neutral');

    const liftBEl = document.getElementById('stat-lift-b');
    liftBEl.textContent = liftB.toFixed(2) + 'x';
    liftBEl.className = 'stat-value ' + (liftB > 1.1 ? 'positive' : liftB < 0.9 ? 'negative' : 'neutral');

    const orEl = document.getElementById('stat-odds-ratio');
    orEl.textContent = oddsRatio === Infinity ? '∞' : oddsRatio.toFixed(2);
    orEl.className = 'stat-value ' + (oddsRatio > 1.5 ? 'positive' : oddsRatio < 0.67 ? 'negative' : 'neutral');
}

function formatProb(p) {
    return (p * 100).toFixed(1) + '%';
}

// Direct Cell Betting (inline panel)
let selectedCell = null;
let selectedCellType = null;

function openBetPanel(cellType, cellElement) {
    if (!marketProbabilities) return;

    // Clear previous selection and modes
    document.querySelectorAll('.cell.selected, .conditional-cell.selected').forEach(c => c.classList.remove('selected'));
    currentCondType = null;
    currentMarginalType = null;

    // Select new cell
    selectedCell = cellElement;
    selectedCellType = cellType;
    cellElement.classList.add('selected');

    // Get cell info
    const cellLabels = {
        'a_yes_b_yes': `${currentMarketConfig.labelA} & ${currentMarketConfig.labelB}`,
        'a_yes_b_no': `${currentMarketConfig.labelA} & ~${currentMarketConfig.labelB}`,
        'a_no_b_yes': `~${currentMarketConfig.labelA} & ${currentMarketConfig.labelB}`,
        'a_no_b_no': `~${currentMarketConfig.labelA} & ~${currentMarketConfig.labelB}`
    };

    const prob = marketProbabilities.joint[cellType];
    const label = cellLabels[cellType] || cellType;

    document.getElementById('bet-panel-title').textContent = `Bet on: ${label}`;
    document.getElementById('bet-panel-description').textContent =
        `Current probability: ${formatProb(prob)}. Buy YES shares to increase, NO to decrease.`;

    updateTradePreview();
    document.getElementById('bet-panel').classList.remove('hidden');
}

function closeBetPanel() {
    document.getElementById('bet-panel').classList.add('hidden');
    document.querySelectorAll('.cell.selected, .conditional-cell.selected').forEach(c => c.classList.remove('selected'));
    selectedCell = null;
    selectedCellType = null;
    currentCondType = null;
    currentMarginalType = null;
}

// Unified handlers that dispatch based on current mode
function updatePanelPreview() {
    if (currentCondType) {
        updateConditionalTradePreview();
    } else if (currentMarginalType) {
        updateMarginalTradePreview();
    } else {
        updateTradePreview();
    }
}

async function executePanelBet() {
    if (currentCondType) {
        await executeConditionalBet();
    } else if (currentMarginalType) {
        await executeMarginalBet();
    } else {
        await executeDirectBet();
    }
}

function updateTradePreview() {
    if (!selectedCellType || !marketProbabilities) return;

    const amount = parseFloat(document.getElementById('panel-bet-amount').value) || 10;
    const prob = marketProbabilities.joint[selectedCellType];

    // Simple estimate: shares ~ amount / prob (ignoring slippage)
    const estimatedShares = prob > 0 ? (amount / prob).toFixed(1) : '?';

    document.getElementById('preview-buy').textContent =
        `YES on "${currentMarketConfig.truthTable?.[selectedCellType] || selectedCellType}"`;
    document.getElementById('preview-cost').textContent = `M$${amount.toFixed(2)}`;
    document.getElementById('preview-shares').textContent = `~${estimatedShares} shares`;
}

async function executeDirectBet() {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
        showError('Please enter your Manifold API key to place bets');
        return;
    }

    if (!selectedCellType || !marketProbabilities) {
        showError('No cell selected');
        return;
    }

    const amount = parseFloat(document.getElementById('panel-bet-amount').value) || 10;
    const answerId = marketProbabilities.answerIds[selectedCellType];

    if (!answerId) {
        showError('Could not find answer ID for this cell');
        return;
    }

    const executeBtn = document.getElementById('panel-execute-bet');
    executeBtn.disabled = true;
    executeBtn.textContent = 'Placing...';

    try {
        const result = await placeBet(apiKey, currentMarket.id, answerId, 'YES', amount);
        showResultDialog('Bet Placed', `Bought ${result.shares?.toFixed(2) || '?'} shares for M$${result.amount?.toFixed(2) || amount}`, false);
        closeBetPanel();
        // Refresh market data
        await loadMarket(currentMarketConfig);
    } catch (error) {
        showError(`Bet failed: ${error.message}`);
    } finally {
        executeBtn.disabled = false;
        executeBtn.textContent = 'Place Bet';
    }
}

// Conditional Betting (with hedging)
let currentCondType = null;

// Hedge configurations for each conditional bet type
const HEDGE_CONFIG = {
    'a_given_b': {
        // To bet on P(A|B): hedge with ~B outcomes, target A&B
        hedgeCells: ['a_yes_b_no', 'a_no_b_no'],  // ~B outcomes
        targetCell: 'a_yes_b_yes',                 // A&B
        hedgeMarginal: 'pNotB',
        description: (cfg) => `Bet on ${cfg.labelA} conditional on ${cfg.labelB} happening`
    },
    'a_given_not_b': {
        // To bet on P(A|~B): hedge with B outcomes, target A&~B
        hedgeCells: ['a_yes_b_yes', 'a_no_b_yes'],  // B outcomes
        targetCell: 'a_yes_b_no',                   // A&~B
        hedgeMarginal: 'pB',
        description: (cfg) => `Bet on ${cfg.labelA} conditional on ${cfg.labelB} NOT happening`
    },
    'b_given_a': {
        // To bet on P(B|A): hedge with ~A outcomes, target A&B
        hedgeCells: ['a_no_b_yes', 'a_no_b_no'],   // ~A outcomes
        targetCell: 'a_yes_b_yes',                  // A&B
        hedgeMarginal: 'pNotA',
        description: (cfg) => `Bet on ${cfg.labelB} conditional on ${cfg.labelA} happening`
    },
    'b_given_not_a': {
        // To bet on P(B|~A): hedge with A outcomes, target ~A&B
        hedgeCells: ['a_yes_b_yes', 'a_yes_b_no'],  // A outcomes
        targetCell: 'a_no_b_yes',                   // ~A&B
        hedgeMarginal: 'pA',
        description: (cfg) => `Bet on ${cfg.labelB} conditional on ${cfg.labelA} NOT happening`
    }
};

function openConditionalBetPanel(condType, cellElement) {
    if (!marketProbabilities) return;

    const config = HEDGE_CONFIG[condType];
    if (!config) return;

    // Clear previous selection
    document.querySelectorAll('.cell.selected, .conditional-cell.selected').forEach(c => c.classList.remove('selected'));

    // Select new cell
    selectedCell = cellElement;
    currentCondType = condType;
    cellElement.classList.add('selected');

    // Get conditional probability
    const condProb = marketProbabilities.conditionals[condType];
    const hedgeCost = marketProbabilities.marginals[config.hedgeMarginal];

    document.getElementById('bet-panel-title').textContent = `Conditional Bet: P(${condType.replace('_given_', '|').replace('_', '~').toUpperCase()})`;
    document.getElementById('bet-panel-description').textContent = config.description(currentMarketConfig);

    updateConditionalTradePreview();
    document.getElementById('bet-panel').classList.remove('hidden');
}

function updateConditionalTradePreview() {
    if (!currentCondType || !marketProbabilities) {
        updateTradePreview();  // Fall back to direct bet preview
        return;
    }

    const config = HEDGE_CONFIG[currentCondType];
    if (!config) return;

    const amount = parseFloat(document.getElementById('panel-bet-amount').value) || 10;
    const hedgeCost = marketProbabilities.marginals[config.hedgeMarginal];
    const targetProb = marketProbabilities.joint[config.targetCell];

    // Split: hedgeAmount proportional to hedge cost, rest to target
    const hedgeAmount = amount * hedgeCost;
    const targetAmount = amount - hedgeAmount;
    const estimatedShares = targetProb > 0 ? (targetAmount / targetProb).toFixed(1) : '?';

    const hedgeLabel = config.hedgeCells.map(c =>
        currentMarketConfig.truthTable?.[c]?.substring(0, 20) + '...' || c
    ).join(' + ');

    document.getElementById('preview-buy').innerHTML = `
        <div>Hedge (~${(hedgeCost * 100).toFixed(0)}%): M$${hedgeAmount.toFixed(2)}</div>
        <div>Target: M$${targetAmount.toFixed(2)}</div>
    `;
    document.getElementById('preview-cost').textContent = `M$${amount.toFixed(2)} total`;
    document.getElementById('preview-shares').textContent = `~${estimatedShares} target shares`;
}

async function executeConditionalBet() {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
        showError('Please enter your Manifold API key to place bets');
        return;
    }

    if (!currentCondType || !marketProbabilities) {
        showError('No conditional selected');
        return;
    }

    const config = HEDGE_CONFIG[currentCondType];
    if (!config) return;

    const amount = parseFloat(document.getElementById('panel-bet-amount').value) || 10;
    const hedgeCost = marketProbabilities.marginals[config.hedgeMarginal];
    const hedgeAmount = amount * hedgeCost;
    const targetAmount = amount - hedgeAmount;

    const executeBtn = document.getElementById('panel-execute-bet');
    executeBtn.disabled = true;
    executeBtn.textContent = 'Placing bets...';

    try {
        const results = [];

        // Place hedge bets (split evenly between hedge cells)
        const perHedgeAmount = Math.max(1, Math.round(hedgeAmount / config.hedgeCells.length));
        for (const cellName of config.hedgeCells) {
            const answerId = marketProbabilities.answerIds[cellName];
            if (!answerId) throw new Error(`No answer ID for ${cellName}`);

            const result = await placeBet(apiKey, currentMarket.id, answerId, 'YES', perHedgeAmount);
            results.push({ type: 'hedge', cell: cellName, result });
        }

        // Place target bet
        const targetAnswerId = marketProbabilities.answerIds[config.targetCell];
        if (!targetAnswerId) throw new Error(`No answer ID for target ${config.targetCell}`);

        const targetResult = await placeBet(apiKey, currentMarket.id, targetAnswerId, 'YES', Math.max(1, Math.round(targetAmount)));
        results.push({ type: 'target', cell: config.targetCell, result: targetResult });

        // Show success
        const totalSpent = results.reduce((sum, r) => sum + (r.result.amount || 0), 0);
        showResultDialog('Conditional Bet Placed',
            `Placed ${results.length} bets totaling M$${totalSpent.toFixed(2)}`, false);
        closeBetPanel();
        currentCondType = null;

        // Refresh market data
        await loadMarket(currentMarketConfig);
    } catch (error) {
        showError(`Bet failed: ${error.message}`);
    } finally {
        executeBtn.disabled = false;
        executeBtn.textContent = 'Place Bet';
    }
}

// Marginal Betting (bet on whole row/column)
const MARGINAL_CONFIG = {
    'a': {
        cells: ['a_yes_b_yes', 'a_yes_b_no'],
        description: (cfg) => `Bet on ${cfg.labelA} (both ${cfg.labelB} and ~${cfg.labelB})`
    },
    'not_a': {
        cells: ['a_no_b_yes', 'a_no_b_no'],
        description: (cfg) => `Bet on ~${cfg.labelA} (both ${cfg.labelB} and ~${cfg.labelB})`
    },
    'b': {
        cells: ['a_yes_b_yes', 'a_no_b_yes'],
        description: (cfg) => `Bet on ${cfg.labelB} (both ${cfg.labelA} and ~${cfg.labelA})`
    },
    'not_b': {
        cells: ['a_yes_b_no', 'a_no_b_no'],
        description: (cfg) => `Bet on ~${cfg.labelB} (both ${cfg.labelA} and ~${cfg.labelA})`
    }
};

let currentMarginalType = null;

function openMarginalBetPanel(marginalType, cellElement) {
    if (!marketProbabilities) return;

    const config = MARGINAL_CONFIG[marginalType];
    if (!config) return;

    // Clear previous selection
    document.querySelectorAll('.cell.selected, .conditional-cell.selected').forEach(c => c.classList.remove('selected'));

    selectedCell = cellElement;
    currentMarginalType = marginalType;
    currentCondType = null;  // Clear conditional mode
    cellElement.classList.add('selected');

    // Get marginal probability
    const marginalKey = 'p' + marginalType.charAt(0).toUpperCase() + marginalType.slice(1).replace('_', '');
    const marginalProb = marketProbabilities.marginals[marginalKey] ||
        config.cells.reduce((sum, c) => sum + marketProbabilities.joint[c], 0);

    document.getElementById('bet-panel-title').textContent = `Marginal Bet: P(${marginalType.replace('not_', '~').toUpperCase()})`;
    document.getElementById('bet-panel-description').textContent = config.description(currentMarketConfig);

    updateMarginalTradePreview();
    document.getElementById('bet-panel').classList.remove('hidden');
}

function updateMarginalTradePreview() {
    if (!currentMarginalType || !marketProbabilities) return;

    const config = MARGINAL_CONFIG[currentMarginalType];
    if (!config) return;

    const amount = parseFloat(document.getElementById('panel-bet-amount').value) || 10;
    const perCellAmount = amount / config.cells.length;

    const cellLabels = config.cells.map(c =>
        currentMarketConfig.truthTable?.[c]?.substring(0, 25) || c
    );

    document.getElementById('preview-buy').innerHTML = cellLabels.map(label =>
        `<div>• ${label}: M$${perCellAmount.toFixed(2)}</div>`
    ).join('');
    document.getElementById('preview-cost').textContent = `M$${amount.toFixed(2)} total`;
    document.getElementById('preview-shares').textContent = `Split across ${config.cells.length} outcomes`;
}

async function executeMarginalBet() {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
        showError('Please enter your Manifold API key to place bets');
        return;
    }

    if (!currentMarginalType || !marketProbabilities) {
        showError('No marginal selected');
        return;
    }

    const config = MARGINAL_CONFIG[currentMarginalType];
    if (!config) return;

    const amount = parseFloat(document.getElementById('panel-bet-amount').value) || 10;
    const perCellAmount = Math.max(1, Math.round(amount / config.cells.length));

    const executeBtn = document.getElementById('panel-execute-bet');
    executeBtn.disabled = true;
    executeBtn.textContent = 'Placing bets...';

    try {
        const results = [];

        for (const cellName of config.cells) {
            const answerId = marketProbabilities.answerIds[cellName];
            if (!answerId) throw new Error(`No answer ID for ${cellName}`);

            const result = await placeBet(apiKey, currentMarket.id, answerId, 'YES', perCellAmount);
            results.push({ cell: cellName, result });
        }

        const totalSpent = results.reduce((sum, r) => sum + (r.result.amount || 0), 0);
        showResultDialog('Marginal Bet Placed',
            `Placed ${results.length} bets totaling M$${totalSpent.toFixed(2)}`, false);
        closeBetPanel();
        currentMarginalType = null;

        await loadMarket(currentMarketConfig);
    } catch (error) {
        showError(`Bet failed: ${error.message}`);
    } finally {
        executeBtn.disabled = false;
        executeBtn.textContent = 'Place Bet';
    }
}

// Legacy Conditional Betting (dialog - keeping for now)
let currentBetType = null;

function openBetDialog(betType) {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
        showError('Please enter your Manifold API key to place bets');
        return;
    }

    if (!marketProbabilities) {
        showError('No market loaded');
        return;
    }

    currentBetType = betType;

    // Set dialog title
    const titles = {
        'a_given_b': `Bet on P(${currentMarketConfig.labelA} | ${currentMarketConfig.labelB})`,
        'a_given_not_b': `Bet on P(${currentMarketConfig.labelA} | ~${currentMarketConfig.labelB})`,
        'b_given_a': `Bet on P(${currentMarketConfig.labelB} | ${currentMarketConfig.labelA})`,
        'b_given_not_a': `Bet on P(${currentMarketConfig.labelB} | ~${currentMarketConfig.labelA})`
    };

    document.getElementById('bet-dialog-title').textContent = titles[betType] || 'Conditional Bet';

    // Set description
    const descriptions = {
        'a_given_b': `Betting that ${currentMarketConfig.labelA} will happen, conditional on ${currentMarketConfig.labelB} happening. You'll be neutral on ${currentMarketConfig.labelB} itself.`,
        'a_given_not_b': `Betting that ${currentMarketConfig.labelA} will happen, conditional on ${currentMarketConfig.labelB} NOT happening. You'll be neutral on ${currentMarketConfig.labelB} itself.`,
        'b_given_a': `Betting that ${currentMarketConfig.labelB} will happen, conditional on ${currentMarketConfig.labelA} happening. You'll be neutral on ${currentMarketConfig.labelA} itself.`,
        'b_given_not_a': `Betting that ${currentMarketConfig.labelB} will happen, conditional on ${currentMarketConfig.labelA} NOT happening. You'll be neutral on ${currentMarketConfig.labelA} itself.`
    };

    document.getElementById('bet-description').textContent = descriptions[betType];

    updateHedgePreview();
    betDialog.classList.remove('hidden');
}

function closeBetDialog() {
    betDialog.classList.add('hidden');
    currentBetType = null;
}

function updateHedgePreview() {
    const amount = parseFloat(document.getElementById('bet-amount').value) || 10;

    if (!currentBetType || !marketProbabilities) return;

    const probs = marketProbabilities;

    // Determine which cells to buy for hedge
    let hedgeCells, targetCell, hedgeCost, targetSpend;
    let hedgeLabel, targetLabel;

    switch (currentBetType) {
        case 'a_given_b':
            // Hedge: Buy ~B outcomes (a_yes_b_no + a_no_b_no)
            hedgeCells = ['a_yes_b_no', 'a_no_b_no'];
            targetCell = 'a_yes_b_yes';
            hedgeCost = probs.marginals.pNotB;  // Cost to get 1 share of ~B
            hedgeLabel = `~${currentMarketConfig.labelB}`;
            targetLabel = `${currentMarketConfig.labelA} & ${currentMarketConfig.labelB}`;
            break;
        case 'a_given_not_b':
            // Hedge: Buy B outcomes (a_yes_b_yes + a_no_b_yes)
            hedgeCells = ['a_yes_b_yes', 'a_no_b_yes'];
            targetCell = 'a_yes_b_no';
            hedgeCost = probs.marginals.pB;
            hedgeLabel = currentMarketConfig.labelB;
            targetLabel = `${currentMarketConfig.labelA} & ~${currentMarketConfig.labelB}`;
            break;
        case 'b_given_a':
            // Hedge: Buy ~A outcomes
            hedgeCells = ['a_no_b_yes', 'a_no_b_no'];
            targetCell = 'a_yes_b_yes';
            hedgeCost = probs.marginals.pNotA;
            hedgeLabel = `~${currentMarketConfig.labelA}`;
            targetLabel = `${currentMarketConfig.labelA} & ${currentMarketConfig.labelB}`;
            break;
        case 'b_given_not_a':
            // Hedge: Buy A outcomes
            hedgeCells = ['a_yes_b_yes', 'a_yes_b_no'];
            targetCell = 'a_no_b_yes';
            hedgeCost = probs.marginals.pA;
            hedgeLabel = currentMarketConfig.labelA;
            targetLabel = `~${currentMarketConfig.labelA} & ${currentMarketConfig.labelB}`;
            break;
    }

    // Calculate amounts
    // To deploy M$X total:
    // - Buy 1 share of each hedge cell (costs hedgeCost total)
    // - Spend remaining (X - hedgeCost) on target cell

    // But we need to scale: with M$X, we buy X shares of hedge, costing X * hedgeCost
    // Wait, that's not right either...

    // Actually: To get conditional exposure worth X shares:
    // - Buy 1 share of each hedge outcome = costs hedgeCost
    // - Remaining capital goes to target
    // Total spent: hedgeCost + targetSpend = amount
    // So targetSpend = amount - hedgeCost (approximately)

    // But this is per-share of the conditional. Let's simplify:
    // The hedge costs hedgeCost to protect 1 unit
    // We scale everything by amount / (1 + epsilon) where epsilon handles slippage

    // Simplified model:
    // hedgeAmount = amount * hedgeCost
    // targetAmount = amount * (1 - hedgeCost)
    const hedgeAmount = amount * hedgeCost;
    const targetAmount = amount - hedgeAmount;

    const targetProb = probs.joint[targetCell];
    const expectedShares = targetAmount / targetProb;  // Rough estimate

    // Display hedge details
    const hedgeDetails = document.getElementById('hedge-details');
    hedgeDetails.innerHTML = `
        <div class="hedge-step">
            <span>1. Buy hedge (${hedgeLabel}):</span>
            <span>~M$${hedgeAmount.toFixed(2)}</span>
        </div>
        <div class="hedge-step">
            <span>2. Buy target (${targetLabel}):</span>
            <span>~M$${targetAmount.toFixed(2)}</span>
        </div>
        <div class="hedge-step">
            <span><strong>Total:</strong></span>
            <span><strong>M$${amount.toFixed(2)}</strong></span>
        </div>
    `;

    // Display payout scenarios
    const payoutScenarios = document.getElementById('payout-scenarios');

    let winScenario, neutralScenario, lossScenario;

    switch (currentBetType) {
        case 'a_given_b':
            winScenario = { label: `${currentMarketConfig.labelA} & ${currentMarketConfig.labelB}`, value: `+M$${(expectedShares - targetAmount).toFixed(2)}`, class: 'win' };
            neutralScenario = { label: `~${currentMarketConfig.labelB} (either A or ~A)`, value: `M$${hedgeAmount.toFixed(2)} returned`, class: 'neutral' };
            lossScenario = { label: `~${currentMarketConfig.labelA} & ${currentMarketConfig.labelB}`, value: `-M$${targetAmount.toFixed(2)}`, class: 'loss' };
            break;
        case 'a_given_not_b':
            winScenario = { label: `${currentMarketConfig.labelA} & ~${currentMarketConfig.labelB}`, value: `+M$${(expectedShares - targetAmount).toFixed(2)}`, class: 'win' };
            neutralScenario = { label: `${currentMarketConfig.labelB} (either A or ~A)`, value: `M$${hedgeAmount.toFixed(2)} returned`, class: 'neutral' };
            lossScenario = { label: `~${currentMarketConfig.labelA} & ~${currentMarketConfig.labelB}`, value: `-M$${targetAmount.toFixed(2)}`, class: 'loss' };
            break;
        case 'b_given_a':
            winScenario = { label: `${currentMarketConfig.labelA} & ${currentMarketConfig.labelB}`, value: `+M$${(expectedShares - targetAmount).toFixed(2)}`, class: 'win' };
            neutralScenario = { label: `~${currentMarketConfig.labelA} (either B or ~B)`, value: `M$${hedgeAmount.toFixed(2)} returned`, class: 'neutral' };
            lossScenario = { label: `${currentMarketConfig.labelA} & ~${currentMarketConfig.labelB}`, value: `-M$${targetAmount.toFixed(2)}`, class: 'loss' };
            break;
        case 'b_given_not_a':
            winScenario = { label: `~${currentMarketConfig.labelA} & ${currentMarketConfig.labelB}`, value: `+M$${(expectedShares - targetAmount).toFixed(2)}`, class: 'win' };
            neutralScenario = { label: `${currentMarketConfig.labelA} (either B or ~B)`, value: `M$${hedgeAmount.toFixed(2)} returned`, class: 'neutral' };
            lossScenario = { label: `~${currentMarketConfig.labelA} & ~${currentMarketConfig.labelB}`, value: `-M$${targetAmount.toFixed(2)}`, class: 'loss' };
            break;
    }

    payoutScenarios.innerHTML = `
        <div class="payout-scenario ${winScenario.class}">
            <span>If ${winScenario.label}:</span>
            <span>${winScenario.value}</span>
        </div>
        <div class="payout-scenario ${neutralScenario.class}">
            <span>If ${neutralScenario.label}:</span>
            <span>${neutralScenario.value}</span>
        </div>
        <div class="payout-scenario ${lossScenario.class}">
            <span>If ${lossScenario.label}:</span>
            <span>${lossScenario.value}</span>
        </div>
    `;

    // Store for execution
    betDialog.dataset.hedgeCells = JSON.stringify(hedgeCells);
    betDialog.dataset.targetCell = targetCell;
    betDialog.dataset.hedgeAmount = hedgeAmount;
    betDialog.dataset.targetAmount = targetAmount;
}

async function executeBet() {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
        showResultDialog('Error', 'No API key provided', true);
        return;
    }

    const amount = parseFloat(document.getElementById('bet-amount').value);
    const hedgeCells = JSON.parse(betDialog.dataset.hedgeCells);
    const targetCell = betDialog.dataset.targetCell;
    const hedgeAmount = parseFloat(betDialog.dataset.hedgeAmount);
    const targetAmount = parseFloat(betDialog.dataset.targetAmount);

    // Disable execute button
    const executeBtn = document.getElementById('execute-bet');
    executeBtn.disabled = true;
    executeBtn.textContent = 'Placing bets...';

    try {
        const results = [];

        // Place hedge bets
        for (const cellName of hedgeCells) {
            const answer = findAnswerForCell(cellName);
            if (!answer) {
                throw new Error(`Could not find answer for ${cellName}`);
            }

            // Split hedge amount between the two hedge cells
            const cellAmount = Math.max(1, Math.round(hedgeAmount / hedgeCells.length));

            const result = await placeBet(apiKey, currentMarket.id, answer.id, 'YES', cellAmount);
            results.push({ cell: cellName, type: 'hedge', result });
        }

        // Place target bet
        const targetAnswer = findAnswerForCell(targetCell);
        if (!targetAnswer) {
            throw new Error(`Could not find answer for ${targetCell}`);
        }

        const targetResult = await placeBet(apiKey, currentMarket.id, targetAnswer.id, 'YES', Math.max(1, Math.round(targetAmount)));
        results.push({ cell: targetCell, type: 'target', result: targetResult });

        // Show success
        const resultHtml = results.map(r =>
            `<div>${r.type === 'hedge' ? 'Hedge' : 'Target'} (${r.cell}): M$${r.result.amount?.toFixed(2) || '?'}</div>`
        ).join('');

        showResultDialog('Bets Placed Successfully', resultHtml, false);
        closeBetDialog();

        // Refresh market data
        await loadMarket(currentMarketConfig);

    } catch (error) {
        console.error('Bet execution failed:', error);
        showResultDialog('Bet Failed', error.message, true);
    } finally {
        executeBtn.disabled = false;
        executeBtn.textContent = 'Place Bet';
    }
}

function findAnswerForCell(cellName) {
    if (!currentMarket || !currentMarket.answers) return null;

    const config = currentMarketConfig;

    for (const answer of currentMarket.answers) {
        const text = answer.text.toLowerCase();

        switch (cellName) {
            case 'a_yes_b_yes':
                if (containsPositive(text, config.labelA) && containsPositive(text, config.labelB)) {
                    return answer;
                }
                break;
            case 'a_yes_b_no':
                if (containsPositive(text, config.labelA) && containsNegative(text, config.labelB)) {
                    return answer;
                }
                break;
            case 'a_no_b_yes':
                if (containsNegative(text, config.labelA) && containsPositive(text, config.labelB)) {
                    return answer;
                }
                break;
            case 'a_no_b_no':
                if (containsNegative(text, config.labelA) && containsNegative(text, config.labelB)) {
                    return answer;
                }
                break;
        }
    }

    return null;
}

async function placeBet(apiKey, contractId, answerId, outcome, amount) {
    const response = await fetch(`${API_BASE}/bet`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Key ${apiKey}`
        },
        body: JSON.stringify({
            contractId,
            answerId,
            outcome,
            amount
        })
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`API error ${response.status}: ${error}`);
    }

    return response.json();
}

function showResultDialog(title, content, isError) {
    document.getElementById('result-dialog-title').textContent = title;
    const contentEl = document.getElementById('result-content');
    contentEl.innerHTML = content;
    contentEl.className = isError ? 'result-error' : 'result-success';
    resultDialog.classList.remove('hidden');
}

function closeResultDialog() {
    resultDialog.classList.add('hidden');
}

// UI Helpers
function showLoading() {
    loadingSection.classList.remove('hidden');
    matrixContainer.classList.add('hidden');
    marketInfo.classList.add('hidden');
}

function hideLoading() {
    loadingSection.classList.add('hidden');
}

function showError(message) {
    errorMessage.textContent = message;
    errorSection.classList.remove('hidden');
}

function hideError() {
    errorSection.classList.add('hidden');
}

function hideAll() {
    matrixContainer.classList.add('hidden');
    marketInfo.classList.add('hidden');
    hideLoading();
    hideError();
}
