// Conditional Markets Viewer - app.js

const API_BASE = 'https://api.manifold.markets/v0';

// =============================================================================
// AMM Core Math (CPMM with p=0.5)
// =============================================================================

/**
 * Calculate shares received for a given cost.
 * Formula: When buying YES, n_new = n + cost, y_new = k² / n_new
 *          shares = cost + (y - y_new)
 */
function sharesForCost(y, n, cost, position) {
    if (cost <= 0) return 0;
    const kSquared = y * n;

    if (position === 'YES') {
        const nNew = n + cost;
        const yNew = kSquared / nNew;
        return cost + (y - yNew);
    } else {
        const yNew = y + cost;
        const nNew = kSquared / yNew;
        return cost + (n - nNew);
    }
}

/**
 * Calculate cost to buy a given number of shares.
 * Formula: cost = (shares - y - n + sqrt((y + n - shares)² + 4 * shares * otherPool)) / 2
 */
function costForShares(y, n, shares, position) {
    if (shares <= 0) return 0;
    const otherPool = position === 'YES' ? n : y;
    const discriminant = Math.pow(y + n - shares, 2) + 4 * shares * otherPool;
    if (discriminant < 0) return Infinity;
    return (shares - y - n + Math.sqrt(discriminant)) / 2;
}

/**
 * Calculate pool state after a trade.
 */
function poolAfterTrade(y, n, cost, position) {
    const kSquared = y * n;
    if (position === 'YES') {
        const nNew = n + cost;
        const yNew = kSquared / nNew;
        return { y: yNew, n: nNew };
    } else {
        const yNew = y + cost;
        const nNew = kSquared / yNew;
        return { y: yNew, n: nNew };
    }
}

/**
 * Calculate probability from pool state.
 * P(YES) = n / (y + n) for p=0.5
 */
function probabilityFromPool(y, n) {
    return n / (y + n);
}

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
    document.getElementById('panel-bet-amount').addEventListener('input', () => {
        updatePanelPreview();
        clearValidation();  // Clear validation when amount changes
    });
    document.getElementById('panel-execute-bet').addEventListener('click', executePanelBet);
    document.getElementById('panel-validate-btn').addEventListener('click', validateWithApi);

    // Direction toggle
    document.querySelectorAll('.direction-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.direction-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentBetDirection = btn.dataset.direction;
            updatePanelPreview();
        });
    });

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
    document.querySelectorAll('.cell.conditional[data-cond]').forEach(cell => {
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

    // Store pool data for AMM calculations
    const pools = {
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
            pools[cellType] = answer.pool || null;
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
        pools: pools,
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
    document.querySelectorAll('.cell.selected').forEach(c => c.classList.remove('selected'));
    currentCondType = null;
    currentMarginalType = null;

    // Hide direction row for direct bets
    document.getElementById('bet-direction-row').style.display = 'none';

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
    document.querySelectorAll('.cell.selected').forEach(c => c.classList.remove('selected'));
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
    const pool = marketProbabilities.pools[selectedCellType];
    const answerText = currentMarketConfig.truthTable?.[selectedCellType] || selectedCellType;

    // Use real AMM math if pool data available, otherwise fall back to naive estimate
    let estimatedShares;
    if (pool && pool.YES && pool.NO) {
        estimatedShares = sharesForCost(pool.YES, pool.NO, amount, 'YES').toFixed(1);
    } else {
        estimatedShares = prob > 0 ? (amount / prob).toFixed(1) : '?';
    }

    const tradePlan = document.getElementById('trade-plan');
    tradePlan.innerHTML = `
        <div class="trade-step target">
            <span class="trade-step-num">1</span>
            <div class="trade-step-details">
                <div class="trade-step-action">Buy YES → ~${estimatedShares} shares</div>
                <div class="trade-step-answer">${answerText}</div>
            </div>
            <span class="trade-step-amount">M$${amount.toFixed(2)}</span>
        </div>
    `;

    const tradeSummary = document.getElementById('trade-summary');
    tradeSummary.innerHTML = `
        <div class="summary-row">
            <span class="summary-label">Current prob:</span>
            <span class="summary-value">${formatProb(prob)}</span>
        </div>
        <div class="summary-row">
            <span class="summary-label">Est. shares:</span>
            <span class="summary-value">~${estimatedShares}</span>
        </div>
        <div class="summary-row total">
            <span class="summary-label">Total cost:</span>
            <span class="summary-value">M$${amount.toFixed(2)}</span>
        </div>
    `;
}

// =============================================================================
// API Dry-Run Validation
// =============================================================================

function clearValidation() {
    document.getElementById('validation-status').textContent = '';
    document.getElementById('validation-status').className = 'validation-status';
    document.getElementById('validation-details').classList.add('hidden');
}

async function validateWithApi() {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
        showError('API key required for validation');
        return;
    }

    if (!currentMarket || !marketProbabilities) {
        showError('No market loaded');
        return;
    }

    const amount = parseFloat(document.getElementById('panel-bet-amount').value) || 10;
    const statusEl = document.getElementById('validation-status');
    const detailsEl = document.getElementById('validation-details');

    statusEl.textContent = '(validating...)';
    statusEl.className = 'validation-status pending';

    try {
        // For direct bets, validate the single cell
        if (selectedCellType && !currentCondType && !currentMarginalType) {
            await validateDirectBet(amount, statusEl, detailsEl);
        }
        // For conditional bets, validate each leg
        else if (currentCondType) {
            await validateConditionalBet(amount, statusEl, detailsEl);
        }
        // For marginal bets, validate each cell
        else if (currentMarginalType) {
            await validateMarginalBet(amount, statusEl, detailsEl);
        }
    } catch (error) {
        statusEl.textContent = '(error)';
        statusEl.className = 'validation-status invalid';
        detailsEl.innerHTML = `<div class="validation-row"><span class="value mismatch">Error: ${error.message}</span></div>`;
        detailsEl.classList.remove('hidden');
    }
}

async function validateDirectBet(amount, statusEl, detailsEl) {
    const pool = marketProbabilities.pools[selectedCellType];
    const answerId = marketProbabilities.answerIds[selectedCellType];

    // Our estimate
    let localShares = 0;
    if (pool && pool.YES && pool.NO) {
        localShares = sharesForCost(pool.YES, pool.NO, amount, 'YES');
    }

    // API dry-run
    const apiResult = await placeBetDryRun(currentMarket.id, answerId, 'YES', amount);
    const apiShares = apiResult.shares || 0;

    // Compare
    const error = Math.abs(localShares - apiShares);
    const errorPct = apiShares > 0 ? (error / apiShares * 100) : 0;
    const isMatch = errorPct < 1;  // Within 1% is a match

    statusEl.textContent = isMatch ? '✓ validated' : '✗ mismatch';
    statusEl.className = `validation-status ${isMatch ? 'valid' : 'invalid'}`;

    detailsEl.innerHTML = `
        <div class="validation-row">
            <span class="label">Local AMM:</span>
            <span class="value">${localShares.toFixed(4)} shares</span>
        </div>
        <div class="validation-row">
            <span class="label">API dry-run:</span>
            <span class="value">${apiShares.toFixed(4)} shares</span>
        </div>
        <div class="validation-row">
            <span class="label">Difference:</span>
            <span class="value ${isMatch ? 'match' : 'mismatch'}">${error.toFixed(4)} (${errorPct.toFixed(2)}%)</span>
        </div>
    `;
    detailsEl.classList.remove('hidden');
}

async function validateConditionalBet(amount, statusEl, detailsEl) {
    const config = HEDGE_CONFIG[currentCondType];
    const hedgeSharesPerCell = amount;

    // CAVEAT: We validate each leg independently against current market state.
    // In real execution, earlier trades move the market before later trades execute.
    // This validation confirms our AMM math is correct, but actual execution will
    // see slightly different prices due to sequential market impact.

    let rows = [];
    let totalError = 0;
    let totalShares = 0;

    // Validate each hedge cell
    for (const cellName of config.hedgeCells) {
        const pool = marketProbabilities.pools[cellName];
        const answerId = marketProbabilities.answerIds[cellName];

        // Our estimate: cost to buy hedgeSharesPerCell shares
        let localCost = 0;
        if (pool && pool.YES && pool.NO) {
            localCost = costForShares(pool.YES, pool.NO, hedgeSharesPerCell, 'YES');
        }

        // API: We need to validate shares for a given cost, not cost for shares
        // So let's validate the shares we'd get for our calculated cost
        const apiResult = await placeBetDryRun(currentMarket.id, answerId, 'YES', localCost);
        const apiShares = apiResult.shares || 0;

        const error = Math.abs(hedgeSharesPerCell - apiShares);
        totalError += error;
        totalShares += hedgeSharesPerCell;

        rows.push(`
            <div class="validation-row">
                <span class="label">Hedge ${cellName.replace('a_', '').replace('b_', '')}:</span>
                <span class="value">${hedgeSharesPerCell.toFixed(1)} vs ${apiShares.toFixed(1)} shares</span>
            </div>
        `);
    }

    // Validate target
    const targetCell = currentBetDirection === 'yes' ? config.targetYes : config.targetNo;
    const targetPool = marketProbabilities.pools[targetCell];
    const targetAnswerId = marketProbabilities.answerIds[targetCell];

    // Calculate target amount
    let totalHedgeCost = 0;
    for (const cellName of config.hedgeCells) {
        const pool = marketProbabilities.pools[cellName];
        if (pool && pool.YES && pool.NO) {
            totalHedgeCost += costForShares(pool.YES, pool.NO, hedgeSharesPerCell, 'YES');
        }
    }
    const targetAmount = Math.max(0, amount - totalHedgeCost);

    let localTargetShares = 0;
    if (targetPool && targetPool.YES && targetPool.NO && targetAmount > 0) {
        localTargetShares = sharesForCost(targetPool.YES, targetPool.NO, targetAmount, 'YES');
    }

    const apiTargetResult = await placeBetDryRun(currentMarket.id, targetAnswerId, 'YES', targetAmount);
    const apiTargetShares = apiTargetResult.shares || 0;

    const targetError = Math.abs(localTargetShares - apiTargetShares);
    totalError += targetError;
    totalShares += localTargetShares;

    rows.push(`
        <div class="validation-row">
            <span class="label">Target:</span>
            <span class="value">${localTargetShares.toFixed(1)} vs ${apiTargetShares.toFixed(1)} shares</span>
        </div>
    `);

    const errorPct = totalShares > 0 ? (totalError / totalShares * 100) : 0;
    const isMatch = errorPct < 2;  // Within 2% for multi-leg

    statusEl.textContent = isMatch ? '✓ validated' : '✗ mismatch';
    statusEl.className = `validation-status ${isMatch ? 'valid' : 'invalid'}`;

    detailsEl.innerHTML = rows.join('') + `
        <div class="validation-row">
            <span class="label">Total error:</span>
            <span class="value ${isMatch ? 'match' : 'mismatch'}">${errorPct.toFixed(2)}%</span>
        </div>
        <div class="validation-row" style="margin-top: 0.5rem; font-size: 0.75rem; color: var(--text-secondary);">
            <span>Note: Validates each leg vs current state. Actual execution sees sequential price changes.</span>
        </div>
    `;
    detailsEl.classList.remove('hidden');
}

async function validateMarginalBet(amount, statusEl, detailsEl) {
    const config = MARGINAL_CONFIG[currentMarginalType];
    const perCellAmount = amount / config.cells.length;

    // Same caveat as conditional: validates each leg independently.

    let rows = [];
    let totalError = 0;
    let totalShares = 0;

    for (const cellName of config.cells) {
        const pool = marketProbabilities.pools[cellName];
        const answerId = marketProbabilities.answerIds[cellName];

        let localShares = 0;
        if (pool && pool.YES && pool.NO) {
            localShares = sharesForCost(pool.YES, pool.NO, perCellAmount, 'YES');
        }

        const apiResult = await placeBetDryRun(currentMarket.id, answerId, 'YES', perCellAmount);
        const apiShares = apiResult.shares || 0;

        const error = Math.abs(localShares - apiShares);
        totalError += error;
        totalShares += localShares;

        rows.push(`
            <div class="validation-row">
                <span class="label">${cellName.replace('a_', '').replace('b_', '')}:</span>
                <span class="value">${localShares.toFixed(1)} vs ${apiShares.toFixed(1)} shares</span>
            </div>
        `);
    }

    const errorPct = totalShares > 0 ? (totalError / totalShares * 100) : 0;
    const isMatch = errorPct < 2;

    statusEl.textContent = isMatch ? '✓ validated' : '✗ mismatch';
    statusEl.className = `validation-status ${isMatch ? 'valid' : 'invalid'}`;

    detailsEl.innerHTML = rows.join('') + `
        <div class="validation-row">
            <span class="label">Total error:</span>
            <span class="value ${isMatch ? 'match' : 'mismatch'}">${errorPct.toFixed(2)}%</span>
        </div>
        <div class="validation-row" style="margin-top: 0.5rem; font-size: 0.75rem; color: var(--text-secondary);">
            <span>Note: Validates each leg vs current state. Actual execution sees sequential price changes.</span>
        </div>
    `;
    detailsEl.classList.remove('hidden');
}

async function placeBetDryRun(contractId, answerId, outcome, amount) {
    const apiKey = apiKeyInput.value.trim();

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
            amount,
            dryRun: true
        })
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`API error ${response.status}: ${error}`);
    }

    return response.json();
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
let currentBetDirection = 'yes';  // 'yes' or 'no'

// Hedge configurations for each conditional bet type
// For YES direction: hedge the condition, buy the target
// For NO direction: same hedge, but opposite target
const HEDGE_CONFIG = {
    'a_given_b': {
        // To bet on P(A|B): hedge with ~B outcomes
        hedgeCells: ['a_yes_b_no', 'a_no_b_no'],  // ~B outcomes
        targetYes: 'a_yes_b_yes',                  // A&B (YES: A happens given B)
        targetNo: 'a_no_b_yes',                    // ~A&B (NO: A doesn't happen given B)
        hedgeMarginal: 'pNotB',
        descYes: (cfg) => `Bet ${cfg.labelA} happens given ${cfg.labelB}`,
        descNo: (cfg) => `Bet ${cfg.labelA} does NOT happen given ${cfg.labelB}`
    },
    'a_given_not_b': {
        // To bet on P(A|~B): hedge with B outcomes
        hedgeCells: ['a_yes_b_yes', 'a_no_b_yes'],  // B outcomes
        targetYes: 'a_yes_b_no',                    // A&~B
        targetNo: 'a_no_b_no',                      // ~A&~B
        hedgeMarginal: 'pB',
        descYes: (cfg) => `Bet ${cfg.labelA} happens given ~${cfg.labelB}`,
        descNo: (cfg) => `Bet ${cfg.labelA} does NOT happen given ~${cfg.labelB}`
    },
    'b_given_a': {
        // To bet on P(B|A): hedge with ~A outcomes
        hedgeCells: ['a_no_b_yes', 'a_no_b_no'],   // ~A outcomes
        targetYes: 'a_yes_b_yes',                   // A&B (YES: B happens given A)
        targetNo: 'a_yes_b_no',                     // A&~B (NO: B doesn't happen given A)
        hedgeMarginal: 'pNotA',
        descYes: (cfg) => `Bet ${cfg.labelB} happens given ${cfg.labelA}`,
        descNo: (cfg) => `Bet ${cfg.labelB} does NOT happen given ${cfg.labelA}`
    },
    'b_given_not_a': {
        // To bet on P(B|~A): hedge with A outcomes
        hedgeCells: ['a_yes_b_yes', 'a_yes_b_no'],  // A outcomes
        targetYes: 'a_no_b_yes',                    // ~A&B
        targetNo: 'a_no_b_no',                      // ~A&~B
        hedgeMarginal: 'pA',
        descYes: (cfg) => `Bet ${cfg.labelB} happens given ~${cfg.labelA}`,
        descNo: (cfg) => `Bet ${cfg.labelB} does NOT happen given ~${cfg.labelA}`
    }
};

function openConditionalBetPanel(condType, cellElement) {
    if (!marketProbabilities) return;

    const config = HEDGE_CONFIG[condType];
    if (!config) return;

    // Clear previous selection
    document.querySelectorAll('.cell.selected').forEach(c => c.classList.remove('selected'));

    // Select new cell
    selectedCell = cellElement;
    currentCondType = condType;
    currentBetDirection = 'yes';  // Reset to YES
    cellElement.classList.add('selected');

    // Reset direction buttons
    document.querySelectorAll('.direction-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.direction-btn[data-direction="yes"]').classList.add('active');

    // Show direction row for conditional bets
    document.getElementById('bet-direction-row').style.display = 'flex';

    // Get conditional probability
    const condProb = marketProbabilities.conditionals[condType];

    const label = condType.replace('_given_', '|').replace('not_', '~').toUpperCase();
    document.getElementById('bet-panel-title').textContent = `Conditional Bet: ${label}`;
    document.getElementById('bet-panel-description').textContent = config.descYes(currentMarketConfig);

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

    // Get target based on direction
    const targetCell = currentBetDirection === 'yes' ? config.targetYes : config.targetNo;
    const targetProb = marketProbabilities.joint[targetCell];
    const condProb = marketProbabilities.conditionals[currentCondType];

    // Update description based on direction
    const desc = currentBetDirection === 'yes' ? config.descYes : config.descNo;
    document.getElementById('bet-panel-description').textContent = desc(currentMarketConfig);

    // KEY INSIGHT: Buy N shares of EACH hedge outcome (not equal dollars!)
    // This ensures neutral payout if the hedged condition occurs.
    // N = amount, so M$10 bet buys 10 shares of each hedge outcome.
    const hedgeSharesPerCell = amount;

    // Calculate hedge cost using real AMM math: costForShares(y, n, shares, 'YES')
    let totalHedgeCost = 0;
    const hedgeCellCosts = [];
    for (const cellName of config.hedgeCells) {
        const cellProb = marketProbabilities.joint[cellName];
        const pool = marketProbabilities.pools[cellName];

        // Use AMM if pool available, otherwise naive estimate
        let cellCost;
        if (pool && pool.YES && pool.NO) {
            cellCost = costForShares(pool.YES, pool.NO, hedgeSharesPerCell, 'YES');
        } else {
            cellCost = hedgeSharesPerCell * cellProb;
        }

        hedgeCellCosts.push({ cellName, cellProb, cellCost });
        totalHedgeCost += cellCost;
    }

    const targetAmount = Math.max(0, amount - totalHedgeCost);
    const targetPool = marketProbabilities.pools[targetCell];

    // Calculate target shares using AMM
    let targetShares;
    if (targetPool && targetPool.YES && targetPool.NO && targetAmount > 0) {
        targetShares = sharesForCost(targetPool.YES, targetPool.NO, targetAmount, 'YES').toFixed(1);
    } else {
        targetShares = targetProb > 0 ? (targetAmount / targetProb).toFixed(1) : '?';
    }

    // Build trade plan HTML
    let stepNum = 1;
    let stepsHtml = '';

    // Hedge bets - each gets hedgeSharesPerCell shares
    for (const { cellName, cellProb, cellCost } of hedgeCellCosts) {
        const answerText = currentMarketConfig.truthTable?.[cellName] || cellName;
        stepsHtml += `
            <div class="trade-step hedge">
                <span class="trade-step-num">${stepNum++}</span>
                <div class="trade-step-details">
                    <div class="trade-step-action">Hedge: Buy YES → ${hedgeSharesPerCell} shares</div>
                    <div class="trade-step-answer">${answerText} (${formatProb(cellProb)})</div>
                </div>
                <span class="trade-step-amount">M$${cellCost.toFixed(2)}</span>
            </div>
        `;
    }

    // Target bet
    const targetText = currentMarketConfig.truthTable?.[targetCell] || targetCell;
    stepsHtml += `
        <div class="trade-step target">
            <span class="trade-step-num">${stepNum}</span>
            <div class="trade-step-details">
                <div class="trade-step-action">Target: Buy YES → ~${targetShares} shares</div>
                <div class="trade-step-answer">${targetText} (${formatProb(targetProb)})</div>
            </div>
            <span class="trade-step-amount">M$${targetAmount.toFixed(2)}</span>
        </div>
    `;

    document.getElementById('trade-plan').innerHTML = stepsHtml;

    // Build payout matrix - shows WIN/LOSE/NEUTRAL for each cell
    const winCell = targetCell;
    const loseCell = currentBetDirection === 'yes' ? config.targetNo : config.targetYes;
    const hedgeSet = new Set(config.hedgeCells);

    // Calculate payouts
    const winPayout = parseFloat(targetShares) - amount;  // shares worth $targetShares, minus cost
    const losePayout = -amount;
    const neutralPayout = 0;  // hedge returns $amount

    function cellPayout(cellName) {
        if (cellName === winCell) return { label: 'WIN', value: winPayout, class: 'payout-win' };
        if (cellName === loseCell) return { label: 'LOSE', value: losePayout, class: 'payout-lose' };
        if (hedgeSet.has(cellName)) return { label: 'NEUTRAL', value: neutralPayout, class: 'payout-neutral' };
        return { label: '?', value: 0, class: '' };
    }

    const payouts = {
        a_yes_b_yes: cellPayout('a_yes_b_yes'),
        a_yes_b_no: cellPayout('a_yes_b_no'),
        a_no_b_yes: cellPayout('a_no_b_yes'),
        a_no_b_no: cellPayout('a_no_b_no')
    };

    const formatPayout = (p) => p.value >= 0 ? `+$${p.value.toFixed(0)}` : `-$${Math.abs(p.value).toFixed(0)}`;

    const payoutMatrixHtml = `
        <div class="payout-matrix">
            <div class="payout-header">Payouts if outcome occurs:</div>
            <div class="payout-grid">
                <div class="payout-corner"></div>
                <div class="payout-col-header">${currentMarketConfig.labelB}</div>
                <div class="payout-col-header">~${currentMarketConfig.labelB}</div>
                <div class="payout-row-header">${currentMarketConfig.labelA}</div>
                <div class="payout-cell ${payouts.a_yes_b_yes.class}">
                    <span class="payout-label">${payouts.a_yes_b_yes.label}</span>
                    <span class="payout-value">${formatPayout(payouts.a_yes_b_yes)}</span>
                </div>
                <div class="payout-cell ${payouts.a_yes_b_no.class}">
                    <span class="payout-label">${payouts.a_yes_b_no.label}</span>
                    <span class="payout-value">${formatPayout(payouts.a_yes_b_no)}</span>
                </div>
                <div class="payout-row-header">~${currentMarketConfig.labelA}</div>
                <div class="payout-cell ${payouts.a_no_b_yes.class}">
                    <span class="payout-label">${payouts.a_no_b_yes.label}</span>
                    <span class="payout-value">${formatPayout(payouts.a_no_b_yes)}</span>
                </div>
                <div class="payout-cell ${payouts.a_no_b_no.class}">
                    <span class="payout-label">${payouts.a_no_b_no.label}</span>
                    <span class="payout-value">${formatPayout(payouts.a_no_b_no)}</span>
                </div>
            </div>
        </div>
    `;

    // Summary
    const effectiveProb = currentBetDirection === 'yes' ? condProb : (1 - condProb);
    document.getElementById('trade-summary').innerHTML = `
        ${payoutMatrixHtml}
        <div class="summary-row">
            <span class="summary-label">Conditional prob:</span>
            <span class="summary-value">${formatProb(effectiveProb)}</span>
        </div>
        <div class="summary-row">
            <span class="summary-label">Hedge (${hedgeSharesPerCell} shares × P(~cond)):</span>
            <span class="summary-value">M$${totalHedgeCost.toFixed(2)}</span>
        </div>
        <div class="summary-row">
            <span class="summary-label">Target shares:</span>
            <span class="summary-value">~${targetShares}</span>
        </div>
        <div class="summary-row total">
            <span class="summary-label">Total cost:</span>
            <span class="summary-value">M$${amount.toFixed(2)}</span>
        </div>
    `;
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

    // Same logic as preview: buy N shares of each hedge cell
    const hedgeSharesPerCell = amount;

    // Calculate per-cell costs
    let totalHedgeCost = 0;
    const hedgeBets = [];
    for (const cellName of config.hedgeCells) {
        const cellProb = marketProbabilities.joint[cellName];
        const cellCost = hedgeSharesPerCell * cellProb;
        hedgeBets.push({ cellName, cellCost: Math.max(1, Math.round(cellCost)) });
        totalHedgeCost += cellCost;
    }

    const targetAmount = Math.max(1, Math.round(amount - totalHedgeCost));

    // Get target based on direction
    const targetCell = currentBetDirection === 'yes' ? config.targetYes : config.targetNo;

    const executeBtn = document.getElementById('panel-execute-bet');
    executeBtn.disabled = true;
    executeBtn.textContent = 'Placing bets...';

    try {
        const results = [];

        // Place hedge bets (each gets hedgeSharesPerCell shares worth)
        for (const { cellName, cellCost } of hedgeBets) {
            const answerId = marketProbabilities.answerIds[cellName];
            if (!answerId) throw new Error(`No answer ID for ${cellName}`);

            const result = await placeBet(apiKey, currentMarket.id, answerId, 'YES', cellCost);
            results.push({ type: 'hedge', cell: cellName, result });
        }

        // Place target bet
        const targetAnswerId = marketProbabilities.answerIds[targetCell];
        if (!targetAnswerId) throw new Error(`No answer ID for target ${targetCell}`);

        const targetResult = await placeBet(apiKey, currentMarket.id, targetAnswerId, 'YES', targetAmount);
        results.push({ type: 'target', cell: targetCell, result: targetResult });

        // Show success
        const totalSpent = results.reduce((sum, r) => sum + (r.result.amount || 0), 0);
        const dirLabel = currentBetDirection === 'yes' ? 'YES' : 'NO';
        showResultDialog('Conditional Bet Placed',
            `Placed ${dirLabel} bet with ${results.length} orders totaling M$${totalSpent.toFixed(2)}`, false);
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
    document.querySelectorAll('.cell.selected').forEach(c => c.classList.remove('selected'));

    selectedCell = cellElement;
    currentMarginalType = marginalType;
    currentCondType = null;  // Clear conditional mode
    cellElement.classList.add('selected');

    // Hide direction row for marginal bets
    document.getElementById('bet-direction-row').style.display = 'none';

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

    // Calculate marginal probability
    const marginalProb = config.cells.reduce((sum, c) => sum + marketProbabilities.joint[c], 0);

    // Build trade plan HTML
    let stepsHtml = '';
    config.cells.forEach((cellName, idx) => {
        const answerText = currentMarketConfig.truthTable?.[cellName] || cellName;
        const cellProb = marketProbabilities.joint[cellName];
        const pool = marketProbabilities.pools[cellName];

        // Use AMM if pool available
        let estShares;
        if (pool && pool.YES && pool.NO) {
            estShares = sharesForCost(pool.YES, pool.NO, perCellAmount, 'YES').toFixed(1);
        } else {
            estShares = cellProb > 0 ? (perCellAmount / cellProb).toFixed(1) : '?';
        }

        stepsHtml += `
            <div class="trade-step target">
                <span class="trade-step-num">${idx + 1}</span>
                <div class="trade-step-details">
                    <div class="trade-step-action">Buy YES → ~${estShares} shares</div>
                    <div class="trade-step-answer">${answerText} (${formatProb(cellProb)})</div>
                </div>
                <span class="trade-step-amount">M$${perCellAmount.toFixed(2)}</span>
            </div>
        `;
    });

    document.getElementById('trade-plan').innerHTML = stepsHtml;

    // Summary
    document.getElementById('trade-summary').innerHTML = `
        <div class="summary-row">
            <span class="summary-label">Marginal prob:</span>
            <span class="summary-value">${formatProb(marginalProb)}</span>
        </div>
        <div class="summary-row">
            <span class="summary-label">Per outcome:</span>
            <span class="summary-value">M$${perCellAmount.toFixed(2)}</span>
        </div>
        <div class="summary-row total">
            <span class="summary-label">Total cost:</span>
            <span class="summary-value">M$${amount.toFixed(2)}</span>
        </div>
    `;
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
