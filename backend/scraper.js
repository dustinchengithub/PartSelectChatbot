import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer';

const BASE_URL = 'https://www.partselect.com';

// Use Puppeteer to fetch pages that have bot detection
async function fetchPageWithPuppeteer(url) {
  console.log("Fetching with Puppeteer:", url);
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    const html = await page.content();
    return html;
  } finally {
    await browser.close();
  }
}

// Simple fetch for sites that don't block (like DuckDuckGo)
async function fetchPageSimple(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

// Use DuckDuckGo to find the correct PartSelect URL for a part number
async function findPartSelectUrl(partNumber) {
  const searchQuery = `site:partselect.com ${partNumber}`;
  const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;

  console.log("Trying DuckDuckGo URL:", ddgUrl);

  const response = await fetch(ddgUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });

  if (!response.ok) {
    console.log("DuckDuckGo request failed:", response.status);
    return null;
  }

  console.log("DuckDuckGo response received");

  const html = await response.text();

  // Debug
  console.log("Contains 'partselect':", html.toLowerCase().includes('partselect'));
  console.log("Contains part number:", html.includes(partNumber));

  // DuckDuckGo HTML version uses uddg= parameter with URL-encoded links
  // Look for encoded PartSelect URLs
  const encodedRegex = new RegExp(`uddg=([^&"']+${partNumber}[^&"']*)`, 'i');
  const encodedMatch = html.match(encodedRegex);

  if (encodedMatch) {
    const decodedUrl = decodeURIComponent(encodedMatch[1]);
    console.log("Found encoded URL, decoded:", decodedUrl);
    if (decodedUrl.includes('partselect.com')) {
      return decodedUrl;
    }
  }

  // Also try direct URL match
  console.log("DDG encoded URL match not found, trying direct regex match");
  const regex = new RegExp(`https?://www\\.partselect\\.com/${partNumber}[^"'\\s&<>]*\\.htm`, 'i');
  const match = html.match(regex);

  console.log("Direct regex match:", match ? match[0] : "NO MATCH");

  if (match) {
    return match[0];
  }

  // Fallback: find any partselect.com URL
  const fallbackRegex = /https?:\/\/www\.partselect\.com\/[^"'\s<>]+\.htm/gi;
  const fallbackMatches = html.match(fallbackRegex);
  console.log("Fallback PartSelect URLs:", fallbackMatches?.slice(0, 3));

  if (fallbackMatches && fallbackMatches.length > 0) {
    return fallbackMatches[0];
  }

  return null;
}

// Search for a part by part number
export async function searchPart(partNumber) {
  try {
    // First, try to find the direct URL via Google site search
    const directUrl = await findPartSelectUrl(partNumber);

    console.log("Direct URL found:", directUrl);

    if (directUrl) {
      console.log("Fetching direct URL with Puppeteer...");
      const html = await fetchPageWithPuppeteer(directUrl);
      console.log("Successfully fetched direct URL, extracting details...");
      const $ = cheerio.load(html);
      return extractPartDetails($, partNumber);
    }

    // Reminder that the PartSelect search didn't work - SEARCH BOX IN WEBPAGE WORKED BUT NOT THE SEARCH URL

    return { error: `No results found for part number: ${partNumber}` };
  } catch (error) {
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
