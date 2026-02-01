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

// =============================================================================
// Multi-Choice Auto-Arbitrage Simulation
// =============================================================================
// Manifold's actual algorithm for buying YES in multi-choice markets:
// 1. Buy noShares NO in each of the OTHER (n-1) answers
// 2. Redeem: noShares NO in (n-1) answers → noShares*(n-2) mana + noShares YES in target
// 3. Use remaining amount to buy more YES directly in target
// 4. Binary search for noShares such that final Σp = 1

/**
 * Calculate Σp (sum of all probabilities) from a pools object.
 */
function sumOfProbabilities(pools) {
    let sum = 0;
    for (const pool of Object.values(pools)) {
        sum += probabilityFromPool(pool.YES, pool.NO);
    }
    return sum;
}

/**
 * Deep copy pools object.
 */
function copyPools(pools) {
    const copy = {};
    for (const [id, pool] of Object.entries(pools)) {
        copy[id] = { YES: pool.YES, NO: pool.NO };
    }
    return copy;
}

/**
 * Simulate buying YES in a multi-choice market using Manifold's actual algorithm:
 * Buy NO in OTHER answers, redeem for mana + YES, use remainder to buy direct YES.
 *
 * @param {Object} allPools - Map of answerId -> {YES, NO} pool state
 * @param {string} targetId - The answer to buy YES in
 * @param {number} betAmount - Total amount to spend
 * @param {number} noShares - Number of NO shares to buy in each other answer
 * @returns {Object|null} { newPools, yesShares, netNoCost, directYesCost } or null if invalid
 */
function simulateMultiChoiceYesBuy(allPools, targetId, betAmount, noShares) {
    const answerIds = Object.keys(allPools);
    const n = answerIds.length;
    const otherIds = answerIds.filter(id => id !== targetId);

    // Step 1: Calculate cost to buy noShares NO in each OTHER answer
    let totalNoCost = 0;
    const newPools = copyPools(allPools);

    for (const otherId of otherIds) {
        const pool = newPools[otherId];
        const cost = costForShares(pool.YES, pool.NO, noShares, 'NO');
        if (!isFinite(cost)) return null;
        totalNoCost += cost;

        // Update pool after NO purchase
        const updatedPool = poolAfterTrade(pool.YES, pool.NO, cost, 'NO');
        newPools[otherId] = { YES: updatedPool.y, NO: updatedPool.n };
    }

    // Step 2: Redemption - NO shares in (n-1) other answers become:
    //   - noShares * (n-2) mana
    //   - noShares YES shares in target
    const redeemedMana = noShares * (n - 2);
    const redeemedYesShares = noShares;

    // Net cost for the NO hedge operation
    const netNoCost = totalNoCost - redeemedMana;

    // Step 3: Remaining amount for direct YES purchase
    const directYesBudget = betAmount - netNoCost;
    if (directYesBudget < -0.0001) {
        return null;  // Not enough budget for this noShares level
    }

    // Direct YES purchase in target
    let directYesShares = 0;
    if (directYesBudget > 0.0001) {
        const targetPool = newPools[targetId];
        directYesShares = sharesForCost(targetPool.YES, targetPool.NO, directYesBudget, 'YES');
        const updatedTarget = poolAfterTrade(targetPool.YES, targetPool.NO, directYesBudget, 'YES');
        newPools[targetId] = { YES: updatedTarget.y, NO: updatedTarget.n };
    }

    // Note: Redemption gives us YES shares but doesn't change the pool.
    // The pool states reflect: NO purchases in other answers + direct YES in target.
    // The user receives redeemed + direct shares.
    const totalYesShares = redeemedYesShares + directYesShares;

    return {
        newPools,
        yesShares: totalYesShares,
        netNoCost,
        directYesCost: Math.max(0, directYesBudget),
        redeemedYesShares,
        directYesShares
    };
}

/**
 * Simulate a trade on one answer in a multi-choice market, including auto-arb.
 * This uses Manifold's actual algorithm: buy NO in other answers, redeem, buy direct YES.
 *
 * @param {Object} allPools - Map of answerId -> {YES, NO} pool state
 * @param {string} targetId - The answer being traded
 * @param {number} cost - Amount to spend
 * @param {string} position - 'YES' or 'NO'
 * @returns {Object} { newPools, shares }
 */
function simulateMultiChoiceTrade(allPools, targetId, cost, position) {
    if (position !== 'YES') {
        // NO trades use a different algorithm (buy YES in other answers)
        // For simplicity, fall back to binary formula for now
        const pool = allPools[targetId];
        const shares = sharesForCost(pool.YES, pool.NO, cost, position);
        const newPool = poolAfterTrade(pool.YES, pool.NO, cost, position);
        const newPools = copyPools(allPools);
        newPools[targetId] = { YES: newPool.y, NO: newPool.n };
        return { newPools, shares };
    }

    // Binary search for noShares that makes Σp = 1
    const n = Object.keys(allPools).length;

    // Bounds for noShares
    let lo = 0;
    let hi = cost * 2;  // Generous upper bound

    // Binary search to find noShares where Σp ≈ 1
    let bestResult = null;
    let bestSumP = Infinity;

    for (let iter = 0; iter < 60; iter++) {
        const mid = (lo + hi) / 2;
        const result = simulateMultiChoiceYesBuy(allPools, targetId, cost, mid);

        if (!result) {
            // This noShares is too high (costs more than budget)
            hi = mid;
            continue;
        }

        const sumP = sumOfProbabilities(result.newPools);

        // Track best result (closest to Σp = 1)
        if (Math.abs(sumP - 1) < Math.abs(bestSumP - 1)) {
            bestResult = result;
            bestSumP = sumP;
        }

        if (Math.abs(sumP - 1) < 0.0001) {
            // Close enough
            break;
        }

        if (sumP > 1) {
            // Need more noShares (more NO buying lowers other probs)
            lo = mid;
        } else {
            // Need less noShares
            hi = mid;
        }
    }

    if (!bestResult) {
        // Fallback to binary if auto-arb fails
        const pool = allPools[targetId];
        const shares = sharesForCost(pool.YES, pool.NO, cost, position);
        const newPool = poolAfterTrade(pool.YES, pool.NO, cost, position);
        const newPools = copyPools(allPools);
        newPools[targetId] = { YES: newPool.y, NO: newPool.n };
        return { newPools, shares };
    }

    return { newPools: bestResult.newPools, shares: bestResult.yesShares };
}

/**
 * Calculate cost for shares in a multi-choice market (accounting for auto-arb).
 * @param {Object} allPools - Map of answerId -> {YES, NO}
 * @param {string} targetId - The answer being traded
 * @param {number} targetShares - Desired number of shares
 * @param {string} position - 'YES' or 'NO'
 * @returns {Object} { cost, newPools }
 */
function multiChoiceCostForShares(allPools, targetId, targetShares, position) {
    if (position !== 'YES' || targetShares <= 0) {
        // Fall back to binary for NO trades
        const pool = allPools[targetId];
        const cost = costForShares(pool.YES, pool.NO, targetShares, position);
        return { cost, newPools: allPools };
    }

    // Binary search for the cost that yields targetShares
    let lo = 0;
    let hi = targetShares * 2;  // Upper bound guess

    // Expand hi if needed
    let result = simulateMultiChoiceTrade(allPools, targetId, hi, position);
    while (result.shares < targetShares && hi < 1000000) {
        hi *= 2;
        result = simulateMultiChoiceTrade(allPools, targetId, hi, position);
    }

    // Binary search
    for (let i = 0; i < 50; i++) {
        const mid = (lo + hi) / 2;
        result = simulateMultiChoiceTrade(allPools, targetId, mid, position);
        if (result.shares < targetShares) {
            lo = mid;
        } else {
            hi = mid;
        }
    }

    const cost = (lo + hi) / 2;
    result = simulateMultiChoiceTrade(allPools, targetId, cost, position);
    return { cost, newPools: result.newPools };
}

// State
let currentMarket = null;
let currentMarketConfig = null;
let marketProbabilities = null;
let currentUserId = null;
let currentPositions = null;  // Map of answerId -> {YES: shares, NO: shares}

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
    // Clear existing options except placeholder
    while (marketSelect.options.length > 1) {
        marketSelect.remove(1);
    }

    try {
        // Load built-in markets
        const response = await fetch('markets.json');
        const builtInMarkets = await response.json();

        // Load custom markets from localStorage
        const customMarkets = getCustomMarkets();

        // Add built-in markets
        if (builtInMarkets.length > 0) {
            const builtInGroup = document.createElement('optgroup');
            builtInGroup.label = 'Built-in Markets';
            builtInMarkets.forEach(market => {
                const option = document.createElement('option');
                option.value = market.slug;
                option.textContent = market.name;
                option.dataset.config = JSON.stringify(market);
                builtInGroup.appendChild(option);
            });
            marketSelect.appendChild(builtInGroup);
        }

        // Add custom markets if any
        if (customMarkets.length > 0) {
            const customGroup = document.createElement('optgroup');
            customGroup.label = 'Your Markets';
            customMarkets.forEach(market => {
                const option = document.createElement('option');
                option.value = market.slug;
                option.textContent = market.name;
                option.dataset.config = JSON.stringify(market);
                option.dataset.custom = 'true';
                customGroup.appendChild(option);
            });
            marketSelect.appendChild(customGroup);
        }

        // Add "Configure new..." option
        const configOption = document.createElement('option');
        configOption.value = '__configure__';
        configOption.textContent = '+ Configure new market...';
        marketSelect.appendChild(configOption);

    } catch (error) {
        console.error('Failed to load markets.json:', error);
        showError('Failed to load market list');
    }
}

function getCustomMarkets() {
    try {
        const stored = localStorage.getItem('custom_markets');
        return stored ? JSON.parse(stored) : [];
    } catch (e) {
        console.error('Failed to load custom markets:', e);
        return [];
    }
}

function saveCustomMarket(config) {
    const markets = getCustomMarkets();
    // Replace if exists, otherwise add
    const existingIndex = markets.findIndex(m => m.slug === config.slug);
    if (existingIndex >= 0) {
        markets[existingIndex] = config;
    } else {
        markets.push(config);
    }
    localStorage.setItem('custom_markets', JSON.stringify(markets));
}

// =============================================================================
// Market Configuration Dialog
// =============================================================================

let configFetchedMarket = null;  // Temporarily holds fetched market during config

function openConfigDialog() {
    const dialog = document.getElementById('config-dialog');
    const stepSlug = document.getElementById('config-step-slug');
    const stepMap = document.getElementById('config-step-map');
    const slugInput = document.getElementById('config-slug');
    const saveBtn = document.getElementById('config-save');

    // Reset dialog state
    stepSlug.classList.remove('hidden');
    stepMap.classList.add('hidden');
    slugInput.value = '';
    saveBtn.disabled = true;
    configFetchedMarket = null;
    document.getElementById('config-fetch-error').classList.add('hidden');
    document.getElementById('config-map-error').classList.add('hidden');

    dialog.classList.remove('hidden');
    slugInput.focus();
}

function closeConfigDialog() {
    document.getElementById('config-dialog').classList.add('hidden');
    configFetchedMarket = null;
}

async function fetchMarketForConfig() {
    const slugInput = document.getElementById('config-slug');
    const errorDiv = document.getElementById('config-fetch-error');
    const stepMap = document.getElementById('config-step-map');
    const fetchBtn = document.getElementById('config-fetch-btn');

    const slug = slugInput.value.trim();
    if (!slug) {
        errorDiv.textContent = 'Please enter a market slug';
        errorDiv.classList.remove('hidden');
        return;
    }

    errorDiv.classList.add('hidden');
    fetchBtn.disabled = true;
    fetchBtn.textContent = 'Loading...';

    try {
        const market = await fetchMarket(slug);

        // Validate it's a 4-answer multi-choice market
        if (!market.answers || market.answers.length !== 4) {
            throw new Error(`Expected 4 answers for 2×2 market, got ${market.answers?.length || 0}`);
        }
        if (market.isResolved) {
            throw new Error('This market has resolved. Choose an active market.');
        }

        configFetchedMarket = market;
        showConfigMappingStep(market);

    } catch (error) {
        errorDiv.textContent = error.message;
        errorDiv.classList.remove('hidden');
    } finally {
        fetchBtn.disabled = false;
        fetchBtn.textContent = 'Fetch';
    }
}

function showConfigMappingStep(market) {
    const stepMap = document.getElementById('config-step-map');
    const titleEl = document.getElementById('config-market-title');
    const answerList = document.getElementById('config-answer-list');
    const labelAInput = document.getElementById('config-label-a');
    const labelBInput = document.getElementById('config-label-b');

    // Show market title
    titleEl.textContent = market.question;

    // Clear and populate answer list
    answerList.innerHTML = '';

    const cellOptions = [
        { value: '', label: '-- Select cell --' },
        { value: 'a_yes_b_yes', label: 'A & B' },
        { value: 'a_yes_b_no', label: 'A & ~B' },
        { value: 'a_no_b_yes', label: '~A & B' },
        { value: 'a_no_b_no', label: '~A & ~B' }
    ];

    market.answers.forEach((answer, index) => {
        const row = document.createElement('div');
        row.className = 'config-answer-row';

        const textSpan = document.createElement('span');
        textSpan.className = 'config-answer-text';
        textSpan.textContent = answer.text;
        textSpan.title = answer.text;  // Full text on hover

        const select = document.createElement('select');
        select.dataset.answerIndex = index;
        select.className = 'config-cell-select';

        cellOptions.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            select.appendChild(option);
        });

        select.addEventListener('change', validateConfigMapping);

        row.appendChild(textSpan);
        row.appendChild(select);
        answerList.appendChild(row);
    });

    // Clear labels
    labelAInput.value = '';
    labelBInput.value = '';

    // Show step 2
    stepMap.classList.remove('hidden');
}

function validateConfigMapping() {
    const saveBtn = document.getElementById('config-save');
    const errorDiv = document.getElementById('config-map-error');
    const labelA = document.getElementById('config-label-a').value.trim();
    const labelB = document.getElementById('config-label-b').value.trim();
    const selects = document.querySelectorAll('.config-cell-select');

    // Check all selects have a value
    const selectedCells = [];
    let allSelected = true;
    selects.forEach(select => {
        if (!select.value) {
            allSelected = false;
        } else {
            selectedCells.push(select.value);
        }
    });

    // Check for duplicates
    const uniqueCells = new Set(selectedCells);
    const hasDuplicates = selectedCells.length !== uniqueCells.size;

    // Check labels
    const hasLabels = labelA && labelB;

    // Update error message
    if (hasDuplicates) {
        errorDiv.textContent = 'Each cell can only be assigned once';
        errorDiv.classList.remove('hidden');
        saveBtn.disabled = true;
        return;
    }

    errorDiv.classList.add('hidden');
    saveBtn.disabled = !(allSelected && hasLabels && !hasDuplicates);
}

function saveConfigAndLoad() {
    const labelA = document.getElementById('config-label-a').value.trim();
    const labelB = document.getElementById('config-label-b').value.trim();
    const selects = document.querySelectorAll('.config-cell-select');

    if (!configFetchedMarket) return;

    // Build truthTable mapping
    const truthTable = {};
    selects.forEach((select, index) => {
        const cellType = select.value;
        const answerText = configFetchedMarket.answers[index].text;
        truthTable[cellType] = answerText;
    });

    // Build config object
    const config = {
        slug: configFetchedMarket.slug,
        name: configFetchedMarket.question.substring(0, 60) + (configFetchedMarket.question.length > 60 ? '...' : ''),
        labelA: labelA,
        labelB: labelB,
        truthTable: truthTable
    };

    // Save to localStorage
    saveCustomMarket(config);

    // Close dialog
    closeConfigDialog();

    // Reload market list and select new market
    loadMarketList().then(() => {
        marketSelect.value = config.slug;
        loadMarket(config);
    });
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
        // Clear user and positions
        currentUserId = null;
        currentPositions = null;
        displayPositions();  // Remove position displays from UI
    });

    // Dialog handlers
    document.getElementById('close-bet-dialog').addEventListener('click', closeBetDialog);
    document.getElementById('cancel-bet').addEventListener('click', closeBetDialog);
    document.getElementById('execute-bet').addEventListener('click', executeBet);
    document.getElementById('close-result-dialog').addEventListener('click', closeResultDialog);
    document.getElementById('close-result').addEventListener('click', closeResultDialog);

    // Config dialog handlers
    document.getElementById('close-config-dialog').addEventListener('click', closeConfigDialog);
    document.getElementById('config-cancel').addEventListener('click', closeConfigDialog);
    document.getElementById('config-fetch-btn').addEventListener('click', fetchMarketForConfig);
    document.getElementById('config-save').addEventListener('click', saveConfigAndLoad);
    document.getElementById('config-slug').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') fetchMarketForConfig();
    });
    document.getElementById('config-label-a').addEventListener('input', validateConfigMapping);
    document.getElementById('config-label-b').addEventListener('input', validateConfigMapping);

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

    // Correlation betting panel
    document.getElementById('correlation-toggle').addEventListener('click', () => {
        const content = document.getElementById('correlation-content');
        const toggle = document.getElementById('correlation-toggle');
        content.classList.toggle('collapsed');
        toggle.textContent = content.classList.contains('collapsed') ? '▶' : '▼';
    });

    document.getElementById('correlation-header').addEventListener('click', (e) => {
        // Only toggle if clicking the header itself, not the button
        if (e.target.id !== 'correlation-toggle') {
            document.getElementById('correlation-toggle').click();
        }
    });

    document.querySelectorAll('.corr-direction-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.corr-direction-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            correlationDirection = btn.dataset.direction;
            updateCorrelationBetPanel();
        });
    });

    document.getElementById('corr-calculate').addEventListener('click', updateCorrelationBetPanel);
    document.getElementById('corr-scale').addEventListener('change', updateCorrelationBetPanel);
    document.getElementById('corr-validate-btn').addEventListener('click', validateCorrelationBet);
    document.getElementById('corr-execute-btn').addEventListener('click', executeCorrelationBet);
}

async function onMarketSelect(event) {
    const slug = event.target.value;
    if (!slug) {
        hideAll();
        return;
    }

    // Special case: configure new market
    if (slug === '__configure__') {
        openConfigDialog();
        // Reset dropdown to placeholder
        marketSelect.value = '';
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

        // Fetch positions if authenticated
        currentPositions = null;
        const apiKey = apiKeyInput.value.trim();
        if (apiKey) {
            try {
                // Get user ID if we don't have it
                if (!currentUserId) {
                    const user = await fetchCurrentUser(apiKey);
                    if (user) {
                        currentUserId = user.id;
                    }
                }
                // Fetch positions
                if (currentUserId) {
                    const positions = await fetchPositions(market.id, currentUserId);
                    currentPositions = positions;
                }
            } catch (e) {
                console.warn('Failed to fetch positions:', e);
            }
        }

        // Update UI
        displayMarketInfo(market);
        displayMatrix(marketProbabilities, config);
        displayConditionals(marketProbabilities);
        displayPositions();

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

/**
 * Fetch current user info (requires API key).
 */
async function fetchCurrentUser(apiKey) {
    const response = await fetch(`${API_BASE}/me`, {
        headers: { 'Authorization': `Key ${apiKey}` }
    });
    if (!response.ok) {
        return null;  // Not authenticated or invalid key
    }
    return response.json();
}

/**
 * Fetch positions for a market.
 * @param {string} marketId - The market ID
 * @param {string} userId - The user ID to fetch positions for
 * @returns {Object} Map of answerId -> {YES: shares, NO: shares}
 */
async function fetchPositions(marketId, userId) {
    const response = await fetch(`${API_BASE}/market/${marketId}/positions?userId=${userId}`);
    if (!response.ok) {
        return {};
    }
    const data = await response.json();

    // Convert to map by answerId
    const positions = {};
    for (const pos of data) {
        if (pos.answerId && pos.totalShares) {
            positions[pos.answerId] = {
                YES: pos.totalShares.YES || 0,
                NO: pos.totalShares.NO || 0
            };
        }
    }
    return positions;
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

// =============================================================================
// Correlation Betting
// =============================================================================

let correlationDirection = 'long';
let currentCorrelationAnalysis = null;

/**
 * Compute neutral correlation weights for a 2x2 joint market.
 *
 * Neutrality constraints form a 2×4 matrix C where C·s = 0.
 * The null space is 2D: (1,1,1,1) is trivial cash, the other is the betting direction.
 *
 * We solve by setting s₁=1 (A∧B), s₄=0 (¬A∧¬B), then solve for s₂, s₃.
 * This gives the long-correlation direction (profits when diagonal outcomes happen).
 *
 * @param {Object} probs - Joint probabilities {a_yes_b_yes, a_yes_b_no, a_no_b_yes, a_no_b_no}
 * @returns {Object} {s1, s2, s3, s4} - Unnormalized weights for long correlation
 */
function computeNeutralCorrelationWeights(probs) {
    const p11 = probs.a_yes_b_yes;
    const p12 = probs.a_yes_b_no;
    const p21 = probs.a_no_b_yes;
    const p22 = probs.a_no_b_no;

    // Marginals
    const pA = p11 + p12;
    const pB = p11 + p21;

    // Set s1=1 (A∧B), s4=0 (¬A∧¬B), solve for s2, s3
    // From A-neutrality: (1-pA)·p11·s1 + (1-pA)·p12·s2 - pA·p21·s3 - pA·p22·s4 = 0
    // From B-neutrality: (1-pB)·p11·s1 - pB·p12·s2 + (1-pB)·p21·s3 - pB·p22·s4 = 0

    // With s1=1, s4=0:
    // (1-pA)·p12·s2 - pA·p21·s3 = -(1-pA)·p11
    // -pB·p12·s2 + (1-pB)·p21·s3 = -(1-pB)·p11

    // Matrix form: [a b; c d] [s2; s3] = [e; f]
    const a = (1 - pA) * p12;
    const b = -pA * p21;
    const c = -pB * p12;
    const d = (1 - pB) * p21;
    const e = -(1 - pA) * p11;
    const f = -(1 - pB) * p11;

    // Solve using Cramer's rule
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-10) {
        // Degenerate case (e.g., independent events)
        return { s1: 1, s2: 0, s3: 0, s4: 1 };
    }

    const s2 = (e * d - b * f) / det;
    const s3 = (a * f - e * c) / det;

    return { s1: 1, s2, s3, s4: 0 };
}

/**
 * Transform weights to be long-only (all non-negative) by adding cash position.
 *
 * @param {Object} weights - {s1, s2, s3, s4} possibly with negatives
 * @returns {Object} {s1, s2, s3, s4} all non-negative
 */
function makeLongOnly(weights) {
    const minWeight = Math.min(weights.s1, weights.s2, weights.s3, weights.s4);
    if (minWeight >= 0) return weights;

    // Add -minWeight to all (equivalent to adding cash)
    const offset = -minWeight;
    return {
        s1: weights.s1 + offset,
        s2: weights.s2 + offset,
        s3: weights.s3 + offset,
        s4: weights.s4 + offset
    };
}

/**
 * Scale weights so the maximum equals the target.
 *
 * @param {Object} weights - {s1, s2, s3, s4}
 * @param {number} maxShares - Target for the maximum weight
 * @returns {Object} Scaled weights
 */
function scaleWeights(weights, maxShares) {
    const maxWeight = Math.max(weights.s1, weights.s2, weights.s3, weights.s4);
    if (maxWeight <= 0) return { s1: 0, s2: 0, s3: 0, s4: 0 };

    const scale = maxShares / maxWeight;
    return {
        s1: weights.s1 * scale,
        s2: weights.s2 * scale,
        s3: weights.s3 * scale,
        s4: weights.s4 * scale
    };
}

/**
 * Analyze a correlation bet: compute costs, expected payouts, and neutrality quality.
 *
 * @param {Object} pools - Pool data {a_yes_b_yes: {YES, NO}, ...}
 * @param {Object} probs - Joint probabilities
 * @param {number} scale - Maximum shares to buy
 * @param {string} direction - 'long' or 'short'
 * @returns {Object} Analysis results
 */
function analyzeCorrelationBet(pools, probs, scale, direction) {
    // Get raw neutral weights
    // Default computation tends to be off-diagonal heavy (short correlation)
    let weights = computeNeutralCorrelationWeights(probs);

    // For long correlation, negate weights to flip which diagonal dominates
    // Negation flips the economic exposure; makeLongOnly then shifts to positive
    if (direction === 'long') {
        weights = { s1: -weights.s1, s2: -weights.s2, s3: -weights.s3, s4: -weights.s4 };
    }

    // Make long-only (shift so all positive) and scale
    weights = makeLongOnly(weights);
    weights = scaleWeights(weights, scale);

    // Map to cell names
    const shares = {
        a_yes_b_yes: weights.s1,
        a_yes_b_no: weights.s2,
        a_no_b_yes: weights.s3,
        a_no_b_no: weights.s4
    };

    // Compute costs using AMM (sequential simulation)
    let simPools = copyPools(pools);
    let totalCost = 0;
    const costs = {};
    const preTradeProbs = {};
    const postTradeProbs = {};

    // Compute initial probabilities
    const allCells = ['a_yes_b_yes', 'a_yes_b_no', 'a_no_b_yes', 'a_no_b_no'];
    for (const cellName of allCells) {
        const pool = simPools[cellName];
        if (pool && pool.YES && pool.NO) {
            preTradeProbs[cellName] = probabilityFromPool(pool.YES, pool.NO);
        }
    }

    // Estimate initial costs for sorting (before sequential effects)
    const initialCostEstimates = {};
    for (const cellName of allCells) {
        if (shares[cellName] < 0.001) continue;
        const pool = simPools[cellName];
        if (pool && pool.YES && pool.NO) {
            // Quick cost estimate using simple formula
            initialCostEstimates[cellName] = costForShares(pool.YES, pool.NO, shares[cellName], 'YES');
        }
    }

    // Sort by cost (lowest first) - smaller bets first for min bet flexibility
    const cellOrder = allCells
        .filter(c => shares[c] >= 0.001)
        .sort((a, b) => (initialCostEstimates[a] || 0) - (initialCostEstimates[b] || 0));

    for (const cellName of cellOrder) {
        const shareCount = shares[cellName];
        if (shareCount < 0.001) {
            costs[cellName] = 0;
            continue;
        }

        const pool = simPools[cellName];
        if (!pool || !pool.YES || !pool.NO) {
            costs[cellName] = 0;
            continue;
        }

        // Use multi-choice simulation for accurate auto-arb handling
        const allPoolsById = {};
        for (const [cn, p] of Object.entries(simPools)) {
            if (p && p.YES && p.NO) {
                allPoolsById[cn] = { YES: p.YES, NO: p.NO };
            }
        }

        // Find cost for target shares using binary search
        const targetShares = shareCount;
        const result = multiChoiceCostForShares(allPoolsById, cellName, targetShares, 'YES');

        if (result && isFinite(result.cost)) {
            costs[cellName] = result.cost;
            totalCost += result.cost;
            simPools = result.newPools;
        } else {
            // Fallback to simple cost calculation
            const cost = costForShares(pool.YES, pool.NO, shareCount, 'YES');
            costs[cellName] = cost;
            totalCost += cost;
            const newPool = poolAfterTrade(pool.YES, pool.NO, cost, 'YES');
            simPools[cellName] = { YES: newPool.y, NO: newPool.n };
        }
    }

    // Compute post-trade probabilities for ALL cells (not just traded ones)
    for (const cellName of allCells) {
        const pool = simPools[cellName];
        if (pool && pool.YES && pool.NO) {
            postTradeProbs[cellName] = probabilityFromPool(pool.YES, pool.NO);
        }
    }

    // Compute expected payouts conditional on each outcome for neutrality check
    // E[payout | A] = (p11·s1 + p12·s2) / pA
    // E[payout | ~A] = (p21·s3 + p22·s4) / p~A
    const pA = postTradeProbs.a_yes_b_yes + postTradeProbs.a_yes_b_no;
    const pNotA = postTradeProbs.a_no_b_yes + postTradeProbs.a_no_b_no;
    const pB = postTradeProbs.a_yes_b_yes + postTradeProbs.a_no_b_yes;
    const pNotB = postTradeProbs.a_yes_b_no + postTradeProbs.a_no_b_no;

    const payoutGivenA = pA > 0 ?
        (postTradeProbs.a_yes_b_yes * shares.a_yes_b_yes + postTradeProbs.a_yes_b_no * shares.a_yes_b_no) / pA : 0;
    const payoutGivenNotA = pNotA > 0 ?
        (postTradeProbs.a_no_b_yes * shares.a_no_b_yes + postTradeProbs.a_no_b_no * shares.a_no_b_no) / pNotA : 0;
    const payoutGivenB = pB > 0 ?
        (postTradeProbs.a_yes_b_yes * shares.a_yes_b_yes + postTradeProbs.a_no_b_yes * shares.a_no_b_yes) / pB : 0;
    const payoutGivenNotB = pNotB > 0 ?
        (postTradeProbs.a_yes_b_no * shares.a_yes_b_no + postTradeProbs.a_no_b_no * shares.a_no_b_no) / pNotB : 0;

    // Expected profit at post-trade prices (should be ~0 for fair market)
    const expectedPayout =
        postTradeProbs.a_yes_b_yes * shares.a_yes_b_yes +
        postTradeProbs.a_yes_b_no * shares.a_yes_b_no +
        postTradeProbs.a_no_b_yes * shares.a_no_b_yes +
        postTradeProbs.a_no_b_no * shares.a_no_b_no;
    const expectedProfit = expectedPayout - totalCost;

    // Compute profit scenarios for different beliefs
    // Shift diagonal probability by delta
    const profitScenarios = [];
    for (const delta of [-0.10, -0.05, 0, 0.05, 0.10]) {
        // Shift diagonal (AB and ~A~B) up by delta/2 each, off-diagonal down
        const shiftedProbs = {
            a_yes_b_yes: Math.max(0.01, Math.min(0.99, postTradeProbs.a_yes_b_yes + delta / 2)),
            a_no_b_no: Math.max(0.01, Math.min(0.99, postTradeProbs.a_no_b_no + delta / 2)),
            a_yes_b_no: Math.max(0.01, Math.min(0.99, postTradeProbs.a_yes_b_no - delta / 2)),
            a_no_b_yes: Math.max(0.01, Math.min(0.99, postTradeProbs.a_no_b_yes - delta / 2))
        };

        const payout =
            shiftedProbs.a_yes_b_yes * shares.a_yes_b_yes +
            shiftedProbs.a_yes_b_no * shares.a_yes_b_no +
            shiftedProbs.a_no_b_yes * shares.a_no_b_yes +
            shiftedProbs.a_no_b_no * shares.a_no_b_no;

        profitScenarios.push({
            delta,
            label: delta === 0 ? 'Current' : (delta > 0 ? `+${(delta * 100).toFixed(0)}pp` : `${(delta * 100).toFixed(0)}pp`),
            profit: payout - totalCost,
            roi: totalCost > 0 ? ((payout - totalCost) / totalCost * 100) : 0
        });
    }

    // Neutrality quality: how close are conditional payouts?
    const maxPayoutDiff = Math.max(
        Math.abs(payoutGivenA - payoutGivenNotA),
        Math.abs(payoutGivenB - payoutGivenNotB)
    );
    const avgPayout = (payoutGivenA + payoutGivenNotA + payoutGivenB + payoutGivenNotB) / 4;
    const neutralityQuality = avgPayout > 0 ? 1 - (maxPayoutDiff / avgPayout) : 1;

    // Check for minimum bet violations (M$1 per bet)
    const MIN_BET = 1.0;
    const belowMinBets = [];
    for (const [cellName, cost] of Object.entries(costs)) {
        if (cost > 0.001 && cost < MIN_BET) {
            belowMinBets.push({ cellName, cost });
        }
    }

    // Count how many non-zero bets we have
    const nonZeroBets = Object.values(costs).filter(c => c > 0.001).length;

    return {
        shares,
        costs,
        totalCost,
        expectedProfit,
        preTradeProbs,
        postTradeProbs,
        tradeOrder: cellOrder,  // Sorted by probability, lowest first
        neutrality: {
            payoutGivenA,
            payoutGivenNotA,
            payoutGivenB,
            payoutGivenNotB,
            quality: neutralityQuality
        },
        profitScenarios,
        belowMinBets,
        nonZeroBets,
        canExecute: belowMinBets.length === 0 && nonZeroBets > 0
    };
}

/**
 * Update the correlation betting panel with current analysis.
 */
function updateCorrelationBetPanel() {
    if (!marketProbabilities || !marketProbabilities.pools) {
        document.getElementById('correlation-results').classList.add('hidden');
        return;
    }

    const scale = parseFloat(document.getElementById('corr-scale').value) || 10;
    const pools = {};
    for (const [cellName, pool] of Object.entries(marketProbabilities.pools)) {
        if (pool && pool.YES && pool.NO) {
            pools[cellName] = { YES: pool.YES, NO: pool.NO };
        }
    }

    if (Object.keys(pools).length < 4) {
        document.getElementById('correlation-results').classList.add('hidden');
        return;
    }

    const probs = marketProbabilities.joint;
    const analysis = analyzeCorrelationBet(pools, probs, scale, correlationDirection);

    // Update position display
    document.getElementById('corr-pos-ab').textContent = analysis.shares.a_yes_b_yes.toFixed(1);
    document.getElementById('corr-pos-anb').textContent = analysis.shares.a_yes_b_no.toFixed(1);
    document.getElementById('corr-pos-nab').textContent = analysis.shares.a_no_b_yes.toFixed(1);
    document.getElementById('corr-pos-nanb').textContent = analysis.shares.a_no_b_no.toFixed(1);

    // Cell name to display label mapping
    const cellLabels = {
        a_yes_b_yes: (currentMarketConfig?.labelA || 'A') + ' & ' + (currentMarketConfig?.labelB || 'B'),
        a_yes_b_no: (currentMarketConfig?.labelA || 'A') + ' & ~' + (currentMarketConfig?.labelB || 'B'),
        a_no_b_yes: '~' + (currentMarketConfig?.labelA || 'A') + ' & ' + (currentMarketConfig?.labelB || 'B'),
        a_no_b_no: '~' + (currentMarketConfig?.labelA || 'A') + ' & ~' + (currentMarketConfig?.labelB || 'B')
    };

    // Build trade plan showing each step with probability movement
    const tradeStepsHtml = analysis.tradeOrder.map((cellName, idx) => {
        const shares = analysis.shares[cellName];
        const cost = analysis.costs[cellName];
        const preProb = analysis.preTradeProbs[cellName] || 0;
        const postProb = analysis.postTradeProbs[cellName] || 0;
        const isBelowMin = cost > 0.001 && cost < 1.0;

        return `
            <div class="trade-step${isBelowMin ? ' below-min' : ''}">
                <span class="trade-step-num">${idx + 1}</span>
                <div class="trade-step-details">
                    <div class="trade-step-cell">${cellLabels[cellName]}</div>
                    <div class="trade-step-movement">${formatProb(preProb)} → ${formatProb(postProb)}</div>
                </div>
                <div class="trade-step-right">
                    <span class="trade-step-shares">${shares.toFixed(1)} sh</span>
                    <span class="trade-step-cost${isBelowMin ? ' min-warning' : ''}">M$${cost.toFixed(2)}</span>
                </div>
            </div>
        `;
    }).join('');
    document.getElementById('corr-trade-steps').innerHTML = tradeStepsHtml;

    // Update labels from config
    if (currentMarketConfig) {
        document.getElementById('corr-col-b').textContent = currentMarketConfig.labelB || 'B';
        document.getElementById('corr-col-not-b').textContent = '~' + (currentMarketConfig.labelB || 'B');
        document.getElementById('corr-row-a').textContent = currentMarketConfig.labelA || 'A';
        document.getElementById('corr-row-not-a').textContent = '~' + (currentMarketConfig.labelA || 'A');
    }

    // Highlight cells based on direction: diagonal for long, off-diagonal for short
    const diagCells = document.querySelectorAll('.corr-pos-cell.diagonal');
    const offDiagCells = document.querySelectorAll('.corr-pos-cell.value:not(.diagonal)');

    // Reset all value cells first
    document.querySelectorAll('.corr-pos-cell.value').forEach(cell => {
        cell.style.background = '';
        cell.style.border = '';
    });

    if (correlationDirection === 'long') {
        // Long correlation: bet on diagonal (both happen or neither)
        diagCells.forEach(cell => {
            cell.style.background = 'rgba(74, 222, 128, 0.15)';
            cell.style.border = '2px solid var(--success)';
        });
    } else {
        // Short correlation: bet on off-diagonal (one happens, other doesn't)
        offDiagCells.forEach(cell => {
            cell.style.background = 'rgba(239, 68, 68, 0.15)';
            cell.style.border = '2px solid var(--error)';
        });
    }

    // Update summary
    document.getElementById('corr-total-cost').textContent = 'M$' + analysis.totalCost.toFixed(2);
    const profitEl = document.getElementById('corr-expected-profit');
    profitEl.textContent = 'M$' + analysis.expectedProfit.toFixed(2);
    profitEl.style.color = analysis.expectedProfit >= 0 ? 'var(--success)' : 'var(--error)';

    // Update neutrality check
    document.getElementById('corr-payout-a').textContent = 'M$' + analysis.neutrality.payoutGivenA.toFixed(2);
    document.getElementById('corr-payout-not-a').textContent = 'M$' + analysis.neutrality.payoutGivenNotA.toFixed(2);
    document.getElementById('corr-payout-b').textContent = 'M$' + analysis.neutrality.payoutGivenB.toFixed(2);
    document.getElementById('corr-payout-not-b').textContent = 'M$' + analysis.neutrality.payoutGivenNotB.toFixed(2);

    const neutralityStatusEl = document.getElementById('corr-neutrality-status');
    if (analysis.neutrality.quality > 0.95) {
        neutralityStatusEl.textContent = 'Excellent neutrality';
        neutralityStatusEl.className = 'neutrality-status good';
    } else if (analysis.neutrality.quality > 0.85) {
        neutralityStatusEl.textContent = 'Good neutrality (some degradation at scale)';
        neutralityStatusEl.className = 'neutrality-status good';
    } else {
        neutralityStatusEl.textContent = 'Neutrality degraded - consider smaller scale';
        neutralityStatusEl.className = 'neutrality-status degraded';
    }

    // Update profit scenarios
    const scenariosEl = document.getElementById('corr-profit-scenarios');
    scenariosEl.innerHTML = analysis.profitScenarios.map(s => {
        const valueClass = s.profit > 0.01 ? 'positive' : (s.profit < -0.01 ? 'negative' : 'neutral');
        const roiStr = s.roi !== 0 ? ` (${s.roi > 0 ? '+' : ''}${s.roi.toFixed(1)}%)` : '';
        return `
            <div class="profit-scenario">
                <span class="scenario-label">${s.label} diagonal:</span>
                <span class="scenario-value ${valueClass}">M$${s.profit.toFixed(2)}${roiStr}</span>
            </div>
        `;
    }).join('');

    // Update minimum bet warning
    const minBetWarning = document.getElementById('corr-min-bet-warning');
    if (analysis.belowMinBets.length > 0) {
        minBetWarning.classList.remove('hidden');
    } else {
        minBetWarning.classList.add('hidden');
    }

    // Update button states
    const validateBtn = document.getElementById('corr-validate-btn');
    const executeBtn = document.getElementById('corr-execute-btn');
    const statusEl = document.getElementById('corr-execute-status');

    const hasApiKey = !!apiKeyInput.value.trim();
    validateBtn.disabled = !analysis.canExecute || !hasApiKey;
    executeBtn.disabled = !analysis.canExecute || !hasApiKey;
    statusEl.textContent = '';
    statusEl.className = 'execute-status';

    if (!hasApiKey) {
        statusEl.textContent = 'API key required';
    } else if (!analysis.canExecute && analysis.belowMinBets.length > 0) {
        statusEl.textContent = `${analysis.belowMinBets.length} bet(s) below M$1 minimum`;
    }

    // Store current analysis for execute/validate
    currentCorrelationAnalysis = analysis;

    document.getElementById('correlation-results').classList.remove('hidden');
}

/**
 * Validate correlation bet with API dry-run.
 */
async function validateCorrelationBet() {
    if (!currentCorrelationAnalysis || !currentCorrelationAnalysis.canExecute) return;

    const statusEl = document.getElementById('corr-execute-status');
    statusEl.textContent = 'Validating...';
    statusEl.className = 'execute-status pending';

    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
        statusEl.textContent = 'API key required';
        statusEl.className = 'execute-status error';
        return;
    }

    try {
        const analysis = currentCorrelationAnalysis;
        // Use the computed trade order (sorted by cost)
        const cellOrder = analysis.tradeOrder || [];
        let allValid = true;
        const results = [];

        for (const cellName of cellOrder) {
            const cost = analysis.costs[cellName];
            // Skip cells with no cost or below minimum
            if (!cost || cost < 1.0) continue;

            const answerId = marketProbabilities.answerIds[cellName];
            if (!answerId) continue;

            try {
                const result = await placeBetDryRun(currentMarket.id, answerId, 'YES', cost);
                // API returns bet details on success (shares, probBefore, probAfter, etc.)
                console.log(`Validated ${cellName}: M$${cost.toFixed(2)} → ${result.shares?.toFixed(2)} shares`);
                results.push({ cellName, cost, result, valid: true });
            } catch (err) {
                console.error(`Validation failed for ${cellName}:`, err.message);
                results.push({ cellName, cost, error: err.message, valid: false });
                allValid = false;
            }
        }

        if (allValid) {
            statusEl.textContent = `Validated ${results.length} bets`;
            statusEl.className = 'execute-status success';
        } else {
            const failedCount = results.filter(r => !r.valid).length;
            statusEl.textContent = `${failedCount}/${results.length} bet(s) failed - see console`;
            statusEl.className = 'execute-status error';
        }
    } catch (error) {
        statusEl.textContent = 'Validation failed: ' + error.message;
        statusEl.className = 'execute-status error';
    }
}

/**
 * Execute the correlation bet.
 */
async function executeCorrelationBet() {
    if (!currentCorrelationAnalysis || !currentCorrelationAnalysis.canExecute) return;

    const statusEl = document.getElementById('corr-execute-status');
    const executeBtn = document.getElementById('corr-execute-btn');
    const validateBtn = document.getElementById('corr-validate-btn');

    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
        statusEl.textContent = 'API key required';
        statusEl.className = 'execute-status error';
        return;
    }

    // Confirm before executing
    const totalCost = currentCorrelationAnalysis.totalCost;
    if (!confirm(`Place correlation bet for M$${totalCost.toFixed(2)}?`)) {
        return;
    }

    executeBtn.disabled = true;
    validateBtn.disabled = true;
    statusEl.textContent = 'Executing...';
    statusEl.className = 'execute-status pending';

    try {
        const analysis = currentCorrelationAnalysis;
        const cellOrder = analysis.tradeOrder || [];
        const results = [];

        for (const cellName of cellOrder) {
            const cost = analysis.costs[cellName];
            if (!cost || cost < 1.0) continue;

            const answerId = marketProbabilities.answerIds[cellName];
            if (!answerId) continue;

            statusEl.textContent = `Betting on ${cellName}...`;

            // placeBet throws on error, returns bet data on success
            const result = await placeBet(apiKey, currentMarket.id, answerId, 'YES', cost);
            console.log(`Placed bet on ${cellName}: M$${cost.toFixed(2)} → ${result.shares?.toFixed(2)} shares`);
            results.push({ cellName, cost, result });
        }

        statusEl.textContent = `Placed ${results.length} bets successfully!`;
        statusEl.className = 'execute-status success';

        // Refresh market data
        if (currentMarketConfig) {
            await loadMarket(currentMarketConfig);
        }
    } catch (error) {
        statusEl.textContent = 'Execution failed: ' + error.message;
        statusEl.className = 'execute-status error';
    } finally {
        executeBtn.disabled = false;
        validateBtn.disabled = false;
    }
}

/**
 * Display current user's positions in the matrix cells.
 */
function displayPositions() {
    const cellIds = {
        'a_yes_b_yes': 'cell-a-b',
        'a_yes_b_no': 'cell-a-not-b',
        'a_no_b_yes': 'cell-not-a-b',
        'a_no_b_no': 'cell-not-a-not-b'
    };

    for (const [cellType, cellId] of Object.entries(cellIds)) {
        const cell = document.getElementById(cellId);
        if (!cell) continue;

        // Remove existing position display
        const existingPos = cell.querySelector('.position-display');
        if (existingPos) existingPos.remove();

        // Get position for this cell
        if (!currentPositions || !marketProbabilities) continue;

        const answerId = marketProbabilities.answerIds[cellType];
        if (!answerId) continue;

        const pos = currentPositions[answerId];
        if (!pos) continue;

        const yesShares = pos.YES || 0;
        const noShares = pos.NO || 0;

        // Only show if user has shares
        if (Math.abs(yesShares) < 0.01 && Math.abs(noShares) < 0.01) continue;

        // Create position display element
        const posEl = document.createElement('div');
        posEl.className = 'position-display';

        if (yesShares > 0.01) {
            posEl.innerHTML = `<span class="pos-yes">+${yesShares.toFixed(0)} YES</span>`;
        } else if (noShares > 0.01) {
            posEl.innerHTML = `<span class="pos-no">+${noShares.toFixed(0)} NO</span>`;
        }

        cell.appendChild(posEl);
    }
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

    // VALIDATION: Each leg tested against ORIGINAL market state (not sequential).
    // This validates our multi-choice AMM math including auto-arb bonus.
    // Trade plan uses sequential simulation which will show different costs.

    // Get all pools for auto-arb calculation
    const allPools = {};
    for (const [cellName, pool] of Object.entries(marketProbabilities.pools)) {
        if (pool && pool.YES && pool.NO) {
            allPools[cellName] = { YES: pool.YES, NO: pool.NO };
        }
    }

    // DEBUG: Log pool state
    console.log('=== VALIDATION DEBUG ===');
    console.log('All pools:', JSON.stringify(allPools, null, 2));
    let sumP = 0;
    for (const [id, pool] of Object.entries(allPools)) {
        const p = probabilityFromPool(pool.YES, pool.NO);
        console.log(`  ${id}: YES=${pool.YES.toFixed(2)}, NO=${pool.NO.toFixed(2)}, prob=${(p*100).toFixed(2)}%`);
        sumP += p;
    }
    console.log(`  Σp = ${sumP.toFixed(4)}`);

    let rows = [];
    let totalError = 0;
    let totalShares = 0;

    // Validate each hedge cell (each against original baseline)
    for (const cellName of config.hedgeCells) {
        const answerId = marketProbabilities.answerIds[cellName];
        const pool = allPools[cellName];

        // DEBUG: Show binary vs multi-choice calculation
        const binaryCost = costForShares(pool.YES, pool.NO, hedgeSharesPerCell, 'YES');
        const binaryShares = sharesForCost(pool.YES, pool.NO, binaryCost, 'YES');
        console.log(`\nHedge ${cellName}:`);
        console.log(`  Binary: cost=${binaryCost.toFixed(4)} for ${hedgeSharesPerCell} shares`);
        console.log(`  Binary verify: ${binaryShares.toFixed(4)} shares for that cost`);

        // Our estimate: cost to buy hedgeSharesPerCell shares WITH AUTO-ARB
        const localResult = multiChoiceCostForShares(allPools, cellName, hedgeSharesPerCell, 'YES');
        const localCost = localResult.cost;
        console.log(`  Multi-choice: cost=${localCost.toFixed(4)}`);

        // API dry-run: shares for that cost (includes auto-arb on their end)
        const apiResult = await placeBetDryRun(currentMarket.id, answerId, 'YES', localCost);
        const apiShares = apiResult.shares || 0;
        console.log(`  API: ${apiShares.toFixed(4)} shares for M$${localCost.toFixed(4)}`);

        const error = Math.abs(hedgeSharesPerCell - apiShares);
        totalError += error;
        totalShares += hedgeSharesPerCell;

        rows.push(`
            <div class="validation-row">
                <span class="label">Hedge ${cellName.replace('a_', '').replace('b_', '')}:</span>
                <span class="value">${hedgeSharesPerCell.toFixed(1)} vs ${apiShares.toFixed(1)} shares (M$${localCost.toFixed(2)})</span>
            </div>
        `);
    }

    // Validate target (against original baseline)
    const targetCell = currentBetDirection === 'yes' ? config.targetYes : config.targetNo;
    const targetAnswerId = marketProbabilities.answerIds[targetCell];
    const targetPool = allPools[targetCell];

    // Calculate target amount using costs from original state
    let totalHedgeCost = 0;
    for (const cellName of config.hedgeCells) {
        const result = multiChoiceCostForShares(allPools, cellName, hedgeSharesPerCell, 'YES');
        totalHedgeCost += result.cost;
    }
    const targetAmount = Math.max(0, amount - totalHedgeCost);

    // DEBUG: Show binary vs multi-choice calculation for target
    console.log(`\nTarget ${targetCell}:`);
    console.log(`  Target amount: M$${targetAmount.toFixed(4)}`);
    const binaryTargetShares = sharesForCost(targetPool.YES, targetPool.NO, targetAmount, 'YES');
    console.log(`  Binary: ${binaryTargetShares.toFixed(4)} shares for M$${targetAmount.toFixed(4)}`);

    // Our estimate: shares for target amount WITH AUTO-ARB
    let localTargetShares = 0;
    if (allPools[targetCell] && targetAmount > 0) {
        const result = simulateMultiChoiceTrade(allPools, targetCell, targetAmount, 'YES');
        localTargetShares = result.shares;
    }
    console.log(`  Multi-choice: ${localTargetShares.toFixed(4)} shares`);

    const apiTargetResult = await placeBetDryRun(currentMarket.id, targetAnswerId, 'YES', targetAmount);
    const apiTargetShares = apiTargetResult.shares || 0;
    console.log(`  API: ${apiTargetShares.toFixed(4)} shares for M$${targetAmount.toFixed(4)}`);

    const targetError = Math.abs(localTargetShares - apiTargetShares);
    totalError += targetError;
    totalShares += localTargetShares;

    rows.push(`
        <div class="validation-row">
            <span class="label">Target:</span>
            <span class="value">${localTargetShares.toFixed(1)} vs ${apiTargetShares.toFixed(1)} shares (M$${targetAmount.toFixed(2)})</span>
        </div>
    `);

    const errorPct = totalShares > 0 ? (totalError / totalShares * 100) : 0;
    const isMatch = errorPct < 5;  // Within 5% for multi-leg with auto-arb approximation

    statusEl.textContent = isMatch ? '✓ validated' : '✗ mismatch';
    statusEl.className = `validation-status ${isMatch ? 'valid' : 'invalid'}`;

    detailsEl.innerHTML = rows.join('') + `
        <div class="validation-row">
            <span class="label">Total error:</span>
            <span class="value ${isMatch ? 'match' : 'mismatch'}">${errorPct.toFixed(2)}%</span>
        </div>
        <div class="validation-row" style="margin-top: 0.5rem; font-size: 0.75rem; color: var(--text-secondary);">
            <span>Note: Each leg validated vs original state. Trade plan simulates sequential execution.</span>
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

    // SEQUENTIAL SIMULATION with AUTO-ARB:
    // Each trade moves the market (affecting later trades) AND triggers auto-arb
    // which rebalances all answers to maintain Σp = 1.
    // Auto-arb gives bonus shares, making trades cheaper than binary AMM predicts.

    // Clone ALL pools for simulation (auto-arb affects all answers)
    let simPools = {};
    for (const [cellName, pool] of Object.entries(marketProbabilities.pools)) {
        if (pool && pool.YES && pool.NO) {
            simPools[cellName] = { YES: pool.YES, NO: pool.NO };
        }
    }

    // Calculate hedge costs sequentially with auto-arb
    let totalHedgeCost = 0;
    const hedgeCellCosts = [];
    for (const cellName of config.hedgeCells) {
        const cellProb = marketProbabilities.joint[cellName];

        let cellCost, effectiveShares;
        if (simPools[cellName]) {
            // Use multi-choice cost calculation (accounts for auto-arb bonus)
            const result = multiChoiceCostForShares(simPools, cellName, hedgeSharesPerCell, 'YES');
            cellCost = result.cost;
            simPools = result.newPools;  // Update all pools after auto-arb
            effectiveShares = hedgeSharesPerCell;
        } else {
            cellCost = hedgeSharesPerCell * cellProb;
            effectiveShares = hedgeSharesPerCell;
        }

        hedgeCellCosts.push({ cellName, cellProb, cellCost, effectiveShares });
        totalHedgeCost += cellCost;
    }

    const targetAmount = Math.max(0, amount - totalHedgeCost);

    // Calculate target shares using simulated pool state (with auto-arb)
    let targetShares;
    if (simPools[targetCell] && targetAmount > 0) {
        const result = simulateMultiChoiceTrade(simPools, targetCell, targetAmount, 'YES');
        targetShares = result.shares.toFixed(1);
    } else {
        targetShares = targetProb > 0 ? (targetAmount / targetProb).toFixed(1) : '?';
    }

    // Build trade plan HTML
    let stepNum = 1;
    let stepsHtml = '';
    let hasMinBetWarning = false;

    // Hedge bets - each gets hedgeSharesPerCell shares
    for (const { cellName, cellProb, cellCost } of hedgeCellCosts) {
        const answerText = currentMarketConfig.truthTable?.[cellName] || cellName;
        const isBelowMin = cellCost < 1;
        if (isBelowMin) hasMinBetWarning = true;

        stepsHtml += `
            <div class="trade-step hedge${isBelowMin ? ' below-min' : ''}">
                <span class="trade-step-num">${stepNum++}</span>
                <div class="trade-step-details">
                    <div class="trade-step-action">Hedge: Buy YES → ${hedgeSharesPerCell} shares</div>
                    <div class="trade-step-answer">${answerText} (${formatProb(cellProb)})</div>
                </div>
                <span class="trade-step-amount${isBelowMin ? ' min-warning' : ''}">M$${cellCost.toFixed(2)}${isBelowMin ? ' → M$1' : ''}</span>
            </div>
        `;
    }

    // Target bet
    const targetText = currentMarketConfig.truthTable?.[targetCell] || targetCell;
    const targetBelowMin = targetAmount < 1;
    if (targetBelowMin) hasMinBetWarning = true;

    stepsHtml += `
        <div class="trade-step target${targetBelowMin ? ' below-min' : ''}">
            <span class="trade-step-num">${stepNum}</span>
            <div class="trade-step-details">
                <div class="trade-step-action">Target: Buy YES → ~${targetShares} shares</div>
                <div class="trade-step-answer">${targetText} (${formatProb(targetProb)})</div>
            </div>
            <span class="trade-step-amount${targetBelowMin ? ' min-warning' : ''}">M$${targetAmount.toFixed(2)}${targetBelowMin ? ' → M$1' : ''}</span>
        </div>
    `;

    // Add minimum bet warning if any leg is below M$1
    if (hasMinBetWarning) {
        // Calculate actual cost after rounding up
        const actualHedgeCost = hedgeCellCosts.reduce((sum, h) => sum + Math.max(1, h.cellCost), 0);
        const actualTargetCost = Math.max(1, targetAmount);
        const actualTotal = actualHedgeCost + actualTargetCost;

        stepsHtml += `
            <div class="min-bet-warning">
                ⚠️ Some legs below M$1 minimum will be rounded up.<br>
                Actual cost: M$${actualTotal} (requested: M$${amount})
            </div>
        `;
    }

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

    // Clone all pools for sequential simulation with auto-arb
    let simPools = {};
    for (const [cellName, pool] of Object.entries(marketProbabilities.pools)) {
        if (pool && pool.YES && pool.NO) {
            simPools[cellName] = { YES: pool.YES, NO: pool.NO };
        }
    }

    // Calculate per-cell costs using sequential simulation with auto-arb
    let totalHedgeCost = 0;
    const hedgeBets = [];
    console.log('Building hedgeBets from config.hedgeCells:', config.hedgeCells);
    for (const cellName of config.hedgeCells) {
        console.log(`  Processing hedge cell: ${cellName}`);
        const result = multiChoiceCostForShares(simPools, cellName, hedgeSharesPerCell, 'YES');
        const cellCost = Math.max(1, result.cost);
        console.log(`    -> cost: ${cellCost}`);
        hedgeBets.push({ cellName, cellCost });
        simPools = result.newPools;  // Update state for next calculation
        totalHedgeCost += result.cost;
    }

    const targetAmount = Math.max(1, amount - totalHedgeCost);

    // Get target based on direction
    const targetCell = currentBetDirection === 'yes' ? config.targetYes : config.targetNo;

    const executeBtn = document.getElementById('panel-execute-bet');
    executeBtn.disabled = true;
    executeBtn.textContent = 'Placing bets...';

    // Debug: Log what we're about to execute
    console.log('=== EXECUTION DEBUG ===');
    console.log('currentCondType:', currentCondType);
    console.log('config.hedgeCells:', config.hedgeCells);
    console.log('hedgeBets:', JSON.stringify(hedgeBets, null, 2));
    console.log('answerIds mapping:', JSON.stringify(marketProbabilities.answerIds, null, 2));

    try {
        const results = [];

        // Place hedge bets (each gets hedgeSharesPerCell shares worth)
        for (const { cellName, cellCost } of hedgeBets) {
            const answerId = marketProbabilities.answerIds[cellName];
            console.log(`Placing hedge bet: cellName=${cellName}, answerId=${answerId}, cost=${cellCost}`);
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
    const perCellAmount = Math.max(1, amount / config.cells.length);

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
            const cellAmount = Math.max(1, hedgeAmount / hedgeCells.length);

            const result = await placeBet(apiKey, currentMarket.id, answer.id, 'YES', cellAmount);
            results.push({ cell: cellName, type: 'hedge', result });
        }

        // Place target bet
        const targetAnswer = findAnswerForCell(targetCell);
        if (!targetAnswer) {
            throw new Error(`Could not find answer for ${targetCell}`);
        }

        const targetResult = await placeBet(apiKey, currentMarket.id, targetAnswer.id, 'YES', Math.max(1, targetAmount));
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
