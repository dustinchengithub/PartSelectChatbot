import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer';
import { EventEmitter } from 'events';

const BASE_URL = 'https://www.partselect.com';

// Event emitter for browser status updates
export const browserEvents = new EventEmitter();

// Singleton browser instance with idle timeout
let browserInstance = null;
let idleTimeout = null;
const IDLE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes of inactivity

function resetIdleTimeout() {
  if (idleTimeout) {
    clearTimeout(idleTimeout);
  }
  idleTimeout = setTimeout(async () => {
    if (browserInstance) {
      console.log("[BROWSER] Closing browser due to inactivity...");
      await closeBrowser('inactivity');
    }
  }, IDLE_TIMEOUT_MS);
}

async function getBrowser() {
  if (!browserInstance) {
    console.log("[BROWSER] Launching new browser instance...");
    browserInstance = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    // Handle browser disconnection
    browserInstance.on('disconnected', () => {
      console.log("[BROWSER] Browser disconnected");
      browserInstance = null;
      if (idleTimeout) {
        clearTimeout(idleTimeout);
        idleTimeout = null;
      }
    });
  }

  // Reset idle timeout on each use
  resetIdleTimeout();

  return browserInstance;
}

// Close the browser (call when done with all operations)
export async function closeBrowser(reason = 'manual') {
  if (idleTimeout) {
    clearTimeout(idleTimeout);
    idleTimeout = null;
  }
  if (browserInstance) {
    console.log("[BROWSER] Closing browser instance...");
    await browserInstance.close();
    browserInstance = null;

    // Emit event when browser closes due to inactivity
    if (reason === 'inactivity') {
      browserEvents.emit('closed', { reason: 'inactivity' });
    }
  }
}

// Process exit handlers for cleanup
process.on('exit', () => {
  if (browserInstance) {
    browserInstance.close();
    browserInstance = null;
  }
});

process.on('SIGINT', async () => {
  await closeBrowser();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await closeBrowser();
  process.exit(0);
});

// Rate limiter: 60 requests per minute
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60 * 1000; // 1 minute in milliseconds
const requestTimestamps = [];

async function waitForRateLimit() {
  const now = Date.now();

  // Remove timestamps older than the rate window
  while (requestTimestamps.length > 0 && requestTimestamps[0] < now - RATE_WINDOW_MS) {
    requestTimestamps.shift();
  }

  // If we've hit the limit, wait until the oldest request expires
  if (requestTimestamps.length >= RATE_LIMIT) {
    const oldestTimestamp = requestTimestamps[0];
    const waitTime = oldestTimestamp + RATE_WINDOW_MS - now;
    if (waitTime > 0) {
      console.log(`[RATE LIMIT] Waiting ${Math.ceil(waitTime / 1000)}s before next request...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    // Remove the expired timestamp after waiting
    requestTimestamps.shift();
  }

  // Record this request
  requestTimestamps.push(Date.now());
}

// Use Puppeteer to fetch pages that have bot detection
async function fetchPageWithPuppeteer(url) {
  await waitForRateLimit();
  console.log("Fetching with Puppeteer:", url);

  const browser = await getBrowser();
  // Use incognito context for fresh session each time
  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    const html = await page.content();
    return html;
  } finally {
    await context.close();
  }
}

// Use PartSelect's internal search endpoint (redirects to part page)
async function findPartSelectUrlViaSearch(partNumber) {
  console.log("[PS-SEARCH] Searching PartSelect for:", partNumber);

  const searchUrl = `${BASE_URL}/api/search/?searchterm=${encodeURIComponent(partNumber)}`;

  await waitForRateLimit();
  console.log("[PS-SEARCH] Navigating to:", searchUrl);

  const browser = await getBrowser();
  // Use incognito context for fresh session
  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Navigate and follow redirects
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    const finalUrl = page.url();
    console.log("[PS-SEARCH] Final URL after redirect:", finalUrl);

    // Check if we landed on a part page (.htm with part number)
    if (finalUrl.includes('.htm') && finalUrl.toUpperCase().includes(partNumber.toUpperCase())) {
      console.log("[PS-SEARCH] SUCCESS - Redirected to part page");
      return { url: finalUrl, method: 'ps-search' };
    }

    // Check page content for errors or if we're on a valid part page
    const html = await page.content();
    const $ = cheerio.load(html);
    const pageTitle = $('title').text().trim().toLowerCase();
    const h1Text = $('h1').first().text().trim();

    console.log("[PS-SEARCH] Page title:", pageTitle);

    // If title indicates error, return null
    if (pageTitle.includes('error') || pageTitle.includes('not found') || pageTitle.includes('page not found')) {
      console.log("[PS-SEARCH] Search returned error page");
      return null;
    }

    // Check if h1 contains part number (we might be on the right page)
    if (h1Text.toUpperCase().includes(partNumber.toUpperCase())) {
      console.log("[PS-SEARCH] SUCCESS - Found part info on page");
      return { url: finalUrl, method: 'ps-search' };
    }

    // Look for part link on results page
    let partUrl = null;
    $('a[href*=".htm"]').each((i, el) => {
      const href = $(el).attr('href');
      if (href && href.toUpperCase().includes(partNumber.toUpperCase()) && !partUrl) {
        partUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      }
    });

    if (partUrl) {
      console.log("[PS-SEARCH] SUCCESS - Found part link:", partUrl);
      return { url: partUrl, method: 'ps-search' };
    }

    console.log("[PS-SEARCH] Could not find part on page");
    return null;

  } catch (error) {
    console.log("[PS-SEARCH] Error:", error.message);
    return null;
  } finally {
    await context.close();
  }
}

// Use DuckDuckGo to find the correct PartSelect URL for a part number (fallback)
async function findPartSelectUrlViaDDG(partNumber) {
  console.log("[DDG] Searching DuckDuckGo for:", partNumber);

  const searchQuery = `site:partselect.com ${partNumber}`;
  const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;

  console.log("[DDG] Trying DuckDuckGo URL:", ddgUrl);

  try {
    await waitForRateLimit();
    const response = await fetch(ddgUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      console.log("[DDG] DuckDuckGo request failed:", response.status);
      return null;
    }

    console.log("[DDG] DuckDuckGo response received");

    const html = await response.text();

    // Debug
    console.log("[DDG] Contains 'partselect':", html.toLowerCase().includes('partselect'));
    console.log("[DDG] Contains part number:", html.includes(partNumber));

    // DuckDuckGo HTML version uses uddg= parameter with URL-encoded links
    // Look for encoded PartSelect URLs
    const encodedRegex = new RegExp(`uddg=([^&"']+${partNumber}[^&"']*)`, 'i');
    const encodedMatch = html.match(encodedRegex);

    if (encodedMatch) {
      const decodedUrl = decodeURIComponent(encodedMatch[1]);
      console.log("[DDG] Found encoded URL, decoded:", decodedUrl);
      if (decodedUrl.includes('partselect.com')) {
        console.log("[DDG] SUCCESS - Found part URL via encoded match");
        return { url: decodedUrl, method: 'ddg' };
      }
    }

    // Also try direct URL match
    console.log("[DDG] Encoded URL match not found, trying direct regex match");
    const regex = new RegExp(`https?://www\\.partselect\\.com/${partNumber}[^"'\\s&<>]*\\.htm`, 'i');
    const match = html.match(regex);

    console.log("[DDG] Direct regex match:", match ? match[0] : "NO MATCH");

    if (match) {
      console.log("[DDG] SUCCESS - Found part URL via direct regex");
      return { url: match[0], method: 'ddg' };
    }

    // Fallback: find any partselect.com URL
    const fallbackRegex = /https?:\/\/www\.partselect\.com\/[^"'\s<>]+\.htm/gi;
    const fallbackMatches = html.match(fallbackRegex);
    console.log("[DDG] Fallback PartSelect URLs:", fallbackMatches?.slice(0, 3));

    if (fallbackMatches && fallbackMatches.length > 0) {
      console.log("[DDG] SUCCESS - Found part URL via fallback regex");
      return { url: fallbackMatches[0], method: 'ddg' };
    }

    console.log("[DDG] No part URL found via DuckDuckGo");
    return null;
  } catch (error) {
    console.log("[DDG] Error during DuckDuckGo search:", error.message);
    return null;
  }
}

// Search for a part by part number
export async function searchPart(partNumber) {
  console.log("=".repeat(50));
  console.log(`[SEARCH] Starting search for part: ${partNumber}`);
  console.log("=".repeat(50));

  try {
    // Method 1: Try PartSelect's internal search endpoint (fastest, most reliable)
    let result = await findPartSelectUrlViaSearch(partNumber);

    // Method 2: Fall back to DuckDuckGo if PartSelect search failed
    if (!result) {
      console.log("[SEARCH] PartSelect search failed, trying DuckDuckGo fallback...");
      result = await findPartSelectUrlViaDDG(partNumber);
    }

    if (result) {
      console.log(`[SEARCH] SUCCESS - Found part URL via ${result.method.toUpperCase()}`);
      console.log(`[SEARCH] URL: ${result.url}`);
      console.log("[SEARCH] Fetching part page with Puppeteer...");

      const html = await fetchPageWithPuppeteer(result.url);
      console.log("[SEARCH] Successfully fetched part page, extracting details...");

      const $ = cheerio.load(html);
      const partDetails = extractPartDetails($, partNumber);
      partDetails.sourceMethod = result.method;
      partDetails.url = result.url;

      console.log("[SEARCH] Part details extracted successfully");
      return partDetails;
    }

    console.log("[SEARCH] FAILED - No URL found via any method");
    return { error: `No results found for part number: ${partNumber}` };
  } catch (error) {
    console.log("[SEARCH] ERROR:", error.message);
    return { error: `Failed to search for part: ${error.message}` };
  }
}

function extractPartDetails($, partNumber) {
  const title = $('h1.title-main').text().trim() || $('h1').first().text().trim();
  const price = $('.price').first().text().trim();
  const description = $('.pd__description').text().trim() ||
    $('meta[name="description"]').attr('content') || '';
  const inStock = $('.pd__availability').text().toLowerCase().includes('in stock') ||
    $('.js-partAvailability').text().toLowerCase().includes('in stock');

  // Get main product image
  let imageUrl = $('.pd__main-image img').attr('src') ||
    $('.js-mainImage').attr('src') ||
    $('meta[property="og:image"]').attr('content') ||
    '';
  if (imageUrl && !imageUrl.startsWith('http')) {
    imageUrl = `https://www.partselect.com${imageUrl}`;
  }

  // Get installation/repair info
  const installationSteps = [];
  $('.repair-story__step, .pd__repair-step').each((i, el) => {
    const step = $(el).text().trim();
    if (step) installationSteps.push(step);
  });

  // Get video links if available
  const videos = [];
  $('a[href*="youtube"], a[href*="video"], .video-link').each((i, el) => {
    const href = $(el).attr('href');
    if (href) videos.push(href);
  });

  // Get symptoms this part fixes
  const symptoms = [];
  $('.pd__symptom, .symptom-item').each((i, el) => {
    symptoms.push($(el).text().trim());
  });

  // Get compatible models section info
  const compatibilityNote = $('.pd__cross-reference, .model-compatibility').text().trim();

  return {
    partNumber,
    title,
    price,
    description: description.substring(0, 500),
    inStock,
    imageUrl,
    installationSteps: installationSteps.slice(0, 10),
    videos: videos.slice(0, 3),
    symptoms: symptoms.slice(0, 10),
    compatibilityNote
  };
}

// Check if a part is compatible with a model
export async function checkCompatibility(partNumber, modelNumber) {
  try {
    // Search for the model and check if the part appears
    const modelUrl = `${BASE_URL}/Models/${encodeURIComponent(modelNumber)}/`;
    const html = await fetchPageWithPuppeteer(modelUrl);
    const $ = cheerio.load(html);

    const modelName = $('h1').first().text().trim();
    const pageText = $.text().toLowerCase();
    const partNumLower = partNumber.toLowerCase();

    // Check if part number appears on the model page
    const isCompatible = pageText.includes(partNumLower);

    // Also try searching for the part and checking its compatible models
    const partInfo = await searchPart(partNumber);

    return {
      partNumber,
      modelNumber,
      modelName,
      isCompatible,
      partInfo: partInfo.error ? null : partInfo,
      message: isCompatible
        ? `Part ${partNumber} appears to be compatible with model ${modelNumber}.`
        : `Could not confirm compatibility between ${partNumber} and ${modelNumber}. Check PartSelect.com directly.`
    };
  } catch (error) {
    return {
      partNumber,
      modelNumber,
      error: `Failed to check compatibility: ${error.message}`,
      message: `Unable to verify compatibility. Please check PartSelect.com directly.`
    };
  }
}

// Get troubleshooting info for common issues
export async function getTroubleshootingInfo(appliance, symptom) {
  try {
    const searchQuery = `${appliance} ${symptom}`;
    const searchUrl = `${BASE_URL}/Repair/Help/${encodeURIComponent(searchQuery.replace(/\s+/g, '-'))}/`;

    let html;
    try {
      html = await fetchPageWithPuppeteer(searchUrl);
    } catch {
      // Troubleshooting URL didn't work, return empty results
      return {
        appliance,
        symptom,
        tips: [],
        suggestedParts: [],
        message: `Could not fetch specific troubleshooting data. Will provide general guidance.`
      };
    }

    const $ = cheerio.load(html);

    // Extract repair help content
    const tips = [];
    $('.repair-help__tip, .repair-story, .help-content p').each((i, el) => {
      const text = $(el).text().trim();
      if (text && text.length > 20) tips.push(text);
    });

    // Get commonly replaced parts for this issue
    const suggestedParts = [];
    $('.part-suggestion, .mega-m__part').slice(0, 5).each((i, el) => {
      const partName = $(el).find('.mega-m__part-name, h3').text().trim();
      const partNum = $(el).find('.mega-m__part-number, .part-number').text().trim();
      if (partName || partNum) {
        suggestedParts.push({ name: partName, number: partNum });
      }
    });

    return {
      appliance,
      symptom,
      tips: tips.slice(0, 5),
      suggestedParts,
      message: tips.length > 0
        ? `Found troubleshooting information for ${appliance} ${symptom}.`
        : `Limited troubleshooting info available. Common causes and solutions will be provided.`
    };
  } catch (error) {
    return {
      appliance,
      symptom,
      tips: [],
      suggestedParts: [],
      message: `Could not fetch specific troubleshooting data. Will provide general guidance.`
    };
  }
}
