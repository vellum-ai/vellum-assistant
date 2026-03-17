import type { ProductDetails } from "./client.js";
import {
  AMAZON_BASE,
  cdpEval,
  handleResult,
  prepareRequest,
  runWithBackoff,
} from "./client.js";

/**
 * Get product details for a specific ASIN, including variations.
 */
export async function getProductDetails(
  asin: string,
  opts: { isFresh?: boolean } = {},
): Promise<ProductDetails> {
  const { tabId } = await prepareRequest();

  return runWithBackoff(async () => {
    const url = `${AMAZON_BASE}/dp/${asin}`;
    const isFreshFlag = JSON.stringify(!!opts.isFresh);

    const script = `
      (async function() {
        try {
          var resp = await fetch(${JSON.stringify(url)}, {
            credentials: 'include',
            headers: { 'Accept': 'text/html,application/xhtml+xml' }
          });
          if (resp.status === 401) return JSON.stringify({ __status: 401, __error: true });
          if (resp.status === 403) return JSON.stringify({ __status: 403, __error: true });
          var html = await resp.text();
          var parser = new DOMParser();
          var doc = parser.parseFromString(html, 'text/html');

          // Title
          var titleEl = doc.getElementById('productTitle') ||
                        doc.querySelector('.product-title-word-break') ||
                        doc.querySelector('h1#title');
          var title = titleEl ? titleEl.textContent.trim() : '';

          // Price
          var priceEl = doc.querySelector('#priceblock_ourprice .a-offscreen') ||
                        doc.querySelector('#priceblock_dealprice .a-offscreen') ||
                        doc.querySelector('.a-price .a-offscreen') ||
                        doc.querySelector('#price_inside_buybox');
          var priceText = priceEl ? priceEl.textContent.trim() : '';
          var priceNum = priceText ? parseFloat(priceText.replace(/[^0-9.]/g, '')) : null;

          // Image
          var imgEl = doc.getElementById('landingImage') || doc.querySelector('#imgBlkFront');
          var imageUrl = imgEl ? (imgEl.getAttribute('data-a-dynamic-image') ? Object.keys(JSON.parse(imgEl.getAttribute('data-a-dynamic-image') || '{}'))[0] : imgEl.getAttribute('src')) : undefined;

          // Rating
          var ratingEl = doc.querySelector('#acrPopover') || doc.querySelector('[data-hook="rating-out-of-text"]');
          var rating = ratingEl ? ratingEl.getAttribute('title') || ratingEl.textContent.trim() : undefined;

          var reviewEl = doc.getElementById('acrCustomerReviewText');
          var reviewCount = reviewEl ? reviewEl.textContent.trim() : undefined;

          // Parent ASIN (for variation child products)
          var parentAsinEl = doc.querySelector('[data-asin]') || doc.querySelector('[name="ASIN"]');
          var parentAsin = undefined;
          var m = html.match(/"parentAsin"\s*:\s*"([A-Z0-9]+)"/);
          if (m) parentAsin = m[1];

          // Detect Fresh
          var isFresh = ${isFreshFlag} || html.includes('amazon.com/fresh') || !!doc.querySelector('[aria-label*="Fresh"]');

          // Variations - parse from inline JS objects
          var variations = [];
          try {
            var dimMatch = html.match(/dimensionRelationshipsStr\s*=\s*'([^']+)'/);
            if (!dimMatch) dimMatch = html.match(/"dimensionRelationshipsStr"\s*:\s*"([^"]+)"/);
            if (dimMatch) {
              var dimStr = dimMatch[1].replace(/\\\\/g, '\\\\').replace(/\\'/g, "'");
              var dimData = JSON.parse(dimStr);
              if (Array.isArray(dimData)) {
                for (var i = 0; i < dimData.length; i++) {
                  var dimItem = dimData[i];
                  var attrs = dimItem.variationAttributes || [];
                  for (var j = 0; j < attrs.length; j++) {
                    variations.push({
                      dimensionName: attrs[j].variationName || '',
                      value: attrs[j].value || '',
                      asin: dimItem.asin || '',
                      isAvailable: dimItem.isPrime !== undefined ? true : !dimItem.unavailable,
                      priceValue: dimItem.price ? parseFloat(String(dimItem.price).replace(/[^0-9.]/g, '')) : null,
                    });
                  }
                }
              }
            }
          } catch(ve) { console.warn('[amazon] variation parsing failed', ve.message); }

          // Fallback: look for asinVariationValues
          if (variations.length === 0) {
            try {
              var asinVarMatch = html.match(/asinVariationValues\s*=\s*(\{[^;]+\})/);
              if (asinVarMatch) {
                var asinVarData = JSON.parse(asinVarMatch[1]);
                var dims = Object.keys(asinVarData);
                for (var di = 0; di < dims.length; di++) {
                  var dim = dims[di];
                  var asins = Object.keys(asinVarData[dim]);
                  for (var ai = 0; ai < asins.length; ai++) {
                    variations.push({
                      dimensionName: dim,
                      value: asinVarData[dim][asins[ai]],
                      asin: asins[ai],
                      isAvailable: true,
                      priceValue: null,
                    });
                  }
                }
              }
            } catch(ve2) { console.warn('[amazon] asinVariationValues parsing failed', ve2.message); }
          }

          return JSON.stringify({
            __status: resp.status,
            __data: {
              asin: ${JSON.stringify(asin)},
              parentAsin: parentAsin,
              title: title,
              price: priceText,
              priceValue: isNaN(priceNum) ? null : priceNum,
              variations: variations,
              isFresh: isFresh,
              imageUrl: imageUrl,
              rating: rating,
              reviewCount: reviewCount,
            }
          });
        } catch(e) {
          return JSON.stringify({ __error: true, __message: e.message });
        }
      })()
    `;

    const result = (await cdpEval(tabId, script)) as Record<string, unknown>;
    handleResult(result);
    return result.__data as ProductDetails;
  });
}
