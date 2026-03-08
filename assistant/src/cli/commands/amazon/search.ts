import type { ProductSearchResult } from "./client.js";
import {
  AMAZON_BASE,
  cdpEval,
  handleResult,
  prepareRequest,
  runWithBackoff,
} from "./client.js";

/**
 * Search Amazon for products.
 * Use isFresh: true to search Amazon Fresh grocery items.
 */
export async function search(
  query: string,
  opts: { isFresh?: boolean; limit?: number } = {},
): Promise<ProductSearchResult[]> {
  const { tabId } = await prepareRequest();

  return runWithBackoff(async () => {
    const url = opts.isFresh
      ? `${AMAZON_BASE}/s?k=${encodeURIComponent(query)}&i=fresh-foods`
      : `${AMAZON_BASE}/s?k=${encodeURIComponent(query)}`;
    const limit = opts.limit ?? 20;
    const isFreshFlag = JSON.stringify(!!opts.isFresh);

    const script = `
      (async function() {
        try {
          var resp = await fetch(${JSON.stringify(
            url,
          )}, { credentials: 'include' });
          if (resp.status === 401) return JSON.stringify({ __status: 401, __error: true });
          if (resp.status === 403) return JSON.stringify({ __status: 403, __error: true });
          var html = await resp.text();
          var parser = new DOMParser();
          var doc = parser.parseFromString(html, 'text/html');
          var results = [];
          var cards = doc.querySelectorAll('[data-component-type="s-search-result"][data-asin]');
          for (var i = 0; i < Math.min(cards.length, ${limit}); i++) {
            var el = cards[i];
            var asin = el.getAttribute('data-asin');
            if (!asin || asin.length < 6) continue;
            var titleEl = el.querySelector('h2 .a-text-normal') || el.querySelector('h2 a span') || el.querySelector('.s-title-instructions-style');
            var priceEl = el.querySelector('.a-price .a-offscreen');
            var imgEl = el.querySelector('img.s-image');
            var ratingEl = el.querySelector('.a-icon-star-small .a-icon-alt') || el.querySelector('[aria-label*="stars"]');
            var reviewEl = el.querySelector('[aria-label*="reviews"]') || el.querySelector('.s-underline-text');
            var isPrime = !!el.querySelector('.a-icon-prime');
            var isFreshEl = !!el.querySelector('[aria-label*="Fresh"]') || html.includes('amazon.com/fresh') && i < 5;
            var priceText = priceEl ? priceEl.textContent.trim() : '';
            var priceNum = priceText ? parseFloat(priceText.replace(/[^0-9.]/g, '')) : null;
            results.push({
              asin: asin,
              title: titleEl ? titleEl.textContent.trim() : '',
              price: priceText,
              priceValue: isNaN(priceNum) ? null : priceNum,
              isPrime: isPrime,
              isFresh: ${isFreshFlag} || isFreshEl,
              imageUrl: imgEl ? imgEl.getAttribute('src') : undefined,
              rating: ratingEl ? ratingEl.getAttribute('aria-label') || ratingEl.textContent.trim() : undefined,
              reviewCount: reviewEl ? reviewEl.textContent.trim() : undefined,
            });
          }
          return JSON.stringify({ __status: resp.status, __data: results });
        } catch(e) {
          return JSON.stringify({ __error: true, __message: e.message });
        }
      })()
    `;

    const result = (await cdpEval(tabId, script)) as Record<string, unknown>;
    handleResult(result);
    return result.__data as ProductSearchResult[];
  });
}
