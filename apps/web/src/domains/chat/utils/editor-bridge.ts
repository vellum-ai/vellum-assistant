/**
 * Editor bridge for the document viewer iframe.
 *
 * Generates the HTML document that renders inside the editor iframe,
 * including:
 * - Markdown to HTML rendering (minimal built-in converter)
 * - postMessage listeners for `highlight_range` and `set_comment_anchors`
 * - postMessage emitters for `text_selected` events on user selection changes
 *
 * The parent component communicates with this iframe exclusively via
 * postMessage, keeping the iframe sandboxed and the bridge surface minimal.
 */

import { jsonForScript } from "@/domains/chat/utils/app-bridge.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommentAnchor {
  commentId: string;
  anchorStart: number;
  anchorEnd: number;
}

// ---------------------------------------------------------------------------
// HTML generator
// ---------------------------------------------------------------------------

/**
 * Generate a self-contained HTML document for the editor iframe.
 *
 * The editor displays rendered markdown content and supports:
 * - `highlight_range` messages: temporarily highlight a character range
 * - `set_comment_anchors` messages: render persistent highlights for inline
 *   comment anchors
 * - `text_selected` outbound messages: emitted when the user selects text,
 *   carrying `{ start, end, text }` for inline comment creation
 */
export function generateEditorHTML(content: string): string {
  const escaped = jsonForScript(content);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 15px;
    line-height: 1.65;
    color: #1a1a1a;
    background: transparent;
    padding: 0;
  }
  body { padding: 24px 32px; }
  h1 { font-size: 1.6em; font-weight: 700; margin: 0.8em 0 0.4em; }
  h2 { font-size: 1.3em; font-weight: 600; margin: 0.7em 0 0.35em; }
  h3 { font-size: 1.1em; font-weight: 600; margin: 0.6em 0 0.3em; }
  p { margin: 0.5em 0; }
  ul, ol { margin: 0.5em 0 0.5em 1.5em; }
  li { margin: 0.2em 0; }
  code {
    font-family: "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.9em;
    background: #f0f0f0;
    padding: 0.15em 0.35em;
    border-radius: 3px;
  }
  pre { margin: 0.5em 0; padding: 12px 16px; background: #f5f5f5; border-radius: 6px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote {
    margin: 0.5em 0;
    padding: 0.5em 1em;
    border-left: 3px solid #d0d0d0;
    color: #555;
  }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  table { border-collapse: collapse; margin: 0.5em 0; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; }
  th { background: #f9f9f9; font-weight: 600; }

  /* Highlight marks applied by postMessage handlers */
  .comment-anchor-highlight {
    background-color: rgba(255, 213, 79, 0.35);
    border-bottom: 2px solid rgba(255, 167, 38, 0.6);
    border-radius: 2px;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }
  .comment-anchor-highlight:hover {
    background-color: rgba(255, 213, 79, 0.55);
  }
  .active-highlight {
    background-color: rgba(66, 165, 245, 0.35);
    border-bottom: 2px solid rgba(33, 150, 243, 0.7);
    border-radius: 2px;
  }
  ::selection {
    background-color: rgba(66, 165, 245, 0.3);
  }
</style>
</head>
<body>
<div id="editor-content"></div>
<script>
(function() {
  var rawContent = ${escaped};

  // Minimal markdown-to-HTML converter covering the most common patterns.
  // A full library (marked, etc.) would add weight; this covers headings,
  // bold, italic, code, links, lists, blockquotes, and paragraphs.
  function mdToHtml(md) {
    var lines = md.split("\\n");
    var html = [];
    var inCodeBlock = false;
    var inList = false;
    var listType = "";

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // Fenced code blocks
      if (line.match(/^\`\`\`/)) {
        if (inCodeBlock) {
          html.push("</code></pre>");
          inCodeBlock = false;
        } else {
          if (inList) { html.push("</" + listType + ">"); inList = false; }
          html.push("<pre><code>");
          inCodeBlock = true;
        }
        continue;
      }
      if (inCodeBlock) {
        html.push(escapeHtml(line) + "\\n");
        continue;
      }

      // Close open list if this line is not a list item
      var isUl = line.match(/^\\s*[-*+]\\s+(.+)/);
      var isOl = line.match(/^\\s*\\d+\\.\\s+(.+)/);
      if (inList && !isUl && !isOl) {
        html.push("</" + listType + ">");
        inList = false;
      }

      // Headings
      var h = line.match(/^(#{1,6})\\s+(.+)/);
      if (h) {
        var level = h[1].length;
        html.push("<h" + level + ">" + inlineFormat(h[2]) + "</h" + level + ">");
        continue;
      }

      // Blockquotes
      var bq = line.match(/^>\\s?(.*)/);
      if (bq) {
        html.push("<blockquote><p>" + inlineFormat(bq[1]) + "</p></blockquote>");
        continue;
      }

      // Unordered list items
      if (isUl) {
        if (!inList || listType !== "ul") {
          if (inList) html.push("</" + listType + ">");
          html.push("<ul>");
          inList = true;
          listType = "ul";
        }
        html.push("<li>" + inlineFormat(isUl[1]) + "</li>");
        continue;
      }

      // Ordered list items
      if (isOl) {
        if (!inList || listType !== "ol") {
          if (inList) html.push("</" + listType + ">");
          html.push("<ol>");
          inList = true;
          listType = "ol";
        }
        html.push("<li>" + inlineFormat(isOl[1]) + "</li>");
        continue;
      }

      // Horizontal rule
      if (line.match(/^(---|\\*\\*\\*|___)\\s*$/)) {
        html.push("<hr>");
        continue;
      }

      // Blank lines
      if (line.trim() === "") {
        continue;
      }

      // Paragraph
      html.push("<p>" + inlineFormat(line) + "</p>");
    }

    if (inList) html.push("</" + listType + ">");
    if (inCodeBlock) html.push("</code></pre>");

    return html.join("\\n");
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function inlineFormat(text) {
    var s = escapeHtml(text);
    // Inline code
    s = s.replace(/\`([^\`]+)\`/g, "<code>$1</code>");
    // Bold
    s = s.replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>");
    s = s.replace(/__(.+?)__/g, "<strong>$1</strong>");
    // Italic
    s = s.replace(/\\*(.+?)\\*/g, "<em>$1</em>");
    s = s.replace(/_(.+?)_/g, "<em>$1</em>");
    // Links
    s = s.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s;
  }

  // Render the content
  var el = document.getElementById("editor-content");
  el.innerHTML = mdToHtml(rawContent);

  // -----------------------------------------------------------------------
  // Selection tracking → notify parent of text_selected
  // -----------------------------------------------------------------------

  var lastSelectionText = "";

  function checkSelection() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      if (lastSelectionText !== "") {
        lastSelectionText = "";
      }
      return;
    }
    var text = sel.toString();
    if (!text.trim() || text === lastSelectionText) return;
    lastSelectionText = text;

    // Compute start/end offsets within plainText
    var range = sel.getRangeAt(0);
    var preRange = document.createRange();
    preRange.selectNodeContents(el);
    preRange.setEnd(range.startContainer, range.startOffset);
    var start = preRange.toString().length;
    var end = start + text.length;

    window.parent.postMessage({
      type: "text_selected",
      start: start,
      end: end,
      text: text
    }, "*");
  }

  document.addEventListener("selectionchange", function() {
    // Debounce to avoid rapid-fire during drag selection
    clearTimeout(checkSelection._timer);
    checkSelection._timer = setTimeout(checkSelection, 150);
  });

  // -----------------------------------------------------------------------
  // postMessage listeners from parent
  // -----------------------------------------------------------------------

  // Track the currently active temporary highlight for cleanup
  var activeHighlightMarks = [];

  function clearActiveHighlights() {
    for (var i = 0; i < activeHighlightMarks.length; i++) {
      var mark = activeHighlightMarks[i];
      var parent = mark.parentNode;
      if (parent) {
        while (mark.firstChild) {
          parent.insertBefore(mark.firstChild, mark);
        }
        parent.removeChild(mark);
      }
    }
    activeHighlightMarks = [];
    el.normalize();
  }

  /**
   * Highlight a character range in the rendered content by wrapping the
   * matching text nodes in a <mark> element.
   */
  function highlightRange(start, end, className) {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    var offset = 0;
    var marks = [];

    while (walker.nextNode()) {
      var node = walker.currentNode;
      var nodeLen = node.textContent.length;
      var nodeStart = offset;
      var nodeEnd = offset + nodeLen;

      if (nodeEnd > start && nodeStart < end) {
        var highlightStart = Math.max(start - nodeStart, 0);
        var highlightEnd = Math.min(end - nodeStart, nodeLen);

        if (highlightStart > 0 || highlightEnd < nodeLen) {
          var range = document.createRange();
          range.setStart(node, highlightStart);
          range.setEnd(node, highlightEnd);
          var mark = document.createElement("mark");
          mark.className = className;
          range.surroundContents(mark);
          marks.push(mark);
          // After surroundContents, the walker position may be invalidated;
          // restart from the container to handle split nodes correctly.
          walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
          offset = 0;
          continue;
        } else {
          var mark = document.createElement("mark");
          mark.className = className;
          node.parentNode.insertBefore(mark, node);
          mark.appendChild(node);
          marks.push(mark);
        }
      }
      offset = nodeEnd;
    }
    return marks;
  }

  window.addEventListener("message", function(event) {
    var d = event.data;
    if (!d || !d.type) return;

    if (d.type === "highlight_range") {
      clearActiveHighlights();
      if (typeof d.start === "number" && typeof d.end === "number" && d.end > d.start) {
        activeHighlightMarks = highlightRange(d.start, d.end, "active-highlight");
        // Scroll the first mark into view
        if (activeHighlightMarks.length > 0) {
          activeHighlightMarks[0].scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    }

    if (d.type === "set_comment_anchors") {
      // Remove existing anchor highlights (but keep active highlights)
      var existing = el.querySelectorAll(".comment-anchor-highlight");
      for (var i = 0; i < existing.length; i++) {
        var mark = existing[i];
        var parent = mark.parentNode;
        if (parent) {
          while (mark.firstChild) {
            parent.insertBefore(mark.firstChild, mark);
          }
          parent.removeChild(mark);
        }
      }
      el.normalize();

      // Apply new anchor highlights
      var anchors = Array.isArray(d.anchors) ? d.anchors : [];
      // Sort by start offset descending so earlier highlights don't shift
      // later offsets
      anchors.sort(function(a, b) { return b.anchorStart - a.anchorStart; });
      for (var j = 0; j < anchors.length; j++) {
        var anchor = anchors[j];
        if (typeof anchor.anchorStart === "number" && typeof anchor.anchorEnd === "number") {
          highlightRange(anchor.anchorStart, anchor.anchorEnd, "comment-anchor-highlight");
        }
      }
    }
  });
})();
</script>
</body>
</html>`;
}
