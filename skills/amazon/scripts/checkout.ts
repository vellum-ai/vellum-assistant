import type {
  CheckoutSummary,
  DeliverySlot,
  PaymentMethod,
  PlaceOrderResult,
} from "./client.js";
import {
  AMAZON_BASE,
  cdpEval,
  handleResult,
  prepareRequest,
  runWithBackoff,
} from "./client.js";

/**
 * Get available Amazon Fresh delivery slots.
 */
export async function getFreshDeliverySlots(): Promise<DeliverySlot[]> {
  const { tabId } = await prepareRequest();

  return runWithBackoff(async () => {
    const url = `${AMAZON_BASE}/fresh/deliverywindows`;

    const script = `
      (async function() {
        try {
          var resp = await fetch(${JSON.stringify(url)}, {
            credentials: 'include',
            headers: {
              'Accept': 'application/json, text/html,*/*',
              'x-requested-with': 'XMLHttpRequest',
            }
          });
          if (resp.status === 401) return JSON.stringify({ __status: 401, __error: true });
          if (resp.status === 403) return JSON.stringify({ __status: 403, __error: true });
          var text = await resp.text();

          var slots = [];
          try {
            var data = JSON.parse(text);
            // Normalize various possible response shapes
            var windows = data.deliveryWindows || data.windows || data.slots || (Array.isArray(data) ? data : []);
            windows.forEach(function(w) {
              slots.push({
                slotId: w.windowId || w.slotId || w.id || '',
                date: w.date || w.windowStartDate || (w.windowStartDateTimeUtc || '').split('T')[0] || '',
                timeWindow: w.timeWindow || w.displayString || (w.windowStartDateTimeUtc && w.windowEndDateTimeUtc
                  ? w.windowStartDateTimeUtc.split('T')[1].substring(0,5) + ' - ' + w.windowEndDateTimeUtc.split('T')[1].substring(0,5)
                  : ''),
                price: (w.price && w.price.localizedDisplayString) ? w.price.localizedDisplayString
                       : (w.deliveryFee || w.fee || 'FREE'),
                isAvailable: w.isAvailable !== false && !w.isFull,
              });
            });
          } catch(pe) {
            // HTML response - parse from page
            var parser = new DOMParser();
            var doc = parser.parseFromString(text, 'text/html');
            doc.querySelectorAll('[data-slot-id], [data-window-id]').forEach(function(el) {
              slots.push({
                slotId: el.getAttribute('data-slot-id') || el.getAttribute('data-window-id') || '',
                date: el.getAttribute('data-date') || '',
                timeWindow: el.getAttribute('data-time-window') || el.textContent.trim(),
                price: (el.querySelector('.a-price') || el.querySelector('.slot-price') || {textContent: 'FREE'}).textContent.trim(),
                isAvailable: !el.classList.contains('unavailable') && !el.hasAttribute('disabled'),
              });
            });
          }

          return JSON.stringify({ __status: resp.status, __data: slots });
        } catch(e) {
          return JSON.stringify({ __error: true, __message: e.message });
        }
      })()
    `;

    const result = (await cdpEval(tabId, script)) as Record<string, unknown>;
    handleResult(result);
    return result.__data as DeliverySlot[];
  });
}

/**
 * Select an Amazon Fresh delivery slot.
 */
export async function selectFreshDeliverySlot(
  slotId: string,
): Promise<{ ok: boolean }> {
  const { tabId } = await prepareRequest();

  return runWithBackoff(async () => {
    const url = `${AMAZON_BASE}/fresh/api/deliverywindows/select`;
    const body = JSON.stringify({ windowId: slotId });

    const script = `
      (async function() {
        try {
          var antiCsrf = '';
          var csrfMeta = document.querySelector('meta[name="anti-csrftoken-a2z"]');
          if (csrfMeta && csrfMeta.content) {
            antiCsrf = csrfMeta.content;
          } else {
            var csrfInp = document.querySelector('input[name="anti-csrftoken-a2z"]');
            if (csrfInp && csrfInp.value) { antiCsrf = csrfInp.value; }
            else { var m = document.cookie.match(/anti-csrftoken-a2z=([^;]+)/); if (m) antiCsrf = decodeURIComponent(m[1]); }
          }

          var resp = await fetch(${JSON.stringify(url)}, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
              'anti-csrftoken-a2z': antiCsrf,
              'x-requested-with': 'XMLHttpRequest',
            },
            body: ${JSON.stringify(body)},
            credentials: 'include',
          });
          if (resp.status === 401) return JSON.stringify({ __status: 401, __error: true });
          if (resp.status === 403) return JSON.stringify({ __status: 403, __error: true });
          var text = await resp.text();
          return JSON.stringify({ __status: resp.status, __ok: resp.ok, __body: text.substring(0, 500) });
        } catch(e) {
          return JSON.stringify({ __error: true, __message: e.message });
        }
      })()
    `;

    const result = (await cdpEval(tabId, script)) as Record<string, unknown>;
    handleResult(result);
    return { ok: Boolean(result.__ok) };
  });
}

/**
 * Get payment methods from the checkout page.
 */
export async function getPaymentMethods(): Promise<PaymentMethod[]> {
  const { tabId } = await prepareRequest();

  return runWithBackoff(async () => {
    const url = `${AMAZON_BASE}/gp/buy/payselect/handlers/display.html`;

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

          var methods = [];
          var seen = new Set();

          // Look for payment instruments in the page
          doc.querySelectorAll('[data-pmid], [id^="payment-instrument-"]').forEach(function(el) {
            var pmid = el.getAttribute('data-pmid') || el.id.replace('payment-instrument-', '');
            if (!pmid || seen.has(pmid)) return;
            seen.add(pmid);

            var textContent = el.textContent || '';
            var last4Match = textContent.match(/(?:ending|\\*{3,})(\\d{4})/);
            var last4 = last4Match ? last4Match[1] : '';

            var type = 'Card';
            if (textContent.toLowerCase().includes('visa')) type = 'Visa';
            else if (textContent.toLowerCase().includes('mastercard')) type = 'Mastercard';
            else if (textContent.toLowerCase().includes('amex') || textContent.toLowerCase().includes('american express')) type = 'AmEx';
            else if (textContent.toLowerCase().includes('discover')) type = 'Discover';

            var isDefault = el.classList.contains('pmts-selected') || !!el.querySelector('[selected]') || false;

            if (last4 || pmid) {
              methods.push({ paymentMethodId: pmid, type, last4, isDefault });
            }
          });

          // Fallback: look for payment method data in inline JSON
          if (methods.length === 0) {
            var jsonMatch = html.match(/"paymentInstruments"\\s*:\\s*(\\[[^\\]]+\\])/);
            if (jsonMatch) {
              try {
                var instruments = JSON.parse(jsonMatch[1]);
                instruments.forEach(function(inst) {
                  methods.push({
                    paymentMethodId: inst.paymentMethodId || inst.id || '',
                    type: inst.cardType || inst.type || 'Card',
                    last4: inst.last4 || inst.maskedCardNumber || '',
                    isDefault: !!inst.isDefault,
                  });
                });
              } catch(e) { console.warn('[amazon] payment instruments JSON parse failed', e.message); }
            }
          }

          return JSON.stringify({ __status: resp.status, __data: methods });
        } catch(e) {
          return JSON.stringify({ __error: true, __message: e.message });
        }
      })()
    `;

    const result = (await cdpEval(tabId, script)) as Record<string, unknown>;
    handleResult(result);
    return result.__data as PaymentMethod[];
  });
}

/**
 * Get the checkout summary (totals, shipping, payment options).
 */
export async function getCheckoutSummary(): Promise<CheckoutSummary> {
  const { tabId } = await prepareRequest();

  return runWithBackoff(async () => {
    const url = `${AMAZON_BASE}/gp/buy/spc/handlers/static-submit-merchantId-data.html`;

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

          var getPrice = function(selector) {
            var el = doc.querySelector(selector);
            return el ? el.textContent.trim() : '';
          };

          var subtotal = getPrice('#subtotals-marketplace-table tr:first-child td:last-child') ||
                         getPrice('.order-summary-line-item-price') ||
                         getPrice('[data-component="subtotalAmount"]');
          var shipping = getPrice('#subtotals-marketplace-table .shipping-row td:last-child') ||
                         getPrice('[data-component="shippingAmount"]') || 'FREE';
          var tax = getPrice('#subtotals-marketplace-table .tax-row td:last-child') ||
                    getPrice('[data-component="taxAmount"]') || '';
          var total = getPrice('#subtotals-marketplace-table .grand-total-price') ||
                      getPrice('[data-component="orderTotalAmount"]') ||
                      getPrice('.grand-total-price');

          var deliveryDateEl = doc.querySelector('.delivery-date') || doc.querySelector('[class*="delivery-date"]');
          var deliveryDate = deliveryDateEl ? deliveryDateEl.textContent.trim() : '';

          // Payment methods
          var methods = [];
          doc.querySelectorAll('[data-pmid], .payment-instrument').forEach(function(el) {
            var pmid = el.getAttribute('data-pmid') || '';
            if (!pmid) return;
            var text = el.textContent || '';
            var last4Match = text.match(/(?:ending|\\*{3,})(\\d{4})/);
            methods.push({
              paymentMethodId: pmid,
              type: text.toLowerCase().includes('visa') ? 'Visa' :
                    text.toLowerCase().includes('mastercard') ? 'Mastercard' : 'Card',
              last4: last4Match ? last4Match[1] : '',
              isDefault: !!el.querySelector('[selected]') || el.classList.contains('selected'),
            });
          });

          return JSON.stringify({
            __status: resp.status,
            __data: { subtotal, shipping, tax, total, paymentMethods: methods, deliveryDate }
          });
        } catch(e) {
          return JSON.stringify({ __error: true, __message: e.message });
        }
      })()
    `;

    const result = (await cdpEval(tabId, script)) as Record<string, unknown>;
    handleResult(result);
    return result.__data as CheckoutSummary;
  });
}

/**
 * Place an Amazon order.
 * WARNING: This submits a real order. Always confirm with the user first.
 */
export async function placeOrder(
  opts: {
    paymentMethodId?: string;
  } = {},
): Promise<PlaceOrderResult> {
  const { tabId } = await prepareRequest();

  return runWithBackoff(async () => {
    // First load the SPC page to get the order submission token
    const spcUrl = `${AMAZON_BASE}/gp/buy/spc/handlers/static-submit-merchantId-data.html`;

    const script = `
      (async function() {
        try {
          var antiCsrf = '';
          var csrfMeta = document.querySelector('meta[name="anti-csrftoken-a2z"]');
          if (csrfMeta && csrfMeta.content) {
            antiCsrf = csrfMeta.content;
          } else {
            var csrfInp = document.querySelector('input[name="anti-csrftoken-a2z"]');
            if (csrfInp && csrfInp.value) { antiCsrf = csrfInp.value; }
            else { var m = document.cookie.match(/anti-csrftoken-a2z=([^;]+)/); if (m) antiCsrf = decodeURIComponent(m[1]); }
          }

          // Load checkout page to get form token
          var spcResp = await fetch(${JSON.stringify(spcUrl)}, {
            credentials: 'include',
            headers: { 'Accept': 'text/html,application/xhtml+xml' }
          });
          if (spcResp.status === 401) return JSON.stringify({ __status: 401, __error: true });
          if (spcResp.status === 403) return JSON.stringify({ __status: 403, __error: true });
          var spcHtml = await spcResp.text();

          // Extract form action and hidden fields
          var parser = new DOMParser();
          var doc = parser.parseFromString(spcHtml, 'text/html');
          var form = doc.querySelector('form#turbo-checkout-pyo-form') || doc.querySelector('form[name="checkout"]') || doc.querySelector('#placeYourOrder form');

          if (!form) {
            return JSON.stringify({ __error: true, __message: 'Could not find order form on checkout page. Please complete checkout manually in the browser.' });
          }

          var formAction = form.getAttribute('action') || '/gp/buy/spc/handlers/static-submit-merchantId-data.html';
          if (!formAction.startsWith('http')) formAction = 'https://www.amazon.com' + formAction;

          // Build form data from hidden inputs
          var formData = new URLSearchParams();
          form.querySelectorAll('input[type="hidden"]').forEach(function(inp) {
            formData.set(inp.name, inp.value);
          });

          // Apply payment method if specified
          if (${JSON.stringify(opts.paymentMethodId || "")}) {
            formData.set('ppw-instrumentId', ${JSON.stringify(
              opts.paymentMethodId || "",
            )});
          }

          // Submit order
          var submitResp = await fetch(formAction, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'anti-csrftoken-a2z': antiCsrf,
            },
            body: formData.toString(),
            credentials: 'include',
          });
          if (submitResp.status === 401) return JSON.stringify({ __status: 401, __error: true });
          if (submitResp.status === 403) return JSON.stringify({ __status: 403, __error: true });
          var resultHtml = await submitResp.text();
          var resultDoc = parser.parseFromString(resultHtml, 'text/html');

          // Extract order ID from confirmation page
          var orderIdEl = resultDoc.querySelector('[class*="order-id"]') ||
                          resultDoc.querySelector('[data-order-id]') ||
                          resultDoc.querySelector('[class*="confirmation"]');
          var orderId = '';
          if (orderIdEl) {
            var oidMatch = (orderIdEl.textContent || '').match(/\\d{3}-\\d{7}-\\d{7}/);
            if (oidMatch) orderId = oidMatch[0];
          }
          // Also check URL for order ID
          var urlMatch = submitResp.url.match(/orderId=([\\d-]+)/);
          if (!orderId && urlMatch) orderId = urlMatch[1];

          var deliveryEl = resultDoc.querySelector('[class*="delivery-date"]') || resultDoc.querySelector('[class*="estimated-delivery"]');
          var estimatedDelivery = deliveryEl ? deliveryEl.textContent.trim() : '';

          return JSON.stringify({
            __status: submitResp.status,
            __data: { orderId: orderId || 'confirmed', estimatedDelivery }
          });
        } catch(e) {
          return JSON.stringify({ __error: true, __message: e.message });
        }
      })()
    `;

    const result = (await cdpEval(tabId, script)) as Record<string, unknown>;
    handleResult(result);
    return result.__data as PlaceOrderResult;
  });
}
