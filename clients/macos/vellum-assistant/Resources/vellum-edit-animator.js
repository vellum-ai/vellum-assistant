/* ============================================================
   vellum-edit-animator.js
   DOM diffing and animated mutation engine for Vellum Assistant.
   Injected into dynamic page WKWebViews at document end.

   API: window.vellum.morphWithAnimation(newHTML) → Promise<{success, fallback, cancelled}>
   ============================================================ */

(function () {
  'use strict';

  // Extend the existing window.vellum namespace (created by the bridge script).
  if (!window.vellum) window.vellum = {};

  // Cancellation generation counter.
  window.vellum._morphGen = 0;

  // ─── Companion CSS ─────────────────────────────────────────────
  (function injectStyles() {
    var style = document.createElement('style');
    style.setAttribute('data-vellum-injected', 'true');
    style.textContent = [
      '.vellum-cursor {',
      '  display: inline;',
      '  animation: vellum-blink 0.6s step-end infinite;',
      '  color: var(--v-accent, #537D53);',
      '}',
      '@keyframes vellum-blink { 50% { opacity: 0; } }'
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  })();

  // ─── Helpers ───────────────────────────────────────────────────

  function isVellumInjected(node) {
    return node.nodeType === 1 && node.hasAttribute('data-vellum-injected');
  }

  function liveChildren(parent) {
    var result = [];
    for (var i = 0; i < parent.childNodes.length; i++) {
      var child = parent.childNodes[i];
      if (!isVellumInjected(child)) {
        result.push(child);
      }
    }
    return result;
  }

  function isSameNode(a, b) {
    if (a.nodeType !== b.nodeType) return false;
    if (a.nodeType === 3) return true; // text nodes match positionally
    if (a.nodeType !== 1) return true;
    if (a.tagName !== b.tagName) return false;
    var aId = a.id;
    var bId = b.id;
    if (aId && bId) return aId === bId;
    if (aId || bId) return false; // one has id, the other doesn't
    return true;
  }

  function getAttributeMap(el) {
    var map = {};
    for (var i = 0; i < el.attributes.length; i++) {
      var attr = el.attributes[i];
      map[attr.name] = attr.value;
    }
    return map;
  }

  // ─── Fallback checks ──────────────────────────────────────────

  function collectTags(doc, tagName) {
    var nodes = doc.querySelectorAll(tagName);
    var result = [];
    for (var i = 0; i < nodes.length; i++) {
      result.push(nodes[i]);
    }
    return result;
  }

  function scriptsChanged(oldDoc, newDoc) {
    var oldScripts = collectTags(oldDoc, 'script');
    var newScripts = collectTags(newDoc, 'script');
    if (oldScripts.length !== newScripts.length) return true;
    for (var i = 0; i < oldScripts.length; i++) {
      if (oldScripts[i].src !== newScripts[i].src) return true;
      if (oldScripts[i].textContent !== newScripts[i].textContent) return true;
    }
    return false;
  }

  function baseChanged(oldDoc, newDoc) {
    var oldBase = oldDoc.querySelector('base');
    var newBase = newDoc.querySelector('base');
    if ((!oldBase) !== (!newBase)) return true;
    if (oldBase && newBase && oldBase.href !== newBase.href) return true;
    return false;
  }

  function stylesheetsChanged(oldDoc, newDoc) {
    var oldLinks = collectTags(oldDoc, 'link[rel="stylesheet"]');
    var newLinks = collectTags(newDoc, 'link[rel="stylesheet"]');
    if (oldLinks.length !== newLinks.length) return true;
    for (var i = 0; i < oldLinks.length; i++) {
      if (oldLinks[i].href !== newLinks[i].href) return true;
    }
    return false;
  }

  function htmlAttrsChanged(oldDoc, newDoc) {
    var oldHtml = oldDoc.documentElement;
    var newHtml = newDoc.documentElement;
    var oldAttrs = getAttributeMap(oldHtml);
    var newAttrs = getAttributeMap(newHtml);
    var allKeys = {};
    var k;
    for (k in oldAttrs) allKeys[k] = true;
    for (k in newAttrs) allKeys[k] = true;
    for (k in allKeys) {
      if (oldAttrs[k] !== newAttrs[k]) return true;
    }
    return false;
  }

  function shouldFallback(newDoc) {
    if (scriptsChanged(document, newDoc)) return true;
    if (baseChanged(document, newDoc)) return true;
    if (stylesheetsChanged(document, newDoc)) return true;
    if (htmlAttrsChanged(document, newDoc)) return true;
    return false;
  }

  // ─── Diff / Collect ops ────────────────────────────────────────

  function collectOps(oldParent, newParent, ops) {
    var oldKids = liveChildren(oldParent);
    var newKids = [];
    for (var n = 0; n < newParent.childNodes.length; n++) {
      newKids.push(newParent.childNodes[n]);
    }

    var oi = 0;
    var ni = 0;

    while (oi < oldKids.length && ni < newKids.length) {
      var oldChild = oldKids[oi];
      var newChild = newKids[ni];

      if (isSameNode(oldChild, newChild)) {
        // Text node comparison
        if (oldChild.nodeType === 3) {
          if (oldChild.textContent !== newChild.textContent) {
            ops.push({ type: 'text_replace', node: oldChild, oldText: oldChild.textContent, newText: newChild.textContent });
          }
          oi++; ni++;
          continue;
        }

        // Element node — compare attributes
        if (oldChild.nodeType === 1) {
          var oldAttrs = getAttributeMap(oldChild);
          var newAttrs = getAttributeMap(newChild);
          var allKeys = {};
          var key;
          for (key in oldAttrs) allKeys[key] = true;
          for (key in newAttrs) allKeys[key] = true;
          for (key in allKeys) {
            if (oldAttrs[key] !== newAttrs[key]) {
              ops.push({ type: 'attr_change', node: oldChild, attr: key, oldVal: oldAttrs[key] !== undefined ? oldAttrs[key] : null, newVal: newAttrs[key] !== undefined ? newAttrs[key] : null });
            }
          }
          // Recurse into children
          collectOps(oldChild, newChild, ops);
        }

        oi++; ni++;
      } else {
        // Try to find a match for newChild ahead in old children (insertion)
        // or a match for oldChild ahead in new children (removal)
        var foundOldAhead = -1;
        var foundNewAhead = -1;

        // Look ahead in new children for current old child
        for (var j = ni + 1; j < newKids.length && j - ni <= 4; j++) {
          if (isSameNode(oldChild, newKids[j])) { foundNewAhead = j; break; }
        }

        // Look ahead in old children for current new child
        for (var k = oi + 1; k < oldKids.length && k - oi <= 4; k++) {
          if (isSameNode(newChild, oldKids[k])) { foundOldAhead = k; break; }
        }

        if (foundOldAhead >= 0 && (foundNewAhead < 0 || foundOldAhead - oi <= foundNewAhead - ni)) {
          // Remove old nodes until we reach the match
          for (var r = oi; r < foundOldAhead; r++) {
            ops.push({ type: 'element_remove', node: oldKids[r], parent: oldParent });
          }
          oi = foundOldAhead;
        } else if (foundNewAhead >= 0) {
          // Insert new nodes until we reach the match
          for (var s = ni; s < foundNewAhead; s++) {
            ops.push({ type: 'element_insert', node: newKids[s], parent: oldParent, refNode: oldChild });
          }
          ni = foundNewAhead;
        } else {
          // No match found — treat as remove + insert (tag changed)
          ops.push({ type: 'element_remove', node: oldChild, parent: oldParent });
          ops.push({ type: 'element_insert', node: newChild, parent: oldParent, refNode: oldChild.nextSibling });
          oi++; ni++;
        }
      }
    }

    // Remaining old children → removals
    while (oi < oldKids.length) {
      ops.push({ type: 'element_remove', node: oldKids[oi], parent: oldParent });
      oi++;
    }

    // Remaining new children → insertions
    while (ni < newKids.length) {
      ops.push({ type: 'element_insert', node: newKids[ni], parent: oldParent, refNode: null });
      ni++;
    }
  }

  // ─── Head sync (non-script, non-stylesheet) ───────────────────

  function syncHead(newDoc) {
    var newTitle = newDoc.querySelector('title');
    if (newTitle && document.title !== newTitle.textContent) {
      document.title = newTitle.textContent;
    }
    // Sync meta tags
    var newMetas = collectTags(newDoc.head, 'meta');
    var oldMetas = collectTags(document.head, 'meta');
    // Remove old non-injected metas, re-add from new
    for (var i = 0; i < oldMetas.length; i++) {
      if (!isVellumInjected(oldMetas[i])) {
        oldMetas[i].parentNode.removeChild(oldMetas[i]);
      }
    }
    for (var j = 0; j < newMetas.length; j++) {
      document.head.appendChild(document.importNode(newMetas[j], true));
    }
    // Sync non-Vellum inline styles in head
    var oldInline = collectTags(document.head, 'style');
    var newInline = collectTags(newDoc.head, 'style');
    for (var m = 0; m < oldInline.length; m++) {
      if (!isVellumInjected(oldInline[m])) {
        oldInline[m].parentNode.removeChild(oldInline[m]);
      }
    }
    for (var n = 0; n < newInline.length; n++) {
      document.head.appendChild(document.importNode(newInline[n], true));
    }
  }

  // ─── Animation helpers ────────────────────────────────────────

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function commonPrefixLen(a, b) {
    var len = Math.min(a.length, b.length);
    for (var i = 0; i < len; i++) {
      if (a[i] !== b[i]) return i;
    }
    return len;
  }

  function commonSuffixLen(a, b, prefixLen) {
    var maxLen = Math.min(a.length - prefixLen, b.length - prefixLen);
    for (var i = 0; i < maxLen; i++) {
      if (a[a.length - 1 - i] !== b[b.length - 1 - i]) return i;
    }
    return maxLen;
  }

  async function animateTextReplace(op, cancelled) {
    var node = op.node;
    var oldText = op.oldText;
    var newText = op.newText;

    var pLen = commonPrefixLen(oldText, newText);
    var sLen = commonSuffixLen(oldText, newText, pLen);

    var oldMiddle = oldText.substring(pLen, oldText.length - sLen);
    var newMiddle = newText.substring(pLen, newText.length - sLen);

    if (oldMiddle.length === 0 && newMiddle.length === 0) return;

    // Replace text node with a span so we can insert a cursor
    var wrapper = document.createElement('span');
    wrapper.setAttribute('data-vellum-injected', 'true');
    var prefix = oldText.substring(0, pLen);
    var suffix = oldText.substring(oldText.length - sLen);
    wrapper.textContent = prefix + oldMiddle + suffix;
    node.parentNode.replaceChild(wrapper, node);

    var cursor = document.createElement('span');
    cursor.className = 'vellum-cursor';
    cursor.setAttribute('data-vellum-injected', 'true');
    cursor.textContent = '\u258F'; // thin block cursor character

    // Position cursor at the end of the changing portion
    var currentMiddle = oldMiddle;

    function updateWrapper() {
      wrapper.textContent = '';
      wrapper.appendChild(document.createTextNode(prefix + currentMiddle));
      wrapper.appendChild(cursor);
      wrapper.appendChild(document.createTextNode(suffix));
    }

    updateWrapper();

    // Delete old middle chars
    for (var d = oldMiddle.length; d > 0; d--) {
      if (cancelled()) {
        var cleanupText = document.createTextNode(op.newText);
        if (wrapper.parentNode) wrapper.parentNode.replaceChild(cleanupText, wrapper);
        return;
      }
      currentMiddle = currentMiddle.substring(0, d - 1);
      updateWrapper();
      await sleep(20);
    }

    // Type new middle chars
    for (var t = 1; t <= newMiddle.length; t++) {
      if (cancelled()) {
        var cleanupText2 = document.createTextNode(op.newText);
        if (wrapper.parentNode) wrapper.parentNode.replaceChild(cleanupText2, wrapper);
        return;
      }
      currentMiddle = newMiddle.substring(0, t);
      updateWrapper();
      await sleep(25);
    }

    // Replace wrapper with a plain text node
    var finalText = document.createTextNode(newText);
    wrapper.parentNode.replaceChild(finalText, wrapper);
  }

  function parseStyleString(str) {
    var map = {};
    if (!str) return map;
    var parts = str.split(';');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (!p) continue;
      var colonIdx = p.indexOf(':');
      if (colonIdx < 0) continue;
      var prop = p.substring(0, colonIdx).trim();
      var val = p.substring(colonIdx + 1).trim();
      map[prop] = val;
    }
    return map;
  }

  async function animateStyleChange(el, oldVal, newVal) {
    var oldStyles = parseStyleString(oldVal);
    var newStyles = parseStyleString(newVal);

    // Identify changed properties
    var changedProps = [];
    var allProps = {};
    var p;
    for (p in oldStyles) allProps[p] = true;
    for (p in newStyles) allProps[p] = true;

    for (p in allProps) {
      if (p === 'transition') continue;
      if (oldStyles[p] !== newStyles[p]) {
        changedProps.push(p);
      }
    }

    if (changedProps.length === 0) return;

    // Set transition for changed properties
    var transitionValue = changedProps.map(function (prop) {
      return prop + ' 0.3s ease';
    }).join(', ');

    el.style.transition = transitionValue;

    // Apply new style values
    for (var i = 0; i < changedProps.length; i++) {
      var prop = changedProps[i];
      if (newStyles[prop] !== undefined) {
        el.style.setProperty(prop, newStyles[prop]);
      } else {
        el.style.removeProperty(prop);
      }
    }

    // Wait for transition to finish
    return new Promise(function (resolve) {
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        el.style.removeProperty('transition');
        resolve();
      }
      el.addEventListener('transitionend', finish, { once: true });
      // Fallback timeout in case transitionend doesn't fire
      setTimeout(finish, 400);
    });
  }

  async function animateInsert(newNode, parent, refNode) {
    var imported = document.importNode(newNode, true);
    if (imported.nodeType === 1) {
      imported.style.opacity = '0';
      imported.style.transform = 'translateY(-8px)';
      imported.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    }
    var safeRef = (refNode && refNode.parentNode === parent) ? refNode : null;
    parent.insertBefore(imported, safeRef);
    if (imported.nodeType === 1) {
      // Force reflow
      void imported.offsetHeight;
      imported.style.opacity = '1';
      imported.style.transform = 'none';
      await new Promise(function (resolve) {
        var done = false;
        function finish() { if (!done) { done = true; imported.style.removeProperty('transition'); resolve(); } }
        imported.addEventListener('transitionend', finish, { once: true });
        setTimeout(finish, 400);
      });
    }
  }

  async function animateRemove(node) {
    if (node.nodeType === 1) {
      node.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
      node.style.opacity = '0';
      node.style.transform = 'translateY(-8px)';
      await new Promise(function (resolve) {
        var done = false;
        function finish() { if (!done) { done = true; resolve(); } }
        node.addEventListener('transitionend', finish, { once: true });
        setTimeout(finish, 350);
      });
    }
    if (node.parentNode) {
      node.parentNode.removeChild(node);
    }
  }

  // ─── Main entry point ─────────────────────────────────────────

  window.vellum.morphWithAnimation = async function (newHTML) {
    var gen = ++window.vellum._morphGen;
    var cancelled = function () { return window.vellum._morphGen !== gen; };

    // Parse new document
    var parser = new DOMParser();
    var newDoc = parser.parseFromString(newHTML, 'text/html');

    // Phase A: Fallback checks
    if (shouldFallback(newDoc)) {
      return { fallback: true };
    }

    // Phase A: Collect ops
    var ops = [];
    if (document.body && newDoc.body) {
      collectOps(document.body, newDoc.body, ops);
    }

    // Op count gate
    if (ops.length > 20) {
      return { fallback: true };
    }

    if (cancelled()) return { cancelled: true };

    // Phase B: Apply ops with animation

    // Sync head (non-animated)
    syncHead(newDoc);

    // Group ops by type
    var textOps = [];
    var styleOps = [];
    var attrOps = [];
    var insertOps = [];
    var removeOps = [];

    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (op.type === 'text_replace') {
        textOps.push(op);
      } else if (op.type === 'attr_change' && op.attr === 'style') {
        styleOps.push(op);
      } else if (op.type === 'attr_change') {
        attrOps.push(op);
      } else if (op.type === 'element_insert') {
        insertOps.push(op);
      } else if (op.type === 'element_remove') {
        removeOps.push(op);
      }
    }

    // Apply non-style attribute changes immediately
    for (var a = 0; a < attrOps.length; a++) {
      if (cancelled()) return { cancelled: true };
      var attrOp = attrOps[a];
      if (attrOp.newVal === null) {
        attrOp.node.removeAttribute(attrOp.attr);
      } else {
        attrOp.node.setAttribute(attrOp.attr, attrOp.newVal);
      }
    }

    // Animate text changes sequentially
    for (var t = 0; t < textOps.length; t++) {
      if (cancelled()) return { cancelled: true };
      await animateTextReplace(textOps[t], cancelled);
    }

    // Animate style changes and structural changes in parallel
    var parallelTasks = [];

    for (var s = 0; s < styleOps.length; s++) {
      parallelTasks.push(animateStyleChange(styleOps[s].node, styleOps[s].oldVal, styleOps[s].newVal));
    }

    for (var r = 0; r < removeOps.length; r++) {
      if (cancelled()) return { cancelled: true };
      parallelTasks.push(animateRemove(removeOps[r].node));
    }

    for (var ins = 0; ins < insertOps.length; ins++) {
      if (cancelled()) return { cancelled: true };
      parallelTasks.push(animateInsert(insertOps[ins].node, insertOps[ins].parent, insertOps[ins].refNode));
    }

    if (parallelTasks.length > 0) {
      await Promise.all(parallelTasks);
    }

    if (cancelled()) return { cancelled: true };

    return { success: true };
  };

})();
